# remote-mouse

Turn your phone into a trackpad for your PC. Run one command on the computer,
scan the QR code it prints, and the whole phone screen becomes a touchpad —
cursor movement, clicks, drag, two-finger scroll, pinch-to-zoom and three-finger
swipes for switching virtual desktops.

No app to install: the phone side is a web page served by the PC itself, over
your local Wi-Fi. Nothing leaves your network and there is no cloud service in
the path.

The trackpad surface is a dim dot-matrix grid, mouse.ly-style: it brightens
into a soft glowing circle under each finger you touch down, so a two- or
three-finger gesture is visible as multiple glowing circles right where your
fingers actually are, and lingers for a moment as it lifts instead of
snapping off.

```
phone browser ──WebSocket(JSON)──► FastAPI on your PC ──pynput──► real cursor
```

## Setup (Windows)

```powershell
git clone https://github.com/chayapolsuriyajan-stack/remote_mouse
cd remote_mouse
.\run.ps1 -AddFirewallRule    # elevated prompt, first time only
```

Later runs are just `.\run.ps1`. The first run builds a `.venv` and installs
dependencies; after that startup is instant.

You'll see something like:

```
  remote-mouse is running. Open this on your phone:

    http://192.168.1.24:8090/?k=204815

  pairing PIN: 204815
  <QR code>
```

Scan the QR with the phone's camera (or type the URL). The page pairs itself
using the PIN in the link and remembers it, so later you can just open the
bookmark. Add it to your home screen and it launches full-screen like an app.

Phone and PC must be on the **same network**, and many home routers isolate
guest Wi-Fi from the main network — use the same SSID for both.

### Linux / macOS

`./run.sh` instead. Everything works, but the three-finger gestures send Windows
shortcuts by default; edit the `gestures` map in `config.json` (see below) for
your desktop. On macOS you must also grant Accessibility permission to the
terminal running the server, or the cursor will not move.

## Using it

| gesture | what it does |
|---|---|
| one finger | move the cursor |
| tap | left click |
| two-finger tap | right click |
| three-finger tap | middle click |
| tap, then press and move | drag (hold-to-drag also works: press and wait) |
| two fingers, move | scroll |
| two fingers, pinch/spread | zoom out / in |
| one finger on the right-hand strip | scroll, one-handed |
| three fingers left / right | previous / next virtual desktop |
| three fingers up / down | Task View / show desktop |
| four fingers left / right | Alt-Tab forwards / backwards |
| Left / Middle / Right buttons | held for as long as you hold the button |

## Tuning

Everything adjustable lives in `config.json`, read at startup:

| key | meaning |
|---|---|
| `port` | HTTP/WebSocket port (default 8090) |
| `pin` | fixed pairing PIN; leave `""` to get a fresh random one each run |
| `pointer.base` | overall cursor speed |
| `pointer.accel` | how much faster a quick flick travels than a slow drag; `0` disables acceleration |
| `pointer.speedCap` | ceiling on the acceleration curve |
| `scroll.divisor` | larger = slower scrolling |
| `scroll.invert` | `true` for macOS-style natural scrolling |
| `zoom.divisor` | larger = slower pinch-zoom |
| `gestures` | gesture name → key combo, e.g. `"swipe3-left": ["ctrl", "win", "left"]` |

Gesture names are `swipe{3,4}-{left,right,up,down}`. Key names are pynput's, plus
friendly aliases (`win`, `super`, `escape`, ...). A combo may also be written as
a string: `"ctrl+win+left"`. Remove a gesture to disable it.

Cursor feel is applied on the PC, so changes take effect on server restart
without touching the phone.

## Security

The server binds to your LAN, so anyone who can reach the port could otherwise
move your mouse. Two things prevent that:

- a **pairing PIN**, required on the WebSocket; a wrong PIN is rejected and the
  page asks for a new one rather than retrying;
- **no remote code path** — the protocol carries pointer deltas, button states
  and gesture *names* only. A gesture can only trigger a key combo you yourself
  put in `config.json`.

Set a fixed `pin` in `config.json` if you'd rather not re-scan after each
restart. Treat that as a password: anyone with it and network access controls
the machine.

## Troubleshooting

**The page won't load on the phone.** The firewall rule is the usual cause — run
`.\run.ps1 -AddFirewallRule` from an elevated PowerShell. Also confirm the phone
is on the same Wi-Fi, and try the other addresses if the banner printed several.

**"Reconnecting" and it never connects.** The page loaded from cache but the
server isn't running, or the PC went to sleep. Restart the server; the phone
reconnects on its own.

**"Wrong PIN".** The PIN is regenerated each run unless you fix it in
`config.json`. Re-scan the QR, or type the new PIN.

**The cursor moves but nothing clicks (macOS).** Accessibility permission, as
above.

**The cursor is jumpy or laggy.** Prefer the 5GHz band, and check the phone
isn't power-saving its Wi-Fi radio. The `pointer.*` settings tune the feel.

**The cursor drifts when I start a two-finger scroll.** Expected in small
amounts: until the second finger lands, one finger means "move".

## Development

```bash
python3 tests/test_units.py     # pointer maths and gesture-map parsing
npm install && npm test         # drives the real page in Chromium with synthetic multi-touch
```

The browser tests run the server with `INPUT_BACKEND=dryrun`, which records
what *would* have been injected and exposes it at `GET /debug/actions` instead of
touching the real cursor — so the whole gesture pipeline is testable headlessly,
on a machine with no display. That env var is also handy by hand: run the server
with it and watch the JSON to see how a gesture is being interpreted.

### Layout

```
server/main.py           FastAPI app: serves the page, owns the WebSocket
server/input_backend.py  pynput injection + the dry-run recorder; pointer maths
server/gestures.py       gesture name -> key combo, with key-name aliases
server/config.py         config.json loading, defaults, env overrides
web/                     the phone page (vanilla JS, no build step)
```

### Wire protocol

The phone sends one JSON message per animation frame at most; the PC applies
acceleration and injects.

| message | meaning |
|---|---|
| `{"t":"m","dx":..,"dy":..}` | relative cursor move, in finger pixels |
| `{"t":"d","b":"l\|r\|m","s":"down\|up"}` | button state |
| `{"t":"s","dx":..,"dy":..}` | scroll |
| `{"t":"z","d":..}` | pinch delta |
| `{"t":"g","g":"swipe3-left"}` | discrete gesture |
| `{"t":"ping"}` → `{"t":"pong"}` | liveness |

Adding keyboard support later is a new message type plus a UI panel; nothing in
the transport needs to change.
