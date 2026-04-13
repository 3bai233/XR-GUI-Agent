#!/usr/bin/env python3
"""
calibrate.py  –  Screen ↔ ESP32 BLE-mouse coordinate calibration

Workflow:
  1.  python calibrate.py
  2.  Press 's' → captures current screenshot
  3.  Click on the screenshot window at a reference point whose screen pixel
      position you want to record
  4.  In the terminal, enter the ESP32 BT absolute coords for that same point
      (use click_at.js to move the BLE cursor to that position and note X Y)
  5.  Repeat for at least 3–6 points spread across the screen
  6.  Type 'done' → fits a linear model and saves calibration.json

Commands:
  s      capture screenshot and pick a point
  list   show collected points
  done   fit model and save calibration.json
  q      quit without saving
"""

import json
import sys
import tkinter as tk

import numpy as np
import pyautogui
from PIL import Image, ImageTk

CALIBRATION_FILE = "calibration.json"


# ── Screenshot + GUI picker ───────────────────────────────────────────────────

def take_screenshot() -> Image.Image:
    return pyautogui.screenshot()


def pick_screen_point(img: Image.Image):
    """
    Open a full-screenshot window.  User clicks one point; the window closes
    automatically after a brief visual confirmation.
    Returns (screen_x, screen_y) in original screenshot pixels, or None.
    """
    result = {}

    root = tk.Tk()
    root.title("Click the calibration point  [window closes on click]")

    # Scale down so it fits most monitors
    sw, sh = img.size
    scale = min(1.0, 1400 / sw, 900 / sh)
    dw, dh = int(sw * scale), int(sh * scale)

    tk_img = ImageTk.PhotoImage(img.resize((dw, dh), Image.LANCZOS))
    canvas = tk.Canvas(root, width=dw, height=dh, cursor="crosshair", bg="black")
    canvas.pack()
    canvas.create_image(0, 0, anchor="nw", image=tk_img)

    def on_click(ev):
        result["x"] = int(ev.x / scale)
        result["y"] = int(ev.y / scale)
        r = 10
        canvas.create_oval(ev.x - r, ev.y - r, ev.x + r, ev.y + r,
                           outline="red", width=2)
        canvas.create_line(ev.x - r * 2, ev.y, ev.x + r * 2, ev.y, fill="red")
        canvas.create_line(ev.x, ev.y - r * 2, ev.x, ev.y + r * 2, fill="red")
        root.after(700, root.destroy)

    canvas.bind("<Button-1>", on_click)
    root.mainloop()
    return (result["x"], result["y"]) if "x" in result else None


# ── Linear regression ─────────────────────────────────────────────────────────

def linear_fit(pts: list) -> dict:
    """
    pts: [[screen_x, screen_y, bt_x, bt_y], ...]
    Returns {"ax", "bx", "ay", "by"} such that:
        bt_x = ax * screen_x + bx
        bt_y = ay * screen_y + by
    """
    sx = np.array([p[0] for p in pts], dtype=float)
    sy = np.array([p[1] for p in pts], dtype=float)
    bx = np.array([p[2] for p in pts], dtype=float)
    by = np.array([p[3] for p in pts], dtype=float)

    Ax = np.column_stack([sx, np.ones_like(sx)])
    Ay = np.column_stack([sy, np.ones_like(sy)])
    (ax, bx_c), *_ = np.linalg.lstsq(Ax, bx, rcond=None)
    (ay, by_c), *_ = np.linalg.lstsq(Ay, by, rcond=None)

    return {
        "ax": float(ax), "bx": float(bx_c),
        "ay": float(ay), "by": float(by_c),
    }


# ── Main REPL ─────────────────────────────────────────────────────────────────

def main():
    pts = []
    print("=== ESP32 BLE Mouse Calibration ===")
    print("s=screenshot+click  list=show points  done=fit&save  q=quit\n")

    while True:
        try:
            cmd = input(">>> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\nQuit.")
            break

        if cmd == "s":
            print("Capturing screenshot …")
            img = take_screenshot()
            coord = pick_screen_point(img)
            if coord is None:
                print("[!] No click detected, try again.")
                continue
            sx, sy = coord
            print(f"  Screen point recorded: ({sx}, {sy})")

            raw = input("  Enter BT coords  X Y  (measured with click_at.js): ").strip()
            parts = raw.split()
            if len(parts) < 2:
                print("[!] Expected two numbers, e.g.: 640 480")
                continue
            try:
                bx, by = int(parts[0]), int(parts[1])
            except ValueError:
                print("[!] Invalid numbers.")
                continue

            pts.append([sx, sy, bx, by])
            print(f"  Saved #{len(pts)}: screen=({sx},{sy}) → bt=({bx},{by})")

        elif cmd == "list":
            if not pts:
                print("  (no points yet)")
            for i, p in enumerate(pts, 1):
                print(f"  #{i}: screen=({p[0]},{p[1]}) → bt=({p[2]},{p[3]})")

        elif cmd == "done":
            if len(pts) < 2:
                print("[!] Need at least 2 points.")
                continue

            params = linear_fit(pts)
            params["points"] = pts
            params["screen_size"] = list(pyautogui.size())

            with open(CALIBRATION_FILE, "w") as f:
                json.dump(params, f, indent=2)

            print(f"\nSaved → {CALIBRATION_FILE}")
            print(f"  bt_x = {params['ax']:.4f} * screen_x + {params['bx']:.2f}")
            print(f"  bt_y = {params['ay']:.4f} * screen_y + {params['by']:.2f}")
            print("\nResiduals (lower is better):")
            for p in pts:
                px = params["ax"] * p[0] + params["bx"]
                py = params["ay"] * p[1] + params["by"]
                err = ((px - p[2]) ** 2 + (py - p[3]) ** 2) ** 0.5
                print(f"  screen=({p[0]},{p[1]})  predicted=({px:.0f},{py:.0f})"
                      f"  actual=({p[2]},{p[3]})  err={err:.1f}px")
            break

        elif cmd in ("q", "quit"):
            print("Quit without saving.")
            break

        else:
            print("Commands: s / list / done / q")


if __name__ == "__main__":
    main()
