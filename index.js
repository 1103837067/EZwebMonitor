/**
 * EZwebMonitor - Realtime FPS / Memory / Jank Overlay
 * https://github.com/1103837067/EZwebMonitor
 */

(function defineBootstrap() {
  if (window.__EZwebMonitorBootstrap) {
    try { window.__EZwebMonitorBootstrap(); } catch(e){}
    return;
  }

  function bootstrap() {
    if (window.__fpsOverlayInstalled) {
      try { window.__perfOverlay?.remove?.(); } catch (e) {}
    }
    window.__fpsOverlayInstalled = true;

    // ---------------- CONFIG ----------------
    const WIDTH = 340, HEADER_H = 36, HEIGHT = 218, PLOT_H = HEIGHT - HEADER_H;
    const BG = "rgba(0,0,0,0.82)", GRID = "rgba(255,255,255,0.08)", TEXT = "#fff";
    const C_FPS = "rgba(0,200,120,0.95)", C_MEM = "rgba(0,120,255,0.95)";
    const COLOR_JANK = "#ffd60a", COLOR_BIG = "#ff3b30";
    const WINDOW_OPTS = [5000, 10000, 15000]; let windowIdx = 0, windowMs = WINDOW_OPTS[windowIdx];

    // Sampling
    let realtime = true; // R=per-frame, S=1Hz
    let lastTS = performance.now();

    // Recording
    let recording = false, recordStart = 0, recorded = [];

    // PerfDog-style constants
    const MOVIE_FT = 1000 / 24;     // ~41.67ms
    const J_MOVIE  = 2 * MOVIE_FT;  // ~83.33ms
    const BJ_MOVIE = 3 * MOVIE_FT;  // 125ms
    const IGNORE_DELTA_GT_MS = 2000;

    // recent frame gaps
    const last3 = [];

    // ---------------- DOM ----------------
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", right: "12px", top: "12px", width: WIDTH + "px", height: HEIGHT + "px",
      zIndex: 2147483647, borderRadius: "10px", overflow: "hidden",
      boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
      color: TEXT, background: BG
    });

    // ---- Header UI ----
    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "grid",
      gridTemplateColumns: "auto 1fr auto auto auto auto",
      alignItems: "center", gap: "6px", padding: "6px 8px",
      background: BG, borderBottom: "1px solid rgba(255,255,255,0.06)",
      fontSize: "11px", height: HEADER_H + "px", boxSizing: "border-box",
      touchAction: "none", cursor: "grab"
    });

    // GitHub icon button
    const ghBtn = document.createElement("button");
    ghBtn.title = "GitHub";
    ghBtn.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
