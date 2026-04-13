/**
 * control_console.js - Absolute move + hover + click/type/drag console
 *
 * Usage:
 *   node control_console.js <port> [baudRate]
 *   e.g. node control_console.js /dev/cu.usbserial-1120 115200
 *
 * Commands:
 *   goto X Y [step] [wait]           Move once to absolute point and hover
 *   click [left|right|middle|back|forward|1|2|4|8|16]
 *   type TEXT                        Keyboard input (ASCII only)
 *   enter                            Send Enter key
 *   drag DIR DIST [step] [wait]      DIR: up/down/left/right
 *   stop                             Stop current script (exit hover)
 *   status                           Show current position/state
 *   help                             Show help
 *   quit / q                         Exit
 */

const readline = require('readline');
const { SerialPort, ReadlineParser } = require('serialport');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Args ----
const args = process.argv;
if (args.length < 3) {
    console.log('Usage: node control_console.js <port> [baudRate]');
    console.log('  e.g. node control_console.js /dev/cu.usbserial-1120 115200');
    process.exit(1);
}
const DEV = args[2];
const BAUD_RATE = parseInt(args[3], 10) || 115200;

// ---- Config ----
// NOTE: firmware mouse_move_to() computes tx2 = abs(x) % step, but initialises
// the counter as tx2 = x (raw coord). With step=1 this degenerates into a
// 1-px-per-loop walk over the full coordinate value, blocking the MCU for
// tens of seconds and making the serial channel unresponsive.
// Keep step >= 5 (and ideally a divisor-friendly value like 5 or 10).
const DEFAULT_STEP = 5;      // px per loop step — must NOT be 1 (firmware bug)
const DEFAULT_WAIT = 25;     // >= 20ms for BLE stability
const RST_STEP = 100;
const RST_WAIT = 20;
const JITTER_D = 300;
const DRAG_STEP = 20;
const DRAG_WAIT = 20;
// Keep one-shot guard register in low range (0..3) to be compatible even
// before firmware memset bug fix is flashed.
const REG_ONCE = 1;
const KEY_RETURN = 0xB0;

// ---- Runtime state ----
let currentX = null;
let currentY = null;
let holding = false;
let busy = false;
let shuttingDown = false;

let commandQueue = Promise.resolve();
const lineWaiters = [];

// ---- Serial ----
const port = new SerialPort({ path: DEV, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser());

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'cmd> ',
});

function clampStep(step) {
    const n = Math.trunc(step);
    if (!Number.isFinite(n) || n === 0) return 1;
    return Math.max(-127, Math.min(127, n));
}

function clampWait(wait) {
    const n = Math.trunc(wait);
    if (!Number.isFinite(n)) return 20;
    return Math.max(1, n);
}

function moveToDurationMs(x, y, step, wait) {
    const stepAbs = Math.max(1, Math.min(127, Math.abs(step)));
    const waitMs = Math.max(1, wait);
    const absX = Math.abs(x);
    const absY = Math.abs(y);

    // Match firmware mouse_move_to() stepping model exactly.
    const majorSteps = Math.max(Math.floor(absX / stepAbs), Math.floor(absY / stepAbs));
    const tailSteps = Math.max(absX % stepAbs, absY % stepAbs);
    return (majorSteps + tailSteps) * waitMs;
}

function estimateGotoMs(x, y, step, wait) {
    return moveToDurationMs(-10000, -10000, RST_STEP, RST_WAIT)
        + 400
        + moveToDurationMs(x, y, step, wait)
        + 200
        + 120;
}

