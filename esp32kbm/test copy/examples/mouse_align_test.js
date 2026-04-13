// Mouse alignment test script
// Pattern: Center -> TL-mid -> Center -> TR-mid -> Center -> BR-mid -> Center -> BL-mid -> loop
// No clicks, only movement. Used to verify mouse position aligns with window.
//
// Adjust these values to match your screen/window size:
var SCR_W = 800;   // half of screen width  (distance from center to left/right edge)
var SCR_H = 900;   // half of screen height (distance from center to top/bottom edge)
var STEP  = 30;    // move step size (smaller = smoother, slower)
var WAIT  = 30;    // delay between steps (ms) — keep >= 20ms for BLE stability
var PAUSE = 500;   // pause at each point (ms)

// Midpoint offsets from center (halfway to each corner)
var MX = parseInt(SCR_W / 2);  // 400
var MY = parseInt(SCR_H / 2);  // 450

// Registers
var R_STAGE = 0x0;

// Stages
var S_INIT    = 0;  // move to top-left corner to reset position
var S_CENTER  = 1;  // move to screen center
var S_TL      = 2;  // move to top-left midpoint,    then back to center
var S_TR      = 3;  // move to top-right midpoint,   then back to center
var S_BR      = 4;  // move to bottom-right midpoint, then back to center
var S_BL      = 5;  // move to bottom-left midpoint,  then back to center

if (ble_check()) {
    var stage = rread(R_STAGE);

    switch (stage) {
        default:
        case S_INIT:
            print('INIT: reset to top-left corner');
            rwrite(R_STAGE, S_CENTER);
            mouse_move_to(-10000, -10000); // slam to top-left edge
            delay(300);
            break;

        case S_CENTER:
            print('MOVE: to center');
            rwrite(R_STAGE, S_TL);
            mouse_move_to(SCR_W, SCR_H, STEP, WAIT); // move to screen center
            delay(PAUSE);
            break;

        case S_TL:
            print('MOVE: center -> top-left mid -> center');
            rwrite(R_STAGE, S_TR);
            mouse_move_to(-MX, -MY, STEP, WAIT); // to top-left midpoint
            delay(PAUSE);
            mouse_move_to(MX, MY, STEP, WAIT);   // back to center
            delay(PAUSE);
            break;

        case S_TR:
            print('MOVE: center -> top-right mid -> center');
            rwrite(R_STAGE, S_BR);
            mouse_move_to(MX, -MY, STEP, WAIT);  // to top-right midpoint
            delay(PAUSE);
            mouse_move_to(-MX, MY, STEP, WAIT);  // back to center
            delay(PAUSE);
            break;

        case S_BR:
            print('MOVE: center -> bottom-right mid -> center');
            rwrite(R_STAGE, S_BL);
            mouse_move_to(MX, MY, STEP, WAIT);   // to bottom-right midpoint
            delay(PAUSE);
            mouse_move_to(-MX, -MY, STEP, WAIT); // back to center
            delay(PAUSE);
            break;

        case S_BL:
            print('MOVE: center -> bottom-left mid -> center');
            rwrite(R_STAGE, S_TL); // loop back to TL
            mouse_move_to(-MX, MY, STEP, WAIT);  // to bottom-left midpoint
            delay(PAUSE);
            mouse_move_to(MX, -MY, STEP, WAIT);  // back to center
            delay(PAUSE);
            break;
    }
} else {
    print('BLE not connected, waiting...');
    delay(1000);
}