<path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8a8.001 8.001 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8.001 8.001 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
</svg>`;
    Object.assign(ghBtn.style, {
      display: "flex", alignItems: "center", justifyContent: "center",
      width: "22px", height: "22px", background: "rgba(255,255,255,0.1)",
      borderRadius: "6px", border: "none", cursor: "pointer", color: "#fff"
    });
    ghBtn.onclick = (e) => { e.stopPropagation(); window.open("https://github.com/1103837067/EZwebMonitor", "_blank", "noopener"); };

    const info = document.createElement("div");
    info.style.whiteSpace = "nowrap";

    const makeBtn = (txt, bg = "rgba(255,255,255,0.10)", tip = "") => {
      const b = document.createElement("button");
      b.textContent = txt; if (tip) b.title = tip;
      Object.assign(b.style, {
        fontSize: "11px", padding: "4px 8px", cursor: "pointer",
        border: "none", borderRadius: "6px", color: TEXT, background: bg
      });
      return b;
    };

    const rateBtn   = makeBtn("R", "rgba(255,255,255,0.10)", "采样模式：R=实时，S=每秒");
    const windowBtn = makeBtn(`${windowMs/1000}s`, "rgba(255,255,255,0.10)", "显示时间窗口");
    const recBtn    = makeBtn("开始", "rgba(0,170,255,0.22)", "开始/结束记录并导出 CSV");
    const closeBtn  = makeBtn("X", "rgba(255,255,255,0.10)");

    rateBtn.onclick = (e) => {
      e.stopPropagation();
      realtime = !realtime;
      rateBtn.textContent = realtime ? "R" : "S";
      if (realtime) loopRAF(); else loopInterval();
    };
    windowBtn.onclick = (e) => {
      e.stopPropagation();
      windowIdx = (windowIdx + 1) % WINDOW_OPTS.length;
      windowMs = WINDOW_OPTS[windowIdx];
      windowBtn.textContent = `${windowMs/1000}s`;
    };
    recBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!recording) {
        recording = true; recorded = []; recordStart = performance.now();
        recBtn.textContent = "结束"; recBtn.style.background = "rgba(255,120,0,0.28)";
      } else {
        recording = false; recBtn.textContent = "开始"; recBtn.style.background = "rgba(0,170,255,0.22)";
        const meta = await collectEnvInfo();
        const csv  = buildCSV(recorded, recordStart, meta);
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        await downloadCSVMobileFriendly(`perf_${ts}.csv`, csv);
      }
    };
    closeBtn.onclick = () => cleanup();

    header.appendChild(ghBtn);
    header.appendChild(info);
    header.appendChild(rateBtn);
    header.appendChild(windowBtn);
    header.appendChild(recBtn);
    header.appendChild(closeBtn);

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * devicePixelRatio; canvas.height = PLOT_H * devicePixelRatio;
    canvas.style.width = WIDTH + "px"; canvas.style.height = PLOT_H + "px";
    const ctx = canvas.getContext("2d"); ctx.scale(devicePixelRatio, devicePixelRatio);

    box.appendChild(header); box.appendChild(canvas); document.body.appendChild(box);

    // ---- shield buttons/canvas from drag start ----
    const shieldFromDrag = (el) => {
      el.addEventListener("pointerdown", e => e.stopPropagation(), { passive: true });
      el.addEventListener("pointermove", e => e.stopPropagation(), { passive: true });
    };
    [ghBtn, rateBtn, windowBtn, recBtn, closeBtn, canvas].forEach(shieldFromDrag);

    // ---- drag only on header empty area ----
    (function enableDrag(){
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      header.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button") || e.target === canvas) return;
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true;
        header.setPointerCapture?.(e.pointerId);
        sx = e.clientX; sy = e.clientY;
        const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
        document.body.style.userSelect = "none"; header.style.cursor = "grabbing";
      });
      window.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        box.style.left = (ox + dx) + "px"; box.style.top = (oy + dy) + "px"; box.style.right = "auto";
        e.preventDefault?.();
      }, { passive: false });
      window.addEventListener("pointerup", () => {
        dragging = false;
        document.body.style.userSelect = ""; header.style.cursor = "grab";
      });
    })();

    // ---------------- DATA ----------------
    const fpsPts = [], memPts = [];
    const memSupported = !!(performance?.memory?.usedJSHeapSize);
    const jankEvents = [];

    const pushPoint = (arr, t, v) => {
      arr.push({ t, v });
      const cutoff = t - windowMs;
      while (arr.length && arr[0].t < cutoff) arr.shift();
    };
    const pushJank = (t, gap, type) => {
      jankEvents.push({ t, gap, type });
      const cutoff = t - windowMs;
      while (jankEvents.length && jankEvents[0].t < cutoff) jankEvents.shift();
    };

    function detectPerfDogStyleJank(delta) {
      if (document.hidden || delta > IGNORE_DELTA_GT_MS) return null;
      const prevAvg = last3.length ? (last3.reduce((a,b)=>a+b,0) / last3.length) : null;
      last3.push(delta); if (last3.length > 3) last3.shift();
      if (prevAvg == null) return null;
      const condA = delta > 2 * prevAvg;
      const condJ = delta > J_MOVIE;
      const condBJ = delta > BJ_MOVIE;
      if (condA && condBJ) return "big";
      if (condA && condJ)  return "jank";
      return null;
    }

    function sampleNow(ts) {
      const d = ts - lastTS; lastTS = ts;
      const fps = 1000 / Math.max(1, d);
      pushPoint(fpsPts, ts, fps);

      const jt = detectPerfDogStyleJank(d);
      if (jt) pushJank(ts, d, jt);

      let memMB = memSupported
        ? performance.memory.usedJSHeapSize / 1048576
        : (memPts.length ? memPts[memPts.length - 1].v : 0);
      pushPoint(memPts, ts, memMB);

      if (recording) {
        recorded.push({
          t: ts,
          fps,
          mem: memMB,
          jank: jt === "jank" ? 1 : 0,
          big_jank: jt === "big" ? 1 : 0,
          delta_ms: Math.round(d)
        });
      }
    }

    // ---------------- HELPERS ----------------
    const avg = a => a.length ? a.reduce((x,y)=>x+y,0) / a.length : NaN;
    const max = a => a.length ? Math.max(...a) : NaN;
    const min = a => a.length ? Math.min(...a) : NaN;

    function updateInfo() {
      const f = Math.round(avg(fpsPts.slice(-10).map(p=>p.v)) || 0);
      const m = memPts.length ? memPts[memPts.length - 1].v : NaN;
      info.textContent = `${f}fps · ${isFinite(m) ? m.toFixed(1) + "MB" : "N/A"}`;
    }

    // ---- Environment Snapshot ----
    async function collectEnvInfo() {
      try {
        const nav = navigator || {}, scr = screen || {};
        const tz = Intl.DateTimeFormat().resolvedOptions?.().timeZone || "";

        const gl = (function(){
          try {
            const c = document.createElement("canvas");
            const g = c.getContext("webgl") || c.getContext("experimental-webgl");
            if (!g) return {};
            const ext = g.getExtension("WEBGL_debug_renderer_info");
            return {
              gl_vendor: ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
              gl_renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)
            };
          } catch { return {}; }
        })();

        let battery = {};
        try {
          if (nav.getBattery) {
            const b = await nav.getBattery();
            battery = { battery_level: +((b.level || 0) * 100).toFixed(0), battery_charging: !!b.charging };
          }
        } catch {}

        const conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
        const net = {
          net_downlink: conn.downlink ?? "",
          net_effective_type: conn.effectiveType ?? "",
          net_rtt: conn.rtt ?? "",
          net_save_data: conn.saveData ?? ""
        };

        let jsHeapLimitMB = "", hasMem = false;
        try {
          if (performance && performance.memory && performance.memory.jsHeapSizeLimit) {
            hasMem = true;
            jsHeapLimitMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576);
          }
        } catch {}

        const meta = {
          ez_version: "v1",
          algo: "perfdog-2x-prev3 + movie-thresholds",
          now_iso: new Date().toISOString(),

          page_url: location.href,
          referrer: document.referrer || "",
          visibility_state: document.visibilityState || "",

          user_agent: nav.userAgent || "",
          platform: nav.platform || "",
          vendor: nav.vendor || "",
          languages: (nav.languages || []).join(","),
          timezone: tz,

          dpr: window.devicePixelRatio || 1,
          viewport_w: window.innerWidth || "",
          viewport_h: window.innerHeight || "",
          screen_w: scr.width || "",
          screen_h: scr.height || "",
          color_depth: scr.colorDepth || "",
          max_touch_points: nav.maxTouchPoints ?? "",

          hardware_concurrency: nav.hardwareConcurrency ?? "",
          device_memory: nav.deviceMemory ?? "",

          ...net,
          ...battery,
          ...gl,

          mem_supported: hasMem ? 1 : 0,
          js_heap_limit_mb: jsHeapLimitMB
        };
        return meta;
      } catch (e) {
        return { error: e.message };
      }
    }

    function metaToCsvHeader(meta) {
      const lines = ["# EZwebMonitor Environment"];
      for (const k of Object.keys(meta)) {
        const v = (meta[k] ?? "").toString().replace(/\r?\n/g, " ").replace(/,/g, ";");
        lines.push(`# ${k},${v}`);
      }
      return lines.join("\n");
    }

    function buildCSV(rows, t0, meta) {
      const head = meta ? metaToCsvHeader(meta) + "\n" : "";
      const lines = ["timestamp_iso,elapsed_ms,fps,memory_mb,jank,big_jank,delta_ms"];
      for (const r of rows) {
        const iso = new Date(performance.timeOrigin + r.t).toISOString();
        const elapsed = Math.round(r.t - t0);
        const fps = isFinite(r.fps) ? r.fps.toFixed(2) : "";
        const mem = (r.mem == null || !isFinite(r.mem)) ? "" : r.mem.toFixed(2);
        lines.push([iso, elapsed, fps, mem, r.jank ? 1 : 0, r.big_jank ? 1 : 0, r.delta_ms ?? ""].join(","));
      }
      return head + lines.join("\n");
    }

    async function downloadCSVMobileFriendly(fileName, csvText) {
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });

      // 1) Web Share with files
      const canFileShare = !!(navigator.canShare && window.File && window.Blob);
      if (canFileShare) {
        try {
          const file = new File([csvText], fileName, { type: "text/csv" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: fileName, text: "性能数据 CSV" });
            return;
          }
        } catch {}
      }
      // 2) a[download]
      try {
        const a = document.createElement("a");
        a.download = fileName;
        a.href = URL.createObjectURL(blob);
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        return;
      } catch {}

      // 3) Clipboard fallback
      try {
        await navigator.clipboard.writeText(csvText);
        alert("已复制 CSV 到剪贴板。");
      } catch {
        console.log(csvText);
        alert("下载/分享失败，已在控制台输出 CSV。");
      }
    }

    // Smooth axis ranges
    const smoothRange = { FPS: { min: 0, max: 120 }, MEM: { min: 0, max: 500 } };

    // ---------------- DRAW ----------------
    function draw() {
      const w = WIDTH, h = PLOT_H;
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = BG; ctx.fillRect(0,0,w,h);

      drawPanel(0, fpsPts, "FPS", C_FPS, smoothRange.FPS, jankEvents, true);
      drawPanel(1, memPts, "内存(MB)", C_MEM, smoothRange.MEM, null, false);
    }

    function drawPanel(row, points, label, color, range, janks, showJankCounts) {
      const w = WIDTH, h = PLOT_H, y0 = row * h / 2, ph = (row === 1 ? h - y0 : h / 2);

      // dynamic ±10% padded range
      let minV = 0, maxV = 1;
      const vals = points.map(p => p.v).filter(v => isFinite(v));
      if (vals.length) {
        const vmin = Math.min(...vals), vmax = Math.max(...vals);
        const pad = (vmax - vmin) * 0.1 || 1;
        minV = Math.max(0, vmin - pad);
        maxV = vmax + pad;
      }
      // smooth easing
      const s = 0.15;
      range.min += (minV - range.min) * s;
      range.max += (maxV - range.max) * s;
      minV = range.min; maxV = range.max;

      // grid + tick labels
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.font = "10px system-ui";
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

      // area
      ctx.beginPath();
      points.forEach((p,i) => {
        const x = ((p.t - tStart) / span) * w;
        const y = y0 + ph - ((p.v - minV) / (maxV - minV || 1)) * (ph - 8);
        i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
      });
      ctx.lineTo(w, y0 + ph); ctx.lineTo(0, y0 + ph); ctx.closePath();
      ctx.fillStyle = color.replace(/,0\.\d+\)/, ",0.12)") || "rgba(255,255,255,0.12)";
      ctx.fill();

      // line
      ctx.beginPath();
      points.forEach((p,i) => {
        const x = ((p.t - tStart) / span) * w;
        const y = y0 + ph - ((p.v - minV) / (maxV - minV || 1)) * (ph - 8);
        i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();

      // stats text (+ J/BJ for FPS panel)
      const a = avg(vals), mx = max(vals), mn = min(vals);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      let suffix = "";
      if (showJankCounts && janks) {
        let jc = 0, bjc = 0;
        for (const ev of janks) {
          if (ev.t >= tStart && ev.t <= tEnd) {
            if (ev.type === 'big') bjc++; else jc++;
          }
        }
        suffix = `  |  J ${jc}  BJ ${bjc}`;
      }
      ctx.fillText(`${label}  avg ${a.toFixed(1)}  max ${mx.toFixed(1)}  min ${mn.toFixed(1)}${suffix}`, 8, y0 + 14);

      // jank marks (FPS only)
      if (janks && janks.length) {
        janks.forEach(ev => {
          if (ev.t < tStart || ev.t > tEnd) return;

          // nearest point value for y
          let v = null;
          for (let i = points.length - 1; i >= 0; i--) {
            if (Math.abs(points[i].t - ev.t) <= (span / points.length + 5)) { v = points[i].v; break; }
          }
          if (v == null && points.length) v = points[points.length - 1].v;

          const x = ((ev.t - tStart) / span) * w;
          const y = y0 + ph - ((v - minV) / (maxV - minV || 1)) * (ph - 8);

          ctx.save();
          ctx.lineWidth = (ev.type === 'big') ? 2.5 : 1.5;
          ctx.strokeStyle = (ev.type === 'big') ? COLOR_BIG : COLOR_JANK;
          const sz = (ev.type === 'big') ? 11 : 7;
          ctx.strokeRect(x - sz/2, y - sz/2, sz, sz);
          ctx.restore();
        });
      }
    }

    // ---------------- LOOPS ----------------
    let rafId = null, timerId = null;
    function loopRAF() {
      cancelAnimationFrame(rafId); clearInterval(timerId);
      const tick = (ts) => { sampleNow(ts); updateInfo(); draw(); rafId = requestAnimationFrame(tick); };
      rafId = requestAnimationFrame(tick);
    }
    function loopInterval() {
      cancelAnimationFrame(rafId); clearInterval(timerId);
      timerId = setInterval(() => { const ts = performance.now(); sampleNow(ts); updateInfo(); draw(); }, 1000);
    }
    loopRAF();

    // ---------------- CLEANUP & API ----------------
    function cleanup() {
      cancelAnimationFrame(rafId);
      clearInterval(timerId);
      try { box.remove(); } catch {}
      try { delete window.__perfOverlay; } catch {}
      window.__fpsOverlayInstalled = false;
    }

    window.__perfOverlay = {
      remove(){ cleanup(); },
      toggleRate(){ rateBtn.click(); },
      toggleWindow(){ windowBtn.click(); },
      start(){ if(!recording) recBtn.click(); },
      stopAndDownload(){ if(recording) recBtn.click(); },
      getJankConfig(){ return { MOVIE_FT, J_MOVIE, BJ_MOVIE, IGNORE_DELTA_GT_MS }; },
      getEnvInfo: collectEnvInfo,
      reload(){ cleanup(); setTimeout(()=>{ try{ bootstrap(); }catch(e){ console.warn(e); } }, 50); }
    };

    window.__EZwebMonitorBootstrap = bootstrap;

    console.log("Overlay ready: EZwebMonitor (FPS/Memory/Jank). 用 window.__perfOverlay.reload() 可重建。");
  } // end bootstrap

  window.__EZwebMonitorBootstrap = bootstrap;
  try { bootstrap(); } catch(e){ console.error("EZwebMonitor bootstrap error", e); }

})(); // end defineBootstrap
