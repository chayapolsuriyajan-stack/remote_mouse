/*
 * Phone-side trackpad.
 *
 * Recognises finger gestures with Pointer Events and streams them to the PC as
 * compact JSON over one WebSocket. Deliberately raw: the phone reports finger
 * travel in CSS pixels and lets the server apply acceleration, so the feel is
 * tunable in config.json without touching this file.
 */
(function () {
  "use strict";

  // --- tuning ---------------------------------------------------------
  var TAP_MS = 250;        // press shorter than this can be a tap
  var TAP_SLOP = 12;       // ...if no finger travelled further than this (px)
  var DRAG_GAP_MS = 320;   // tap-then-press within this window starts a drag
  var LONG_PRESS_MS = 550; // or just hold still this long
  var AXIS_LOCK = 10;      // two-finger travel before committing to scroll/pinch
  var SWIPE_MIN = 55;      // multi-finger centroid travel that counts as a swipe
  var EDGE_WIDTH = 34;     // right-hand one-finger scroll strip, matches CSS

  // --- elements -------------------------------------------------------
  var pad = document.getElementById("pad");
  var statusEl = document.getElementById("status");
  var pinDialog = document.getElementById("pinDialog");
  var pinForm = document.getElementById("pinForm");
  var pinInput = document.getElementById("pinInput");

  // --- pairing --------------------------------------------------------
  var params = new URLSearchParams(location.search);
  var pin = params.get("k") || localStorage.getItem("rm_pin") || "";
  if (params.get("k")) {
    localStorage.setItem("rm_pin", params.get("k"));
    // Drop the PIN from the address bar once it is stored, so it does not ride
    // along in screenshots or shared links.
    history.replaceState(null, "", location.pathname);
  }

  // --- connection -----------------------------------------------------
  var ws = null;
  var connected = false;
  var retryDelay = 500;
  var pingTimer = null;

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = "status " + (ok ? "status--on" : "status--off");
  }

  function connect() {
    if (!pin) {
      pinDialog.hidden = false;
      setStatus("Not paired", false);
      return;
    }
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?k=" + encodeURIComponent(pin));

    ws.onopen = function () {
      connected = true;
      retryDelay = 500;
      setStatus("Connected", true);
      pinDialog.hidden = true;
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { send({ t: "ping" }); }, 10000);
    };

    ws.onclose = function (event) {
      connected = false;
      clearInterval(pingTimer);
      if (event.code === 1008) {
        // The server rejected the PIN: stop retrying and ask for a new one
        // rather than hammering it in a loop.
        localStorage.removeItem("rm_pin");
        pin = "";
        setStatus("Wrong PIN", false);
        pinDialog.hidden = false;
        return;
      }
      setStatus("Reconnecting", false);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    };

    ws.onerror = function () { setStatus("Offline", false); };
  }

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  pinForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = pinInput.value.trim();
    if (!value) return;
    pin = value;
    localStorage.setItem("rm_pin", pin);
    pinDialog.hidden = true;
    setStatus("Connecting", false);
    connect();
  });

  // --- outbound batching ----------------------------------------------
  // Touch events fire far more often than is useful to transmit; coalescing
  // into one message per animation frame keeps the socket at ~60 msg/s no
  // matter how fast the digitiser samples.
  var pendMoveX = 0, pendMoveY = 0;
  var pendScrollX = 0, pendScrollY = 0;
  var pendZoom = 0;
  var flushQueued = false;

  function round2(value) { return Math.round(value * 100) / 100; }

  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flush);
  }

  function flush() {
    flushQueued = false;
    if (pendMoveX || pendMoveY) {
      send({ t: "m", dx: round2(pendMoveX), dy: round2(pendMoveY) });
      pendMoveX = pendMoveY = 0;
    }
    if (pendScrollX || pendScrollY) {
      send({ t: "s", dx: round2(pendScrollX), dy: round2(pendScrollY) });
      pendScrollX = pendScrollY = 0;
    }
    if (pendZoom) {
      send({ t: "z", d: round2(pendZoom) });
      pendZoom = 0;
    }
  }

  function buttonDown(code) { send({ t: "d", b: code, s: "down" }); }
  function buttonUp(code) { send({ t: "d", b: code, s: "up" }); }

  function click(code) {
    buttonDown(code);
    buttonUp(code);
    buzz(8);
  }

  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
  }

  // --- gesture recognition --------------------------------------------
  var pointers = new Map();   // pointerId -> {x, y, x0, y0}
  var seq = null;             // state for the current touch sequence
  var lastTapEnd = 0;
  var longPressTimer = null;

  // --- dot-grid touch highlight -----------------------------------------
  // Replicates the mouse.ly trackpad: a dim grid of dots that brightens into
  // a soft glowing circle under each finger. Purely visual - drawn on a
  // canvas behind the pad's own contents, with pointer-events left on #pad,
  // so it can never intercept a touch the gesture recognizer needs.
  var dotsCanvas = document.getElementById("padDots");
  var dotsCtx = dotsCanvas ? dotsCanvas.getContext("2d") : null;
  var DOT_SPACING = 24;     // px between dot centers
  var DOT_R0 = 1.9, DOT_R1 = 4.6;      // idle / fully-lit radius
  var DOT_A0 = 0.34, DOT_A1 = 0.95;    // idle / fully-lit opacity
  var GLOW_RADIUS = 120;    // px: how far the highlight reaches from a finger
  var FADE_MS = 220;        // how long the glow lingers after the last finger lifts
  var DIM_RGB = [44, 56, 96];      // matches --line
  var LIT_RGB = [74, 222, 128];    // matches --accent
  var padRect = { left: 0, top: 0, width: 0, height: 0 };
  var dotsLoopRunning = false;
  var fadePoints = [];
  var fadeStart = 0;

  function resizeDotsCanvas() {
    if (!dotsCanvas) return;
    padRect = pad.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    dotsCanvas.width = Math.max(1, Math.round(padRect.width * dpr));
    dotsCanvas.height = Math.max(1, Math.round(padRect.height * dpr));
    dotsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderDots();
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function renderDots() {
    if (!dotsCtx || !padRect.width) return;
    var w = padRect.width, h = padRect.height;
    dotsCtx.clearRect(0, 0, w, h);

    var touches = [];
    if (pointers.size > 0) {
      pointers.forEach(function (p) {
        touches.push({ x: p.x - padRect.left, y: p.y - padRect.top, w: 1 });
      });
    } else if (fadePoints.length && performance.now() - fadeStart < FADE_MS) {
      var remaining = 1 - (performance.now() - fadeStart) / FADE_MS;
      fadePoints.forEach(function (p) { touches.push({ x: p.x, y: p.y, w: remaining }); });
    }

    for (var gy = DOT_SPACING / 2; gy < h; gy += DOT_SPACING) {
      for (var gx = DOT_SPACING / 2; gx < w; gx += DOT_SPACING) {
        var influence = 0;
        for (var i = 0; i < touches.length; i++) {
          var dx = gx - touches[i].x, dy = gy - touches[i].y;
          var t = 1 - Math.sqrt(dx * dx + dy * dy) / GLOW_RADIUS;
          if (t > 0) {
            t = smoothstep(t) * touches[i].w;
            if (t > influence) influence = t;
          }
        }
        var radius = DOT_R0 + (DOT_R1 - DOT_R0) * influence;
        var alpha = DOT_A0 + (DOT_A1 - DOT_A0) * influence;
        dotsCtx.beginPath();
        dotsCtx.arc(gx, gy, radius, 0, Math.PI * 2);
        dotsCtx.fillStyle = "rgba(" +
          Math.round(DIM_RGB[0] + (LIT_RGB[0] - DIM_RGB[0]) * influence) + "," +
          Math.round(DIM_RGB[1] + (LIT_RGB[1] - DIM_RGB[1]) * influence) + "," +
          Math.round(DIM_RGB[2] + (LIT_RGB[2] - DIM_RGB[2]) * influence) + "," + alpha + ")";
        if (influence > 0.08) {
          dotsCtx.shadowColor = "rgba(74,222,128," + influence + ")";
          dotsCtx.shadowBlur = 9 * influence;
        } else {
          dotsCtx.shadowBlur = 0;
        }
        dotsCtx.fill();
      }
    }
  }

  function dotsTick() {
    renderDots();
    if (pointers.size > 0 || performance.now() - fadeStart < FADE_MS) {
      requestAnimationFrame(dotsTick);
    } else {
      dotsLoopRunning = false;
    }
  }

  function ensureDotsLoop() {
    if (dotsLoopRunning || !dotsCtx) return;
    dotsLoopRunning = true;
    requestAnimationFrame(dotsTick);
  }

  // Called with the last finger's client coordinates right as it lifts, so the
  // glow has somewhere to fade from instead of just vanishing.
  function startFade(clientX, clientY) {
    fadePoints = [{ x: clientX - padRect.left, y: clientY - padRect.top }];
    fadeStart = performance.now();
  }

  window.addEventListener("resize", resizeDotsCanvas);
  window.addEventListener("orientationchange", resizeDotsCanvas);

  function newSequence() {
    return {
      maxPointers: 0,
      startTime: performance.now(),
      travel: 0,        // furthest any finger strayed from where it landed
      mode: null,       // move | edge | scroll | pinch | swipe
      dragging: false,
      swiped: false,
      centroid: null,
      spread: 0,
      // Accumulators used only while deciding between scroll and pinch.
      accX: 0,
      accY: 0,
      accSpread: 0
    };
  }

  function centroidOf() {
    var x = 0, y = 0;
    pointers.forEach(function (p) { x += p.x; y += p.y; });
    var n = pointers.size || 1;
    return { x: x / n, y: y / n };
  }

  function spreadOf() {
    var list = [];
    pointers.forEach(function (p) { list.push(p); });
    if (list.length < 2) return 0;
    return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  }

  // Re-baseline whenever the number of fingers changes: otherwise adding or
  // lifting a finger jumps the centroid and the cursor leaps across the screen.
  function rebase() {
    seq.centroid = centroidOf();
    seq.spread = spreadOf();
    seq.accX = seq.accY = seq.accSpread = 0;
  }

  function trackTravel(p) {
    seq.travel = Math.max(seq.travel, Math.hypot(p.x - p.x0, p.y - p.y0));
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  pad.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    pad.classList.add("pad--active");

    if (pointers.size === 0) seq = newSequence();
    var rect = pad.getBoundingClientRect();
    pointers.set(event.pointerId, {
      x: event.clientX, y: event.clientY,
      x0: event.clientX, y0: event.clientY
    });
    seq.maxPointers = Math.max(seq.maxPointers, pointers.size);
    rebase();
    ensureDotsLoop();

    if (pointers.size === 1) {
      var inEdge = event.clientX >= rect.right - EDGE_WIDTH;
      seq.mode = inEdge ? "edge" : "move";
      if (!inEdge && performance.now() - lastTapEnd < DRAG_GAP_MS) {
        // tap, then press again straight away = pick up and drag
        seq.dragging = true;
        buttonDown("l");
        buzz(12);
      } else if (!inEdge) {
        longPressTimer = setTimeout(function () {
          if (pointers.size === 1 && seq && !seq.dragging && seq.travel < TAP_SLOP) {
            seq.dragging = true;
            buttonDown("l");
            buzz(18);
          }
        }, LONG_PRESS_MS);
      }
    } else {
      cancelLongPress();
      seq.mode = null;  // decided on first movement below
    }
  });

  pad.addEventListener("pointermove", function (event) {
    var p = pointers.get(event.pointerId);
    if (!p) return;
    event.preventDefault();

    // Coalesced events give the full sub-frame path on browsers that batch
    // touchmoves, so fast flicks keep their true distance.
    var samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
    if (!samples.length) samples = [event];
    var last = samples[samples.length - 1];

    var count = pointers.size;
    if (count === 1) {
      var dx = 0, dy = 0;
      for (var i = 0; i < samples.length; i++) {
        dx += samples[i].clientX - p.x;
        dy += samples[i].clientY - p.y;
        p.x = samples[i].clientX;
        p.y = samples[i].clientY;
      }
      trackTravel(p);
      if (seq.travel >= TAP_SLOP) cancelLongPress();
      if (seq.mode === "edge") {
        pendScrollY += dy;
      } else {
        pendMoveX += dx;
        pendMoveY += dy;
      }
      queueFlush();
      return;
    }

    p.x = last.clientX;
    p.y = last.clientY;
    trackTravel(p);
    cancelLongPress();

    var centroid = centroidOf();
    var cdx = centroid.x - seq.centroid.x;
    var cdy = centroid.y - seq.centroid.y;

    if (count === 2) {
      var spread = spreadOf();
      var dspread = spread - seq.spread;
      seq.centroid = centroid;
      seq.spread = spread;

      if (!seq.mode) {
        // Each finger arrives in its own pointermove, so a single per-event
        // delta is only ever half the real gesture. Accumulate until one of the
        // two candidates clearly wins, then replay what was banked so the
        // gesture doesn't lose its first few pixels.
        seq.accX += cdx;
        seq.accY += cdy;
        seq.accSpread += dspread;
        var slid = Math.hypot(seq.accX, seq.accY);
        var pinched = Math.abs(seq.accSpread);
        if (Math.max(slid, pinched) < AXIS_LOCK) return;
        if (pinched > slid) {
          seq.mode = "pinch";
          pendZoom += seq.accSpread;
        } else {
          seq.mode = "scroll";
          pendScrollX += seq.accX;
          pendScrollY += seq.accY;
        }
        seq.accX = seq.accY = seq.accSpread = 0;
      } else if (seq.mode === "pinch") {
        pendZoom += dspread;
      } else if (seq.mode === "scroll") {
        pendScrollX += cdx;
        pendScrollY += cdy;
      }
      queueFlush();
      return;
    }

    // Three or more fingers: one discrete swipe per sequence.
    if (!seq.swiped) {
      var totalX = centroid.x - seq.centroid.x;
      var totalY = centroid.y - seq.centroid.y;
      if (Math.hypot(totalX, totalY) >= SWIPE_MIN) {
        var horizontal = Math.abs(totalX) > Math.abs(totalY);
        var direction = horizontal
          ? (totalX > 0 ? "right" : "left")
          : (totalY > 0 ? "down" : "up");
        seq.swiped = true;
        seq.mode = "swipe";
        send({ t: "g", g: "swipe" + Math.min(count, 4) + "-" + direction });
        buzz(20);
      }
    }
  });

  function endPointer(event) {
    var p = pointers.get(event.pointerId);
    if (!p) return;
    event.preventDefault();
    pointers.delete(event.pointerId);
    if (pad.hasPointerCapture && pad.hasPointerCapture(event.pointerId)) {
      pad.releasePointerCapture(event.pointerId);
    }

    if (pointers.size > 0) {
      rebase();   // fingers remain: re-baseline so the cursor doesn't jump
      return;
    }
    startFade(p.x, p.y);   // let the highlight glow linger and fade, not snap off

    cancelLongPress();
    pad.classList.remove("pad--active");
    flush();

    var duration = performance.now() - seq.startTime;
    if (seq.dragging) {
      buttonUp("l");
    } else if (!seq.swiped && duration < TAP_MS && seq.travel < TAP_SLOP) {
      if (seq.maxPointers === 1) {
        click("l");
        lastTapEnd = performance.now();   // arm tap-then-hold dragging
      } else if (seq.maxPointers === 2) {
        click("r");
      } else if (seq.maxPointers === 3) {
        click("m");
      }
    }
    seq = null;
  }

  pad.addEventListener("pointerup", endPointer);
  pad.addEventListener("pointercancel", function (event) {
    // A cancelled pointer (system gesture, call banner) must not leave a button
    // held down on the PC.
    if (seq && seq.dragging && pointers.size === 1) buttonUp("l");
    if (seq) seq.dragging = false;
    endPointer(event);
  });

  // The pad is a control surface; suppress the browser's own context menu and
  // any residual double-tap zoom.
  pad.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  document.addEventListener("dblclick", function (e) { e.preventDefault(); });

  // --- explicit buttons -------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll("[data-button]"), function (btn) {
    var code = btn.getAttribute("data-button");
    btn.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      btn.classList.add("btn--down");
      buttonDown(code);
      buzz(8);
    });
    var release = function (event) {
      event.preventDefault();
      btn.classList.remove("btn--down");
      buttonUp(code);
    };
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", function () {
      if (btn.classList.contains("btn--down")) {
        btn.classList.remove("btn--down");
        buttonUp(code);
      }
    });
  });

  // --- housekeeping -----------------------------------------------------
  // Stop the screen dimming mid-session; re-request it after the phone wakes.
  var wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
    }).catch(function () { /* denied or unsupported: not fatal */ });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      requestWakeLock();
      if (!connected && pin) connect();
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* offline install is optional */ });
  }

  resizeDotsCanvas();
  requestWakeLock();
  connect();

  // Exposed for the automated gesture tests, which assert on what the page
  // decided to send rather than on what the OS did.
  window.__remoteMouse = {
    send: send,
    flush: flush,
    state: function () { return { connected: connected, pointers: pointers.size }; }
  };
})();
