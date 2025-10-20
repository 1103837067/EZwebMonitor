/**
 * EZwebMonitor (PerfDog-style Jank) - reloadable + mobile-friendly + drag fix
 *
 * 功能：
 * - FPS/Memory 双图、深色可拖拽（Pointer Events，触屏/鼠标通吃）
 * - R/S 采样切换（每帧 / 1Hz）
 * - 5s/10s/15s 窗口切换（仅保留当前窗口数据）
 * - CSV 录制导出（含 jank,big_jank,delta_ms），移动端：优先 Web Share -> 下载 -> 复制兜底
 * - 动态纵轴 ±10% + 平滑过渡
 * - PerfDog 风格 jank/big-jank（前3帧均值×2 + 电影帧倍数阈值）
 * - FPS 图黄/红框标注 jank/big-jank；J/BJ 统计显示在 FPS 面板统计行
 * - 修复：按钮/画布点击不会触发拖动（仅 header 空白处可拖）
 *
 * 加载：
 *   import("https://cdn.jsdelivr.net/gh/1103837067/EZwebMonitor/index.js");
 *
 * 重新构建（无需再次 import）：
 *   window.__perfOverlay.reload();
 *   // 或
 *   window.__EZwebMonitorBootstrap();
 */

(function defineBootstrap() {
  if (window.__EZwebMonitorBootstrap) {
    try { window.__EZwebMonitorBootstrap(); } catch(e){ console.warn("EZwebMonitor.reload failed", e); }
    return;
  }

  function bootstrap() {
    if (window.__fpsOverlayInstalled) {
      try { window.__perfOverlay?.remove?.(); } catch (e) {}
    }
    window.__fpsOverlayInstalled = true;

    // ---------------- CONFIG ----------------
    const WIDTH=340, HEADER_H=36, HEIGHT=218, PLOT_H=HEIGHT-HEADER_H;
    const BG="rgba(0,0,0,0.82)", GRID="rgba(255,255,255,0.08)", TEXT="#fff";
    const C_FPS="rgba(0,200,120,0.95)", C_MEM="rgba(0,120,255,0.95)";
    const COLOR_JANK="#ffd60a"; // 小卡顿：黄
    const COLOR_BIG ="#ff3b30"; // 大卡顿：红

    const WINDOW_OPTS=[5000,10000,15000]; // 5s/10s/15s
    let windowIdx=0, windowMs=WINDOW_OPTS[windowIdx];

    // Sampling
    let realtime=true; // R=per-frame, S=1Hz
    let lastTS=performance.now();

    // Recording
    let recording=false, recordStart=0, recorded=[];

    // PerfDog-style constants
    const MOVIE_FT = 1000/24;   // ~41.67ms
    const J_MOVIE  = 2 * MOVIE_FT;   // ~83.33ms
    const BJ_MOVIE = 3 * MOVIE_FT;   // 125ms
    const IGNORE_DELTA_GT_MS = 2000; // 避免后台/挂起假阳性

    // 维护最近3帧的间隔
    const last3 = []; // ms

    // ---------------- DOM ----------------
    const box=document.createElement("div");
    Object.assign(box.style,{
      position:"fixed",right:"12px",top:"12px",width:WIDTH+"px",height:HEIGHT+"px",
      zIndex:2147483647,borderRadius:"10px",overflow:"hidden",
      boxShadow:"0 8px 24px rgba(0,0,0,0.5)",
      fontFamily:"system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
      color:TEXT,background:BG
    });

    const header=document.createElement("div");
    Object.assign(header.style,{
      display:"grid",
      gridTemplateColumns:"1fr auto auto auto auto",
      alignItems:"center",gap:"6px",padding:"6px 8px",
      background:BG,borderBottom:"1px solid rgba(255,255,255,0.06)",
      fontSize:"11px",
      height:HEADER_H+"px",boxSizing:"border-box",
      touchAction:"none", cursor:"grab" // Pointer Events & 抓手光标
    });

    const info=document.createElement("div");
    info.style.whiteSpace="nowrap";

    const makeBtn=(txt,bg="rgba(255,255,255,0.10)",tip="")=>{
      const b=document.createElement("button");
      b.textContent=txt;
      if(tip) b.title=tip;
      Object.assign(b.style,{
        fontSize:"11px",padding:"4px 8px",cursor:"pointer",
        border:"none",borderRadius:"6px",color:TEXT,background:bg
      });
      return b;
    };

    const rateBtn  = makeBtn("R","rgba(255,255,255,0.10)","采样模式：R=实时，S=每秒");
    const windowBtn= makeBtn(`${windowMs/1000}s`,"rgba(255,255,255,0.10)","显示时间窗口");
    const recBtn   = makeBtn("开始","rgba(0,170,255,0.22)","开始/结束记录并导出 CSV");
    const closeBtn = makeBtn("X","rgba(255,255,255,0.10)");

    rateBtn.onclick=(e)=>{ e.stopPropagation(); realtime=!realtime; rateBtn.textContent=realtime?"R":"S"; if(realtime){loopRAF();}else{loopInterval();} };
    windowBtn.onclick=(e)=>{ e.stopPropagation(); windowIdx=(windowIdx+1)%WINDOW_OPTS.length; windowMs=WINDOW_OPTS[windowIdx]; windowBtn.textContent=`${windowMs/1000}s`; };

    // —— 移动端友好导出：包装为 async —— //
    recBtn.onclick=async (e)=>{
      e.stopPropagation();
      if(!recording){
        recording=true; recorded=[]; recordStart=performance.now();
        recBtn.textContent="结束"; recBtn.style.background="rgba(255,120,0,0.28)";
      }else{
        recording=false; recBtn.textContent="开始"; recBtn.style.background="rgba(0,170,255,0.22)";
        const csv=buildCSV(recorded,recordStart);
        const ts=new Date().toISOString().replace(/[:.]/g,'-');
        await downloadCSVMobileFriendly(`perf_${ts}.csv`, csv);
      }
    };

    closeBtn.onclick=()=>{ cleanup(); };

    const canvas=document.createElement("canvas");
    canvas.width=WIDTH*devicePixelRatio; canvas.height=PLOT_H*devicePixelRatio;
    canvas.style.width=WIDTH+"px"; canvas.style.height=PLOT_H+"px";
    const ctx=canvas.getContext("2d"); ctx.scale(devicePixelRatio,devicePixelRatio);

    // 组装 DOM
    header.appendChild(info); header.appendChild(rateBtn); header.appendChild(windowBtn); header.appendChild(recBtn); header.appendChild(closeBtn);
    box.appendChild(header); box.appendChild(canvas); document.body.appendChild(box);

    // ---- 给交互元素加“防拖动护航”（阻止 pointer 事件冒泡到 header）----
    function shieldFromDrag(el){
      el.addEventListener("pointerdown", e => { e.stopPropagation(); }, { passive:true });
      el.addEventListener("pointermove", e => { e.stopPropagation(); }, { passive:true });
    }
    [rateBtn, windowBtn, recBtn, closeBtn, canvas].forEach(shieldFromDrag);

    // ---------------- Drag：Pointer Events（仅 header 空白区域可拖） ----------------
    (function enableDrag(){
      let dragging=false,sx=0,sy=0,ox=0,oy=0;

      header.addEventListener("pointerdown",(e)=>{
        // 点击到按钮或 canvas 时不启动拖拽（仅 header 空白处可拖）
        if (e.target.closest("button") || e.target === canvas) return;
        // 只响应主键
        if (e.button !== undefined && e.button !== 0) return;

        dragging=true;
        header.setPointerCapture?.(e.pointerId);
        sx=e.clientX; sy=e.clientY;
        const r=box.getBoundingClientRect(); ox=r.left; oy=r.top;
        document.body.style.userSelect="none";
        header.style.cursor="grabbing";
      });

      window.addEventListener("pointermove",(e)=>{
        if(!dragging) return;
        const dx=e.clientX-sx, dy=e.clientY-sy;
        box.style.left=(ox+dx)+"px"; box.style.top=(oy+dy)+"px"; box.style.right="auto";
        e.preventDefault?.(); // 阻止页面随手指滚动
      }, { passive:false });

      window.addEventListener("pointerup",()=>{
        dragging=false;
        document.body.style.userSelect="";
        header.style.cursor="grab";
      });
    })();

    // ---------------- DATA ----------------
    /** @type {{t:number,v:number}[]} */ const fpsPts=[];
    /** @type {{t:number,v:number}[]} */ const memPts=[];
    const memSupported=!!(performance?.memory?.usedJSHeapSize);

    // jank events (only for current window)
    /** @type {{t:number, gap:number, type:'jank'|'big'}[]} */ const jankEvents=[];

    function pushPoint(arr,t,v){
      arr.push({t,v});
      const cutoff=t - windowMs;
      while(arr.length && arr[0].t < cutoff) arr.shift();
    }
    function pushJank(t, gap, type){
      jankEvents.push({t, gap, type});
      const cutoff=t - windowMs;
      while(jankEvents.length && jankEvents[0].t < cutoff) jankEvents.shift();
    }

    // PerfDog-style detect
    function detectPerfDogStyleJank(deltaMs){
      if (document.hidden || deltaMs > IGNORE_DELTA_GT_MS) return null;
      const prevAvg = last3.length ? (last3.reduce((a,b)=>a+b,0)/last3.length) : null;

      // 更新 last3 给下一帧
      last3.push(deltaMs);
      if (last3.length > 3) last3.shift();

      if (prevAvg == null) return null; // 需要历史
      const condA = deltaMs > 2 * prevAvg;
      const condJ = deltaMs > J_MOVIE;
      const condBJ= deltaMs > BJ_MOVIE;
      if (condA && condBJ) return 'big';
      if (condA && condJ)  return 'jank';
      return null;
    }

    function sampleNow(ts){
      const delta=ts-lastTS; lastTS=ts;
      const fps=1000/Math.max(1,delta);
      pushPoint(fpsPts, ts, fps);

      const jt = detectPerfDogStyleJank(delta);
      const isB = jt === 'big';
      const isJ = jt === 'jank';
      if (jt) pushJank(ts, delta, jt);

      let memMB=null;
      if (memSupported) memMB = performance.memory.usedJSHeapSize/1048576;
      else memMB = (memPts.length ? memPts[memPts.length-1].v : 0);
      pushPoint(memPts, ts, memMB);

      if (recording) recorded.push({
        t: ts,
        fps,
        mem: memMB,
        jank: isJ ? 1 : 0,
        big_jank: isB ? 1 : 0,
        delta_ms: Math.round(delta)
      });
    }

    // ---------------- HELPERS ----------------
    const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
    const max=a=>a.length?Math.max(...a):NaN;
    const min=a=>a.length?Math.min(...a):NaN;

    function updateInfo(){
      const fpsAvg=Math.round(avg(fpsPts.slice(-10).map(p=>p.v))||0);
      const memLast=memPts.length?memPts[memPts.length-1].v:NaN;
      const memTxt=isFinite(memLast)?`${memLast.toFixed(1)}MB`:"N/A";
      // Header 不显示 J/BJ
      info.textContent=`${fpsAvg}fps · ${memTxt}`;
    }

    function buildCSV(rows,t0){
      const lines=["timestamp_iso,elapsed_ms,fps,memory_mb,jank,big_jank,delta_ms"];
      for(const r of rows){
        const iso=new Date(performance.timeOrigin+r.t).toISOString();
        const elapsed=Math.round(r.t-t0);
        const fps=isFinite(r.fps)?r.fps.toFixed(2):"";
        const mem=(r.mem==null||!isFinite(r.mem))?"":r.mem.toFixed(2);
        const jflag = r.jank ? 1 : 0;
        const bjflag = r.big_jank ? 1 : 0;
        const d = r.delta_ms ?? "";
        lines.push([iso,elapsed,fps,mem,jflag,bjflag,d].join(","));
      }
      return lines.join("\n");
    }

    // ---- 下载/分享 CSV（移动端友好）----
    async function downloadCSVMobileFriendly(fileName, csvText) {
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });

      // 1) Web Share API (with files): Android Chrome / iOS 16+ Safari
      const canFileShare = !!(navigator.canShare && window.File && window.Blob);
      if (canFileShare) {
        try {
          const file = new File([csvText], fileName, { type: "text/csv" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: fileName, text: "性能数据 CSV" });
            console.log("[EZwebMonitor] 已通过系统分享导出 CSV。");
            return;
          }
        } catch (e) {
          console.warn("[EZwebMonitor] Web Share 文件分享失败，转入下一步。", e);
        }
      }

      // 2) 传统下载
      try {
        const a = document.createElement("a");
        a.download = fileName;
        a.href = URL.createObjectURL(blob);
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        console.log("[EZwebMonitor] 已触发浏览器下载。移动端通常保存在“下载”或“文件”。");
        return;
      } catch (e) {
        console.warn("[EZwebMonitor] a[download] 下载失败，转入下一步。", e);
      }

      // 3) 兜底：复制到剪贴板
      try {
        await navigator.clipboard.writeText(csvText);
        alert("已将 CSV 文本复制到剪贴板。\n若下载无响应，可粘贴到备忘录/文件并保存为 .csv。");
        console.log("[EZwebMonitor] 已复制 CSV 到剪贴板。");
        return;
      } catch (e) {
        console.warn("[EZwebMonitor] 复制失败。请手动在控制台复制。", e);
        console.log("CSV START >>>\n" + csvText + "\n<<< CSV END");
        alert("下载/分享/复制均未成功。\n已在控制台打印 CSV，请手动复制保存。");
      }
    }

    // Smooth axis ranges
    const smoothRange={ FPS:{min:0,max:120}, MEM:{min:0,max:500} };

    // ---------------- DRAW ----------------
    function draw(){
      const w=WIDTH, h=PLOT_H;
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle=BG; ctx.fillRect(0,0,w,h);

      drawPanel(0, fpsPts, "FPS", C_FPS, smoothRange.FPS, jankEvents, true); // FPS 带 jank 标注 + 统计 J/BJ
      drawPanel(1, memPts, "内存(MB)", C_MEM, smoothRange.MEM, null, false);
    }

    function drawPanel(row, points, label, color, range, janks, showJankCounts){
      const w=WIDTH, h=PLOT_H, y0=row*h/2, ph=(row===1?h-y0:h/2);

      // dynamic ±10% padded range
      let minV=0, maxV=1;
      const vals=points.map(p=>p.v).filter(v=>isFinite(v));
      if(vals.length){
        const vmin=Math.min(...vals), vmax=Math.max(...vals);
        const pad=(vmax-vmin)*0.1 || 1;
        minV=Math.max(0, vmin - pad);
        maxV=vmax + pad;
      }

      // smooth easing
      const s=0.15;
      range.min += (minV - range.min) * s;
      range.max += (maxV - range.max) * s;
      minV=range.min; maxV=range.max;

      // grid + tick labels
      ctx.strokeStyle=GRID; ctx.lineWidth=1;
      ctx.fillStyle="rgba(255,255,255,0.55)"; ctx.font="10px system-ui";
      for(let i=0;i<=4;i++){
        const y=y0 + i*ph/4;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
        const val=(maxV-minV)*(1-i/4)+minV;
        ctx.fillText(val.toFixed(0), w-36, Math.max(y0+10, y-2));
      }

      if(!points.length) return;

      const tEnd=performance.now();
      const tStart=tEnd - windowMs;
      const span=windowMs;

      // area fill
      ctx.beginPath();
      points.forEach((p,i)=>{
        const x=((p.t - tStart)/span)*w;
        const y=y0 + ph - ((p.v - minV)/(maxV - minV || 1))*(ph - 8);
        i?ctx.lineTo(x,y):ctx.moveTo(x,y);
      });
      ctx.lineTo(w,y0+ph); ctx.lineTo(0,y0+ph); ctx.closePath();
      ctx.fillStyle = color.replace(/,0\.\d+\)/, ",0.12)") || "rgba(255,255,255,0.12)";
      ctx.fill();

      // line
      ctx.beginPath();
      points.forEach((p,i)=>{
        const x=((p.t - tStart)/span)*w;
        const y=y0 + ph - ((p.v - minV)/(maxV - minV || 1))*(ph - 8);
        i?ctx.lineTo(x,y):ctx.moveTo(x,y);
      });
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();

      // stats text（FPS 面板追加 J/BJ 统计）
      const a=avg(vals), mx=max(vals), mn=min(vals);
      ctx.fillStyle="rgba(255,255,255,0.7)";
      let suffix = "";
      if (showJankCounts && janks){
        let jc=0, bjc=0;
        for (const ev of janks){ if (ev.t>=tStart && ev.t<=tEnd){ if(ev.type==='big') bjc++; else jc++; } }
        suffix = `  |  J ${jc}  BJ ${bjc}`;
      }
      ctx.fillText(`${label}  avg ${a.toFixed(1)}  max ${mx.toFixed(1)}  min ${mn.toFixed(1)}${suffix}`, 8, y0+14);

      // ---- JANK MARKS (FPS only) ----
      if (janks && janks.length){
        const sizeJ = 7;   // jank box
        const sizeB = 11;  // big jank box
        janks.forEach(ev=>{
          if (ev.t < tStart || ev.t > tEnd) return;

          // 最近点的 y 值
          let v = null;
          for (let i=points.length-1;i>=0;i--){
            if (Math.abs(points[i].t - ev.t) <= (span/points.length + 5)) { v = points[i].v; break; }
          }
          if (v == null && points.length) v = points[points.length-1].v;

          const x=((ev.t - tStart)/span)*w;
          const y=y0 + ph - ((v - minV)/(maxV - minV || 1))*(ph - 8);

          ctx.save();
          ctx.setLineDash([]);
          ctx.lineWidth = (ev.type==='big') ? 2.5 : 1.5;
          ctx.strokeStyle = (ev.type==='big') ? COLOR_BIG : COLOR_JANK;
          const sz = (ev.type==='big') ? sizeB : sizeJ;
          ctx.strokeRect(x - sz/2, y - sz/2, sz, sz);
          ctx.restore();
        });
      }
    }

    // ---------------- LOOPS ----------------
    let rafId=null, timerId=null;
    function loopRAF(){
      cancelAnimationFrame(rafId); clearInterval(timerId);
      function tick(ts){ sampleNow(ts); updateInfo(); draw(); rafId=requestAnimationFrame(tick); }
      rafId=requestAnimationFrame(tick);
    }
    function loopInterval(){
      cancelAnimationFrame(rafId); clearInterval(timerId);
      timerId=setInterval(()=>{ const ts=performance.now(); sampleNow(ts); updateInfo(); draw(); }, 1000);
    }
    loopRAF();

    // ---------------- CLEANUP ----------------
    function cleanup(){
      cancelAnimationFrame(rafId);
      clearInterval(timerId);
      try{ box.remove(); }catch(e){}
      try { delete window.__perfOverlay; } catch(e){}
      window.__fpsOverlayInstalled = false; // 关闭后可再次 bootstrap
    }

    // ---------------- API ----------------
    window.__perfOverlay = {
      remove(){ cleanup(); },
      toggleRate(){ rateBtn.click(); },
      toggleWindow(){ windowBtn.click(); },
      start(){ if(!recording) recBtn.click(); },
      stopAndDownload(){ if(recording) recBtn.click(); },
      getJankConfig(){ return { MOVIE_FT, J_MOVIE, BJ_MOVIE, IGNORE_DELTA_GT_MS }; },
      reload(){ cleanup(); setTimeout(()=>{ try{ bootstrap(); }catch(e){ console.warn(e); } }, 50); }
    };

    window.__EZwebMonitorBootstrap = bootstrap;

    console.log("Overlay ready: PerfDog-style jank + mobile-friendly + drag-fix. 用 window.__perfOverlay.reload() 可重建。");
  } // end bootstrap

  window.__EZwebMonitorBootstrap = bootstrap;
  try { bootstrap(); } catch(e){ console.error("EZwebMonitor bootstrap error", e); }

})(); // end defineBootstrap
