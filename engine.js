// StemSplit separation engine: MDX-Net vocal model (UVR-MDX-NET Voc_FT) pipeline.
// Mirrors audio-separator's MDX inference: n_fft 7680, hop 1024, dim_f 3072, dim_t 256,
// chunk overlap 0.25, trim n_fft/2, instrumental = mix - vocals * compensate.
// Pure DSP + a pluggable `runModel(Float32Array) -> Promise<Float32Array>`.
var StemEngine = (function () {
  "use strict";
  var N = 7680, HOP = 1024, DIM_F = 3072, DIM_T = 128, TRIM = N / 2; // 128 frames: half the memory of 256, measured -0.0 dB with 10% overlap
  var CHUNK = HOP * (DIM_T - 1), COMPENSATE = 1.021, OVERLAP = 0.1; // 10% crossfade keeps section joins clean
  var M = 16384; // power-of-two size for Bluestein (>= 2N-1)

  // ---- radix-2 FFT of size M (in place) ----
  var LOG = 14, rev = new Uint32Array(M), cosT = new Float64Array(M / 2), sinT = new Float64Array(M / 2);
  for (var i = 0; i < M; i++) { var x = i, y = 0; for (var b = 0; b < LOG; b++) { y = (y << 1) | (x & 1); x >>= 1; } rev[i] = y; }
  for (i = 0; i < M / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / M); sinT[i] = -Math.sin(2 * Math.PI * i / M); }
  function fft(re, im, inverse) {
    for (var i = 0; i < M; i++) { var j = rev[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (var size = 2; size <= M; size <<= 1) {
      var h = size >> 1, step = M / size;
      for (var s = 0; s < M; s += size) {
        for (var k = 0, ti = 0; k < h; k++, ti += step) {
          var c = cosT[ti], sn = inverse ? -sinT[ti] : sinT[ti];
          var a = s + k, bb = a + h;
          var tr = re[bb] * c - im[bb] * sn, tim = re[bb] * sn + im[bb] * c;
          re[bb] = re[a] - tr; im[bb] = im[a] - tim; re[a] += tr; im[a] += tim;
        }
      }
    }
  }

  // ---- Bluestein DFT of size N (forward), via chirp-z ----
  var wRe = new Float64Array(N), wIm = new Float64Array(N);
  for (i = 0; i < N; i++) { var ang = Math.PI * ((i * i) % (2 * N)) / N; wRe[i] = Math.cos(ang); wIm[i] = -Math.sin(ang); }
  var BRe = new Float64Array(M), BIm = new Float64Array(M);
  BRe[0] = wRe[0]; BIm[0] = -wIm[0];
  for (i = 1; i < N; i++) { BRe[i] = BRe[M - i] = wRe[i]; BIm[i] = BIm[M - i] = -wIm[i]; }
  fft(BRe, BIm, false);
  var aRe = new Float64Array(M), aIm = new Float64Array(M);
  // in: xr, xi (length N) -> out: Xr, Xi (length N), forward DFT
  function dft(xr, xi, Xr, Xi) {
    aRe.fill(0); aIm.fill(0);
    for (var n = 0; n < N; n++) { aRe[n] = xr[n] * wRe[n] - xi[n] * wIm[n]; aIm[n] = xr[n] * wIm[n] + xi[n] * wRe[n]; }
    fft(aRe, aIm, false);
    for (var k = 0; k < M; k++) { var r = aRe[k] * BRe[k] - aIm[k] * BIm[k]; aIm[k] = aRe[k] * BIm[k] + aIm[k] * BRe[k]; aRe[k] = r; }
    fft(aRe, aIm, true);
    for (k = 0; k < N; k++) { var cr = aRe[k] / M, ci = aIm[k] / M; Xr[k] = cr * wRe[k] - ci * wIm[k]; Xi[k] = cr * wIm[k] + ci * wRe[k]; }
  }
  // inverse DFT (unnormalised * 1/N) via conjugation
  function idft(Xr, Xi, xr, xi) {
    for (var k = 0; k < N; k++) Xi[k] = -Xi[k];
    dft(Xr, Xi, xr, xi);
    for (var n = 0; n < N; n++) { xr[n] /= N; xi[n] = -xi[n] / N; }
  }

  var WIN = new Float64Array(N);
  for (i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); // periodic Hann (torch default)
  // window-square envelope for ISTFT normalisation over a full chunk
  var OLA = (DIM_T - 1) * HOP + N, WSUM = new Float64Array(OLA);
  for (var t = 0; t < DIM_T; t++) for (i = 0; i < N; i++) WSUM[t * HOP + i] += WIN[i] * WIN[i];

  var fr = new Float64Array(N), fi = new Float64Array(N), Fr = new Float64Array(N), Fi = new Float64Array(N);
  var PADLEN = CHUNK + N, padL = new Float64Array(PADLEN), padR = new Float64Array(PADLEN);

  // STFT of one chunk (two channels) -> model input [4, DIM_F, DIM_T] = Lre, Lim, Rre, Rim
  function stftChunk(L, R) {
    var P = N / 2;
    for (var i = 0; i < CHUNK; i++) { padL[P + i] = L[i]; padR[P + i] = R[i]; }
    for (i = 1; i <= P; i++) { // reflect padding (torch center=True)
      padL[P - i] = L[i]; padR[P - i] = R[i];
      padL[P + CHUNK - 1 + i] = L[CHUNK - 1 - i]; padR[P + CHUNK - 1 + i] = R[CHUNK - 1 - i];
    }
    var out = new Float32Array(4 * DIM_F * DIM_T), plane = DIM_F * DIM_T;
    for (var t = 0; t < DIM_T; t++) {
      var off = t * HOP;
      for (var n = 0; n < N; n++) { fr[n] = padL[off + n] * WIN[n]; fi[n] = padR[off + n] * WIN[n]; }
      dft(fr, fi, Fr, Fi); // Z = FFT(L + iR)
      for (var k = 3; k < DIM_F; k++) { // first 3 bins are zeroed, as in the reference
        var j = (N - k) % N, idx = k * DIM_T + t;
        out[idx] = (Fr[k] + Fr[j]) / 2;               // Lre
        out[plane + idx] = (Fi[k] - Fi[j]) / 2;       // Lim
        out[2 * plane + idx] = (Fi[k] + Fi[j]) / 2;   // Rre
        out[3 * plane + idx] = (Fr[j] - Fr[k]) / 2;   // Rim
      }
    }
    return out;
  }

  var olaL = new Float64Array(OLA), olaR = new Float64Array(OLA);
  // ISTFT of model output [4, DIM_F, DIM_T] -> two channels of CHUNK samples
  function istftChunk(spec) {
    olaL.fill(0); olaR.fill(0);
    var plane = DIM_F * DIM_T;
    for (var t = 0; t < DIM_T; t++) {
      Fr.fill(0); Fi.fill(0);
      for (var k = 0; k < DIM_F; k++) {
        var idx = k * DIM_T + t;
        var lr = spec[idx], li = spec[plane + idx], rr = spec[2 * plane + idx], ri = spec[3 * plane + idx];
        // Z[k] = XL[k] + i XR[k]
        Fr[k] += lr - ri; Fi[k] += li + rr;
        if (k > 0) { var j = N - k; // XL[N-k] = conj XL[k], same for XR
          Fr[j] += lr + ri; Fi[j] += -li + rr; }
      }
      idft(Fr, Fi, fr, fi);
      var off = t * HOP;
      for (var n = 0; n < N; n++) { olaL[off + n] += fr[n] * WIN[n]; olaR[off + n] += fi[n] * WIN[n]; }
    }
    var L = new Float32Array(CHUNK), R = new Float32Array(CHUNK), P = N / 2;
    for (var i = 0; i < CHUNK; i++) { var w = WSUM[P + i]; L[i] = olaL[P + i] / w; R[i] = olaR[P + i] / w; }
    return [L, R];
  }

  function plan(n) {
    var gen = CHUNK - 2 * TRIM, pad = gen + TRIM - (n % gen), total = TRIM + n + pad;
    var step = Math.floor((1 - OVERLAP) * CHUNK), starts = [];
    for (var s = 0; s < total; s += step) starts.push(s);
    return { total: total, starts: starts };
  }

  // ---- section-at-a-time API (memory-light: the song is never copied whole) ----
  function sectionInput(L, R, st, total) {
    var n = L.length, end = Math.min(st + CHUNK, total), cL = new Float32Array(CHUNK), cR = new Float32Array(CHUNK);
    var a = Math.max(st, TRIM), b = Math.min(end, TRIM + n); // mixture = [TRIM zeros][song][zeros]
    if (b > a) { cL.set(L.subarray(a - TRIM, b - TRIM), a - st); cR.set(R.subarray(a - TRIM, b - TRIM), a - st); }
    return [cL, cR];
  }
  async function processSection(cL, cR, runModel) { return istftChunk(await runModel(stftChunk(cL, cR))); }
  function newAccumulator(n) { var t = plan(n).total; return { resL: new Float32Array(t), resR: new Float32Array(t), div: new Float32Array(t) }; }
  function accumulate(acc, st, out) {
    var total = acc.div.length, end = Math.min(st + CHUNK, total), actual = end - st;
    for (var i = 0; i < actual; i++) {
      var w = OVERLAP > 0 ? (actual > 1 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (actual - 1)) : 1) : 1; // np.hanning
      acc.resL[st + i] += out[0][i] * w; acc.resR[st + i] += out[1][i] * w; acc.div[st + i] += w;
    }
  }
  // vocals written into the accumulator's own buffers (no extra copies); returns 4 views
  function finish(L, R, acc) {
    var n = L.length, iL = new Float32Array(n), iR = new Float32Array(n);
    var vL = acc.resL.subarray(TRIM, TRIM + n), vR = acc.resR.subarray(TRIM, TRIM + n), d = acc.div.subarray(TRIM, TRIM + n);
    for (var i = 0; i < n; i++) {
      var dd = d[i] > 0 ? d[i] : 1;
      vL[i] /= dd; vR[i] /= dd;
      iL[i] = L[i] - vL[i] * COMPENSATE; iR[i] = R[i] - vR[i] * COMPENSATE;
    }
    return { vL: vL, vR: vR, iL: iL, iR: iR };
  }
  async function separate(L, R, runModel, onProgress) {
    var p = plan(L.length), acc = newAccumulator(L.length);
    for (var c = 0; c < p.starts.length; c++) {
      var inp = sectionInput(L, R, p.starts[c], p.total);
      accumulate(acc, p.starts[c], await processSection(inp[0], inp[1], runModel));
      if (onProgress) onProgress(c + 1, p.starts.length);
    }
    return finish(L, R, acc);
  }

  function chunkCount(n) { return plan(n).starts.length; }

  return { separate: separate, plan: plan, sectionInput: sectionInput, processSection: processSection, newAccumulator: newAccumulator, accumulate: accumulate, finish: finish, stftChunk: stftChunk, istftChunk: istftChunk, chunkCount: chunkCount,
           DIM_F: DIM_F, DIM_T: DIM_T, CHUNK: CHUNK, N: N };
})();
if (typeof module !== "undefined") module.exports = StemEngine;
