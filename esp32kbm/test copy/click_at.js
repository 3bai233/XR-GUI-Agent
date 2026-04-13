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
const STEP     = 6;    // px per step for target move (slow, visible)
const WAIT     = 25;   // ms per step (>= 20ms for BLE stability)
const RST_STEP = 100;  // px per step for reset-to-corner (fast)
const RST_WAIT = 20;   // ms per step for reset
const JITTER_D = 300;  // ms per jitter cycle (hold mode)

// ---- State ----
let targetX = null;
let targetY = null;
// States: 'INPUT' | 'SPACE_WAIT' | 'MOVING' | 'HOLDING'
let state   = 'INPUT';
let busy    = false;
let aborted = false;

// ---- Raw line input buffer (used in INPUT state) ----
let lineBuf = '';

// ---- Serial ----
const port   = new SerialPort({ path: DEV, baudRate: BAUD_RATE });
const parser = port.pipe(new ReadlineParser());
parser.on('data', (line) => {
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

async function sendScript(stmts) {
    await send('#STOP');
    await sleep(150);
    await send('#CLS');
    for (const s of stmts) await send(s + ';');
    await send('#RUN');
}

function estimateMs(x, y) {
    return Math.ceil(20000 / RST_STEP) * RST_WAIT + 500
         + Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / STEP) * WAIT + 400;
}

// ---- Core actions ----

async function moveToAndHold(x, y) {
    aborted = false;
    state   = 'MOVING';
    process.stdout.write(`\r\n→ Moving to (${x}, ${y})  [STEP=${STEP}px WAIT=${WAIT}ms]\r\n`);

    await sendScript([
        `mouse_move_to(-10000,-10000,${RST_STEP},${RST_WAIT})`,
        `delay(400)`,
        `mouse_move_to(${x},${y},${STEP},${WAIT})`,
        `delay(200)`,
    ]);

    const total = estimateMs(x, y);
    let elapsed = 0;
    while (elapsed < total) {
        if (aborted) return;
        await sleep(Math.min(100, total - elapsed));
        elapsed += 100;
    }
    if (aborted) return;

    await send('#STOP');
    await sleep(200);
    await sendScript([
        `mouse_move(1,0)`, `delay(${JITTER_D})`,
        `mouse_move(-1,0)`, `delay(${JITTER_D})`,
    ]);

    state = 'HOLDING';
    process.stdout.write(`\r\n[HOLDING] at (${x}, ${y})\r\n`);
    printHoldMenu();
    busy = false;
}

async function clickNow() {
    process.stdout.write(`\r\n  [CLICK]\r\n`);
    await send('#STOP');
    await sleep(200);
    await sendScript([`mouse_click(1)`, `delay(150)`]);
    await sleep(400);
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
            if (busy) return;
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
    await send('#STOP');
    await sleep(300);
    await send('#RESETALL');
    await sleep(800);
    state = 'INPUT';
    process.stdout.write(prompt());
});
