"""Injection of pointer/keyboard events into the host OS.

Two implementations behind one interface:

* PynputBackend - the real thing, drives the OS cursor via pynput.
* DryRunBackend - records what it *would* have done. Used by the test suite (and
  by anyone poking at the protocol on a machine with no display), so the whole
  client/protocol path can be exercised on a headless box.

All pointer smoothing lives here rather than on the phone: the client sends raw
finger deltas, the PC decides how far the cursor actually travels. That keeps the
feel tunable from config.json with no page reload.
"""

from __future__ import annotations

import math
import os
from typing import Any

import gestures

BUTTONS = {"l": "left", "r": "right", "m": "middle"}


class _AcceleratedPointer:
    """Shared pointer maths: acceleration curve + sub-pixel accumulation.

    A batched move carries the finger travel for one animation frame, so its
    magnitude is a decent proxy for speed. Slow drags get close to 1:1 for
    precision; fast flicks get multiplied so the cursor can cross a 4K screen in
    one swipe. Fractional leftovers are carried over instead of truncated -
    without that, slow movement below one pixel per frame would never move the
    cursor at all.
    """

    def __init__(self, pointer_cfg: dict[str, Any]) -> None:
        self.base = float(pointer_cfg.get("base", 1.5))
        self.accel = float(pointer_cfg.get("accel", 0.06))
        self.speed_cap = float(pointer_cfg.get("speedCap", 60.0))
        self._rem_x = 0.0
        self._rem_y = 0.0

    def step(self, dx: float, dy: float) -> tuple[int, int]:
        speed = min(math.hypot(dx, dy), self.speed_cap)
        factor = self.base * (1.0 + self.accel * speed)
        x = dx * factor + self._rem_x
        y = dy * factor + self._rem_y
        ix, iy = int(x), int(y)
        self._rem_x = x - ix
        self._rem_y = y - iy
        return ix, iy


class _Accumulator:
    """Carries fractional scroll/zoom clicks across messages, like the pointer."""

    def __init__(self) -> None:
        self._rem = 0.0

    def step(self, value: float) -> int:
        total = value + self._rem
        clicks = int(total)
        self._rem = total - clicks
        return clicks


class BaseBackend:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.pointer = _AcceleratedPointer(config.get("pointer", {}))
        scroll_cfg = config.get("scroll", {})
        self.scroll_divisor = float(scroll_cfg.get("divisor", 45.0)) or 45.0
        # Windows' own convention is "finger down => content moves up"; set
        # invert to get macOS-style natural scrolling instead.
        self.scroll_sign = 1.0 if scroll_cfg.get("invert") else -1.0
        self.zoom_divisor = float(config.get("zoom", {}).get("divisor", 60.0)) or 60.0
        self.gesture_map = gestures.load_gesture_map(config)
        self._pressed: set[str] = set()
        self._scroll_x = _Accumulator()
        self._scroll_y = _Accumulator()
        self._zoom = _Accumulator()

    # --- subclasses implement these -------------------------------------
    def _move(self, dx: int, dy: int) -> None: ...
    def _button(self, button: str, pressed: bool) -> None: ...
    def _scroll(self, dx: int, dy: int) -> None: ...
    def _zoom_scroll(self, clicks: int) -> None: ...
    def _combo(self, keys: list[str]) -> None: ...

    # --- protocol surface used by main.py --------------------------------
    def move(self, dx: float, dy: float) -> None:
        ix, iy = self.pointer.step(dx, dy)
        if ix or iy:
            self._move(ix, iy)

    def button(self, code: str, pressed: bool) -> None:
        name = BUTTONS.get(code)
        if not name:
            return
        # Ignore redundant transitions so a duplicated packet can't double-click,
        # and so release_all() is a no-op for buttons that were never held.
        if pressed == (name in self._pressed):
            return
        if pressed:
            self._pressed.add(name)
        else:
            self._pressed.discard(name)
        self._button(name, pressed)

    def scroll(self, dx: float, dy: float) -> None:
        cx = self._scroll_x.step(dx / self.scroll_divisor)
        cy = self._scroll_y.step(self.scroll_sign * dy / self.scroll_divisor)
        if cx or cy:
            self._scroll(cx, cy)

    def zoom(self, delta: float) -> None:
        clicks = self._zoom.step(delta / self.zoom_divisor)
        if clicks:
            self._zoom_scroll(clicks)

    def gesture(self, name: str) -> bool:
        keys = self.gesture_map.get(name)
        if not keys:
            return False
        self._combo(keys)
        return True

    def release_all(self) -> None:
        """Called when a phone disconnects, so a dropped Wi-Fi packet mid-drag
        can't leave a mouse button stuck down."""
        for code in BUTTONS:
            self.button(code, False)


class DryRunBackend(BaseBackend):
    """Records actions instead of performing them."""

    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        self.actions: list[dict[str, Any]] = []

    def _record(self, **action: Any) -> None:
        self.actions.append(action)

    def _move(self, dx: int, dy: int) -> None:
        self._record(kind="move", dx=dx, dy=dy)

    def _button(self, button: str, pressed: bool) -> None:
        self._record(kind="button", button=button, pressed=pressed)

    def _scroll(self, dx: int, dy: int) -> None:
        self._record(kind="scroll", dx=dx, dy=dy)

    def _zoom_scroll(self, clicks: int) -> None:
        self._record(kind="zoom", clicks=clicks)

    def _combo(self, keys: list[str]) -> None:
        self._record(kind="combo", keys=list(keys))


class PynputBackend(BaseBackend):
    def __init__(self, config: dict[str, Any]) -> None:
        super().__init__(config)
        from pynput.keyboard import Controller as KeyboardController
        from pynput.mouse import Button, Controller as MouseController

        self._Button = Button
        self._mouse = MouseController()
        self._keyboard = KeyboardController()
        # Fail loudly at startup rather than on the first swipe if config.json
        # names a key that doesn't exist.
        for name, keys in self.gesture_map.items():
            for key in keys:
                gestures.resolve_key(key)

    def _move(self, dx: int, dy: int) -> None:
        self._mouse.move(dx, dy)

    def _button(self, button: str, pressed: bool) -> None:
        target = getattr(self._Button, button)
        if pressed:
            self._mouse.press(target)
        else:
            self._mouse.release(target)

    def _scroll(self, dx: int, dy: int) -> None:
        self._mouse.scroll(dx, dy)

    def _zoom_scroll(self, clicks: int) -> None:
        from pynput.keyboard import Key

        with self._keyboard.pressed(Key.ctrl):
            self._mouse.scroll(0, clicks)

    def _combo(self, keys: list[str]) -> None:
        resolved = [gestures.resolve_key(key) for key in keys]
        *modifiers, final = resolved
        for modifier in modifiers:
            self._keyboard.press(modifier)
        try:
            self._keyboard.press(final)
            self._keyboard.release(final)
        finally:
            for modifier in reversed(modifiers):
                self._keyboard.release(modifier)


def make_backend(config: dict[str, Any]) -> BaseBackend:
    """Pick a backend. INPUT_BACKEND=dryrun forces the recording one; otherwise
    the real backend is used, falling back to dry-run if pynput can't attach to a
    display (which is exactly the case in CI and in this container)."""
    choice = os.environ.get("INPUT_BACKEND", "auto").lower()
    if choice == "dryrun":
        return DryRunBackend(config)
    try:
        return PynputBackend(config)
    except Exception as exc:  # ImportError, or no display / no X server
        if choice == "pynput":
            raise
        print(f"[input] pynput unavailable ({exc}); falling back to dry-run backend")
        return DryRunBackend(config)
