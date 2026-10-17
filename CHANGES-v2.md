# dashcam-studio-v2 — Phases 0–3

Rollback: `git checkout baseline-v1` (original), or `git checkout phase1-batching` / `phase2-key-import` / `phase3-library-index`.
Return to latest: `git checkout feature/library-index-and-fixes`.

- Phase 1 (`js/batching.js`): key requests are grouped into 4- or 6-angle sessions and sent ≤30 per request, one batch at a time; a refused batch is reported and the rest continue. Used by the connector (v1.4.0 — reinstall it), the console helper, and the in-app token fetch.
- Phase 2 (`js/key-import.js`): "Import keys or token" box in the Unlock dialog — keys file, pasted keys JSON, or Bearer token. Manual console method stays open beneath it.
  Limitation: a Bearer token fetch from the app's own page only works if Tesla allows cross-site requests (CORS); otherwise the app says so and the helper/connector is the path.
- Phase 3 (`js/lib-index.js`, `js/lib-index-ui.js`): IndexedDB metadata index (no video, no keys), All / Undecrypted / Already decrypted filter, remembered-events panel with reviewed checkbox, Clear index. Falls back to memory-only if IndexedDB fails.
  Limitation: browsers can't reopen a folder without you picking it again, so remembered events show as "not loaded" until you reopen the folder; encrypted clips need keys again after a reload (keys are never stored).

Tests: `node test/batching.test.js`; headless: test/smoke.js, test/phase2.js, test/phase3.js, test/helpertest.js.

## Saved keys (tag phase3-saved-keys)
Opt-in "Remember keys on this device" in the Unlock dialog (OFF by default). Keys go in IndexedDB "tdc-saved-keys",
keyed by each clip's wrapped-key fingerprint from its encrypted header. They are saved from every route and re-applied
when a folder is opened. "Forget saved keys" wipes them; Clear index does not. Without IndexedDB: nothing is saved.

## Phase 4: unified search, mobile-first (branch feature/phase4-search, tag phase4-search)
Rollback: `git checkout pre-phase4` (main before Phase 4). To switch the new UI off without code: Settings ▸ Search ▸ Classic search bars, or `?search=classic`.

- `js/search-ui.js` (new) and CSS at the end of `css/app.css`: one floating search for Find (object/scene) and Redact (text/plates/faces).
  - It's an icon by default. Tap it, or press `/` or Ctrl/Cmd+K, to expand it; Esc closes it (captured first, so Esc doesn't also leave a focused camera).
  - Results appear in a light dropdown grouped as Find matches and Blurred text/regions, each with a time.
  - Picking a Find match uses search.js's own jump (seek, switch camera, gold box). Picking a text region seeks, focuses that camera and flashes a gold outline around the region.
  - Phones and narrow or touch screens get a bottom sheet with `position: fixed`, kept above the keyboard with `visualViewport`. It sets `interactive-widget=overlays-content` while open so Android doesn't resize the page. The grid isn't reflowed. The input font is 16px so iOS doesn't zoom.
  - It drives the classic bars' inputs and buttons. search.js, redact.js, decryption, grid, export, key flows and the connector are unchanged (index.html adds one script tag; app.js adds one guarded init call).
  - Fallback: init runs in try/catch. On failure it removes anything half-built and never adds `body.usearch`, so the classic Find and Redact bars stay visible. The "Classic search bars" setting (localStorage `tdc.classicSearch`) shows them on purpose.
- Test: `node test/phase4-search.js http://127.0.0.1:8770/index.html` (desktop 1440×900 plus iPhone 390×844 with touch and a simulated keyboard; covers shortcuts, jumps, Classic toggle, and two forced-failure fallbacks).
- Screenshots: `screenshots/phase4-before-*.png` and `phase4-after-*.png`.

## Mobile portrait grid (branch feature/mobile-portrait-grid, tag mobile-portrait-grid)
Rollback: `git checkout pre-mobile-portrait` (Phase 4 without this) or `pre-phase4`.

