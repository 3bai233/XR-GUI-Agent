#!/usr/bin/env python3
"""
esp32_bridge.py  –  Agent S3 → ESP32 BLE mouse bridge

Replaces pyautogui mouse actions with ESP32 serial commands so that
Agent S3 controls a Pico4 Ultra (or any BLE HID device) instead of
the local machine's cursor.  Keyboard actions (hotkey, typewrite, press …)
are left on the local machine.

Usage:
  python esp32_bridge.py \\
      --serial_port /dev/cu.usbserial-110 \\
      --calibration calibration.json \\
      --move_mode fast \\
      --provider openai \\
      --model doubao-seed-2-0-pro-260215 \\
      --model_url https://ark.cn-beijing.volces.com/api/v3 \\
      --model_api_key 5c23f5a5-be32-4155-b1ab-88aa8b9de9a7 \\
      --ground_provider vllm \\
      --ground_url http://127.0.0.1:8888/v1 \\
      --ground_api_key dummy \\
      --ground_model MAI-UI-8B \\
      --grounding_width 1000 \\
      --grounding_height 1000 \\
      --task "open Chrome and search for weather"

Requires: pip install pyserial
"""


#!/usr/bin/env python3
"""
esp32_bridge.py – 修复版：增加串口握手与同步机制
"""

import argparse
import io
import json
import platform
import re
import sys
import time
from typing import List, Optional, Tuple

import serial
import numpy as np
import pyautogui
from PIL import Image

# ── Calibration ───────────────────────────────────────────────────────────────

def load_calibration(path: str) -> dict:
    """加载标定数据"""
    with open(path) as f:
        return json.load(f)

def screen_to_bt(cal: dict, sx: float, sy: float) -> Tuple[int, int]:
    """将屏幕坐标转换为 ESP32 绝对步进坐标"""
    if "u" in cal and "v" in cal and len(cal["u"]) == 10:
        # 三次多项式映射
        x, y = sx, sy
        cu, cv = cal["u"], cal["v"]
        u = (cu[0] + cu[1]*x + cu[2]*y + cu[3]*x**2 + cu[4]*x*y + cu[5]*y**2
             + cu[6]*x**3 + cu[7]*x**2*y + cu[8]*x*y**2 + cu[9]*y**3)
        v = (cv[0] + cv[1]*x + cv[2]*y + cv[3]*x**2 + cv[4]*x*y + cv[5]*y**2
             + cv[6]*x**3 + cv[7]*x**2*y + cv[8]*x*y**2 + cv[9]*y**3)
        return int(round(u)), int(round(v))
    # 线性映射回退
    return (int(round(cal["ax"] * sx + cal["bx"])), int(round(cal["ay"] * sy + cal["by"])))

# ── ESP32Mouse – 增强驱动类 ──────────────────────────────────────────────────

# ... (前面的 import 和 Calibration 保持不变)

