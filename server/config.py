"""Configuration loading for the remote-mouse server.

Everything the user is likely to want to tune (pointer feel, scroll speed, the
gesture -> keystroke map, the pairing PIN) lives in config.json next to the repo
root so it can be edited without touching code. Missing file or missing keys fall
back to the defaults below rather than erroring, so a fresh checkout just runs.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("REMOTE_MOUSE_CONFIG", REPO_ROOT / "config.json"))

DEFAULTS: dict[str, Any] = {
    "host": "0.0.0.0",
    "port": 8090,
    # Empty means "generate a fresh random PIN on every start".
    "pin": "",
    "pointer": {"base": 1.5, "accel": 0.06, "speedCap": 60.0},
    "scroll": {"divisor": 45.0, "invert": False},
    "zoom": {"divisor": 60.0},
    "gestures": {
        "swipe3-left": ["ctrl", "win", "left"],
        "swipe3-right": ["ctrl", "win", "right"],
        "swipe3-up": ["win", "tab"],
        "swipe3-down": ["win", "d"],
        "swipe4-left": ["alt", "tab"],
        "swipe4-right": ["alt", "shift", "tab"],
    },
}


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """One-level-deep merge: nested dicts are merged, everything else replaced."""
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = {**out[key], **value}
        else:
            out[key] = value
    return out


def load_config(path: Path | None = None) -> dict[str, Any]:
    path = path or CONFIG_PATH
    config = dict(DEFAULTS)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = _merge(config, json.load(handle))
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[config] ignoring unreadable {path}: {exc}")

    # Env overrides win over the file, so run.ps1 / CI can steer without edits.
    if os.environ.get("REMOTE_MOUSE_PORT"):
        config["port"] = int(os.environ["REMOTE_MOUSE_PORT"])
    if os.environ.get("REMOTE_MOUSE_PIN") is not None:
        config["pin"] = os.environ["REMOTE_MOUSE_PIN"]

    if not str(config.get("pin", "")).strip():
        config["pin"] = f"{random.randrange(0, 1_000_000):06d}"
    config["pin"] = str(config["pin"]).strip()
    return config
