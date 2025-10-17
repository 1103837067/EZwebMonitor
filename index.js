/**
 * FPS & Memory Overlay
 * Version: 1.0.0
 * Author: you
 *
 * Load via console (jsDelivr CDNs GitHub):
 *   import("https://cdn.jsdelivr.net/gh/<yourname>/perf-monitor/index.js");
 *
 * Features:
 * - FPS + Memory dual charts (dark overlay, draggable header)
 * - R/S toggle: R = realtime (per-frame), S = 1 Hz (per-second)
 * - Window toggle: 5s → 10s → 15s (only collects the selected window)
 * - Dynamic Y range (±10% padding) with smooth animation
 * - Per-panel stats: avg / max / min + grid tick labels
 * - Record to CSV: “开始” to start, “结束” to stop & download
 * - Hover tooltips on controls (X has no tooltip)
 * - Clean removal on close (no leftover timers/raf/DOM/global refs)
 */

(function installFPSMemoryOverlay(){
  // If an instance exists, remove it first to ensure a clean load
  if (window.__fpsOverlayInstalled) {
    try { window.__perfOverlay?.remove?.(); } catch (e) {}
  }
  window.__fpsOverlayInstalled = true;

  // ----------------------
  // Config
  // ----------------------
  const WIDTH = 340;
  const HEADER_H = 36;
  const HEIGHT = 218;
  const PLOT_H = HEIGHT - HEADER_H;

  const BG   = "rgba(0,0,0,0.82)";
  const GRID = "rgba(255,255,255,0.08)";
  const TEXT = "#fff";
  const C_FPS = "rgba(0,200,120,0.95)";
  const C_MEM = "rgba(0,120,255,0.95)";

  const WINDOW_OPTS = [5000, 10000, 15000];  // 5s / 10s / 15s
  let windowIdx = 0;
  let windowMs  = WINDOW_OPTS[windowIdx];

  let realtime     = true;   // R = raf; S = 1 Hz
  let recording    = false;  // recording state
  let recordStart  = 0;      // perf.now() timestamp at start
  let recorded     = [];     // {t, fps, mem}

  // ----------------------
  // DOM
  // ----------------------
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed",
    right: "12px",
    top: "12px",
    width: WIDTH + "px",
    height: HEIGHT + "px",
    zIndex: 2147483647,
    borderRadius: "10px",
    overflow: "hidden",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
    fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
    color: TEXT,
    background: BG
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "grid",
    gridTemplateColumns: "1fr auto auto auto auto",
    alignItems: "center",
    gap: "6px",
    padding: "6px 8px",
    background: BG,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    fontSize: "11px",
    cursor: "move",
    height: HEADER_H + "px",
    boxSizing: "border-box"
  });

  const info = document.createElement("div");
  info.style.whiteSpace = "nowrap";

  const makeBtn = (txt, bg = "rgba(255,255,255,0.10)", tip = "") => {
    const b = document.createElement("button");
    b.textContent = txt;
    if (tip) b.title = tip; // tooltip on hover
    Object.assign(b.style, {
      fontSize: "11px",
      padding: "4px 8px",
      cursor: "pointer",
      border: "none",
      borderRadius: "6px",
      color: TEXT,
      background: bg
    });
    return b;
  };

  // --- Buttons ---
  const rateBtn   = makeBtn("R", "rgba(255,255,255,0.10)", "采样模式：R=实时，S=每秒");
  const windowBtn = makeBtn(`${windowMs/1000}s`, "rgba(255,255,255,0.10)", "显示时间窗口");
  const recBtn    = makeBtn("开始", "rgba(0,170,255,0.22)", "开始/结束记录并导出 CSV");
  const closeBtn  = makeBtn("X", "rgba(255,255,255,0.10)"); // no tooltip

  rateBtn.onclick = (e) => {
    e.stopPropagation();
    realtime = !realtime;
    rateBtn.textContent = realtime ? "R" : "S";
    if (realtime) loopRAF(); else loopInterval();
  };

  windowBtn.onclick = (e) => {
    e.stopPropagation();
    windowIdx = (windowIdx + 1) % WINDOW_OPTS.length;
    windowMs  = WINDOW_OPTS[windowIdx];
    windowBtn.textContent = `${windowMs/1000}s`;
    // On next sample, trimming will adapt to the new window size
  };

  recBtn.onclick = (e) => {
    e.stopPropagation();
    if (!recording) {
      recording = true;
      recorded = [];
      recordStart = performance.now();
      recBtn.textContent = "结束";
      recBtn.style.background = "rgba(255,120,0,0.28)";
    } else {
      recording = false;
      recBtn.textContent = "开始";
      recBtn.style.background = "rgba(0,170,255,0.22)";
      const csv = buildCSV(recorded, recordStart);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `perf_${ts}.csv`;
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };

  closeBtn.onclick = () => {
    cancelAnimationFrame(rafId);
    clearInterval(timerId);
    box.remove();
    delete window.__perfOverlay;
    window.__fpsOverlayInstalled = false;
  };

  header.appendChild(info);
  header.appendChild(rateBtn);
  header.appendChild(windowBtn);
  header.appendChild(recBtn);
  header.appendChild(closeBtn);

  const canvas = document.createElement("canvas");
  canvas.width  = WIDTH * devicePixelRatio;
  canvas.height = PLOT_H * devicePixelRatio;
  canvas.style.width  = WIDTH + "px";
  canvas.style.height = PLOT_H + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);

  box.appendChild(header);
  box.appendChild(canvas);
  document.body.appendChild(box);

  // ----------------------
  // Drag (grab header)
  // ----------------------
  (function enableDrag(){
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.addEventListener("mousedown", e => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      document.body.style.userSelect = "none";
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      box.style.left = (ox + dx) + "px";
      box.style.top  = (oy + dy) + "px";
      box.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      document.body.style.userSelect = "";
    });
  })();

  // ----------------------
  // Data & Sampling
  // ----------------------
  let lastTS = performance.now();
  /** @type {{t:number, v:number}[]} */ const fpsPts = [];
  /** @type {{t:number, v:number}[]} */ const memPts = [];
  const memSupported = !!(performance?.memory?.usedJSHeapSize);

  function pushPoint(arr, t, v) {
    arr.push({ t, v });
    // Only keep the selected window (5s / 10s / 15s)
    const cutoff = t - windowMs;
    while (arr.length && arr[0].t < cutoff) arr.shift();
  }

  function sampleNow(ts) {
    const delta = ts - lastTS; lastTS = ts;
    const fps = 1000 / Math.max(1, delta);
    pushPoint(fpsPts, ts, fps);

    let memMB = null;
    if (memSupported) {
      memMB = performance.memory.usedJSHeapSize / 1048576;
    } else {
      memMB = memPts.length ? memPts[memPts.length - 1].v : 0;
    }
    pushPoint(memPts, ts, memMB);

    if (recording) recorded.push({ t: ts, fps, mem: memMB });
  }

  // ----------------------
  // Stats & Helpers
  // ----------------------
  const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
  const max = a => a.length ? Math.max(...a) : NaN;
  const min = a => a.length ? Math.min(...a) : NaN;

  function updateInfo() {
    const fpsAvg = Math.round(avg(fpsPts.slice(-10).map(p => p.v)) || 0);
    const memLast = memPts.length ? memPts[memPts.length - 1].v : NaN;
    const memTxt = isFinite(memLast) ? `${memLast.toFixed(1)}MB` : "N/A";
    info.textContent = `${fpsAvg}fps · ${memTxt}`;
  }

  function buildCSV(rows, t0) {
    const lines = ["timestamp_iso,elapsed_ms,fps,memory_mb"];
    for (const r of rows) {
      const iso = new Date(performance.timeOrigin + r.t).toISOString();
      const elapsed = Math.round(r.t - t0);
      const fps = isFinite(r.fps) ? r.fps.toFixed(2) : "";
      const mem = (r.mem == null || !isFinite(r.mem)) ? "" : r.mem.toFixed(2);
      lines.push([iso, elapsed, fps, mem].join(","));
    }
    return lines.join("\n");
  }

  // Smooth Y-range cache (for animated axis)
  const smoothRange = {
    FPS: { min: 0, max: 120 },
    MEM: { min: 0, max: 500 }
  };

  // ----------------------
  // Drawing
  // ----------------------
  function draw() {
    const w = WIDTH, h = PLOT_H, tNow = performance.now();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h);

    const fpsWin = fpsPts; // already trimmed to windowMs
    const memWin = memPts;

    drawPanel(0, fpsWin, "FPS",      C_FPS, smoothRange.FPS);
    drawPanel(1, memWin, "内存(MB)", C_MEM, smoothRange.MEM);
  }

  function drawPanel(row, points, label, color, range) {
    const w = WIDTH, h = PLOT_H;
    const y0 = row * h / 2;
    const ph = (row === 1 ? h - y0 : h / 2);

    // Compute dynamic ±10% padded range from visible points
    let minV = 0, maxV = 1;
    const vals = points.map(p => p.v).filter(v => isFinite(v));
    if (vals.length) {
      const vmin = Math.min(...vals), vmax = Math.max(...vals);
      const pad = (vmax - vmin) * 0.1 || 1;
      minV = Math.max(0, vmin - pad);
      maxV = vmax + pad;
    }

    // Smooth transition for nicer axis animation
    const s = 0.15; // smoothing factor (0~1)
    range.min += (minV - range.min) * s;
    range.max += (maxV - range.max) * s;
    minV = range.min; maxV = range.max;

    // Grid & tick labels
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "10px system-ui";
    for (let i = 0; i <= 4; i++) {
      const y = y0 + i * ph / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      const val = (maxV - minV) * (1 - i / 4) + minV;
      ctx.fillText(val.toFixed(0), w - 36, Math.max(y0 + 10, y - 2));
    }

    if (!points.length) return;

    const tEnd = performance.now();
    const tStart = tEnd - windowMs;
    const span = windowMs;

    // Area fill
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = ((p.t - tStart) / span) * w;
      const y = y0 + ph - ((p.v - minV) / (maxV - minV || 1)) * (ph - 8);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.lineTo(w, y0 + ph); ctx.lineTo(0, y0 + ph); ctx.closePath();
    ctx.fillStyle = color.replace(/,0\.\d+\)/, ",0.12)") || "rgba(255,255,255,0.12)";
    ctx.fill();

    // Line
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = ((p.t - tStart) / span) * w;
      const y = y0 + ph - ((p.v - minV) / (maxV - minV || 1)) * (ph - 8);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

    // Stats text
    const a = avg(vals), mx = max(vals), mn = min(vals);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(`${label}  avg ${a.toFixed(1)}  max ${mx.toFixed(1)}  min ${mn.toFixed(1)}`, 8, y0 + 14);
  }

  // ----------------------
  // Main Loops
  // ----------------------
  let rafId = null, timerId = null;

  function loopRAF() {
    cancelAnimationFrame(rafId);
    clearInterval(timerId);
    function tick(ts) {
      sampleNow(ts);
      updateInfo();
      draw();
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function loopInterval() {
    cancelAnimationFrame(rafId);
    clearInterval(timerId);
    timerId = setInterval(() => {
      const ts = performance.now();
      sampleNow(ts);
      updateInfo();
      draw();
    }, 1000);
  }

  // Default to realtime (R)
  loopRAF();

  // ----------------------
  // Public API (optional)
  // ----------------------
  window.__perfOverlay = {
    remove(){ closeBtn.click(); },
    toggleRate(){ rateBtn.click(); },
    toggleWindow(){ windowBtn.click(); },
    start(){ if(!recording) recBtn.click(); },
    stopAndDownload(){ if(recording) recBtn.click(); }
  };

  console.log("Overlay ready: FPS+Memory (R/S, 5/10/15s, dynamic axis, CSV).");
})();
