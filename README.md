# StemSplit — Separate Vocals & Instrumentals

A free website that splits a song into two tracks with AI:

- **Vocals** – the singing voice on its own
- **Instrumental** – all the music without the voice

The AI (UVR-MDX-NET Voc_FT) runs **inside the visitor's browser** with ONNX Runtime Web, so songs are never uploaded and hosting costs nothing. It uses the device's graphics processor (WebGPU) when the browser supports it and all processor cores otherwise. Works on computers and phones.

## How it is hosted

A plain static site on [Render](https://render.com) (free tier). No build step, no server code, no database, no secrets.

| Setting | Value |
|---|---|
| Service type | Static Site |
| Build command | `echo "static site, nothing to build"` |
| Publish directory | `./` |

### Optional: faster first visit
The page enables cross-origin isolation (needed for multi-core processing) with a small service worker, `coi-serviceworker.min.js`, which reloads the page once on the very first visit. Sending the headers from the server instead avoids that reload. In the Render dashboard → the site → **Settings → Headers**, add two rules for path `/*`:

| Header | Value |
|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |

`render.yaml` contains the same settings for anyone deploying with a Render Blueprint.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole interface |
| `engine.js` | Spectrogram (STFT) maths and section processing, shared with the worker |
| `worker.js` | Background worker that runs the AI model |
| `model/voc_ft_flex.part0-4.wasm` | The AI model (66.8 MB ONNX file split into parts; `.wasm` only so every host serves it as raw bytes) |
| `ort/` | ONNX Runtime Web 1.30.0 (MIT) |
| `fonts/` | Familjen Grotesk, IBM Plex Sans, IBM Plex Mono (SIL Open Font License, via Fontsource) |
| `samples/` | 30-second excerpt of “Let’s Go Fishin’” by Karissa Hobbs, CC BY 3.0 |

## Tested
- Separation quality measured against known stems (real speech mixed with real drums, bass and keys): vocal SDR 15.2 dB; music with no voice gives a vocal track about 50 dB quieter than the music.
- The browser engine matches the Python reference implementation to −60 dB.
- Full run, playback and WAV downloads tested in Chromium, plus layout and file-picker taps in iPhone and Android emulation.

## Credits
- Model: UVR-MDX-NET Voc_FT, from the [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui) project.
- Inference: [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
- Cross-origin isolation helper: [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (MIT).

Only process audio you own or have permission to use.
