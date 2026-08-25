"""Unit tests for the pure-Python parts: gesture map parsing and the input
backend's pointer/scroll/zoom maths. Runs anywhere - no browser, no display.

    python3 tests/test_units.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import config  # noqa: E402
import gestures  # noqa: E402
import input_backend  # noqa: E402

failures = []


def check(name, condition, detail=""):
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        failures.append(name)


def backend():
    return input_backend.DryRunBackend(config.load_config())


print("gesture map")
gmap = gestures.load_gesture_map(config.load_config())
check("windows key alias resolves to pynput's 'cmd'", gmap["swipe3-left"] == ["ctrl", "cmd", "left"], gmap["swipe3-left"])
check("task view mapped", gmap["swipe3-up"] == ["cmd", "tab"], gmap["swipe3-up"])
check("string combos accepted", gestures.load_gesture_map({"gestures": {"x": "Ctrl+Win+Left"}})["x"] == ["ctrl", "cmd", "left"])
check("every configured key is a real pynput key name or single char",
      all(len(k) == 1 or k in {"ctrl", "cmd", "alt", "shift", "tab", "left", "right", "up", "down", "enter", "esc"}
          for combo in gmap.values() for k in combo))

print("pointer")
b = backend()
b.move(10, 0)
check("move is amplified, never inverted", b.actions[0]["dx"] > 10 and b.actions[0]["dy"] == 0, b.actions[0])
b = backend()
b.move(1, 0)
slow = b.actions[0]["dx"]
b = backend()
b.move(40, 0)
fast = b.actions[0]["dx"]
check("acceleration: fast flicks travel more than 40x a slow nudge", fast > slow * 40, f"slow={slow} fast={fast}")
b = backend()
for _ in range(5):
    b.move(0.3, 0)
check("sub-pixel moves accumulate instead of vanishing", any(a["dx"] for a in b.actions), b.actions)
b = backend()
b.move(0, 0)
check("a zero move emits nothing", b.actions == [])

print("buttons")
b = backend()
b.button("l", True)
b.button("l", True)
b.button("l", False)
check("duplicate press is ignored", len(b.actions) == 2, b.actions)
b = backend()
b.button("l", True)
b.release_all()
check("release_all lifts a held button", b.actions[-1] == {"kind": "button", "button": "left", "pressed": False}, b.actions)
b = backend()
b.release_all()
check("release_all is a no-op when nothing is held", b.actions == [])
b = backend()
b.button("z", True)
check("unknown button code ignored", b.actions == [])

print("scroll and zoom")
b = backend()
b.scroll(0, 90)
check("finger down scrolls content down (Windows convention)", b.actions[0]["dy"] < 0, b.actions)
cfg = config.load_config()
cfg["scroll"]["invert"] = True
b = input_backend.DryRunBackend(cfg)
b.scroll(0, 90)
check("invert gives natural scrolling", b.actions[0]["dy"] > 0, b.actions)
b = backend()
for _ in range(10):
    b.scroll(0, 5)
check("small scrolls accumulate into a click", any(a["dy"] for a in b.actions), b.actions)
b = backend()
b.zoom(120)
check("spreading fingers zooms in", b.actions[0]["clicks"] > 0, b.actions)
b = backend()
b.zoom(-120)
check("pinching in zooms out", b.actions[0]["clicks"] < 0, b.actions)

print("gestures")
b = backend()
check("known gesture applies", b.gesture("swipe3-left") is True)
check("known gesture sends the mapped combo", b.actions[-1] == {"kind": "combo", "keys": ["ctrl", "cmd", "left"]}, b.actions[-1])
check("unknown gesture reports back", b.gesture("swipe9-left") is False)

print()
if failures:
    print(f"{len(failures)} failing check(s): {', '.join(failures)}")
    sys.exit(1)
print("all unit checks passed")