- Portrait means portrait orientation on a window ≤ 900px wide, or a touch tablet ≤ 1366px wide (so iPad Pro is included). It's decided by the window size, not the device model, and updates live on rotation.
- Order: Front | Back, Left pillar | Right pillar, Left repeater | Right repeater. 4-angle cars (no pillar cameras) get 2 rows with no empty slots. If only one pillar file is missing, its slot is kept so the rows don't shift.
- Tiles are always (width − gaps)/2 at the camera's own aspect ratio. When 3 rows don't fit above the controls, the camera area scrolls vertically (`overflow-y: auto`, momentum, `overscroll-behavior: contain`) and the controls stay pinned. A focused camera always fits and doesn't scroll, so pinch/pan isn't fought. Safe-area insets are respected.
- Landscape and desktop are unchanged. This is display-only: export doesn't read the live layout. The new code paths are wrapped in try/catch and fall back to the previous layout.
- Code: `js/focus.js` (portrait query, 4-angle collapse), `js/ui.js` (`U.fit` doesn't shrink in portrait and toggles `body.portrait-scroll`), and CSS at the end of `css/app.css`.
- Test: `node test/portrait-grid.js http://127.0.0.1:8770/index.html` (79 checks: iPhone SE 1st gen 320×568, SE 375×667, 15/16 393×852, Pro Max 430×932, iPad 820×1180, each in portrait and landscape; 6/5/4-angle events; scrolling, pinned controls, rotation, focus, search sheet; desktop unchanged).
- Screenshots: `screenshots/mobile-*.png`.

## Insecure-origin fix (tag mobile-search-insecure-fix)
- **Problem:** on `http://<Mac LAN IP>:port` (the phone test setup) the page isn't a secure context, so the Cache Storage API (`caches`) and `navigator.clipboard` don't exist. search.js forced transformers.js `env.useBrowserCache = true`, so it threw "Browser cache is not available in this environment", and the message wrongly blamed the internet.
- **Fix in search.js:** probe `isSecureContext` and `caches.open()` before loading. When there's no cache, set `useBrowserCache = false` and load the model from the network for that session. The status says "Model cache unavailable on this connection (not https), so the model is downloaded again each visit." Errors now say whether storage, network or memory is the problem.
- **Fix in tesla-auth.js:** Copy connector / Copy helper fall back to a selected textarea plus `execCommand("copy")`. Clipboard auto-apply already skipped cleanly when there's no clipboard.
- **Checked and unchanged:** Redact/OCR is vendored and uses no cache. Face blur uses the native FaceDetector or MediaPipe from the CDN, with no cache. IndexedDB (library index, saved keys) works on http.
- **Test:** `node test/insecure-origin.js http://<non-localhost-ip>:PORT/index.html`.

## Camera bar dock (tag camera-bar-dock)
Rollback: `git checkout mobile-search-insecure-fix`, or set the camera bar back to "On video".

- New pref `cameraBar.dock` ("over" by default, or "beside") plus `cameraBar.side` ("top" or "bottom"). It follows the map's Beside video pattern: a button on the bar (**Beside video** / **On video**) and Settings ▸ Camera bar (a checkbox and Above/Below). It's remembered in prefs.
- When docked, the bar moves into `#barDock`, a strip glued to the stage's top or bottom edge. `U.fit` reserves its height and shifts the stage, so the bar never covers a camera. Dragging the ⋮⋮ grip up or down past the middle of the video switches sides. Camera switching, focus zoom buttons and Hide all work from the dock. The bar doesn't fade when idle because it's off the video.
- Phones: in portrait the strip sits above or below the grid and the tiles keep their full half-width (the grid scrolls if needed). In landscape the desktop arrangement is kept. Works together with the map docked beside.
- Export is unchanged (it never drew the camera bar). If docking fails, it falls back to "over".
- Test: `node test/camera-bar-dock.js http://127.0.0.1:8770/index.html`.

## Burn detection boxes in export (tag burn-detection-boxes)
Rollback: `git checkout pre-burn-boxes` (= camera-bar-dock, 308c8f5), or just leave the checkbox off.

- New `js/burn-boxes.js` and an Export dialog checkbox **Burn detection boxes** (OFF by default, saved in localStorage `tdc.export.burnBoxes`; works in Simple and Advanced mode).
- When on, `compositor.drawFrame` draws the gold box plus a label onto each camera tile of exported frames, using the same data the viewer overlay uses (`TDC.search.hits` with a located `.box`, kept on screen for ±2.5 s like the viewer). Boxes are mapped through each tile's own contain-fit, so they line up at any export size.
- Label = class name + confidence. Phase 4 text-search hits use the search phrase and a relative match % (score ÷ best result, since CLIP scores aren't probabilities). Future detector hits with `{cls|label, conf}` show e.g. "car 92%".
- Readability: line width and font scale with tile height (min 11 px), dark outline on the box, dark background plus black outline behind the text, clipped to the tile.
- No box near a frame → nothing drawn. Missing or malformed detection data → nothing drawn, no error. Redaction blur is drawn first, then the boxes.
- Test: `node test/burn-boxes.js http://127.0.0.1:8770/index.html` (set `SHOTS=path.png` to save an example frame).

## Connector 1.4.4: home-network players (tag connector-lan-origins)
Rollback: `git checkout pre-connector-lan` (= burn-detection-boxes, 52743c3), then reinstall connector 1.4.3.

- Fixes "Connector refused: player origin http://192.168.x.x:PORT is not in ALLOWED_PLAYER_ORIGINS". `originAllowed` = the explicit allowlist (localhost, shinrajp.github.io) **or** the new `isPrivateOrigin()`.
- `isPrivateOrigin()` parses with `URL` and needs the string to be exactly the canonical origin (no path, no user info, no hex or short IPv4 forms). It accepts http/https, any port, for localhost, `[::1]`, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (numeric octets ≤ 255) and `*.local` mDNS names. Lookalikes such as `192.168.1.1.evil.com`, `192.168.1.1@evil.com` and `evil.local.com` are refused.
- Unchanged: one-time nonce handshake and opener/origin checks; the Tesla token is still only posted to localhost players.
- Version 1.4.4 in `@version`, the guard and the badge; `js/connector-src.js` regenerated (`node tools/embed-connector.js`); README and Unlock help updated.
- Reinstall: https://raw.githubusercontent.com/shinrajp/dashcam-studio/feature/burn-detection-boxes/connector/Tesla-Grid-Player-Connector.user.js
- Test: `node test/connector-origins.js` (no browser needed).

## Live detection labels on the gold box (tag live-detection-labels)
Rollback: `git checkout pre-live-labels` (= connector-lan-origins, 858059d).

- The viewer's gold box now shows the same label as the export burn-in (search phrase + relative match %, later Phase 5 class + confidence), via the new shared `TDC.burnBoxes.forHit()` and `TDC.burnBoxes.draw()`. The old "Camera · phrase" tag is gone; the tile's own camera label still shows the camera.
- Font and line width scale with the tile (12 px minimum on screen). Dark outline on the box, dark background + outline behind the text. The label sits above the box, or below it when the box touches the top edge, and is clipped to the picture inside the tile. Retina sharp (canvas at devicePixelRatio, max 2).
- The overlay canvas keeps `pointer-events: none`, so it never blocks the tile buttons or the camera bar. It works with the camera bar on the video or docked beside it, and in the phone portrait grid.
- If `burn-boxes.js` is missing, the viewer falls back to the plain gold box. The "Gold box" checkbox still hides it.
- Test: `node test/live-labels.js http://127.0.0.1:8770/index.html` (desktop, bar docked, iPhone portrait, fallback; `SHOTS=file.png` saves screenshots).

## Phase 5: object detection (tag phase5-detection)
Rollback: `git checkout pre-phase5` (= live-detection-labels, 355b10b), or leave Settings ▸ Object detection off (the default). With it off, nothing new loads.

- `js/detect-worker.js`: YOLO11 in a Web Worker (onnxruntime-web 1.22 from jsDelivr). Tries WebGPU first, but skips software adapters (SwiftShader/llvmpipe), which were about 25× slower than WASM in testing; otherwise uses WASM. Input is a 640 letterbox; output is decoded with class-wise NMS. Models are cached in IndexedDB `tdc-models` (works on insecure http), and cache errors are ignored.
- `js/gdino-worker.js`: experimental Grounding DINO tiny via transformers.js 3.8.1 (module worker; q4f16 on WebGPU, int8 on WASM). Not exercised in the automated tests.
- `js/detect.js`: settings (`tdc.detect.v1`: enabled=false, model nano on phones / small on desktop, conf 0.35, live=false, optional custom `urls`), COCO class and synonym matching, worker RPC, greedy IoU tracker with linear interpolation, `boxesAt(cam, t)`, detector search, throttled live detection, and the Settings UI (model picker, toggle, threshold, live toggle, status with the backend, "Load model now").
- `search.js`: class-name queries go to the detector when it's enabled; any failure falls back to the CLIP search. Opening a hit tracks the object ±2.5 s (0.25 s steps on desktop, 0.5 s on phones, 25 s time budget), and CLIP hits get a box that follows too. The viewer draws tracked or live boxes through `burnBoxes.draw`.
- `burn-boxes.js`: `at()` prefers tracked boxes, so export shows the same moving boxes and labels ("car 91%").
- `models/yolo11n.onnx`, `models/yolo11s.onnx`: exported from the official Ultralytics weights; AGPL-3.0, see models/README.md.
- Measured in headless Chrome on the box CPU (WASM, 1 thread, 640×640): nano about 0.33 s per frame, small about 1.2 s per frame, model start under 1 s. A real "car" search over 25 frames took 9.6 s. Software WebGPU: nano 9 s, small 17 s per frame (hence the skip).
- Test: `node test/phase5-detection.js http://127.0.0.1:8770/index.html` (unit, settings, mock end-to-end, failure, real nano + small; `REAL=0` skips the real part; `SHOTS=dir` saves phase5-*.png).

## Phase 5 fix: worker "script error", honest labels, small objects (tag phase5-worker-fix)
Rollback: `git checkout pre-phase5-fix` (= phase5-detection, 3180065).

- **Root cause (reproduced):** with a static server that sends `.js` as `text/plain` (Windows `python -m http.server` can do this when the registry maps .js oddly, and so can some NAS servers), WebKit/Safari refuses to start `new Worker("js/detect-worker.js")`. The worker's error event carries no message, so the app showed "Detection worker failed: script error", and tracking (and detector search) fell back to the picture search. Reproduced with `test/serve-badmime.js` on a non-localhost http IP in Playwright WebKit with the old code; Chromium tolerated it. The same failure follows from `.mjs`/`.wasm` MIME types for the runtime, or from a blocked jsDelivr.
- **Fix:** the worker source is fetched and started from a `blob:` URL (with fallback to `new Worker(url)`). onnxruntime-web 1.22 is vendored in `vendor/ort/` (wasm build 11 MB, WebGPU/JSEP build 22 MB; CDN only as backup). The worker fetches the runtime files as bytes and loads them from typed blob URLs (`wasmPaths: {mjs, wasm}`; the runtime files are also cached in IndexedDB). `numThreads` = 1 unless `crossOriginIsolated`.
- Real error messages everywhere: the worker posts `fatal` for uncaught errors/rejections; `onerror` includes the file/line, or says the script couldn't start and how it was loaded. Example: "couldn't fetch ort.wasm.min.js: HTTP 404 …".
- The companion server now serves `models/` and correct `.mjs`/`.wasm` types.
- **Labels:** picture-search (CLIP) hits no longer show a fake confidence. They read "phrase? (best match)" or "phrase? (match)". When the tracker follows a picture-search box onto an object of another class, the label stays "umbrella? (match)" instead of borrowing the car's "83%". Detector results keep "car 91%".
- **Small objects:** `D.SMALL` classes (umbrella, backpack, handbag, traffic light, stop sign, …) use 60% of the threshold (35% → 21%). If the full frame has none, the search looks at 2×2 overlapping 60% tiles (merged with NMS); tracking reuses tiles for tiled hits. Setting: Small objects Auto / Always zoom / Off.
- Measured on `test/fixtures/small-umbrella-*.png` (a public-domain umbrella pasted into a sample frame, threshold 21%), full frame → tiles: nano 70 px 0→49%, 45 px 0→36%, 30 px 0→0 (missed); small 70 px 40→70%, 45 px 0→85%, 30 px 0→42%.
- Tests: `node test/phase5-worker.js <localhost url> <LAN bad-MIME url>` runs Playwright Chromium and WebKit through three cases: localhost, LAN http with wrong MIME types (`node test/serve-badmime.js . 18792`), and a blocked CDN. It also checks error text, labels and umbrella recall. burn-boxes/live-labels tests and screenshots are updated for the new labels.

## Phase 6: plates & street names, on this device (branch feature/phase6-plates-ocr, tag phase6-plates-ocr)
Rollback: `git checkout pre-phase6` (= phase5 worker fix, 780a481), or leave Settings ▸ Plates & text off (the default). With it off, nothing new loads and searches route exactly as before.

- `models/plates/`: open-image-models YOLOv9-tiny licence-plate detector (384 and 640, "end2end" with NMS in the graph, MIT) and fast-plate-ocr CCT-S v2 global reader (MIT). See models/README.md for sources, checksums and the US/California check.
- `js/detect-worker.js`: decodes `[N, 7]` end2end outputs; new `loadOcr`/`ocr` messages run the reader on a batch of 128×64 crops (uint8 NHWC) and return per-slot probabilities. The COCO path is unchanged.
- `js/plate-text.js` (pure, node-testable): `decode` (argmax + runner-up per slot), `normalizeCA` (1ABC234 with second-choice / look-alike fixes and lower confidence for fixed characters; gives up after 2 fixes), `parseQuery`, `matchPlate` (exact 1.0, partial 0.9, wildcard 0.95, look-alike 0.85/0.8, one edit 0.7, two edits for 7+ chars 0.5), `matchText` (street words, abbreviations, OCR without spaces).
- `js/lib-index.js`: `TDC.libIndex.text` in its own IndexedDB database `tdc-text-index` (keeps the events DB at version 1 so older branches still open it). One record per event: `{eventId, at, cams, step, street, model, items:[{kind, text, raw, conf, det, chars, format, cam, t, box}]}`. Memory fallback when IndexedDB fails.
- `js/plates.js`: own worker (same blob/MIME-proof start as Phase 5, models cached in IndexedDB), plate detect (+ optional 2×2 tiles) → crop → read → normalise; street text through `redact.readSigns` every ~2 s; event scan (1 s steps, at most 120 frames on phones / 360 on computers); search rows for search.js; plate tracking ±2.5 s for the gold box; blur tracks per camera (IoU tracker, interpolated) for preview and export; `exportPrep` scans all cameras before an export with blur on; Settings UI.
- `js/redact.js`: `readSigns()`; "Blur plates" uses the real detector when Plates & text is on (text-shape guess otherwise or on failure); `burn()` and the live layer also paint plate blur boxes.
- `js/search.js`: plate/street queries go to plates.js first (only when enabled), hits list shows the reading; plate hits are tracked with the plate detector. `search-ui.js` shows the reading too. `ui.js`: one guarded `exportPrep` call before export (failure → toast, export continues without plate blur).
- Measured (headless Chrome, box CPU, WASM 1 thread): on 5 synthetic CA-style plates 36–92 px wide, Fast and Accurate both found 5/5 (IoU 0.75–0.96) and read 5/5 exactly, no false plates; Fast 115 ms detect + 82 ms read per frame, Accurate 297 + 80 ms. Event scan 16 frames in 7.9 s. Street sign "Palm Ave" read as "PalmAve." (matched) in 1.4 s per frame. Real export: plate area sharpness 36.3 → 2.6 with blur.
- Tests: `node test/plate-text.test.js`; `node test/phase6-plates.js http://127.0.0.1:8796/index.html` (needs ffmpeg; builds /tmp/plate-samples); `node test/phase6-webkit.js <localhost url> <LAN bad-MIME url>` (Chromium + WebKit; localhost, wrong-MIME LAN http, offline). Screenshots: `screenshots/phase6-*.png`.
- Limitations: tested on synthetic plates and still photos, not yet on your footage or iPhone. Very small or far plates (< ~30 px wide), night glare, motion blur and angled plates will be missed or misread. Plates between sampled frames that appear for < 1 s may be missed by the blur. Street-name reading is slow and fussy (sign must be large and clear).

## Phase 6B: optional cloud boost (tag phase6-cloud-boost)
Rollback: `git checkout phase6-plates-ocr` (Part A only), or leave Settings ▸ Cloud boost on **Off** (the default). With it off, nothing is sent and searches route exactly as in Part A.

- `js/cloud-boost.js` (`TDC.cloud`): provider picker Off / Grok (xAI) / Claude (Anthropic) / Gemini (Google); the user's own key in sessionStorage, or localStorage with "Remember key"; consent dialog before the first send per provider (host, "frames leave this device", billed calls, estimate); rate limit (one at a time, ≥ 1.5 s, max calls per run, default 12); JPEG ≤ 1024 px (plate crops ≥ 320 px); prompts ask for JSON with normalised `[x,y,w,h]`; parser also takes Gemini `box_2d` (0–1000, y first) and ```json fences; only Claude `text` blocks are read (adaptive thinking ignored). Readable 401/403/404/429/network errors.
  - xAI: `POST https://api.x.ai/v1/chat/completions`, Bearer, `image_url` data URI, default `grok-4.3`.
  - Anthropic: `POST https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, base64 image block, default `claude-haiku-5-5`.
  - Google: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, `x-goog-api-key` header (never in the URL), `inline_data`, `responseMimeType: application/json`, default `gemini-3.5-flash-lite`.
- Use 1, `recheckPlates`: weak readings (below "trust readings above") are grouped per camera/plate/~4 s; one crop per group goes to the provider; its answer is stored as `item.cloud` and replaces `item.text` (the local text kept as `item.localText`). Results show "· checked by …". Button: "Re-check N weak plates with …" under the classic and floating search status.
- Use 2, `find`: `ask <anything>` in search (only when a provider is picked) sends evenly spaced frames per camera (≈ one per 2 s, capped by calls per run) and turns the JSON boxes into hits (label, text, confidence, provider). No local tracking for these hits.
- `companion/lib/server.js`: optional `POST /api/cloud` relay (token required; only https POSTs to the three API paths; only auth/content headers forwarded; no redirects; nothing stored or logged). Used only when the app runs in the companion and "Use companion" is ticked.
- CORS checked Oct 16, 2026 with preflight requests from a browser origin: api.x.ai `*`, api.anthropic.com `*` (with the direct-browser header), generativelanguage.googleapis.com echoes the origin for `content-type, x-goog-api-key`. So the relay isn't needed today.
- Tests: `node test/phase6-cloud.js http://127.0.0.1:8796/index.html` (off by default, key storage, consent/cancel, request shapes and headers per provider, rate limit, downscale, parsing incl. box_2d and thinking blocks, 401 and network errors, weak-plate re-check end to end, Forget, key never sent to any other host, playback still works); `node test/companion-cloud.test.js` (relay allowlist); `test/phase6-webkit.js` now also makes a mocked call to each provider from Chromium and WebKit (localhost, wrong-MIME LAN http, offline CDNs). **All provider responses are mocked; no real API keys were used.** Screenshots: `screenshots/phase6-cloud-*.png` (boxes in them come from the mock).
- Limitations: not tried with real keys or real billing; model names change often (editable in Settings); provider answers can be wrong or refuse; frames from `ask` are sampled (≈ every 2 s), so short moments can be missed; cloud boxes aren't tracked or used for export blur.

## Search window: dock below video, float, pin + phone thumbnail strip (branch feature/search-float, tag search-float)
Rollback point: tag `pre-search-float` (= feature/phase5-detection 780a481).
- `js/search-ui.js`: the search panel now defaults to **docked below the video** in normal page flow (`#usDock`, between the video area and the transport), so `ui.fit()` sizes the grid into the remaining height and it never overlaps a camera. Header: grip, **Float/Dock**, **Pin**, close. Floating = `position: fixed` window, dragged by the header with pointer events (mouse/pen/touch, pointer capture), clamped to the (visual) viewport, CSS-resizable, arrow keys on the grip. Pin disables drag/resize/keys. Mode/x/y/w/h/pinned in `localStorage["tdc.searchPanel.v1"]`; saved position is kept and only clamped for display, so it returns when the viewport grows. Tap-outside-to-close removed. Phone typing: the docked panel becomes the existing above-keyboard sheet while a spacer keeps the grid unchanged.
- `js/search-strip.js` (new): phones (≤760 px, or coarse pointer ≤1024 px), full screen or one focused camera: collapsible strip with Results (lazy 96 px JPEG thumbnails, one hidden `<video>`, sequential, max 40 cached, object URLs revoked on clear/event change, decoder released when idle) and Cameras (throttled drawImage snapshots from the live tiles). Tap → `searchUI.select` → seek + camera + gold box. Collapsed/tab saved in `tdc.searchStrip.v1`. Init failure → no strip, nothing else affected.
- `js/search.js`: exposes `openHit`/`renderHits` (used when the classic hit buttons are absent).
- Tests: `test/search-float.js` (Chromium + WebKit). `phase4-search.js` and `portrait-grid.js` updated for the docked default (no bottom sheet until typing, no tap-outside close).
- Limits: playwright WebKit can't emulate a coarse pointer, so phone-landscape detection there is stood in by the test; real iPhone not tested. Sideways on a phone the strip overlays the bottom of the video while the controls are showing.

## 360 view prototype (tag panorama-360-proto)
Rollback: `git checkout pre-panorama-360` (= phase5-worker-fix, 780a481). With the 360 toggle off, the app behaves exactly as before.

- `js/pano-toggle.js` (always loaded, tiny): the **360** button; lazy-loads `js/pano.js` on first use.
- `js/pano.js`:
  - A WebGL2 renderer, with a WebGL1 fallback, draws one full-screen triangle strip. It uses six video textures with per-camera rotation (yaw·pitch·roll), a lens model (Kannala–Brandt θ(1+k1θ²+…+k4θ⁸) or rectilinear), principal point, and mirror.
  - Overlaps are feather-blended by edge distance × angular weight. Blind spots are dark.
  - Two views: look-around (drag, pinch, wheel, optional DeviceOrientation gyro) and flat equirect. The mode is saved in `tdc.pano.view.v1`.
  - Estimated defaults (yaw/pitch/FOV): front 0/−3/70 rect; back 180/−18/125 fisheye; pillars ±58/−6/90; repeaters ±132/−8/85. Mounting positions are stored but not used (no parallax correction).
  - Calibration panel (Advanced): per-camera sliders, lens and mirror, saved in `tdc.pano.calib.v1` and sanitised, with JSON export/import and reset.
  - Performance: phones render at ×0.5 resolution, width ≤1280, ≤30 fps. Nothing is drawn while paused and unchanged, or while the tab is hidden. The view turns off when another event opens.
- Export: new Advanced preset "360 equirectangular (beta)" at 2048×1024, stepping down to 1920×960 and 1440×720. It uses H.264, then VP9, then AV1, through the same WebCodecs path (`encodeOnce` with `cand.equirect` → `T.pano.drawEquirect`). Overlays are not drawn. There is no spherical metadata (the README points to Google's Spatial Media Metadata Injector). The grid export is unchanged.
- Test: `node test/panorama-360.js http://127.0.0.1:8770/index.html` (`SHOTS=dir` → panorama-look, panorama-equirect, panorama-equirect-view, panorama-calibrate, panorama-mobile). It checks lazy loading, WebGL2/WebGL1 compile, non-black renders, projection maths, the dark blind spot, calibration, toggle off restoring the grid, no rendering while off, 360 export at 2:1, regular export, and phone resolution.
- Limitations: the sample clips are synthetic single photos per camera, so seams in the screenshots don't line up (real footage + calibration needed). Auto-refine is a TODO. Not tested on a real iPhone or GPU, only headless SwiftShader.
