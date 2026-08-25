"""Gesture -> keystroke translation.

There is no OS API for "do a three-finger swipe", so every gesture the phone
recognises is expressed as the keyboard shortcut that performs the equivalent
action on the target OS. Keeping that as a plain name->list-of-keys map means
retargeting to Linux or macOS is a config.json edit, not a code change.

This module is importable without pynput installed: key names stay strings until
something actually asks to resolve them, so the gesture map can be unit-tested on
a headless box.
"""

from __future__ import annotations

from typing import Any, Iterable

# Aliases accepted in config.json for keys whose pynput name is non-obvious.
# "win" is what a Windows user calls the key pynput knows as Key.cmd.
KEY_ALIASES = {
    "win": "cmd",
    "windows": "cmd",
    "super": "cmd",
    "meta": "cmd",
    "control": "ctrl",
    "option": "alt",
    "escape": "esc",
    "return": "enter",
    "del": "delete",
    "pgup": "page_up",
    "pgdn": "page_down",
}


class UnknownKeyError(ValueError):
    """Raised when a config.json gesture names a key pynput doesn't have."""


def normalise(name: str) -> str:
    return KEY_ALIASES.get(name.strip().lower(), name.strip().lower())


def normalise_combo(combo: Iterable[str]) -> list[str]:
    return [normalise(key) for key in combo]


def load_gesture_map(config: dict[str, Any]) -> dict[str, list[str]]:
    """Read config["gestures"] into a normalised gesture -> key-list map."""
    raw = config.get("gestures") or {}
    out: dict[str, list[str]] = {}
    for gesture, combo in raw.items():
        if isinstance(combo, str):
            # Allow "ctrl+win+left" as well as ["ctrl", "win", "left"].
            combo = combo.split("+")
        if not combo:
            continue
        out[str(gesture)] = normalise_combo(combo)
    return out


def resolve_key(name: str):
    """Turn a normalised key name into something pynput's keyboard can press.

    Single printable characters are passed through as-is; everything else has to
    be a member of pynput.keyboard.Key.
    """
    from pynput.keyboard import Key  # imported lazily: not available headless

    if len(name) == 1:
        return name
    try:
        return getattr(Key, name)
    except AttributeError as exc:
        raise UnknownKeyError(f"unknown key name {name!r} in gesture map") from exc
