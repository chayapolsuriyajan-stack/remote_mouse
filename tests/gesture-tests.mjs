/*
 * End-to-end check of the phone client's gesture recognition.
 *
 * Starts the server with the dry-run input backend, drives the real page in a
 * mobile Chromium context with synthesised multi-touch (via CDP, which is the
 * only way to deliver more than one finger), then asserts on GET /debug/actions
 * - i.e. on exactly what would have been injected into Windows.
 *
 *   node tests/gesture-tests.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.TEST_PORT || 8099);
const PIN = "424242";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name} ${detail === undefined ? "" : JSON.stringify(detail)}`);
    failures++;
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not come up");
}

async function actions({ clear = true } = {}) {
  const res = await fetch(`${BASE}/debug/actions?clear=${clear}`);
  return (await res.json()).actions;
}

// --- multi-touch helpers ------------------------------------------------
// Playwright's touchscreen API only does single taps, so fingers go in over CDP.
function makeTouch(cdp) {
  const dispatch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })),
    });
  return {
    start: (points) => dispatch("touchStart", points),
    move: (points) => dispatch("touchMove", points),
    end: (points) => dispatch("touchEnd", points),
    // touchEnd with an empty list lifts everything.
    endAll: () => dispatch("touchEnd", []),
  };
}

const settle = (page, ms = 450) => page.waitForTimeout(ms);

async function main() {
  const server = spawn("python3", [path.join(ROOT, "server", "main.py")], {
    env: {
      ...process.env,
      INPUT_BACKEND: "dryrun",
      REMOTE_MOUSE_PIN: PIN,
      REMOTE_MOUSE_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));

  const browser = await chromium.launch();
  try {
    const health = await waitForServer();
    check("server runs the dry-run backend", health.backend === "DryRunBackend", health);

    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`${BASE}/?k=${PIN}`);
    await page.waitForSelector("#status.status--on", { timeout: 10000 });
    check("phone pairs with the PIN from the QR URL", true);
    check("PIN is scrubbed from the address bar", !page.url().includes("k="), page.url());

    const cdp = await context.newCDPSession(page);
    const touch = makeTouch(cdp);
    const pad = await page.locator("#pad").boundingBox();
    const cx = Math.round(pad.x + pad.width / 2);
    const cy = Math.round(pad.y + pad.height / 2);

    await actions();  // drop anything from page load

    // --- 1 finger: tap = left click ------------------------------------
    await touch.start([{ x: cx, y: cy }]);
    await page.waitForTimeout(60);
    await touch.endAll();
    await settle(page);
    let acts = await actions();
    const buttons = acts.filter((a) => a.kind === "button");
    check("tap sends exactly one left press + release",
      buttons.length === 2 && buttons.every((b) => b.button === "left") &&
      buttons[0].pressed === true && buttons[1].pressed === false, acts);
    check("tap does not drag the cursor", !acts.some((a) => a.kind === "move" && (a.dx || a.dy)), acts);

    // --- 1 finger: move -------------------------------------------------
    await touch.start([{ x: cx - 80, y: cy - 80 }]);
    for (let i = 1; i <= 10; i++) {
      await touch.move([{ x: cx - 80 + i * 10, y: cy - 80 + i * 6 }]);
      await page.waitForTimeout(20);
    }
    await touch.endAll();
    await settle(page);
    acts = await actions();
    const moves = acts.filter((a) => a.kind === "move");
    const sum = moves.reduce((a, m) => ({ dx: a.dx + m.dx, dy: a.dy + m.dy }), { dx: 0, dy: 0 });
    check("dragging one finger emits cursor moves", moves.length > 0, acts.length);
    check("cursor follows the finger's direction (right and down)", sum.dx > 0 && sum.dy > 0, sum);
    check("acceleration amplifies a 100x60px swipe", sum.dx > 100 && sum.dy > 60, sum);
    check("a long move is not mistaken for a click", !acts.some((a) => a.kind === "button"), acts);

    // --- 2 fingers: tap = right click -----------------------------------
    await touch.start([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
    await page.waitForTimeout(60);
    await touch.endAll();
    await settle(page);
    acts = await actions();
    check("two-finger tap right-clicks",
      acts.filter((a) => a.kind === "button").every((b) => b.button === "right") &&
      acts.filter((a) => a.kind === "button").length === 2, acts);

    // --- 2 fingers: scroll ----------------------------------------------
    await touch.start([{ x: cx - 30, y: cy - 60 }, { x: cx + 30, y: cy - 60 }]);
    for (let i = 1; i <= 12; i++) {
      const y = cy - 60 + i * 12;
      await touch.move([{ x: cx - 30, y }, { x: cx + 30, y }]);
      await page.waitForTimeout(20);
    }
    await touch.endAll();
    await settle(page);
    acts = await actions();
    const scrolls = acts.filter((a) => a.kind === "scroll");
    const scrollY = scrolls.reduce((a, s) => a + s.dy, 0);
    check("two fingers moving together scroll", scrolls.length > 0, acts);
    check("fingers down scrolls the page down", scrollY < 0, scrollY);
    check("scrolling does not also move the cursor", !acts.some((a) => a.kind === "move"), acts);

    // --- 2 fingers: pinch -----------------------------------------------
    await touch.start([{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
    for (let i = 1; i <= 12; i++) {
      await touch.move([{ x: cx - 30 - i * 10, y: cy }, { x: cx + 30 + i * 10, y: cy }]);
      await page.waitForTimeout(20);
    }
    await touch.endAll();
    await settle(page);
    acts = await actions();
    const zooms = acts.filter((a) => a.kind === "zoom");
    check("spreading two fingers pinch-zooms", zooms.length > 0, acts);
    check("spreading zooms in, not out", zooms.reduce((a, z) => a + z.clicks, 0) > 0, zooms);
    check("pinching is not reported as scrolling", !acts.some((a) => a.kind === "scroll"), acts);

    // --- 3 fingers: swipe ------------------------------------------------
    for (const [dir, dx, keys] of [
      ["left", -1, ["ctrl", "cmd", "left"]],
      ["right", 1, ["ctrl", "cmd", "right"]],
    ]) {
      const xs = [cx - 40, cx, cx + 40];
      await touch.start(xs.map((x, id) => ({ x, y: cy, id })));
      for (let i = 1; i <= 10; i++) {
        await touch.move(xs.map((x, id) => ({ x: x + dx * i * 12, y: cy, id })));
        await page.waitForTimeout(20);
      }
      await touch.endAll();
      await settle(page);
      acts = await actions();
      const combos = acts.filter((a) => a.kind === "combo");
      check(`three-finger swipe ${dir} fires the virtual-desktop shortcut once`,
        combos.length === 1 && JSON.stringify(combos[0].keys) === JSON.stringify(keys), acts);
      check(`three-finger swipe ${dir} does not leak cursor movement`,
        !acts.some((a) => a.kind === "move"), acts);
    }

    // --- 3 fingers up = task view ----------------------------------------
    {
      const xs = [cx - 40, cx, cx + 40];
      await touch.start(xs.map((x, id) => ({ x, y: cy + 80, id })));
      for (let i = 1; i <= 10; i++) {
        await touch.move(xs.map((x, id) => ({ x, y: cy + 80 - i * 12, id })));
        await page.waitForTimeout(20);
      }
      await touch.endAll();
      await settle(page);
      acts = await actions();
      const combos = acts.filter((a) => a.kind === "combo");
      check("three-finger swipe up opens Task View",
        combos.length === 1 && JSON.stringify(combos[0].keys) === JSON.stringify(["cmd", "tab"]), acts);
    }

    // --- tap-then-hold drag ----------------------------------------------
    await touch.start([{ x: cx, y: cy }]);
    await page.waitForTimeout(60);
    await touch.endAll();
    await page.waitForTimeout(80);            // inside DRAG_GAP_MS
    await touch.start([{ x: cx, y: cy }]);
    for (let i = 1; i <= 8; i++) {
      await touch.move([{ x: cx + i * 10, y: cy }]);
      await page.waitForTimeout(20);
    }
    await touch.endAll();
    await settle(page);
    acts = await actions();
    const drag = acts.filter((a) => a.kind === "button");
    const downIdx = acts.findIndex((a) => a.kind === "button" && a.pressed && a.button === "left");
    const upIdx = acts.map((a) => a.kind === "button" && !a.pressed).lastIndexOf(true);
    check("tap-then-hold holds the left button down while moving",
      drag.length === 4 && acts.slice(downIdx, upIdx).some((a) => a.kind === "move"), acts);

    // --- explicit buttons --------------------------------------------------
    await page.locator('[data-button="r"]').dispatchEvent("pointerdown");
    await page.locator('[data-button="r"]').dispatchEvent("pointerup");
    await settle(page, 200);
    acts = await actions();
    check("the Right button sends a right click",
      acts.length === 2 && acts.every((a) => a.button === "right"), acts);

    // --- edge scroll strip -------------------------------------------------
    const edgeX = Math.round(pad.x + pad.width - 16);
    await touch.start([{ x: edgeX, y: cy - 60 }]);
    for (let i = 1; i <= 10; i++) {
      await touch.move([{ x: edgeX, y: cy - 60 + i * 12 }]);
      await page.waitForTimeout(20);
    }
    await touch.endAll();
    await settle(page);
    acts = await actions();
    check("the right-hand strip scrolls with one finger",
      acts.some((a) => a.kind === "scroll") && !acts.some((a) => a.kind === "move"), acts);

    // --- disconnect safety --------------------------------------------------
    await touch.start([{ x: cx, y: cy }]);
    await page.waitForTimeout(700);           // past LONG_PRESS_MS: button is held
    await actions();
    await page.close();                       // phone vanishes mid-drag
    await new Promise((r) => setTimeout(r, 400));
    acts = await actions();
    check("a phone that disappears mid-drag does not leave the button stuck",
      acts.some((a) => a.kind === "button" && a.pressed === false), acts);

    check("no JavaScript errors on the page", pageErrors.length === 0, pageErrors);

    // --- pairing is enforced -------------------------------------------------
    const stranger = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(`${BASE}/?k=000000`);
    await strangerPage.waitForSelector("#pinDialog:not([hidden])", { timeout: 10000 });
    check("a wrong PIN is rejected and prompts for pairing", true);
    await stranger.close();
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }

  console.log();
  if (failures) {
    console.log(`${failures} failing check(s)`);
    process.exit(1);
  }
  console.log("all gesture checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
