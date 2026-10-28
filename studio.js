// StemSplit Studio: a small multitrack mixer that runs on the Web Audio API.
// Tracks (vocals, instrumental, recorded takes, added files) each get volume, pan, mute/solo and
// voice effects; the master bus has a DJ filter, speed and a safety limiter. The same graph
// builder drives live playback and the offline WAV export, so what you hear is what you download.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const root = $("studio");
  if (!root) return;

  const PRESETS = {
    none:   { label: "No effects",   bass: 0,   treble: 0,  reverb: 0,    echo: 0,    polish: false },
    studio: { label: "Studio vocal", bass: -2,  treble: 3,  reverb: 0.22, echo: 0,    polish: true },
    hall:   { label: "Concert hall", bass: 0,   treble: 1,  reverb: 0.6,  echo: 0,    polish: true },
    echo:   { label: "Echo",         bass: 0,   treble: 2,  reverb: 0.15, echo: 0.45, polish: true },
    warm:   { label: "Warm",         bass: 4,   treble: -3, reverb: 0.18, echo: 0,    polish: true },
    radio:  { label: "Old radio",    bass: -18, treble: -9, reverb: 0,    echo: 0,    polish: true },
  };
  const COLORS = { vocals: "--vocal", instrumental: "--inst", take: "--take", import: "--import" };

  const S = {
    tracks: [], name: "song", pos: 0, xfade: 0,
    master: { gain: 0.9, filter: 0, speed: 1 },
    loop: { on: false, a: null, b: null },
    takePreset: "studio", headphones: true, monitor: false,
  };
  let ctx = null, live = null, rec = null, nextId = 1, takeCount = 0, stopCards = () => {}, raf = 0;

  // ---------------- audio graph (shared by live playback and export) ----------------
  const irCache = new WeakMap();
  function impulse(c) {
    if (irCache.has(c)) return irCache.get(c);
    const len = Math.floor(c.sampleRate * 2.6), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let seed = ch ? 7 : 3;
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        const t = i / len;
        d[i] = ((seed / 2147483647) * 2 - 1) * Math.pow(1 - t, 3.2) * (i < c.sampleRate * 0.012 ? i / (c.sampleRate * 0.012) : 1);
      }
    }
    irCache.set(c, ir); return ir;
  }
  function setFilter(f, v, c, t) {
    const nyq = c.sampleRate / 2;
    if (Math.abs(v) < 0.03) { f.type = "lowpass"; f.frequency.setTargetAtTime(Math.min(22000, nyq * 0.98), t, 0.02); f.Q.value = 0.5; }
    else if (v < 0) { f.type = "lowpass"; f.frequency.setTargetAtTime(Math.min(nyq * 0.98, 20000 * Math.pow(250 / 20000, -v)), t, 0.03); f.Q.value = 1.1; }
    else { f.type = "highpass"; f.frequency.setTargetAtTime(30 * Math.pow(5000 / 30, v), t, 0.03); f.Q.value = 1.1; }
  }
  function buildMaster(c) {
    const input = c.createGain(), filter = c.createBiquadFilter(), limit = c.createDynamicsCompressor(), out = c.createGain();
    limit.threshold.value = -2; limit.knee.value = 2; limit.ratio.value = 12; limit.attack.value = 0.002; limit.release.value = 0.15;
    input.connect(filter); filter.connect(limit); limit.connect(out); out.connect(c.destination);
    return { input, filter, limit, out };
  }
  function applyMaster(m, c, neutral) {
    const t = c.currentTime;
    m.out.gain.setTargetAtTime(neutral ? 1 : S.master.gain, t, 0.02);
    setFilter(m.filter, neutral ? 0 : S.master.filter, c, t);
  }
  function buildTrack(c, dest) {
    const n = {
      input: c.createGain(), low: c.createBiquadFilter(), high: c.createBiquadFilter(), comp: c.createDynamicsCompressor(),
      pan: c.createStereoPanner(), dry: c.createGain(), revSend: c.createGain(), rev: c.createConvolver(),
      echoSend: c.createGain(), delay: c.createDelay(2), fb: c.createGain(), echoTone: c.createBiquadFilter(),
    };
    n.low.type = "lowshelf"; n.low.frequency.value = 220;
    n.high.type = "highshelf"; n.high.frequency.value = 3800;
    n.rev.buffer = impulse(c);
    n.delay.delayTime.value = 0.34; n.fb.gain.value = 0.38; n.echoTone.type = "lowpass"; n.echoTone.frequency.value = 3500;
    n.input.connect(n.low); n.low.connect(n.high); n.high.connect(n.comp); n.comp.connect(n.pan);
    n.pan.connect(n.dry); n.dry.connect(dest);
    n.pan.connect(n.revSend); n.revSend.connect(n.rev); n.rev.connect(dest);
    n.pan.connect(n.echoSend); n.echoSend.connect(n.delay); n.delay.connect(n.echoTone); n.echoTone.connect(n.fb); n.fb.connect(n.delay); n.echoTone.connect(dest);
    return n;
  }
  function xfadeFactor(tr) {
    if (tr.kind === "vocals") return S.xfade <= 0 ? 1 : 1 - S.xfade;
    if (tr.kind === "instrumental") return S.xfade >= 0 ? 1 : 1 + S.xfade;
    return 1;
  }
  function audibleGain(tr, solo) {
    const anySolo = S.tracks.some((x) => x.solo);
    if (solo) return tr.gain;                    // single-track export
    if (anySolo ? !tr.solo : tr.mute) return 0;
    return tr.gain * xfadeFactor(tr);
  }
  function applyTrack(n, tr, c, solo) {
    const t = c.currentTime, f = tr.fx;
    n.input.gain.setTargetAtTime(audibleGain(tr, solo), t, 0.015);
    n.low.gain.setTargetAtTime(f.bass, t, 0.02);
    n.high.gain.setTargetAtTime(f.treble, t, 0.02);
    if (f.polish) { n.comp.threshold.value = -24; n.comp.ratio.value = 3.5; n.comp.knee.value = 10; n.comp.attack.value = 0.005; n.comp.release.value = 0.2; }
    else { n.comp.threshold.value = 0; n.comp.ratio.value = 1; n.comp.knee.value = 0; }
    n.pan.pan.setTargetAtTime(tr.pan, t, 0.02);
    n.dry.gain.setTargetAtTime(1 - f.reverb * 0.35, t, 0.02);
    n.revSend.gain.setTargetAtTime(f.reverb * 0.9, t, 0.02);
    n.echoSend.gain.setTargetAtTime(f.echo * 0.7, t, 0.02);
  }
  const trackStart = (tr) => tr.offset + tr.nudge;
  const trackEnd = (tr) => trackStart(tr) + tr.buffer.duration;
  const totalLen = () => S.tracks.reduce((m, tr) => Math.max(m, trackEnd(tr)), 0);

  // Start every track's source for timeline span [from, until) at context time `when`.
  function startSources(c, nodes, list, from, until, when, speed) {
    const srcs = [], stopAt = when + (until - from) / speed;
    for (const tr of list) {
      const st = trackStart(tr), en = trackEnd(tr);
      if (en <= from || st >= until) continue;
      const src = c.createBufferSource(); src.buffer = tr.buffer; src.playbackRate.value = speed;
      src.connect(nodes.get(tr.id).input);
      if (from >= st) src.start(when, from - st); else src.start(when + (st - from) / speed, 0);
      src.stop(stopAt); srcs.push(src);
    }
    return srcs;
  }

  // ---------------- live playback ----------------
  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function posNow() {
    if (!live) return S.pos;
    const t = ctx.currentTime; let seg = live.segs[0];
    for (const s of live.segs) if (s.when <= t) seg = s;
    return Math.min(seg.until, Math.max(seg.from, seg.from + (t - seg.when) * S.master.speed));
  }
  function posAt(t) { // timeline position for a past/future context time
    if (!live) return S.pos;
    let seg = live.segs[0];
    for (const s of live.segs) if (s.when <= t) seg = s;
    return seg.from + (t - seg.when) * S.master.speed;
  }
  function play() {
    if (live || !S.tracks.length) return;
    ensureCtx(); stopCards();
    try { if (navigator.audioSession) navigator.audioSession.type = rec ? "play-and-record" : "playback"; } catch (e) {}
    const total = totalLen();
    if (S.pos >= total - 0.05) S.pos = loopValid() ? S.loop.a : 0;
    const master = buildMaster(ctx); applyMaster(master, ctx, false);
    const nodes = new Map();
    for (const tr of S.tracks) { const n = buildTrack(ctx, master.input); applyTrack(n, tr, ctx, false); nodes.set(tr.id, n); }
    live = { master, nodes, segs: [], timer: 0 };
    schedule(S.pos, ctx.currentTime + 0.06);
    tickLoop(); renderTransport();
  }
  function loopValid() { return S.loop.on && S.loop.a != null && S.loop.b != null && S.loop.b - S.loop.a > 0.2; }
  function schedule(from, when) {
    const total = totalLen();
    const useLoop = loopValid() && from < S.loop.b;
    const until = useLoop ? S.loop.b : total;
    const srcs = startSources(ctx, live.nodes, S.tracks, from, until, when, S.master.speed);
    live.segs.push({ from, until, when, srcs });
    if (live.segs.length > 3) live.segs.shift();
    const endTime = when + (until - from) / S.master.speed;
    const ms = Math.max(0, (endTime - ctx.currentTime - (useLoop ? 0.35 : -0.03)) * 1000);
    live.timer = setTimeout(() => {
      if (!live) return;
      if (useLoop && loopValid()) schedule(S.loop.a, endTime);  // gapless: next pass starts exactly at the loop end
      else if (!rec) { pause(); S.pos = 0; renderTransport(); }
    }, ms);
  }
  function pause() {
    if (!live) return;
    S.pos = Math.max(0, posNow());
    clearTimeout(live.timer);
    for (const s of live.segs) for (const src of s.srcs) { try { src.stop(); } catch (e) {} }
    try { live.master.out.disconnect(); } catch (e) {}
    live = null; cancelAnimationFrame(raf); renderTransport(); drawPlayheads();
  }
  function restartIfPlaying() { if (live && !rec) { pause(); play(); } }
  function seek(t) {
    const was = !!live && !rec;
    if (rec) return;
    pause(); S.pos = Math.max(0, Math.min(totalLen(), t));
    drawPlayheads(); renderTransport();
    if (was) play();
  }
  function refreshLive() {
    if (!live) return;
    applyMaster(live.master, ctx, false);
    for (const tr of S.tracks) { const n = live.nodes.get(tr.id); if (n) applyTrack(n, tr, ctx, false); }
  }
  function tickLoop() {
    cancelAnimationFrame(raf);
    const step = () => { drawPlayheads(); renderTime(); if (rec) drawMeter(); if (live || rec) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  }

  // ---------------- recording ----------------
  const WORKLET = `class R extends AudioWorkletProcessor{constructor(){super();this.f=true;this.b=new Float32Array(4096);this.n=0}
  process(i){const c=i[0]&&i[0][0];if(!c)return true;if(this.f){this.port.postMessage({start:currentTime});this.f=false}
  for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===this.b.length){this.port.postMessage(this.b);this.b=new Float32Array(4096);this.n=0}}return true}}
  registerProcessor("stemsplit-recorder",R);`;
  let workletReady = null;
  async function startRecording() {
    if (rec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return studioError("This browser can't use a microphone. Try Chrome, Edge, Firefox or Safari.");
    ensureCtx();
    if (S.master.speed !== 1) { S.master.speed = 1; $("st-speed").value = 1; renderDj(); }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: !S.headphones, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      return studioError(e && e.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow the microphone for this site in your browser's settings, then press Record again."
        : "No microphone was found. Connect one (or allow it in your phone's settings) and try again.");
    }
    pause();
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch (e) {}
    const src = ctx.createMediaStreamSource(stream), sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
    const chunks = []; let startCtx = null, node;
    try {
      if (!workletReady) workletReady = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
      await workletReady;
      node = new AudioWorkletNode(ctx, "stemsplit-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      node.port.onmessage = (e) => { if (e.data && e.data.start != null) startCtx = e.data.start; else chunks.push(e.data); };
    } catch (e) { // older browsers
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => { if (startCtx == null) startCtx = e.playbackTime - 4096 / ctx.sampleRate; chunks.push(e.inputBuffer.getChannelData(0).slice()); };
    }
    src.connect(node); node.connect(sink);
    let monitor = null;
    if (S.monitor) { // hear yourself through the take's effects (headphones only)
      monitor = buildTrack(ctx, ctx.destination);
      applyTrack(monitor, { gain: 1, pan: 0, fx: { ...PRESETS[S.takePreset] }, kind: "take" }, ctx, true);
      src.connect(monitor.input);
    }
    const settings = stream.getAudioTracks()[0].getSettings ? stream.getAudioTracks()[0].getSettings() : {};
    rec = { stream, src, node, sink, analyser, chunks, monitor, get startCtx() { return startCtx; }, inLatency: settings.latency || 0.01, started: S.pos };
    play(); renderTransport(); tickLoop();
  }
  function stopRecording() {
    if (!rec) return;
    const r = rec; rec = null;
    const startPos = r.startCtx != null && live ? posAt(r.startCtx) : r.started;
    pause();
    try { r.src.disconnect(); r.node.disconnect(); r.sink.disconnect(); if (r.monitor) r.monitor.input.disconnect(); } catch (e) {}
    r.stream.getTracks().forEach((t) => t.stop());
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
    const n = r.chunks.reduce((a, c) => a + c.length, 0);
    if (n < ctx.sampleRate * 0.3) { renderAll(); return studioError("The recording was too short. Press Record, sing, then press Stop."); }
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0); let o = 0;
    for (const c of r.chunks) { d.set(c, o); o += c.length; }
    // what you sang at context time T was in time with music heard at T minus output and input latency
    const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + r.inLatency;
    takeCount++;
    addTrack({ kind: "take", name: `Your take ${takeCount}`, buffer: buf, offset: startPos - latency, fx: { ...PRESETS[S.takePreset] }, preset: S.takePreset });
    S.pos = Math.max(0, startPos);
    studioInfo(`Take ${takeCount} added. If it sounds early or late, use “Line up” on its track.`);
  }
  function drawMeter() {
    if (!rec) return;
    const a = new Float32Array(rec.analyser.fftSize); rec.analyser.getFloatTimeDomainData(a);
    let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
    const db = 20 * Math.log10(p + 1e-6), frac = Math.max(0, Math.min(1, (db + 60) / 60));
    $("st-meter-fill").style.width = (frac * 100).toFixed(1) + "%";
    $("st-meter-fill").classList.toggle("hot", db > -3);
  }

  // ---------------- export ----------------
  async function render(list, opts) {
    const solo = !!opts.solo, speed = solo ? 1 : S.master.speed;
    const from = solo ? Math.min(...list.map(trackStart)) : 0, to = Math.max(...list.map(trackEnd));
    const tail = list.some((t) => t.fx.reverb > 0 || t.fx.echo > 0) ? 3 : 0.2;
    const sr = 44100, len = Math.ceil(((to - from) / speed + tail) * sr);
    const off = new OfflineAudioContext(2, len, sr);
    const master = buildMaster(off); applyMaster(master, off, solo);
    const nodes = new Map();
    for (const tr of list) { const n = buildTrack(off, master.input); applyTrack(n, tr, off, solo); nodes.set(tr.id, n); }
    startSources(off, nodes, list, from, to, 0, speed);
    const out = await off.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }
  async function download(list, filename, opts, btn) {
    const label = btn.textContent; btn.disabled = true; btn.textContent = "Rendering…";
    try {
      await new Promise((r) => setTimeout(r, 30));
      const [L, R] = await render(list, opts);
      const blob = new Blob([window.StemSplitEncodeWav(L, R)], { type: "audio/wav" });
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      btn.textContent = "Downloaded ✓"; setTimeout(() => { btn.textContent = label; }, 2500);
    } catch (e) {
      btn.textContent = label; studioError("The file couldn't be created. Your device may be low on memory; try muting or deleting some tracks.");
    } finally { btn.disabled = false; }
  }

  // ---------------- tracks ----------------
  function peaks(buf, cols = 1200) {
    const chs = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i)), n = buf.length, per = Math.max(1, Math.floor(n / cols));
    const v = new Float32Array(cols); let max = 1e-9;
    for (let c = 0; c < cols; c++) { let m = 0; for (let i = c * per; i < Math.min(n, (c + 1) * per); i += 32) for (const d of chs) { const a = Math.abs(d[i]); if (a > m) m = a; } v[c] = m; if (m > max) max = m; }
    return { v, max };
  }
  function addTrack(t) {
    const tr = { id: nextId++, gain: 1, pan: 0, mute: false, solo: false, nudge: 0, preset: "none", fx: { ...PRESETS.none }, ...t };
    tr.peaks = peaks(tr.buffer);
    S.tracks.push(tr); renderAll(); restartIfPlaying();
  }
  function removeTrack(tr) {
    pause(); S.tracks = S.tracks.filter((x) => x !== tr); renderAll();
  }

  // ---------------- rendering the UI ----------------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function fmt(t, tenths) {
    t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60;
    return tenths ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) { if (k === "class") e.className = attrs[k]; else if (k.startsWith("on")) e[k] = attrs[k]; else if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }
  function slider(id, label, min, max, step, value, onInput, fmtVal) {
    const out = el("output", { for: id, class: "st-val" }); out.textContent = fmtVal(value);
    const input = el("input", { type: "range", id, min, max, step, value });
    input.oninput = () => { const v = parseFloat(input.value); out.textContent = fmtVal(v); onInput(v); };
    return el("div", { class: "st-ctl" }, el("label", { for: id, text: label }), input, out);
  }
  function renderTracks() {
    const box = $("st-tracks"); box.innerHTML = "";
    for (const tr of S.tracks) {
      const id = "t" + tr.id, color = COLORS[tr.kind];
      const lane = el("div", { class: "st-lane", title: "Tap or drag to jump" }, el("canvas", { "aria-hidden": "true" }), el("div", { class: "st-loopband" }), el("div", { class: "st-head" }));
      lane.style.setProperty("--c", `var(${color})`);
      const mute = el("button", { class: "st-tog", "aria-pressed": String(tr.mute), title: "Mute", text: "M" });
      mute.onclick = () => { tr.mute = !tr.mute; mute.setAttribute("aria-pressed", String(tr.mute)); refreshLive(); dimLanes(); };
      const solo = el("button", { class: "st-tog solo", "aria-pressed": String(tr.solo), title: "Solo (hear only this)", text: "S" });
      solo.onclick = () => { tr.solo = !tr.solo; solo.setAttribute("aria-pressed", String(tr.solo)); refreshLive(); dimLanes(); };
      const dl = el("button", { class: "st-small", text: "Download", title: "Download this track with its effects" });
      dl.onclick = () => download([tr], `${S.name}_${tr.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_")}.wav`, { solo: true }, dl);
      const del = (tr.kind === "take" || tr.kind === "import") ? el("button", { class: "st-small danger", text: "Delete" }) : null;
      if (del) del.onclick = () => removeTrack(tr);
      const fxBtn = el("button", { class: "st-small", "aria-expanded": "false", text: "Effects" });
      const head = el("div", { class: "st-trackhead" },
        el("span", { class: "st-dot" }), el("strong", { class: "st-name", text: tr.name }),
        el("span", { class: "st-tools" }, mute, solo, fxBtn, dl, del));
      head.style.setProperty("--c", `var(${color})`);
      const mix = el("div", { class: "st-row" },
        slider(id + "-vol", "Volume", 0, 1.5, 0.01, tr.gain, (v) => { tr.gain = v; refreshLive(); }, (v) => Math.round(v * 100) + "%"),
        slider(id + "-pan", "Left / right", -1, 1, 0.01, tr.pan, (v) => { tr.pan = v; refreshLive(); }, (v) => Math.abs(v) < 0.02 ? "Centre" : (v < 0 ? "L " : "R ") + Math.round(Math.abs(v) * 100)));
      if (tr.kind === "take" || tr.kind === "import") {
        mix.append(slider(id + "-nudge", tr.kind === "take" ? "Line up" : "Starts at", tr.kind === "take" ? -0.5 : 0, tr.kind === "take" ? 0.5 : Math.max(10, Math.ceil(totalLen())), tr.kind === "take" ? 0.005 : 0.1,
          tr.kind === "take" ? tr.nudge : tr.offset,
          (v) => { if (tr.kind === "take") tr.nudge = v; else tr.offset = v; drawLanes(); restartIfPlaying(); },
          (v) => tr.kind === "take" ? (Math.abs(v) < 0.003 ? "In time" : (v < 0 ? "Earlier " : "Later ") + Math.round(Math.abs(v) * 1000) + " ms") : fmt(v, true)));
      }
      const fx = el("div", { class: "st-fx", hidden: "" });
      const preset = el("select", { id: id + "-preset", "aria-label": "Effect preset" });
      for (const k in PRESETS) preset.append(el("option", { value: k, text: PRESETS[k].label }));
      preset.value = tr.preset in PRESETS ? tr.preset : "none";
      const fxSliders = el("div", { class: "st-row" });
      const drawFx = () => {
        fxSliders.innerHTML = "";
        fxSliders.append(
          slider(id + "-rev", "Reverb", 0, 1, 0.01, tr.fx.reverb, (v) => { tr.fx.reverb = v; refreshLive(); }, (v) => Math.round(v * 100) + "%"),
          slider(id + "-echo", "Echo", 0, 1, 0.01, tr.fx.echo, (v) => { tr.fx.echo = v; refreshLive(); }, (v) => Math.round(v * 100) + "%"),
          slider(id + "-bass", "Bass", -18, 12, 0.5, tr.fx.bass, (v) => { tr.fx.bass = v; refreshLive(); }, (v) => (v > 0 ? "+" : "") + v + " dB"),
          slider(id + "-treb", "Treble", -12, 12, 0.5, tr.fx.treble, (v) => { tr.fx.treble = v; refreshLive(); }, (v) => (v > 0 ? "+" : "") + v + " dB"));
        const pol = el("input", { type: "checkbox", id: id + "-pol" }); pol.checked = tr.fx.polish;
        pol.onchange = () => { tr.fx.polish = pol.checked; refreshLive(); };
        fxSliders.append(el("label", { class: "st-check", for: id + "-pol" }, pol, " Polish (evens out loud and quiet parts)"));
      };
      preset.onchange = () => { tr.preset = preset.value; tr.fx = { ...PRESETS[preset.value] }; drawFx(); refreshLive(); };
      drawFx();
      fx.append(el("div", { class: "st-ctl" }, el("label", { for: id + "-preset", text: "Preset" }), preset), fxSliders);
      fxBtn.onclick = () => { const open = fx.hidden; fx.hidden = !open; fxBtn.setAttribute("aria-expanded", String(open)); };
      const card = el("div", { class: "st-track", "data-id": tr.id }, head, lane, mix, fx);
      box.append(card);
      bindSeek(lane);
    }
    drawLanes(); dimLanes();
  }
  function dimLanes() {
    const anySolo = S.tracks.some((t) => t.solo);
    for (const tr of S.tracks) {
      const c = root.querySelector(`.st-track[data-id="${tr.id}"]`);
      if (c) c.classList.toggle("silent", anySolo ? !tr.solo : tr.mute);
    }
  }
  function drawLanes() {
    const total = Math.max(0.1, totalLen());
    for (const tr of S.tracks) {
      const card = root.querySelector(`.st-track[data-id="${tr.id}"]`); if (!card) continue;
      const cv = card.querySelector("canvas"), dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 300, h = cv.clientHeight || 48;
      cv.width = w * dpr; cv.height = h * dpr;
      const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      g.fillStyle = css(COLORS[tr.kind]);
      const x0 = (trackStart(tr) / total) * w, x1 = (trackEnd(tr) / total) * w, cols = Math.max(1, Math.floor((x1 - x0) / 2));
      for (let c = 0; c < cols; c++) {
        const i = Math.floor((c / cols) * tr.peaks.v.length), bh = Math.max(1, (tr.peaks.v[i] / tr.peaks.max) * (h - 8));
        g.fillRect(x0 + c * 2, (h - bh) / 2, 1.4, bh);
      }
    }
    drawPlayheads();
  }
  function drawPlayheads() {
    const total = Math.max(0.1, totalLen()), p = Math.min(1, posNow() / total);
    root.querySelectorAll(".st-head").forEach((e) => { e.style.left = (p * 100).toFixed(3) + "%"; });
    const lv = S.loop.a != null && S.loop.b != null;
    root.querySelectorAll(".st-loopband").forEach((e) => {
      e.hidden = !lv; if (!lv) return;
      e.style.left = (S.loop.a / total * 100) + "%"; e.style.width = ((S.loop.b - S.loop.a) / total * 100) + "%";
      e.classList.toggle("on", S.loop.on);
    });
    const seekBar = $("st-seek"); if (document.activeElement !== seekBar) seekBar.value = Math.round(p * 1000);
  }
  function bindSeek(lane) {
    let drag = false;
    const at = (e) => { const r = lane.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * totalLen(); };
    lane.onpointerdown = (e) => { if (rec) return; drag = { was: !!live }; lane.setPointerCapture(e.pointerId); pause(); S.pos = at(e); drawPlayheads(); renderTime(); };
    lane.onpointermove = (e) => { if (!drag) return; S.pos = at(e); drawPlayheads(); renderTime(); };
    const end = () => { if (!drag) return; const was = drag.was; drag = false; if (was) play(); };
    lane.onpointerup = end; lane.onpointercancel = end;
  }
  function renderTime() { $("st-time").textContent = `${fmt(posNow(), true)} / ${fmt(totalLen(), false)}`; }
  function renderTransport() {
    const playing = !!live;
    $("st-play").textContent = playing && !rec ? "Pause" : "Play";
    $("st-play").setAttribute("aria-pressed", String(playing && !rec));
    $("st-play").disabled = !!rec;
    $("st-rec").textContent = rec ? "Stop recording" : "Record";
    $("st-rec").classList.toggle("recording", !!rec);
    $("st-meter").hidden = !rec;
    $("st-start").disabled = !!rec; $("st-seek").disabled = !!rec;
    renderTime();
  }
  function renderDj() {
    $("st-xfade-out").textContent = Math.abs(S.xfade) < 0.03 ? "Both full" : S.xfade < 0 ? `Music ${Math.round((1 + S.xfade) * 100)}%` : `Vocals ${Math.round((1 - S.xfade) * 100)}%`;
    $("st-speed-out").textContent = S.master.speed.toFixed(2) + "×";
    $("st-filter-out").textContent = Math.abs(S.master.filter) < 0.03 ? "Off" : S.master.filter < 0 ? `Low-pass ${Math.round(-S.master.filter * 100)}%` : `High-pass ${Math.round(S.master.filter * 100)}%`;
    $("st-loop-out").textContent = S.loop.a == null ? "Not set" : `${fmt(S.loop.a, true)} → ${S.loop.b == null ? "…" : fmt(S.loop.b, true)}`;
    $("st-loop").setAttribute("aria-pressed", String(S.loop.on)); $("st-loop").textContent = S.loop.on ? "Loop on" : "Loop off";
    $("st-loop").disabled = !(S.loop.a != null && S.loop.b != null);
  }
  function renderAll() { renderTracks(); renderTransport(); renderDj(); $("st-export").disabled = !S.tracks.length; }
  function studioError(msg) { const e = $("st-msg"); e.textContent = msg; e.className = "st-msg error"; e.hidden = false; }
  function studioInfo(msg) { const e = $("st-msg"); e.textContent = msg; e.className = "st-msg"; e.hidden = false; }

  // ---------------- wiring ----------------
  $("st-play").onclick = () => { $("st-msg").hidden = true; live ? pause() : play(); };
  $("st-start").onclick = () => seek(loopValid() ? S.loop.a : 0);
  $("st-seek").oninput = () => seek(($("st-seek").value / 1000) * totalLen());
  $("st-rec").onclick = () => { $("st-msg").hidden = true; rec ? stopRecording() : startRecording(); };
  $("st-headphones").onchange = () => { S.headphones = $("st-headphones").checked; if (!S.headphones) { S.monitor = false; $("st-monitor").checked = false; } $("st-monitor").disabled = !S.headphones; };
  $("st-monitor").onchange = () => { S.monitor = $("st-monitor").checked; };
  $("st-takefx").onchange = () => { S.takePreset = $("st-takefx").value; };
  $("st-xfade").oninput = () => { S.xfade = parseFloat($("st-xfade").value); if (Math.abs(S.xfade) < 0.04) S.xfade = 0; refreshLive(); renderDj(); };
  $("st-speed").oninput = () => { if (rec) { $("st-speed").value = 1; return; } S.master.speed = parseFloat($("st-speed").value); renderDj(); restartIfPlaying(); };
  $("st-speed-reset").onclick = () => { $("st-speed").value = 1; $("st-speed").oninput(); };
  $("st-filter").oninput = () => { S.master.filter = parseFloat($("st-filter").value); if (Math.abs(S.master.filter) < 0.04) S.master.filter = 0; refreshLive(); renderDj(); };
  $("st-master").oninput = () => { S.master.gain = parseFloat($("st-master").value); $("st-master-out").textContent = Math.round(S.master.gain * 100) + "%"; refreshLive(); };
  $("st-a").onclick = () => { S.loop.a = posNow(); if (S.loop.b != null && S.loop.b <= S.loop.a + 0.2) S.loop.b = null; renderDj(); drawPlayheads(); };
  $("st-b").onclick = () => { const p = posNow(); if (S.loop.a == null || p <= S.loop.a + 0.2) return studioError("Set the loop start (A) first, then press B at a later point."); S.loop.b = p; S.loop.on = true; renderDj(); drawPlayheads(); restartIfPlaying(); };
  $("st-loop").onclick = () => { S.loop.on = !S.loop.on; renderDj(); drawPlayheads(); restartIfPlaying(); };
  $("st-addfile").addEventListener("change", async () => {
    const f = $("st-addfile").files[0]; $("st-addfile").value = ""; if (!f) return;
    ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      addTrack({ kind: "import", name: f.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Added track", buffer: buf, offset: 0 });
      studioInfo(`Added “${f.name}”. Use “Starts at” on its track to move it.`);
    } catch (e) { studioError("That file couldn't be read as audio. Try an MP3, WAV or M4A file."); }
  });
  $("st-export").onclick = () => download(S.tracks, `${S.name}_mix.wav`, { solo: false }, $("st-export"));
  for (const k in PRESETS) $("st-takefx").append(el("option", { value: k, text: PRESETS[k].label }));
  $("st-takefx").value = S.takePreset;
  window.addEventListener("resize", () => { if (!root.hidden) drawLanes(); });
  document.addEventListener("keydown", (e) => {
    if (root.hidden || e.code !== "Space" || /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) return;
    if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
    e.preventDefault(); if (!rec) (live ? pause() : play());
  });

  window.StemSplitStudio = {
    load({ vocals, instrumental, name, stopCards: sc }) {
      this.unload();
      stopCards = sc || (() => {});
      S.name = name || "song"; S.pos = 0; S.xfade = 0; S.loop = { on: false, a: null, b: null };
      S.master = { gain: 0.9, filter: 0, speed: 1 }; takeCount = 0;
      ["st-xfade", "st-filter"].forEach((i) => { $(i).value = 0; }); $("st-speed").value = 1; $("st-master").value = 0.9; $("st-master-out").textContent = "90%";
      root.hidden = false;
      addTrack({ kind: "instrumental", name: "Instrumental", buffer: instrumental, offset: 0 });
      addTrack({ kind: "vocals", name: "Vocals", buffer: vocals, offset: 0 });
      $("st-msg").hidden = true;
    },
    unload() { if (rec) stopRecording(); pause(); S.tracks = []; root.hidden = true; $("st-tracks").innerHTML = ""; },
    pause() { if (!rec) pause(); },
    _state: S, _render: render,  // used by automated tests
  };
})();
