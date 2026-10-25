// StemSplit AI worker: runs UVR-MDX-NET Voc_FT with ONNX Runtime Web, one 3-second section at a time.
importScripts("ort/ort.webgpu.min.js", "engine.js");

let session = null;

async function run(spec) {
  const out = await session.run({ input: new ort.Tensor("float32", spec, [1, 4, StemEngine.DIM_F, StemEngine.DIM_T]) });
  const d = out.output.data;
  for (let i = 0; i < d.length; i += 997) if (!Number.isFinite(d[i])) throw new Error("bad_output");
  return d;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      ort.env.wasm.numThreads = m.threads || 1;  // >1 only when the page is cross-origin isolated
      ort.env.wasm.wasmBinary = m.wasm;
      ort.env.wasm.wasmPaths = { mjs: new URL("ort/ort-wasm-simd-threaded.asyncify.mjs", self.location.href).href };
      const opts = (ep) => ({ executionProviders: [ep], graphOptimizationLevel: "all" });
      let dev = null;
      if (m.tryGpu && self.navigator && navigator.gpu) {
        try { session = await ort.InferenceSession.create(m.model, opts("webgpu")); dev = "gpu"; } catch (err) { session = null; }
      }
      if (!session) { session = await ort.InferenceSession.create(m.model, opts("wasm")); dev = "cpu"; }
      self.postMessage({ type: "ready", device: dev, threads: ort.env.wasm.numThreads });
    } else if (m.type === "section") {
      const out = await StemEngine.processSection(m.cL, m.cR, run);
      self.postMessage({ type: "section", out }, [out[0].buffer, out[1].buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "error", stage: m.type, message: String((err && err.message) || err) });
  }
};
