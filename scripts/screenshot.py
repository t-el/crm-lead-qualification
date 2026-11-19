"""Capture the dashboard, a lead transcript and the booking page with Playwright (headless) into docs/.

Runs the demo with --keep-alive (simulated clock, mock CRM/SMS), then shoots:
  docs/dashboard.png     leads, stages, scores, next follow-up, CRM ids
  docs/lead-detail.png   the missed-call text-back conversation + follow-up jobs
  docs/booking-page.png  the signed booking link a qualified lead receives

    pip install playwright && playwright install chromium   # or set CHROME_PATH to a local Chrome
    python scripts/screenshot.py
"""

import os
import re
import signal
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
PORT = os.getenv("SHOT_PORT", "8907")


def main():
    env = os.environ | {"PORT": PORT}
    srv = subprocess.Popen(["npx", "tsx", "scripts/demo.ts", "--keep-alive"], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True,
                           start_new_session=True)
    try:
        out = ""
        for line in srv.stdout:
            out += line
            if "KEEP_ALIVE_READY" in line:
                break
        booking = re.search(r"booking page: (\S+)", out).group(1)
        detail = re.search(r"lead detail: (\S+)", out).group(1)
        base = f"http://127.0.0.1:{PORT}"
        with sync_playwright() as p:
            launch = {"headless": True}
            if os.getenv("CHROME_PATH"):
                launch["executable_path"] = os.environ["CHROME_PATH"]
            b = p.chromium.launch(**launch)
            page = b.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=1)
            page.goto(f"{base}/admin")
            page.screenshot(path=str(DOCS / "dashboard.png"), full_page=True)
            page.goto(detail)
            page.screenshot(path=str(DOCS / "lead-detail.png"), full_page=True)
            page.set_viewport_size({"width": 900, "height": 820})
            page.goto(booking)
            page.screenshot(path=str(DOCS / "booking-page.png"), full_page=True)
            b.close()
        print("saved", *(DOCS / f for f in ("dashboard.png", "lead-detail.png", "booking-page.png")))
    finally:
        os.killpg(srv.pid, signal.SIGTERM)   # npx -> tsx -> node: stop the whole group


if __name__ == "__main__":
    main()