function buildMoveAndHoldScript(x, y, step, wait) {
    // Wrap entire body in ble_check so the MCU doesn't spin-loop on HID
    // calls while the host is not connected (those calls silently drop but
    // still consume time, masking the real connection problem).
    return [
        `if (!ble_check()) { print('BLE not connected'); delay(1000); }`
      + ` else if (rread(0) === 0) {`
      + `mouse_move_to(-10000,-10000,${RST_STEP},${RST_WAIT});`
      + `delay(400);`
      + `mouse_move_to(${x},${y},${step},${wait});`
      + `delay(200);`
      + `rwrite(0,1);`
      + `} else {`
      + `mouse_move(1,0);`
      + `delay(${JITTER_D});`
      + `mouse_move(-1,0);`
      + `delay(${JITTER_D});`
      + `}`
    ];
}

function buildHoldOnlyScript() {
    return [
        `mouse_move(1,0)`,
        `delay(${JITTER_D})`,
        `mouse_move(-1,0)`,
        `delay(${JITTER_D})`,
    ];
}

function jsAsciiString(text) {
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7f) {
            throw new Error('Keyboard input only supports ASCII in current firmware channel.');
        }
    }
    return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function buttonCode(name) {
    if (!name) return 1;
    const v = name.toLowerCase();
    if (v === 'left') return 1;
    if (v === 'right') return 2;
    if (v === 'middle') return 4;
    if (v === 'back') return 8;
    if (v === 'forward') return 16;

    const num = parseInt(v, 10);
    if ([1, 2, 4, 8, 16].includes(num)) return num;
    throw new Error('Invalid click button. Use left/right/middle/back/forward or 1/2/4/8/16.');
}

function dragDelta(dir, dist) {
    const d = dir.toLowerCase();
    if (d === 'up') return { dx: 0, dy: -dist };
    if (d === 'down') return { dx: 0, dy: dist };
    if (d === 'left') return { dx: -dist, dy: 0 };
    if (d === 'right') return { dx: dist, dy: 0 };
    throw new Error('Invalid direction. Use up/down/left/right.');
}

function printHelp() {
    console.log('Commands:');
    console.log('  ble                               Check current BLE connection state');
    console.log('  goto X Y [step] [wait]');
    console.log('  click [left|right|middle|back|forward|1|2|4|8|16]');
    console.log('  type TEXT');
    console.log('  enter');
    console.log('  drag DIR DIST [step] [wait]   (DIR=up/down/left/right)');
    console.log('  stop');
    console.log('  status');
    console.log('  help');
    console.log('  quit');
}

function printStatus() {
    const pos = currentX === null ? 'unknown' : `(${currentX}, ${currentY})`;
    console.log(`[STATUS] busy=${busy} holding=${holding} position=${pos}`);
}

function writePortRaw(data) {
    return new Promise((resolve, reject) => {
        port.write(data, (err) => {
            if (err) return reject(err);
            port.drain((drainErr) => {
                if (drainErr) return reject(drainErr);
                resolve();
            });
        });
    });
}

async function send(cmd) {
    await writePortRaw(cmd + '\0');
    await sleep(30);
}

async function stopRun() {
    await send('#STOP');
    await sleep(120);
}

async function sendScript(stmts, { resetRegisters = false } = {}) {
    await stopRun();
    if (resetRegisters) await send('#RESET');
    await send('#CLS');
    for (const s of stmts) await send(s + ';');
    await send('#RUN');
}

function waitForLineMatch(pattern, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const waiter = {
            pattern,
            resolve,
            reject,
            timer: setTimeout(() => {
                const idx = lineWaiters.indexOf(waiter);
                if (idx >= 0) lineWaiters.splice(idx, 1);
                reject(new Error('Timed out waiting for ESP32 response.'));
            }, timeoutMs),
        };
        lineWaiters.push(waiter);
    });
}

function notifyLineWaiters(line) {
    for (let i = lineWaiters.length - 1; i >= 0; i--) {
        const w = lineWaiters[i];
        if (w.pattern.test(line)) {
            clearTimeout(w.timer);
            lineWaiters.splice(i, 1);
            w.resolve(line);
        }
    }
}

