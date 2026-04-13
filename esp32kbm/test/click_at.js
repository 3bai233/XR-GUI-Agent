/**
 * click_at.js - Interactive mouse click tool v2
 *
 * Usage: node click_at.js <port> [baudRate
 *   e.g: node click_at.js /dev/cu.usbserial-1120 115200
 *
 * Workflow:
 *   1. Type "X Y" and press Enter to set coordinates (Enter alone = reuse last)
 *   2. Press SPACE  → mouse moves slowly to (X,Y), then holds (±1px jitter)
 *   3. Press Enter  → click at current held position
 *   4. Press B      → stop holding, return to coordinate input
 *   5. Press Space  → (while holding) re-move to same coordinates
 *   6. Press Q / Ctrl+C → quit
 *
 * NOTE: stays in raw mode the entire time to avoid stdin switching issues.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { SerialPort, ReadlineParser } = require('serialport');

// ---- Args ----
const args = process.argv;
if (args.length < 3) {
    console.log('Usage: node click_at.js <port> [baudRate]');
    console.log('  e.g: node click_at.js /dev/cu.usbserial-1120 115200');
    process.exit(1);
}
const DEV       = args[2];
const BAUD_RATE = parseInt(args[3]) || 115200;

// ---- Movement config ----
const STEP     = 5;    // px per step for target move (slow, visible)
const WAIT     = 25;   // ms per step (>= 20ms for BLE stability)
const RST_STEP = 100;  // px per step for reset-to-corner (fast)
const RST_WAIT = 20;   // ms per step for reset
const JITTER_D = 300;  // ms per jitter cycle (hold mode)
const MOVE_DEBOUNCE_MS = 800;

// ---- State ----
let targetX = null;
let targetY = null;
// States: 'INPUT' | 'SPACE_WAIT' | 'MOVING' | 'HOLDING'
let state        = 'INPUT';
let busy         = false;
let aborted      = false;
let lastMoveTime = 0;   // debounce timestamp for SPACE-triggered move

// ---- Raw line input buffer (used in INPUT state) ----
let lineBuf = '';
const lineWaiters = [];

// ---- Serial ----
const port   = new SerialPort({ path: DEV, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser());
parser.on('data', (line) => {
    notifyLineWaiters(line);
    // Erase current input line, print ESP32 output, reprint prompt+buffer
    process.stdout.write(`\r\x1b[2K[ESP32] ${line}\r\n`);
    if (state === 'INPUT') process.stdout.write(prompt() + lineBuf);
});
port.on('error', (err) => { console.error('[PORT ERROR]', err.message); process.exit(1); });

function prompt() {
    return targetX !== null
        ? `Coords (Enter=reuse [${targetX},${targetY}]): `
        : `Coords "X Y": `;
}

async function send(cmd) {
    await port.write(cmd + '\0');
    await sleep(80);
}

function waitForLineMatch(pattern, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const waiter = {
            pattern,
            timer: setTimeout(() => {
                const idx = lineWaiters.indexOf(waiter);
                if (idx >= 0) lineWaiters.splice(idx, 1);
                reject(new Error('Timed out waiting for ESP32 response.'));
            }, timeoutMs),
            resolve,
            reject,
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

async function syncDeviceReady() {
    process.stdout.write('[SYNC] Waiting ESP32 to accept STOP...\r\n');

    // Some firmware logs may prepend dots from the run loop, e.g. ".SCRIPT STOP.".
    // Use loose matching to avoid false negative sync failures.
    const stopPattern = /SCRIPT STOP\./;
    let stopped = false;
    for (let i = 0; i < 8; i++) {
        await send('#STOP');
        try {
            await waitForLineMatch(stopPattern, 3000);
            stopped = true;
            break;
        } catch (_) {
            // Device may still be busy in previous script, retry.
            await sleep(120);
        }
    }
    if (!stopped) {
        process.stdout.write('[SYNC WARN] STOP ack not observed, continue with RESETALL.\r\n');
    }

    await sleep(120);
    await send('#RESETALL');
    try {
        await waitForLineMatch(/RESET,clear all register and script code\./, 5000);
    } catch (_) {
        process.stdout.write('[SYNC WARN] RESETALL ack not observed, continue anyway.\r\n');
    }
    await sleep(300);
}

async function sendScript(stmts, { resetRegisters = false } = {}) {
    await send('#STOP');
    await sleep(150);
    if (resetRegisters) await send('#RESET');
    await send('#CLS');
    for (const s of stmts) await send(s + ';');
    await send('#RUN');
}

function moveToDurationMs(x, y, step, wait) {
    const stepAbs = Math.max(1, Math.min(127, Math.abs(step)));
    const waitMs  = Math.max(1, wait);
    const absX = Math.abs(x);
    const absY = Math.abs(y);

    // Mirror firmware's mouse_move_to() stepping logic:
    // phase 1 moves by `step`, phase 2 moves remaining 1px tail.
    const majorSteps = Math.max(Math.floor(absX / stepAbs), Math.floor(absY / stepAbs));
    const tailSteps  = Math.max(absX % stepAbs, absY % stepAbs);
    return (majorSteps + tailSteps) * waitMs;
}

function estimateMovePhaseMs(x, y) {
    return moveToDurationMs(-10000, -10000, RST_STEP, RST_WAIT)
         + 400
         + moveToDurationMs(x, y, STEP, WAIT)
         + 200
         + 120; // Serial/loop scheduling margin.
}

function buildMoveAndHoldScript(x, y) {
    return [
        `if (!ble_check()) { print('BLE not connected'); delay(1000); }`
      + ` else if (rread(0) === 0) {`
      + `mouse_move_to(-10000,-10000,${RST_STEP},${RST_WAIT});`
      + `delay(400);`
      + `mouse_move_to(${x},${y},${STEP},${WAIT});`
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

// ---- Core actions ----

async function moveToAndHold(x, y) {
    aborted      = false;
    state        = 'MOVING';
    process.stdout.write(`\r\n→ Moving to (${x}, ${y})  [STEP=${STEP}px WAIT=${WAIT}ms]\r\n`);

    await sendScript(buildMoveAndHoldScript(x, y), { resetRegisters: true });

    const total = estimateMovePhaseMs(x, y);
    let elapsed = 0;
    while (elapsed < total) {
        if (aborted) return;
        const tick = Math.min(100, total - elapsed);
        await sleep(tick);
        elapsed += tick;
    }
    if (aborted) return;

    lastMoveTime = Date.now();
    state = 'HOLDING';
    process.stdout.write(`\r\n[HOLDING] at (${x}, ${y})\r\n`);
    printHoldMenu();
    busy = false;
}

async function clickNow() {
    process.stdout.write(`\r\n  [CLICK]\r\n`);
    await send('#STOP');
    await sleep(150);
    await send('#CLS');
    await send('mouse_click(1);');
    await send('#RUN');
    // 160ms < one loop cycle (click + 150ms delay), so #STOP arrives before 2nd click
    await sleep(160);
    await sendScript([
        `mouse_move(1,0)`, `delay(${JITTER_D})`,
        `mouse_move(-1,0)`, `delay(${JITTER_D})`,
    ]);
}

async function stopHolding() {
    aborted = true;
    await send('#STOP');
    await sleep(300);
    state   = 'INPUT';
    busy    = false;
    lineBuf = '';
    process.stdout.write(`\r\n[STOPPED]\r\n`);
    process.stdout.write(prompt());
}

function printHoldMenu() {
    process.stdout.write('  Enter=click  Space=re-move  B=stop & re-input  Q=quit\r\n');
}

// ---- Single raw mode stdin handler (never switches mode) ----
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (key) => {
    // Ctrl+C or Q always quits
    if (key === '\u0003' || key === 'q' || key === 'Q') {
        await send('#STOP');
        process.stdout.write('\r\n[EXIT]\r\n');
        port.close(() => process.exit(0));
        return;
    }

    // ---- INPUT state: manual line editor ----
    if (state === 'INPUT') {
        if (key === '\r' || key === '\n') {
            // Enter → parse coords or reuse
            process.stdout.write('\r\n');
            const trimmed = lineBuf.trim();
            lineBuf = '';
            if (trimmed === '') {
                if (targetX === null) {
                    process.stdout.write('[!] No previous coords. Enter X Y first.\r\n');
                    process.stdout.write(prompt());
                    return;
                }
                // reuse last coords — fall through
            } else {
                const parts = trimmed.split(/[\s,]+/);
                const x = parseInt(parts[0]);
                const y = parseInt(parts[1]);
                if (isNaN(x) || isNaN(y) || parts.length < 2) {
                    process.stdout.write('[!] Invalid. Enter two numbers, e.g: 400 500\r\n');
                    process.stdout.write(prompt());
                    return;
                }
                targetX = x;
                targetY = y;
            }
            process.stdout.write(`Coords → (${targetX}, ${targetY})  |  Press SPACE to move, Q to quit\r\n`);
            state = 'SPACE_WAIT';
        } else if (key === '\u007f' || key === '\b') {
            // Backspace
            if (lineBuf.length > 0) {
                lineBuf = lineBuf.slice(0, -1);
                process.stdout.write('\b \b');
            }
        } else if (key >= ' ') {
            // Printable character
            lineBuf += key;
            process.stdout.write(key);
        }
        return;
    }

    // ---- SPACE_WAIT state ----
    if (state === 'SPACE_WAIT') {
        if (key === ' ') {
            if (busy || Date.now() - lastMoveTime < MOVE_DEBOUNCE_MS) return;
            lastMoveTime = Date.now();
            busy = true;
            await moveToAndHold(targetX, targetY);
            // busy reset inside moveToAndHold
        }
        return;
    }

    // ---- HOLDING state ----
    if (state === 'HOLDING') {
        if (busy) return;
        if (key === '\r' || key === '\n') {
            busy = true;
            await clickNow();
            busy = false;
            printHoldMenu();
        } else if (key === 'b' || key === 'B') {
            busy = true;
            await stopHolding();
            // busy reset inside stopHolding
        } else if (key === ' ') {
            if (Date.now() - lastMoveTime < MOVE_DEBOUNCE_MS) return;
            lastMoveTime = Date.now();
            busy = true;
            await moveToAndHold(targetX, targetY);
            // busy reset inside moveToAndHold
        }
    }
});

// ---- Start ----
port.on('open', async () => {
    process.stdout.write(`[PORT] ${DEV} @ ${BAUD_RATE}\r\n`);
    process.stdout.write(`Speed: STEP=${STEP}px / WAIT=${WAIT}ms\r\n`);
    process.stdout.write(`-------------------------------------------\r\n`);
    await syncDeviceReady();
    state = 'INPUT';
    process.stdout.write(prompt());
});
