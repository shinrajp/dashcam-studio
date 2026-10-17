# Tests
- `node test/batching.test.js` — unit tests for session-aware batching (4/6-angle, >30 files, rejected batch).
- `test/smoke.js`, `test/helpertest.js` — headless Chrome smoke tests (need `npm i puppeteer-core` and Chrome; serve the app with `python3 -m http.server 8770`). Fixture clips: synthetic MP4s named like TeslaCam files under /workspace/fixtures (not included).
- `test/plate-worker.js` — Playwright (Chromium + WebKit): plate worker start with detection off / plates on, served by plain `python3 -m http.server` on localhost and LAN; WASM on Safari, readable errors, retry after a killed WebGPU start. `node test/plate-worker.js` (starts its own server on PORT=8782).
- `test/hud-front.js` — Playwright (Chromium + WebKit, desktop + phone): HUD, self-driving badge and time stay visible on top in every view (one camera, subset, front hidden, full screen, gold search box / detector boxes, phone strip) and are burnt into export frames.