async function queryBleConnected() {
    const token = `BLECHK_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const pattern = new RegExp(`${token}:(0|1)`);
    const waiting = waitForLineMatch(pattern, 3000);

    await sendScript([
        `print('${token}:' + (ble_check()?1:0))`,
        `delay(150)`,
    ], { resetRegisters: false });

    let line;
    try {
        line = await waiting;
    } finally {
        await stopRun();
    }

    const m = line.match(pattern);
    return Boolean(m && m[1] === '1');
}

async function ensureBleConnected() {
    const connected = await queryBleConnected();
    if (!connected) {
        throw new Error('BLE not connected on ESP32 side. Please reconnect the phone and run "ble" to verify.');
    }
}

async function gotoAndHold(x, y, step = DEFAULT_STEP, wait = DEFAULT_WAIT) {
    await ensureBleConnected();

    const s = clampStep(step);
    const w = clampWait(wait);

    console.log(`→ Move once to (${x}, ${y}) [STEP=${s}, WAIT=${w}]`);
    await sendScript(buildMoveAndHoldScript(x, y, s, w), { resetRegisters: true });

    const total = estimateGotoMs(x, y, s, w);
    console.log(`  Waiting ~${Math.round(total / 1000)}s for move to complete...`);
    await sleep(total);

    // Stop looping script after move phase; jitter hold is optional here.
    await stopRun();
    holding = true;

    currentX = x;
    currentY = y;
    console.log(`[OK] Arrived at (${currentX}, ${currentY}) — BLE connected if no 'BLE not connected' above`);
}

async function runActionOnce(stmts, settleMs) {
    await ensureBleConnected();

    const body = `${stmts.join(';')};rwrite(${REG_ONCE},1)`;
    await sendScript([
        `if (!ble_check()) { print('BLE not connected'); delay(200); } else if (rread(${REG_ONCE}) === 0) {${body}}`,
        `delay(20)`,
    ], { resetRegisters: true });

    await sleep(settleMs);
    await stopRun();
    holding = false;
}

async function actionClick(button) {
    await runActionOnce([
        `mouse_click(${button})`,
        `delay(120)`,
    ], 260);

    holding = currentX !== null;
    console.log('[OK] Click done');
}

async function actionType(text) {
    const jsText = jsAsciiString(text);
    const settle = Math.max(260, 160 + text.length * 20);

    await runActionOnce([
        `keyboard_print(${jsText})`,
        `delay(80)`,
    ], settle);

    holding = currentX !== null;
    console.log('[OK] Keyboard input sent');
}

async function actionEnter() {
    await runActionOnce([
        `keyboard_write(${KEY_RETURN})`,
        `delay(80)`,
    ], 260);

    holding = currentX !== null;
    console.log('[OK] Enter sent');
}

async function actionDrag(direction, distance, step = DRAG_STEP, wait = DRAG_WAIT) {
    if (currentX === null) {
        throw new Error('Run goto X Y first so absolute position is known.');
    }

    const dist = Math.abs(Math.trunc(distance));
    if (!Number.isFinite(dist) || dist <= 0) {
        throw new Error('Distance must be a positive integer.');
    }

    const { dx, dy } = dragDelta(direction, dist);
    const s = Math.abs(clampStep(step));
    const w = clampWait(wait);
    const settle = moveToDurationMs(dx, dy, s, w) + 280;

    await runActionOnce([
        `mouse_down(1)`,
        `delay(20)`,
        `mouse_move_to(${dx},${dy},${s},${w})`,
        `delay(20)`,
        `mouse_up(1)`,
        `delay(80)`,
    ], settle);

    currentX += dx;
    currentY += dy;

    holding = true;
    console.log(`[OK] Drag ${direction} ${dist}, now at (${currentX}, ${currentY})`);
}

async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
        await stopRun();
        await sleep(120);
        await send('#RESETALL');
        // Best-effort cleanup: don't block exit forever on missing replies.
        try { await waitForLineMatch(/^RESET,clear all register and script code\.$/, 2000); } catch (_) {}
    } catch (_) {
        // Ignore shutdown path errors.
    }

    rl.close();

    port.close(() => {
        process.exit(code);
    });

    // Fallback in case close callback is not fired.
    setTimeout(() => process.exit(code), 300);
}

async function executeCommand(line) {
    const raw = line.trim();
    if (!raw) return;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'help' || cmd === 'h') {
        printHelp();
        return;
    }
    if (cmd === 'status') {
        printStatus();
        return;
    }
    if (cmd === 'ble') {
        const connected = await queryBleConnected();
        console.log(`[BLE] ${connected ? 'connected' : 'not connected'}`);
        return;
    }
    if (cmd === 'quit' || cmd === 'q' || cmd === 'exit') {
        await shutdown(0);
        return;
    }
    if (cmd === 'stop') {
        await stopRun();
        holding = false;
        console.log('[OK] Stopped');
        return;
    }

    if (cmd === 'goto') {
        if (parts.length < 3) {
            throw new Error('Usage: goto X Y [step] [wait]');
        }
        const x = parseInt(parts[1], 10);
        const y = parseInt(parts[2], 10);
        const step = parts[3] !== undefined ? parseInt(parts[3], 10) : DEFAULT_STEP;
        const wait = parts[4] !== undefined ? parseInt(parts[4], 10) : DEFAULT_WAIT;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('X and Y must be integers.');
        }
        await gotoAndHold(x, y, step, wait);
        return;
    }

    if (cmd === 'click') {
        const btn = buttonCode(parts[1]);
        await actionClick(btn);
        return;
    }

    if (cmd === 'type') {
        const text = raw.slice(4).trimStart();
        if (!text) {
            throw new Error('Usage: type TEXT');
        }
        await actionType(text);
        return;
    }

    if (cmd === 'enter') {
        await actionEnter();
        return;
    }

    if (cmd === 'drag') {
        if (parts.length < 3) {
            throw new Error('Usage: drag DIR DIST [step] [wait]');
        }
        const direction = parts[1];
        const distance = parseInt(parts[2], 10);
        const step = parts[3] !== undefined ? parseInt(parts[3], 10) : DRAG_STEP;
        const wait = parts[4] !== undefined ? parseInt(parts[4], 10) : DRAG_WAIT;

        if (!Number.isFinite(distance)) {
            throw new Error('DIST must be an integer.');
        }

        await actionDrag(direction, distance, step, wait);
        return;
    }

    throw new Error('Unknown command. Type help to view supported commands.');
}

function enqueueCommand(line) {
    commandQueue = commandQueue
        .then(async () => {
            if (shuttingDown) return;
            busy = true;
            await executeCommand(line);
        })
        .catch((err) => {
            console.error('[ERROR]', err.message || err);
        })
        .finally(() => {
            busy = false;
            if (!shuttingDown) rl.prompt();
        });
}

parser.on('data', (line) => {
    notifyLineWaiters(line);
    process.stdout.write(`\n[ESP32] ${line}\n`);
    if (!busy && !shuttingDown) rl.prompt(true);
});

port.on('error', (err) => {
    console.error('[PORT ERROR]', err.message);
    shutdown(1);
});

port.on('open', async () => {
    try {
        console.log(`[PORT] ${DEV} @ ${BAUD_RATE}`);
        await send('#STOP');
        await sleep(200);
        await send('#RESETALL');
        await sleep(600);
        console.log('Ready. Type help to view commands.');
        rl.prompt();
    } catch (err) {
        console.error('[INIT ERROR]', err.message || err);
        shutdown(1);
    }
});

rl.on('line', (line) => {
    enqueueCommand(line);
});

rl.on('close', () => {
    if (!shuttingDown) {
        shutdown(0);
    }
});

process.on('SIGINT', () => {
    shutdown(0);
});
