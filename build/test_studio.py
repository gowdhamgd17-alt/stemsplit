"""Automated Studio tests in Chromium with a fake microphone.
Loads synthetic tracks straight into the Studio (no AI run needed) so mixing math can be checked exactly."""
import json, sys, time
from playwright.sync_api import sync_playwright

SCR = "/tmp/claude-0/-home-claude/61988cfb-cdbd-5f34-b81b-6e79ef172970/scratchpad/"
URL = "http://127.0.0.1:8790/"
results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail)); print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else "")); sys.stdout.flush()

LOAD = """() => {
  const sr = 44100, n = sr * 6;
  const mk = (f, amp) => { const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr });
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * f * i / sr); } return b; };
  window.__inst = mk(110, 0.2); window.__voc = mk(880, 0.1);
  window.StemSplitStudio.load({ vocals: __voc, instrumental: __inst, name: "test_song", stopCards: () => {} });
  return document.getElementById("studio").hidden;
}"""
RENDER = """async (opts) => {
  const S = window.StemSplitStudio._state;
  const [L, R] = await window.StemSplitStudio._render(S.tracks, { solo: false });
  const sr = 44100, rms = (a, f, t) => { let s = 0; for (let i = f * sr | 0; i < (t * sr | 0); i++) s += a[i] * a[i]; return Math.sqrt(s / ((t - f) * sr)); };
  // project onto the two test tones to measure how much of each is in the mix (window 1..5 s)
  const amp = (a, f) => { let c = 0, s = 0; for (let i = sr; i < 5 * sr; i++) { c += a[i] * Math.cos(2 * Math.PI * f * i / sr); s += a[i] * Math.sin(2 * Math.PI * f * i / sr); } return 2 * Math.hypot(c, s) / (4 * sr); };
  return { len: L.length / sr, inst: amp(L, 110), voc: amp(L, 880), rmsTail: L.length / sr > 7.2 ? rms(L, 6.1, 7.1) : 0 };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                                f"--use-file-for-fake-audio-capture={SCR}fakemic.wav", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1200, "height": 900}, accept_downloads=True, permissions=["microphone"])
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(2500)
    check("studio hidden before results", pg.evaluate("document.getElementById('studio').hidden"))
    pg.evaluate(LOAD)
    check("studio shows after load with 2 tracks", pg.evaluate("!document.getElementById('studio').hidden && document.querySelectorAll('.st-track').length === 2"))

    r = pg.evaluate(RENDER); base = r
    check("mix keeps the 2:1 balance of instrumental to vocals", abs(r["inst"] / r["voc"] - 2) < 0.03, f"inst {r['inst']:.3f} voc {r['voc']:.3f}")
    check("master volume 90% (+ limiter makeup) applied", 0.85 < r["inst"] / 0.2 < 1.0, f"overall gain {r['inst']/0.2:.3f}")
    check("mix length equals track length", abs(r["len"] - 6.2) < 0.05, f"{r['len']:.2f}s")

    pg.fill("#st-xfade", "-1"); pg.dispatch_event("#st-xfade", "input")
    r = pg.evaluate(RENDER)
    check("crossfader left = vocals only", r["inst"] < 0.002 and abs(r["voc"] - base["voc"]) < 0.005, f"inst {r['inst']:.4f} voc {r['voc']:.3f}")
    pg.fill("#st-xfade", "1"); pg.dispatch_event("#st-xfade", "input")
    r = pg.evaluate(RENDER)
    check("crossfader right = music only", r["voc"] < 0.002 and abs(r["inst"] - base["inst"]) < 0.005, f"inst {r['inst']:.3f} voc {r['voc']:.4f}")
    pg.fill("#st-xfade", "0"); pg.dispatch_event("#st-xfade", "input")

    pg.locator(".st-track").nth(0).locator("button.st-tog").first.click()   # mute instrumental
    r = pg.evaluate(RENDER)
    check("mute removes track from mix", r["inst"] < 0.002, f"inst {r['inst']:.4f}")
    pg.locator(".st-track").nth(0).locator("button.st-tog").first.click()   # unmute
    pg.locator(".st-track").nth(1).locator("button.st-tog.solo").click()     # solo vocals
    r = pg.evaluate(RENDER)
    check("solo plays only that track", r["inst"] < 0.002 and r["voc"] > 0.08, f"inst {r['inst']:.4f} voc {r['voc']:.3f}")
    pg.locator(".st-track").nth(1).locator("button.st-tog.solo").click()

    pg.fill("#st-speed", "1.25"); pg.dispatch_event("#st-speed", "input")
    r = pg.evaluate(RENDER)
    check("speed 1.25x shortens the mix", abs(r["len"] - (6 / 1.25 + 0.2)) < 0.05, f"{r['len']:.2f}s expected {6/1.25+0.2:.2f}s")
    pg.click("#st-speed-reset")

    # effects: reverb on vocals adds a tail after the music ends
    pg.locator(".st-track").nth(1).get_by_role("button", name="Effects").click()
    pg.locator(".st-track").nth(1).locator("select").select_option("hall")
    r = pg.evaluate(RENDER)
    check("reverb preset adds a 3 s tail with sound in it", abs(r["len"] - 9.0) < 0.05 and r["rmsTail"] > 1e-3, f"len {r['len']:.2f}s, tail rms {r['rmsTail']:.5f}")

    # live playback + seeking by tapping a lane
    pg.click("#st-play"); pg.wait_for_timeout(1200)
    t1 = pg.evaluate("window.StemSplitStudio._state.pos")
    lane = pg.locator(".st-lane").first.bounding_box()
    pg.mouse.click(lane["x"] + lane["width"] * 0.5, lane["y"] + lane["height"] / 2); pg.wait_for_timeout(600)
    pg.click("#st-play"); pg.wait_for_timeout(200)
    pos = pg.evaluate("window.StemSplitStudio._state.pos")
    check("tap on lane seeks while playing", 3.0 <= pos <= 4.6, f"position {pos:.2f}s after tapping middle of a 6 s timeline")

    # A-B loop stays inside the loop region and runs gaplessly past several passes
    pg.evaluate("window.StemSplitStudio._state.pos = 1.0"); pg.click("#st-a")
    pg.evaluate("window.StemSplitStudio._state.pos = 2.0"); pg.click("#st-b")
    pg.evaluate("window.StemSplitStudio._state.pos = 1.0")
    pg.click("#st-play"); samples = []
    for _ in range(14):
        pg.wait_for_timeout(250); samples.append(pg.evaluate("(() => { const t = document.getElementById('st-time').textContent; const [m, s] = t.split(' / ')[0].split(':'); return +m * 60 + +s; })()"))
    pg.click("#st-play")
    check("A-B loop keeps playing inside 1.0–2.0 s for 3.5 s", all(0.9 <= x <= 2.1 for x in samples) and max(samples) - min(samples) > 0.6, f"positions {samples}")
    pg.click("#st-loop")

    # recording with the fake microphone (a 330 Hz tone)
    pg.evaluate("window.StemSplitStudio._state.pos = 0")
    pg.click("#st-rec"); pg.wait_for_timeout(3000)
    check("meter visible while recording", pg.is_visible("#st-meter"))
    lvl = pg.evaluate("parseFloat(document.getElementById('st-meter-fill').style.width)")
    check("microphone level shows signal", lvl > 20, f"meter {lvl:.0f}%")
    pg.click("#st-rec"); pg.wait_for_timeout(800)
    info = pg.evaluate("""(() => { const S = window.StemSplitStudio._state; const t = S.tracks.find(t => t.kind === 'take');
      if (!t) return null; const d = t.buffer.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return { n: S.tracks.length, dur: t.buffer.duration, offset: t.offset, rms: Math.sqrt(s / d.length), name: t.name, preset: t.preset }; })()""")
    check("take added as a new track", info is not None and info["n"] == 3, json.dumps(info))
    if info:
        check("take is about 3 s long with the mic signal", 2.5 < info["dur"] < 3.8 and info["rms"] > 0.01, f"{info['dur']:.2f}s rms {info['rms']:.3f}")
        check("take placed near the start (latency compensated)", -0.3 < info["offset"] < 0.3, f"offset {info['offset']*1000:.0f} ms")
        check("new take gets the chosen effect preset", info["preset"] == "studio")
    # download the take and the mix
    for name, loc in (("take", pg.locator(".st-track").nth(2).get_by_role("button", name="Download")), ("mix", pg.locator("#st-export"))):
        with pg.expect_download(timeout=30000) as d: loc.click()
        f = SCR + "studio_" + d.value.suggested_filename; d.value.save_as(f)
        import soundfile as sf, numpy as np
        a, sr = sf.read(f)
        check(f"{name} downloads as a playable WAV", sr == 44100 and a.ndim == 2 and np.abs(a).max() > 0.05, f"{d.value.suggested_filename} {a.shape[0]/sr:.2f}s peak {np.abs(a).max():.2f}")
    # added audio file becomes a track
    pg.set_input_files("#st-addfile", SCR + "Test Song.mp3"); pg.wait_for_timeout(1500)
    check("added audio file appears as a track", pg.evaluate("window.StemSplitStudio._state.tracks.some(t => t.kind === 'import')"))
    sw = pg.evaluate("document.documentElement.scrollWidth"); check("no sideways scroll on desktop", sw <= 1200, f"{sw}px")
    pg.screenshot(path=SCR + "studio_desktop.png", full_page=True)
    check("no page errors", not errs, "; ".join(errs[:3]))

    # phone layout
    for dev in ("iPhone SE", "Pixel 7"):
        c2 = b.new_context(**dict(p.devices[dev]), permissions=["microphone"]); p2 = c2.new_page(); e2 = []
        p2.on("pageerror", lambda e: e2.append(str(e)))
        p2.goto(URL); p2.wait_for_timeout(2500); p2.evaluate(LOAD); p2.wait_for_timeout(500)
        sw = p2.evaluate("document.documentElement.scrollWidth"); vw = p2.evaluate("innerWidth")
        check(f"{dev}: no sideways scroll", sw <= vw, f"{sw}px page vs {vw}px screen")
        p2.locator("#studio").screenshot(path=SCR + f"studio_{dev.replace(' ', '_')}.png")
        check(f"{dev}: no page errors", not e2, "; ".join(e2[:2]))
        c2.close()
    b.close()

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)} of {len(results)} checks passed")