class ESP32Mouse:
    def __init__(self, port: str, baud: int = 115200, step: int = 5):
        self._ser = serial.Serial(port, baud, timeout=0.1)
        self._step = step
        self._wait = 25
        self._cur_bt = None
        time.sleep(2)
        self.sync_ready()

    def sync_ready(self):
        """完全清理状态，初始化寄存器为0"""
        for _ in range(3):
            self._ser.write(b"#STOP\0")
            time.sleep(0.1)
        self._ser.write(b"#RESETALL\0") # 清除所有寄存器，rread(0) 变为 0
        time.sleep(0.5)

    def _estimate_ms(self, dx, dy, step, wait, needs_reset):
        """根据是否需要归位计算精准等待时间"""
        t = 0
        if needs_reset:
            t += self._estimate_move_ms(10000, 10000, 100, 20) + 400
        t += self._estimate_move_ms(dx, dy, step, wait) + 200 + 150
        return t / 1000.0

    def _estimate_move_ms(self, dx, dy, step, wait):
        s, w = max(1, abs(step)), max(1, wait)
        major = max(abs(dx) // s, abs(dy) // s)
        tail = max(abs(dx) % s, abs(dy) % s)
        return (major + tail) * w

    def _execute_smart_move(self, bt_x, bt_y, extra_stmts=None):
        """
        核心逻辑：利用 rread(0) 避免重复归零
        """
        needs_reset = (self._cur_bt is None)
        
        # 构造 ESP32 脚本：如果寄存器0为0，则执行重置动作
        script = [
            "if (rread(0) == 0) {",
            f"  mouse_move_to(-10000,-10000,100,20);",
            "  delay(400);",
            f"  mouse_move_to({bt_x},{bt_y},{self._step},{self._wait});",
            "  delay(200);",
            "  rwrite(0,1);", # 标记已归位
            "}"
        ]
        
        # 如果已经归位了，且坐标发生了变化，则进行相对移动或重新绝对移动
        # 为保证 BLE 绝对坐标精度，这里建议如果坐标变了，直接重置 rwrite(0,0) 触发重新归位
        # 或者使用 click_at.js 的逻辑：如果已在位置，只执行额外动作
        if self._cur_bt and self._cur_bt != (bt_x, bt_y):
            script.insert(0, "rwrite(0,0);") # 坐标变了，强制下一轮重新归零
            needs_reset = True

        if extra_stmts:
            script.extend(extra_stmts)

        # 发送并运行
        self._ser.write(b"#STOP\0")
        time.sleep(0.05)
        self._ser.write(b"#CLS\0")
        for stmt in script:
            self._ser.write((stmt + ";").encode())
        self._ser.write(b"#RUN\0")

        # 阻塞等待
        wait_s = self._estimate_ms(bt_x, bt_y, self._step, self._wait, needs_reset)
        time.sleep(wait_s)
        self._cur_bt = (bt_x, bt_y)

    def move_to(self, bt_x, bt_y):
        self._execute_smart_move(bt_x, bt_y)

    def click(self, bt_x, bt_y, btn_code=1):
        # 将移动和点击合并为一个脚本发送，减少一次 #STOP 造成的重置
        extra = [f"mouse_click({btn_code})", "delay(100)"]
        self._execute_smart_move(bt_x, bt_y, extra_stmts=extra)

# ── Patch 部分的改进 ─────────────────────────────────────────────────────────

def patch_pyautogui(mouse: ESP32Mouse, cal: dict):
    last_pos = [None, None] # 跟踪最后一次指令坐标

    def _moveTo(x, y, **kw):
        if [x, y] == last_pos: return # 坐标没变，直接跳过，防止反复重置
        bt_x, bt_y = screen_to_bt(cal, x, y)
        mouse.move_to(bt_x, bt_y)
        last_pos[0], last_pos[1] = x, y

    def _click(x=None, y=None, button="left", **kw):
        btn = {"left": 1, "right": 2, "middle": 4}.get(button, 1)
        if x is not None and y is not None:
            bt_x, bt_y = screen_to_bt(cal, x, y)
            mouse.click(bt_x, bt_y, btn)
            last_pos[0], last_pos[1] = x, y
        else:
            # 如果没给坐标，在当前位置点一下
            mouse._ser.write(f"mouse_click({btn});\0".encode())
            time.sleep(0.2)

    pyautogui.moveTo = _moveTo
    pyautogui.click = _click
    # ... 其他补丁
    # 其余 mouseUp/Down 可根据需要类似封装
    print("[ESP32] PyAutoGUI mouse functions patched.")

# ── Agent Loop & Main ─────────────────────────────────────────────────────────

def run_agent_loop(agent, task: str, scaled_w: int, scaled_h: int):
    """Agent 执行主循环"""
    obs = {}
    for step in range(15):
        screenshot = pyautogui.screenshot().resize((scaled_w, scaled_h), Image.LANCZOS)
        buf = io.BytesIO()
        screenshot.save(buf, format="PNG")
        obs["screenshot"] = buf.getvalue()

        print(f"\n🔄 Step {step + 1}/15 - Querying agent...")
        info, code = agent.predict(instruction=task, observation=obs)

        if not code or any(x in code[0].lower() for x in ["done", "fail"]):
            print(f"[TERMINAL] {code[0]}")
            break

        print(f"EXECUTING: {code[0]}")
        try:
            exec(code[0]) # 执行被 patch 过的 pyautogui 指令
        except Exception as e:
            print(f"Execution error: {e}")
        time.sleep(1.0)

def main():
    p = argparse.ArgumentParser(
        description="Agent S3 + ESP32 BLE mouse bridge",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    # ESP32 / calibration
    p.add_argument("--serial_port",   required=True,
                   help="Serial port, e.g. /dev/cu.usbserial-110")
    p.add_argument("--baud",          type=int, default=115200)
    p.add_argument("--calibration",   default="calibration.json",
                   help="Path to calibration.json from calibrate.py")
    p.add_argument("--move_mode",     choices=["fast", "slow"], default="fast",
                   help="fast=STEP50/20ms  slow=STEP5/25ms")

    # Agent S3 (mirror of run_agent.sh args)
    p.add_argument("--provider",           default="openai")
    p.add_argument("--model",              default="gpt-5-2025-08-07")
    p.add_argument("--model_url",          default="")
    p.add_argument("--model_api_key",      default="")
    p.add_argument("--model_temperature",  type=float, default=None)
    p.add_argument("--ground_provider",    required=True)
    p.add_argument("--ground_url",         required=True)
    p.add_argument("--ground_api_key",     default="")
    p.add_argument("--ground_model",       required=True)
    p.add_argument("--grounding_width",    type=int, required=True)
    p.add_argument("--grounding_height",   type=int, required=True)
    p.add_argument("--max_trajectory_length", type=int, default=8)
    p.add_argument("--enable_reflection",  action="store_true", default=True)
    p.add_argument("--enable_local_env",   action="store_true", default=False)
    p.add_argument("--task",               default=None,
                   help="Task instruction (prompted if omitted)")
    args = p.parse_args()

    # ── Calibration ──────────────────────────────────────────────────────────
    cal = load_calibration(args.calibration)
    if cal.get("degree", None) == 3 and "u" in cal and "v" in cal:
        print("[CAL] 三次多项式映射:")
        print("  u = c0 + c1*x + c2*y + c3*x^2 + c4*x*y + c5*y^2 + c6*x^3 + c7*x^2*y + c8*x*y^2 + c9*y^3")
        print("  v = c0 + c1*x + c2*y + c3*x^2 + c4*x*y + c5*y^2 + c6*x^3 + c7*x^2*y + c8*x*y^2 + c9*y^3")
        print("  u系数:", [f"{c:.6g}" for c in cal["u"]])
        print("  v系数:", [f"{c:.6g}" for c in cal["v"]])
    else:
        print(f"[CAL] bt_x = {cal['ax']:.4f}·sx + {cal['bx']:.2f}")
        print(f"[CAL] bt_y = {cal['ay']:.4f}·sy + {cal['by']:.2f}")

    # ── Serial ───────────────────────────────────────────────────────────────
    print(f"[SERIAL] Opening {args.serial_port} @ {args.baud} …")
    mouse = ESP32Mouse(args.serial_port, step=5) # 默认慢速以保证精度
    patch_pyautogui(mouse, cal)

    # ── Build Agent S3 ───────────────────────────────────────────────────────
    # Import after patching so any module-level pyautogui usage is also patched
    from gui_agents.s3.agents.agent_s import AgentS3
    from gui_agents.s3.agents.grounding import OSWorldACI
    from gui_agents.s3.utils.local_env import LocalEnv

    current_platform = platform.system().lower()
    screen_w, screen_h = pyautogui.size()
    scale = min(2400 / screen_w, 2400 / screen_h, 1.0)
    scaled_w = int(screen_w * scale)
    scaled_h = int(screen_h * scale)

    engine_params = {
        "engine_type": args.provider,
        "model":       args.model,
        "base_url":    args.model_url,
        "api_key":     args.model_api_key,
        "temperature": args.model_temperature,
    }
    engine_params_for_grounding = {
        "engine_type":      args.ground_provider,
        "model":            args.ground_model,
        "base_url":         args.ground_url,
        "api_key":          args.ground_api_key,
        "grounding_width":  args.grounding_width,
        "grounding_height": args.grounding_height,
    }

    local_env = LocalEnv() if args.enable_local_env else None
    grounding_agent = OSWorldACI(
        env=local_env,
        platform=current_platform,
        engine_params_for_generation=engine_params,
        engine_params_for_grounding=engine_params_for_grounding,
        width=screen_w,
        height=screen_h,
    )
    agent = AgentS3(
        engine_params,
        grounding_agent,
        platform=current_platform,
        max_trajectory_length=args.max_trajectory_length,
        enable_reflection=args.enable_reflection,
    )

    task = args.task or input("Task: ").strip()
    agent.reset()
    print("Ready. (Agent S3 initialization sequence omitted for brevity)")
    try:
        run_agent_loop(agent, task, scaled_w, scaled_h)
    finally:
        mouse.close()
        print("[ESP32] Serial closed.")


if __name__ == "__main__":
    main()
