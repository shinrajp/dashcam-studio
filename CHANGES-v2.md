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

## All-in-one test branch (branch feature/all-in-one, tag all-in-one)
Rollback point: tag `pre-all-in-one` (= feature/phase6-plates-ocr f70d6b9).
- Built from feature/phase6-plates-ocr, then normal merge commits (no rebase) of feature/search-float (1f9f4cd) and feature/panorama-360 (3bc60ee, which includes the generic-LAN-address scrub in test/connector-origins.js). All three branched from 780a481.
- Conflicts were all additive (both sides appended): CHANGES-v2.md (both merges), README.md (Phase 6 sections + 360 section), css/app.css (search window/strip rules + 360 rules), index.html (plate-text/plates/cloud-boost scripts + pano-toggle). Resolved by keeping both sides; js/search.js, js/search-ui.js, js/ui.js and js/app.js merged automatically.
- Integration fix: the phone thumbnail strip labels plate / street-text results with the reader's text (e.g. "7ABC234 91% · checked by Grok") instead of the generic class label.

## Plates: match %, Best match, "Best match only" filter (tag plate-bestmatch)
Rollback point: tag `pre-plate-bestmatch` (= feature/all-in-one e3f6081).
- `js/plates.js`: rows carry `match` (text similarity to the query), `conf` (read confidence) and `score = match × read` (read only for `plates` / empty `street`). `cluster()` merges every row with the same reading (canonical look-alike form for plates, normalised words for street text) into one hit at its best sighting, with `sightings` (distinct camera / >2 s). The top score, and any other reading within `BEST_EPS` = 0.02, get `best`. `labelText()` builds the shared label `7ABC234 · match 100% · read 91% · checked by Grok · seen 2× · Best match` into `hit.text` / `hit.boxText`.
- Same label everywhere: results list and classic bar (`hit.text`), live gold box and export burn-in (`burnBoxes.labelFor` prefers `hit.boxText`), tracked plate boxes (`detect.boxesAt` prefers the hit's `boxText`), phone strip.
- `js/search.js`: `S.allHits` keeps every plate/street result, `S.hits` is the shown set; `S.setBestOnly()` / `S.bestOnly()` (`localStorage["tdc.search.bestOnly"]`) filters it and drops tracks of hidden hits, so list, gold box, timeline, strip and burn-in follow it. A plate search opens the best match first.
- UI: **Best match only** checkbox in the search panel (docked/floating; only shown for plate/street results), **★ Best only** button in the phone strip; best rows get a ★.
- Tests: new `test/plate-bestmatch.js` (Chromium + WebKit, injected index). `phase6-plates.js` expects the merged result and new label.
- Limits: merging is by reading, so two different cars with the same misread collapse into one result (other sightings still listed via "seen N×" but only the best is boxed). Street-text results get the same treatment. The filter doesn't affect plate blurring.

## Plate worker fix: "Plate worker failed: could not start" in Safari (tag plate-worker-fix)
Rollback point: tag `pre-plate-worker-fix` (= feature/all-in-one e82b124).
- Root cause: on a Mac (Apple Silicon) Safari has WebGPU, so the plate worker picked onnxruntime-web 1.22's WebGPU/JSEP build (21 MB wasm). In Safari/WebKit 26+ that build runs away with memory/CPU and the browser kills the worker (onnxruntime issue #26827). A killed worker fires a bare `error` event with no message, so plates.js showed "could not start". Headless WebKit on Linux has no WebGPU, so it always took the WASM path and worked, which is why the tests missed it. The worker file, models and MIME handling were fine.
- `js/worker-start.js` (new, loaded before detect.js): one blob-URL, MIME-proof `start()` used by both detection and plates (plates no longer rely on `T.detect.makeWorker`), `gpuOk()` (false on Safari/WebKit and all iOS browsers; `localStorage["tdc.webgpu"]` = on/off overrides) and `describe()` for bare worker errors.
- `js/detect-worker.js` posts `{type:"stage"}` before each step (runtime download, runtime start, model start on WebGPU/WASM, plate reader, ready). Its own errors were already posted with their text.
- `js/plates.js` / `js/detect.js`: a bare `error` waits 400 ms for the worker's own `fatal` report, then names the stage ("the browser stopped the worker while starting the model on WebGPU …") or, if the script never ran, "the worker script could not start (blob / file …)". A plate worker killed during WebGPU start is retried once on WASM. A worker killed after loading is reset so the next scan starts a new one. Detection now also uses WASM on Safari.
- Test: `test/plate-worker.js` (Chromium + WebKit). It serves the app with plain `python3 -m http.server` on localhost and the LAN address, with detection off and plates on. It covers: real model load and a frame, only one worker, WebKit asking for WASM, UA policy, override, simulated kill on WebGPU (retry) and on WASM (stage named), missing runtime (404 text), a throwing worker script (its message), and a missing worker file.
- Limits: real Safari WebGPU can't be run headless on the box, so the kill is simulated; the fix avoids that path. Safari gets WASM speed (about 0.3 s per frame on Accurate).

## Vehicle details (beta): colour, bus type, police / ambulance / fire, make & model (tag vehicle-attrs)
Rollback point: tag `pre-vehicle-attrs` (= feature/all-in-one feb6ce7).
- Two stages on device: YOLO11 boxes (car / bus / truck) → per-crop attributes. `js/vehicle-attrs.js` (pure, unit-testable): query parser, 12 named colours from centre-weighted pixels (two-tone kept as a second colour; *low light* when dark or sodium-orange), 16 types/roles with CLIP prompt ensembles, 26 makes / ~90 models. `js/vehicle.js` (`TDC.vehicle`): settings, IndexedDB index `tdc-vehicle-index` (boxes + numbers only, memory fallback), CLIP crops (reuses `TDC.search.clip`, the picture-search model), scoring, Best match clustering, shared label, live colour labels.
- Search: queries with a colour, type or make go to Vehicle details when it is on (plain `car` still goes to the detector). Query chips (`#findChips`, `#usChips`) show the parsed query for vehicle, plate, detector and picture searches. When it is off, a vehicle-like query keeps the picture search and gets a tip.
- Same label in the list, gold box (tracking reuses the detector track), live labels, export burn-in and phone strip: `red tour bus · bus 95% · type 61% · color red · Best match`. Buses skip make/model.
- `js/plate-text.js parseQuery`: natural phrases (`blur the license plate`, `find plate 7ABC`, `search for licence plates`, `tag starting with 7AB`) → plate search; `blur` turns on plate blurring. Explicit plate phrases with Plates off explain how to turn plates on instead of running picture search.
- Fix found on the way: hidden sample videos (detector/plate/picture search frames) returned black frames in WebKit when not in the page. `seekSample` now parks them in a 2 px invisible holder. Affects frame sampling only, not playback or export.
- Tests: `test/vehicle-attrs.js` (accuracy, Commons PD/CC0 photos fetched at test time), `test/vehicle-search.js` (end to end, Chromium + WebKit), new plate-phrase cases in `test/plate-text.test.js`. Tools: `tools/fetch-vehicle-fixtures.py`, `tools/vehicle-fixtures.json`, `tools/make-vehicle-footage.py` (plates blurred with the bundled plate finder).
- Limits: see README (night/sodium light, double-deckers vs city buses, make/model weak). No new model files; CLIP (MIT) ~150 MB downloaded once. Not tested on a real iPhone or real Safari.

## Burn-in parity: exported boxes = viewer boxes (tag burn-parity)
Rollback point: tag `pre-burn-parity` (= feature/all-in-one 308e094).
- Report (Safari, real footage): the export with *Burn detection boxes* had far fewer boxes than the viewer. They were static, appeared about 2–3 s early at the spot the object reached later, stayed frozen while it drove through them, then vanished. Confidences were different. An earlier phase5 test also showed 3 cameras with boxes in the player but 5 in the export at the same moment.
- Root cause: the viewer and the export picked boxes differently. (1) **Detect while playing** kept only the LAST live detection (`detect.live`, one entry, held 1.5 s). The viewer refreshes it every ~0.9 s while playing, but the export decodes frames offline with the player paused, so almost every exported frame had no live box. (2) The export then fell back to `burnBoxes.at`'s list of ALL search results within ±2.5 s of each frame (static box at the result's moment: hence "early, frozen, then gone", with the search's own confidences). The viewer instead drew only the opened result group, near the anchor. That gave too many boxes in some places (the 3-vs-5) and too few in others. (3) An export started while tracking was still running burned half-built tracks. There was no clip/trim offset: both sides use event (source) time. `frameMap` maps trimmed sections correctly, and the test checks it.
- Fix: `burnBoxes.at(cam, t)` is the single box set for both. `search.js paintBoxes` draws it on each tile, and the export compositor burns it. Order: followed tracks, then live detections, then results within ±1 s (was 2.5 s). Live detections are now kept per camera by time (`detect.liveSamples`), and between two detections the same object is moved linearly, so the box follows it smoothly. The live sample time is taken from the frame on screen (video time + clip start), not the player clock. Before encoding, `burnBoxes.prepare` waits for pending tracking (`search.pending`). When Detect while playing is on, it also runs the same live detection over the export ranges on the focused camera (missing samples only, with progress). "Show the gold box" off hides boxes in both.
- Test: `test/burn-parity.js` (Chromium + WebKit, real YOLO11 + CLIP). A bus drives across the front camera (`tools/make-moving-footage.py`), and the export has two trimmed sections. It covers A live detection (viewer played through), B detector search + tracking, C Vehicle details "city bus", and D a plate result. At sampled times it checks that the viewer box set equals the export frame's box set per camera (count, label, IoU > 0.8). The live and tracked bus box must overlap the real bus position (IoU > 0.5). One decoded export frame must have gold pixels on the bus box.
- Limits: live detection runs only on the focused camera (as in the viewer), so other cameras get boxes only from search results and tracking. Export with Detect while playing on is slower: one detection per ~0.9 s of exported video (2 s on phones). Between two detections, motion is assumed linear. Not tested in real Safari: headless WebKit on Linux, WebCodecs path.

## Bus detection / live detection speed (tag bus-detect-fix)
Rollback point: tag `pre-bus-fix` (= feature/all-in-one b3a3190).
- Report: "it's now unable to detect bus", "only the Front camera gets boxes", "I can see the bus being detected, but search says no bus is found".
- Not a burn-parity regression: on the 8 s moving-bus footage the old (`pre-burn-parity`) and new code detect the bus the same way, in Chromium and WebKit. Root causes: (1) search "bus" with the camera picker on its default (Front) only looked at the front camera, and spread a 140-frame budget over the whole event (about one frame every 4 s on a 10-minute event, one every ~26 s across 6 cameras), so a bus passing for a few seconds was easily skipped; (2) starting a search wiped what Detect while playing had already seen; (3) Vehicle details looked at no more than 60 frames and dropped every YOLO bus it couldn't confirm as "city bus" / "tour bus"; (4) Detect while playing only ran on the focused camera, about once a second.
- Search: object and vehicle searches check every camera, one frame every 1–2 s (600 frames on computers, 180 on phones), reuse frames already detected, and add the moments Detect while playing saw (same model, same threshold). For a vehicle query the YOLO bus search runs first; the vehicle details refine it and never remove it: unconfirmed bus moments are shown as "bus 88% · city bus? not confirmed".
- Detect while playing: *All cameras* (computers) / *Focused camera* (phones) setting; each visible camera in turn on the same worker. Adaptive rate: the next detection starts when the previous one finishes (requestVideoFrameCallback, else requestAnimationFrame; frames are skipped while busy; no fixed 1 s timer). Boxes are drawn on every frame from a tracker (IoU matching, constant-velocity prediction, smoothed position and size, dropped ~0.5 s after the object is lost). *Detection speed*: Fast (320-pixel model `models/yolo11n-320.onnx`), Balanced (default, up to ~5/s), Battery saver (~1/s, default on phones with low battery or, on iPhone, a guessed Low Power Mode). Frames go to the worker as transferable ImageBitmaps. Tiles hidden behind a focused camera aren't detected (WebKit hands back blank frames for them). The export runs the same detection on the same cameras at the chosen rate, with progress per camera.
- Measured on the box (WASM, 1 thread, 2 cameras, detections/s total): Chromium Fast 8–9.5, Balanced 3.0–3.5, Battery 0.8–1.0; WebKit Fast 8.8–10.5, Balanced 2.8–3.2, Battery 0.8–1.0. Playback fps with live on: Chromium unchanged; headless WebKit −10–15 %, same as with the old 1/s version.
- Tests: `test/bus-detect.js` (new; fails on `pre-bus-fix`: no rear-camera boxes, "no bus found"), `test/burn-parity.js` (now also the rear camera; tolerates the viewer landing on the other side of a detection switch point), live-labels, burn-boxes, phase5-detection, search-float, vehicle-search (white police car check now front-only, since the rear ambulance can also come up).
- Limits: Balanced reaches ~3/s, not 5/s, with WASM on this CPU (≈280 ms per detection); iOS Low Power Mode isn't exposed, it's guessed from a 30 Hz screen; Fast mode is less accurate (smaller input); long exports widen the detection spacing (cap 900 detections, 200 on phones); searching every camera takes longer than front only; the vehicle classifier can call a white ambulance a "white police car". Not tested on a real iPhone or Safari.

## Multi-object search (tag multi-search)
Rollback point: tag `pre-multi-search` (= feature/all-in-one bbbc52e).
- Ask: "how to search multiple objects in one pass?" A search used to map the whole phrase to one COCO class (or one vehicle / plate / picture query).
- Now: `bus, person, police car`, `red car and cyclist`, `traffic light / stop sign`, `white police car + person`, `bus, plate 7AB*`. `js/multi-search.js` (`TDC.multi`) splits the query (commas, `;`, `+`, `/`, `&` always; `and` / `or` only when every part is a known object / vehicle / plate phrase, so picture-search sentences stay whole; multi-word classes and vehicle phrases never split; a lone colour joins the next part) and classifies each term (object → detector class, vehicle details → colour/type/make, plate → plate index, else picture search / CLIP).
- One pass: one scan of every camera's sampled frames (`search.detSamples`); each frame is detected once at the lowest threshold any term needs and kept in `detect.frameCache`, then every object term filters it with its own class threshold (small-object tiles once per frame), vehicle terms run `vehicle.frame` on the same detections (vehicle.js split into begin / frame / end), picture terms score the same decoded frames (every k-th frame, ≤ 140), live detections are added as in the single search. Plate terms use the plate index, built once for all plate terms. Grounding DINO (one prompt per run) runs each term separately.
- Results keep their term: per-term grouping (each term's own clustering), chips with colour + count + All in the search panel, the floating search and the phone strip; tapping a chip shows only that term. Each term has its own box colour (cyan, pink, green, violet, orange, teal) in the viewer and in the burned-in export (`burnBoxes.at` adds `color`, drawn as the box stroke and a bar under the label); the opened result and what follows it stay gold. Best match only applies to plate terms.
- Test: `test/multi-search.js` (Chromium + WebKit): parsing (14 cases) and term kinds; one pass "bus, person" (one detector run per frame, chips + counts, filter in strip and floating search, viewer gold + pink, export burns both, decoded file has the pink person box); "city bus, person"; speed vs separate searches on the 3-minute footage.
- Speed (3-minute event, 2 cameras, 360 frames, WASM, frame cache cleared before each run), "bus, person, car" in one pass vs three separate searches: Chromium 143 s vs 145 + 141 + 142 = 428 s (≈ 3× faster); WebKit 162 s vs 153 + 158 + 563 s (one separate run was slow) — a one-pass search costs about the same as ONE single search, because the detector runs once per frame. Same results per term (2 / 12 / 12).
- Limits: plate terms read plates in their own scan (the plate model is a different detector; the index is shared by all plate terms, and a second search reuses it); picture-search terms look at fewer frames (≤ 140) than object terms; with Grounding DINO each term is a separate pass; gold-box tracking follows the results near the opened one (other terms in that group are tracked too, drawn in their colour); timeline marks are not coloured per term; up to 6 terms; "and"/"or" between free words (not known objects) are not split.

## Boxes on/off button (tag box-toggle)
Rollback point: tag `pre-box-toggle` (= feature/all-in-one d74801f).
- A **Boxes** button in the camera bar, next to **Cameras** (icon only on narrow phones). Key **X** (B already opens the split-section panel in Advanced mode). One saved state (`localStorage tdc.boxes.v1`) shared with the *Show the gold box* checkbox: ticking one updates the other.
- Off: no boxes in the viewer (live detections and search results), nothing burned into the export, and **Detect while playing** stops running the detector (no CPU/battery use); on again: detection resumes at the next frame. The icon gets a strike-through and `aria-pressed="false"`.
- API: `TDC.search.boxesOn()`, `setBoxes(on)`, `toggleBoxes()`.
- Test: `test/box-toggle.js` (Chromium + WebKit, 13 checks each): default on, X turns off (aria-pressed, strike, checkbox, saved), no detections while playing when off, export burns 0 boxes, kept after reload, tap turns on and detections resume, checkbox ↔ button, visible in focused single camera, full screen and phone layouts.
- Limits: the setting is per browser, not per event; turning boxes off does not cancel a search that is already running (its results are just hidden); search results and timeline marks are still listed.

## Live white balance (tag white-balance)
Rollback point: tag `pre-white-balance` (= feature/all-in-one f667259).
- **White balance** chip next to HUD / Map (aria-pressed, saved in `localStorage tdc.wb.v1`, off by default) and a readout at the bottom right of the video ("3000 K · Warm streetlight · both mirrors" / left mirror / right mirror; "Looking for your white paint in the mirror cameras" when the paint isn't seen). Code: `js/wb.js` (`TDC.wb`), started from `js/app.js`.
- Estimate: ~4.5 Hz, a 40×90 downscale of each mirror camera's inner strip (left repeater: right 18 % of the image, right repeater: left 18 %, lower half; constants in `TDC.wb.C`). Pixels with any channel ≥ 250 are skipped; walking down from the brightest, strongly red (R/G > 2.1) or green pixels are skipped (hue gate) until the top 5 % is collected; candidates darker than luminance 80 = no paint; median-trimmed in log-chroma (drops odd neutral specks and coloured outliers; too scattered = not one painted surface). Per-camera chroma-jump rejection against the running estimate (> 0.22 in log R/G, B/G, accepted only if it lasts 14 samples ≈ 3 s), EMA 0.25, both mirrors averaged. Paint unseen 8 s → correction fades out. CCT: linear sRGB → XYZ → xy → McCamy; words: Sodium (< 2300 K or strong orange), Warm (< 3600), Neutral (< 4800), Cool (< 6200), Daylight.
- Correction: gains_c = lerp(1, ref/white_c, 0.7) with ref = the white's luminance, renormalised to keep the white's luminance, clamped 0.5–2.2. Applied to the camera `<video>` elements only (and the 360 canvas): an SVG `feColorMatrix` (`filter: url(#tdcWb)`, sRGB) in Chromium / Firefox; on Safari / iOS a `brightness()` on the video plus a `mix-blend-mode: multiply` tint layer right above the video, inside the (now `isolation: isolate`) tile, below labels and boxes. Both paths give the same result in tests. Export, detection, search, plates and the 360 export read frames with `drawImage`, which ignores CSS filters and the tint layer.
- Hidden mirror videos (focused on another camera) still give the white point in Chromium and WebKit; if a browser hands back black frames for them, the estimate is held. Sampling stops when off or the tab is hidden; when paused it samples only when the frame changes.
- Test: `test/white-balance.js` + `tools/make-wb-footage.py` (night scene under a 3000 K cast, white paint on the mirrors' inner edges, a red lamp reflection at 4.0–4.5 s; a second event without paint). Chromium + WebKit, 35 checks each, all pass: estimator units (clipped / red / green / specks, jump rejection, smoothing, CCT, gains); estimate 2957 K (Chromium) / 2910 K (WebKit) for 3000 K; readout; red flash: CCT range 2937–2957 / 2875–2910 K, 245–252 lamp pixels gated; on-screen paint moves 69–70 % toward neutral with brightness kept, in both render paths; front camera and 360 view corrected; full screen + 2× zoom 76–77 %; overlays pixel-identical with the videos hidden and a box over the video keeps its colours; detection input identical; export frames identical on vs off (pixel hash of all 30 composited frames; the files differ only in the same 6 header bytes that differ between any two exports); saved across reloads; tab hidden pauses; readout visible and not covered in grid, full screen and phone; no-paint event shows "Looking…" with no correction. Screenshots: `screenshots/white-balance-{before,after,fullscreen,360,phone,looking}-{chromium,webkit}.png`.
- Regression: hud-front (62/62), box-toggle (13/13), burn-parity (20/20) in Chromium + WebKit; live-labels 21/21 (Puppeteer Chromium, desktop + iPhone portrait).
- Limits: it trusts that the car is white (on a coloured car the "white point" is the paint colour: turn it off); one global correction for all cameras (the mirrors' light, not each camera's); the correction is not in the export (by design); real Safari / iOS were not available here: WebKit was tested with Playwright's WebKit build, and Safari uses the blend path, which needs no SVG filter on video; the tint layer also darkens the letterbox/placeholder area very slightly; strongly lit coloured scenes (e.g. a red-lit car wash) for more than ~3 s are taken as a new light.

## White balance from the real mirror cameras (tag wb-real)
Rollback point: tag `pre-wb-real` (= 56c58af). Back to the first version: tag `white-balance`.
- On the real Model X repeaters the car body is at the OUTER edge (left repeater: far left of its image; right repeater: far right), a dim sliver at night, not a bright highlight. `js/wb.js` now samples that edge (`TDC.wb.C.SIDE`) in a strip 14 % wide (lower 88 %), downscaled to 32×64 cells.
- Body mask: per cell a running mean / variance over the sampled frames (only while the scene moves); per row the body runs from the image edge to the first cell that is a static edge (temporal std ≤ 0.6 × the scene's and a dark valley / step ≥ 10 levels in the mean image); rows median-smoothed into one region touching the edge; confident with ≥ 8 frames, edges in ≥ 30 % of rows and a smooth curve. Until then a default wedge (1.2 % → 7 % of the width, from 18 % down). The learned shape is saved per camera (`tdc.wb.mask.v1`) and used at once after a reload.
- White point: mean of the 60–95th luminance percentile of the body cells; clipped (≥ 250) cells skipped; dark cells below max(6, 0.2 × scene median) skipped; "paint seen" needs ≥ 12 cells at ≥ max(10, 0.3 × scene median), so dim night paint counts. Hue gate, log-chroma trimming, chroma-jump rejection (14 samples ≈ 3 s) and EMA 0.25 kept. Gains clamped to 0.65–1.7.
- Settings > White balance (`tdc.wb.cfg.v1`): Strength (default 70 %), Strip width, Car body edge per mirror (auto / left / right edge; changing it relearns), Show sample area (dashed strip + magenta body cells + "Body found · left edge" / "Default sliver").
- Tested on the user's real night clip (kept out of the repo): learned body on both mirrors (left: up to 6.1 % of the width, right: up to 4.8 %), estimate 3300–3500 K, "Warm streetlight · both mirrors", in Chromium and WebKit.
- Test: `test/white-balance.js` + `tools/make-wb-footage.py` now put a dim, textured body sliver on the OUTER edges with a moving scene; 44 checks in Chromium and WebKit, all pass (mask learned on both mirrors, default sliver before, side override, strength 30 / 70 / 100 %, remembered shape, no-body, parked scene, plus all the earlier checks: export identical, overlays unchanged, red flash ignored, persistence, full screen + zoom, 360).
- Limits: the body has to be learned while driving (parked footage keeps the default sliver, which is usually right); the body shape assumes the factory repeater framing; on a coloured car turn it off; a gain clamp means very strong sodium casts are only partly corrected even at 100 %.

## Cameras menu never clipped or covered (tag cam-popover)
Rollback point: tag `pre-cam-popover` (= wb-real, 1ba8d8c).
- Cause: the menu was `position: absolute` inside the camera bar, which is inside the stage (`overflow: hidden`) and has a `backdrop-filter` (a containing block even for fixed children); it always opened downward. With the bar at the bottom (floating or docked below the video) it was cut off by the stage or ran off the screen, and other layers could cover it.
- Fix (`js/focus.js`, `css/app.css`): the menu is moved to `<body>` and placed with `position: fixed`, `z-index: 70` (above the stage, tiles, overlays, map, floating search 60, full-screen controls 40). Direction: upward when the bar is in the lower half of the video, docked below it, or there's more room above; downward otherwise; sideways (right or left of the button) when neither has room for it. Right-aligned with the button, flipped to its left edge when needed, clamped 8 px inside the (visual) viewport, `max-height` = the room (scrolls). While open it follows the button every frame (drag, layout, full screen) and on resize / scroll / visual-viewport changes; pressing on the bar (to drag it) keeps it open, a tap elsewhere closes it, and it closes when the button goes away (focused view, bar hidden). `aria-haspopup` / `aria-expanded`; Enter opens on the first camera, ↑/↓, Space, Esc returns to the button.
- Test: `test/cam-popover.js`, Chromium + WebKit, 13 checks each, all pass: bar at the top, floating at the bottom, docked below and above the video, after a drag top → bottom, full screen, phone portrait (bottom + docked) and short landscape: menu fully inside the viewport, `elementFromPoint` at every option is the option, opens upward at the bottom; tap toggles; keyboard; tap outside closes. The old code fails 11 of them. Regression: camera-bar-dock 19/19 (Puppeteer), box-toggle 13/13, hud-front 62/62 (Chromium + WebKit). Screenshots: `screenshots/cam-popover-{top,floating-bottom,beside-bottom,beside-top,fullscreen,phone,landscape}-{chromium,webkit}.png`.
- Limits: on a very short window the menu scrolls rather than showing all six at once; real iOS Safari not tested here (Playwright WebKit only).


## Cameras menu in Safari: anchored, never left / low (tag cam-popover-fix)
Rollback point: tag `pre-cam-popover-fix` (= 9d7c8f7).
- User report (real Safari, bar docked below the grid): the "Show in grid" list sat at the far left of the bar, opened downward over the timeline with one row visible, covering "All cameras".
- Cause: Safari kept the OLD `js/focus.js` from its cache (the static server sends only Last-Modified, so Safari caches heuristically) together with the NEW `css/app.css`. The old script never moves the menu out of the bar, and the new CSS (`position: fixed; left: 0; top: 0`) inside the bar, whose `backdrop-filter` makes it the containing block for fixed children, put it at the bar's top-left corner. Reproduced in Playwright WebKit with exactly that mix (`screenshots/cam-popover-safari-before-webkit.png`).
- Fix: every local script and stylesheet in `index.html` carries a version query (`?v=cam-popover-fix`; `tools/bump-asset-version.py <version>` sets it), so new HTML/CSS never runs with old JS. The menu markup now sits directly in `<body>` (not inside the bar). Placement: placed again in the next animation frame after it is shown, anchored by its bottom (`bottom = innerHeight − button top + 6`) when it opens upward, right edge aligned with the Cameras button and clamped, and if an ancestor ever offsets `position: fixed` the measured offset is corrected.
- Test: `test/cam-popover.js` adds the user's layout (820×445, Safari desktop UA in WebKit, bar docked below a 6-camera grid, white balance on): menu on `<body>`, centre within / right-aligned to the Cameras button, bottom above the button, opens upward, inside the window, all 6 options hittable, not over the timeline. 16/16 Chromium + WebKit. Regression: camera-bar-dock 19/19, box-toggle 13/13 (Chromium + WebKit). After: `screenshots/cam-popover-safari-after-webkit.png`.
- Note: after updating, a hard reload (⌘⇧R) once in Safari makes sure the new index.html is used.

## Vehicle colour after white balance (tag wb-color)
Rollback point: tag `pre-wb-color` (= f4a64d9; cam-popover-fix sits between and is independent).
- Cause: vehicle colour (`js/vehicle-attrs.js colorFromPixels`) read the RAW frame pixels. White balance only changed how the viewer shows the videos, so a white bus under a ~3000 K streetlight was still judged brown / beige / orange, in searches and in the live labels.
- Fix: when a white point is known for that moment, every vehicle crop is corrected before the colour is judged (`opts.gains`). The white point comes from `TDC.wb.colourFix(t)`: the live, smoothed viewer estimate within ±2 s, else one estimate per 4 s window of the event measured from both mirror cameras' frames (7 frames over ±1 s on its own hidden video, the learned / remembered body shape or one learned from those frames). The body has to be static relative to its own brightness (passing lamps brighten the whole body, but street texture slides through), otherwise there is no white point (no "body" found on a moving street).
- Strength: classification uses the FULL correction (`CLASSIFY_STRENGTH = 1.0`), not the viewer's 70 %: the viewer keeps some warmth because it looks natural, but a colour name needs the white to come out neutral; 70 % still leaves a 3000 K white clearly beige / orange. The gains map the white to its own brightest channel (not its luminance, which would turn a white into "silver"), clamped 0.4–2.8.
- Night classifier: a pixel is neutral when its CIELAB chroma is small for its lightness (C* < 4 + 0.1 L*, ×1.5 for dim warm hues), so a dim yellowish grey is gray, not brown, while real brown and beige stay colours; with a warm white point (< 4500 K) the white / silver / gray steps are lower (0.6 / 0.4 / 0.22) because a white vehicle under a streetlight is lit far less than in daylight; and a mostly-black crop (≥ 70 % black, < 15 % colour) is black (a dark car, not blue / brown).
- Setting: Settings ▸ White balance ▸ "Colour search uses white balance": Auto (default; whenever a white point is found, even with the viewer toggle off) / On (also falls back to the viewer's last estimate) / Off (raw, as before). Label: `color white (corrected for 2900 K light)`.
- Index: vehicle index records carry `cver: 2` and the setting; older entries (raw colours) and entries made with another setting are judged again on the next search (detections are kept).
- Untouched: YOLO input (raw frames, identical detections with the setting on / off), export pixels. Burned-in export LABELS use the same corrected colour word as the viewer (export prepare asks `colourFix(t)`), so viewer and export agree.
- Test: `test/wb-color.js` + `tools/make-wbcolor-footage.py` (night street under ~3000 K; white tour bus, red car, blue bus, brown car from public-domain / CC0 photos; mirror cameras with the dim body; a no-body variant; a daylight variant). Before → after: white bus brown (Chromium) / orange (WebKit) → white; red car red → red; blue bus brown → blue; brown car brown → brown; ~2850 K found with the viewer toggle off; search "white bus" → "white bus · bus 93% · color white (corrected for 2900 K light) · Best match"; setting off → brown again; old index entries re-judged; no body → raw colours, no "corrected"; live label "white"; detector input unchanged.
- Limits: white vs silver at night depends on how brightly the vehicle is lit; one white point for all cameras (the mirrors' light), so a vehicle under a different lamp (LED, neon) can still be off; under strong correction red tail-lights can lean purple; the on-demand estimate needs the car moving (parked: the default sliver is trusted, as in the viewer); white-balance estimates for a whole event cost about 14 extra frame seeks per 4 s window.


## Blur plates works in Safari, and as soon as it's ticked (tag plate-blur-fix)
Rollback point: tag `pre-plate-blur-fix` (= c7b672d).
- Cause 1 (no blur in the viewer or the export on Safari): the blur used the canvas `ctx.filter = "blur(…)"`. Safari doesn't support it (behind a flag up to Safari 27), so setting it did nothing and the "blur" drew a sharp copy of the plate on top of itself, in the viewer layer and in every export frame (same `paintBox`). Reproduced in WebKit: the plate reader still read 7TST123 from a "blurred" export frame.
- Cause 2 (nothing blurred after ticking): ticking "Blur plates" only saved the setting. Plate boxes came only from a plate search or an export, so until then there was nothing to blur, and the status line kept saying "Models load on the first plate search."
- Cause 3 (silent): any error in the blur lookup was caught and dropped (`catch → []`).
- Fix: `js/redact.js` tests once whether canvas filters work; without them it blurs by halving the area down to about one pixel per blur radius (each step averages 2×2 pixels) and scaling it back up smoothly. The source rectangle is kept inside the frame (Safari draws nothing for an out-of-bounds source). `js/plates.js`: turning blur on (or opening an event with blur on) uses the saved plate index or scans the event in the background with the status line "Finding plates to blur… / Plates found and blurred (N readings)"; plate searches and export wait for that scan instead of running a second one. The reader keeps using its own hidden video (raw frames), so blur never hides plates from search. Errors in the blur lookup now go to the console, the Plates & text status line and a toast ("Plate blur problem: …").
- Test: `test/plate-blur.js` (Chromium + WebKit, real plate models, `tools/make-plate-footage.py`). Before (WebKit, old code) 6 of 11 checks fail; after, 11 / 11 in both browsers.
- Limits: the fallback blur looks a little blockier than the Chromium filter; plates are only as well tracked as the scan step (about 0.5 to 1 s, with padding); asset URLs moved to `?v=plate-blur-fix` so Safari loads the new scripts.

## Colour constancy prototype (tag color-constancy-proto, rollback pre-color-constancy = dfd81a8)
- **Off by default.** Settings ▸ White balance ▸ *Colour constancy (prototype)*: Off / On. When on: *Estimator* (fusion / learned / paint), *Adaptation* (CAT16 default / Bradford / gains), *CLIP colour check* (off by default).
- `js/colour-constancy.js` (`T.cc`): estimates the light colour from several references (car paint in the mirrors, lane/crosswalk markings, plate backgrounds, a small learned estimator, grey world), fuses them robustly (Cauchy-weighted, in log-chroma), and corrects in linear sRGB with CAT16 or Bradford (or per-channel gains). It also brightens a dark frame so the reference white sits at 75 % (at most ×4).
- Learned estimator: FC4 (SqueezeNet 1.1) from matteo-rizzo/fc4-pytorch (MIT), exported to ONNX and int8-quantised: `models/cc/fc4-squeezenet11-int8.onnx`, 1.78 MB, ~50–70 ms per frame in WASM (single thread). Weights were trained on the Gehler–Shi ColorChecker set, which has no stated licence (see `models/cc/README.md`).
- Used for: vehicle-colour search and export labels. Viewer: CAT16/Bradford as a 3×3 matrix in the SVG filter (linearRGB) on Chromium; the Safari blend path still uses gains (an approximation). Live labels still use the shipped method.
- Classification uses full adaptation (D = 1); the viewer uses the Strength setting (70 %).
- Accuracy (synthetic night set, 23 vehicles × 8 lights × 2 exposures = 368, Chromium; `test/cc-eval.js`, `test/cc-eval-results.json`):
  - Light estimate error, mean: no correction 23.0°, grey world 2.3°, paint 0.65°, lanes 0.98°, plates 4.0°, learned 4.1° (calibrated, cross-validated), fusion 0.49°, fusion without paint 0.71°.
  - Colour correct (strict): shipped paint + gains 28.5 % (56.5 % with brightening); paint + Bradford 36.1 % (64.7 %); paint + CAT16 35.9 % (65.2 %); fusion + CAT16 35.9 % (64.1 %); learned + CAT16 31.8 % (57.9 %). Raw 13.9 %.
  - CLIP colour on the corrected crop: 54.1 %; pixel statistics 64.1 %; fused 66.0 %. Costs ~180 ms per crop.
  - Real Commons night photos (n = 7): raw 5/7, fusion + brightening 7/7, learned + brightening 6/7.
- Limits: the synthetic set flatters grey world and clean paint; real set is tiny (7). On the wb-color test footage, fusion + CAT16 gets some vehicles wrong that the shipped gains get right (logged, not asserted, in `test/color-constancy.js`). Borderline vehicles (red/silver, brown/grey) can flip between runs. Region-wise correction not done (deferred).
- Tools: `tools/cc-export-fc4.py`, `tools/make-cc-testset.py`, `tools/fetch-cc-night.py` (test images are fetched, not committed).

## Text search, text redaction and time search fixes (tag text-search-fix, rollback pre-text-search-fix = 7780307)
- Problem (on real clips): text search and "Blur text" missed most words, moving text (a truck's side) slid out from under its blur, the blur on wide short lines was mostly transparent, errors were silent, and the per-frame OCR stopped after 240 frames.
- `js/redact.js`: full-resolution OCR with a contrast stretch (no canvas filter, so it also works in Safari), a local-contrast pass at night, split text blobs, every line read, sampling within a time budget instead of a fixed cap; boxes are linked into tracks and interpolated between samples so the blur follows the text; an opaque blur sized to the line height (taller pad so a moving truck's text stays covered); the white-balance filter is copied onto the blur layer; unreadable frames are counted and errors shown.
- `js/text-search.js` (new): one OCR index per event, over every camera, shared by text search, Blur text and All text, so later queries answer at once. Routing: `text …`, `sign: …`, quoted words or an ALL-CAPS phrase go to text search. Results show time, camera, thumbnail and what was read; the gold box follows the text. A seek that never finishes counts as an unreadable frame (no stall); a failed frame is retried once with a fresh video.
- `js/text-match.js` (new): fuzzy phrase matching (OCR look-alikes 0/O, 1/l, 8/B, one or two edits, cut-off text), short numbers must match exactly, generic words (`St`, `Ave`) never match on their own; track building.
- `js/time-search.js` (new): `20:53:46`, `8:53 pm`, `2:30`, `90s`, `+1:05`, `-10s` in the search box; out-of-range times offer the nearest end.
- Settings ▸ Search ▸ *Show text search & redaction (beta)* (on by default) hides the text-only controls; plate / face blur and time search stay.
- Tests: `test/text-redact.js` (synthetic `tools/make-text-footage.py`, day and night: read rate per text type, export burn leak + opacity, no over-blur, All text instant, search thumbnails / click, WB filter, errors shown, the Settings switch), `test/time-search.js`.
- Screenshots: `screenshots/text-*.png`, time search (synthetic footage).

## Highlight / Redact search matches (tag redact-toggle, rollback pre-redact-toggle = 8d5042e)
- Asked for: redaction that can be toggled, and search results that can be redacted, highlighted, or both, in the viewer and the export.
- UI: **Matches · Highlight · Redact** in the search panel and the classic Find bar. Highlight = the existing Boxes state (camera-bar button, X, *Gold box*). Redact is new, saved in `localStorage` `tdc.results.redact`, off by default, key **R**. Several-thing searches: two small buttons on every term chip (outline = highlight, filled box = redact) override the switch for that term (`S.terms[i].hl / .rd`); tapping a switch resets its overrides. The panel also gets **Show blur** for Blur text / plates / faces results (same state as the classic *Show blur* tick), so that redaction can be turned off and on without clearing it.
- One source for viewer and export: `burnBoxes.at` (outlines) now honours per-term highlight; new `burnBoxes.redactAt` lists the matches to blur (followed tracks, live detections of the searched classes only, results within ±1 s; every result, not only the chip / Best-match view). The viewer paints it on the existing blur layer (`redact.js` paintLive, under the outlines) and the export burns it in `redact.burn` (compositor), whatever *Burn detection boxes* says. Export prepare (tracking, live detection over the export range) also runs when only redaction needs it, and Detect while playing keeps running with Highlight off if matches are being redacted.
- Safari fix found on the way: WebKit ignores the source rectangle when drawing a decoded (I420) `VideoFrame`, which is what the export draws, so the fallback blur put a tiny copy of the WHOLE frame into each box instead of a blur. This affected Blur text / plates / faces in Safari exports too. Frames are now copied to a canvas once per frame before blurring.
- Test: `test/redact-toggle.js` (Chromium + WebKit; `tools/make-moving-footage.py`): UI defaults, R / X keys, persistence; the 4 modes measured in the viewer layers and in frames the exporter actually draws (detail inside the bus box: blur ≈ 2–8 % of the plain frame when redacted; outline pixels present / absent); redaction burned in with *Burn detection boxes* unticked; the no-canvas-filter (Safari) path; per-term (bus redacted, sign highlighted) viewer + export; chip filter keeps other terms blurred; Show blur on / off; `REAL=1` adds a real YOLO "bus" search, redact only.
- Limits: a picture-search (CLIP) result only has a box once it is opened (or Redact is turned on while it is open), so unopened picture results aren't blurred; a result that isn't followed is blurred for ±1 s at its found position (a fast-moving object can move out from under it; turn on Detect while playing or open the result to follow it); per-term choices last for that search only; asset URLs `?v=redact-toggle`.

## Vehicle colour ignores lit lamps; live boxes no longer stay frame-sized (tag taillight-fix)
Rollback point: tag `pre-taillight-fix` (= 8d5042e).
- Report 1: a white city bus seen from behind at night (left repeater, white balance 2800 K) was labelled "red bus 92%". Its lit tail / brake lamps and their red glow tint the whole rear pink (hue ≈ 350°, saturation ≈ 0.25), and every pixel with red hue and s > 0.16 voted red.
- Report 2 (front camera, 3100 K): a red Tesla seen from the front read "gray car" (its dark red paint sits at brightness 0.15 to 0.2, below the black cut-off, and the blue-white headlights voted blue). A dark RAV4 seen from behind read "blue car": its lit full-width tail bar tints the top red, and the lower cladding reads pale blue.
- Fix (`js/vehicle-attrs.js colorFromPixels`):
  - Lamps are masked before the vote, together with a halo of 7 % of the crop and the more saturated red or amber pixels in a wider glow zone. Lamps are: clipped cores (all channels ≥ 0.88, dark crops only); bright saturated red or amber lenses that stand above the body (and above the paint, when the crop is mostly red; dark crops only, since by day bright red paint looks the same: the red tour bus in `test/vehicle-search.js` read gray until this was limited); and very bright blue-white headlights or LEDs. A lamp is a small blob: a large connected red patch is paint, and more than 18 % "lamps" means paint.
  - At night a red, pink or magenta pixel needs s ≥ 0.42 (≥ 0.3 when it is dark), otherwise it counts as neutral. Pale blue at night (s < 0.42) counts as neutral too.
  - Rear lamps lit (red lenses, or a bright red ring round clipped cores): red counts half, and a lamp-coloured answer (red, orange, purple, brown) needs a clear majority, otherwise the less saturated reading wins.
  - Dark red paint at night votes red (red and purple together under a blue-heavy correction), and a consistent colour beats "dark gray" (road, glass, shade) unless the vehicle's own red lamps are lit.
  - A dark vehicle at night whose colour is contradictory (warm on top, cool below) reads black or gray, with confidence ≤ 0.4.
  - Dark-pixel colour votes are red only (dark blue is glass and shade, dark yellow-brown is streetlight leftover). At night white wins over silver at ≥ 60 % of silver's share (was 75 %), so a white bus in streetlight shade doesn't flip to silver.
  - If more than 60 % of the crop was masked, the result leans neutral and confidence drops.
  - The result carries `lamps`, `rearLit`, `dark` and `thin`.
- Live labels: the colour word is voted per followed vehicle (older votes fade; frames with lamps or poor light count less), so one brake flare doesn't flip the label. The vehicle index is re-judged (colour version 3).
- Box (`js/detect.js`): the gold box spanning most of the frame was the live tracker. The bus had just passed right next to the car (box ≈ the whole frame) and then pulled away. Each new detection moved the box corner 60 % and the size only 40 % of the way, and with All cameras a camera is looked at about once every 1 to 2 s, so the box stayed several times too large for seconds. Now a size change over 1.6× (or IoU < 0.2 with the prediction) takes the detection as it is, smoothing works on the box centre, and the live-sample interpolation (export, paused viewer) no longer blends two very different sizes.
- Test: `test/taillight-color.js`. It covers 30 synthetic crops (node, Chromium and WebKit) and the tracker and interpolation checks. Before: white bus with strong glow or cast → red (4 cases), dark SUV with tail bar → red (2), dark red sedan under a blue-heavy correction → black. After: all pass (white/silver, black/gray, red). True reds still read red: a red car or bus with and without lamps, in daylight, and with headlights.
- Limits:
  - A vehicle lit red by ANOTHER car's lamps (e.g. our own tail lights on a parked car beside us) has no lamp of its own to find, so it can still read red.
  - White versus silver at night depends on how brightly it is lit.
  - The 3100 K frame of report 2 looks over-corrected: a white crosswalk shows hue ≈ 215°, s ≈ 0.3 even at the viewer's 70 %. The mirror white point (the car's own paint) was warmer than the street light; that is a white-balance estimate issue, not fixed here.
  - "SUV" is not a detector class (YOLO/COCO has car, truck, bus); with Vehicle details on, "SUV" in a search is checked by the CLIP type step, but live labels don't name it.
  - Classifying a crop takes ~1.2 ms instead of ~0.3 ms (64 px crop, desktop).

## Colour lock: one colour tag per vehicle (tag color-lock, rollback pre-color-lock = 51922fd)
- `js/color-lock.js`: every colour reading of a vehicle (live detection, export preparation, vehicle-search frames) is chained, per camera, into a colour track. Readings are linked by predicted position, size and class family (car/truck together); one reading per track per frame; a vehicle lost for ≤ 3 s is re-acquired near its predicted path, and a clearly different locked colour needs a close overlap to join after a gap.
- Each reading is weighted: confidence × crop size (full weight from 120 px wide). It counts less when lamps are masked (down to ×0.3), its own rear lamps are lit (×0.6), in low light (×0.5), when the crop is dark (×0.6) or thin (×0.4), at the frame edge (×0.4), or when it overlaps another vehicle (×0.5).
- The colour is provisional (`~white`) until there are ≥ 2.2 good-frame equivalents and the leading colour has ≥ 60 % of them. After that it is LOCKED. It changes only when another colour holds ≥ 72 % of the good readings (weight ≥ 0.25) of the last 2.5 s, over ≥ 3 readings spanning ≥ 1.5 s (weight ≥ 1.6). The old evidence is then scaled ×0.3.
- The live label while playing (tracker), the paused viewer and the *Burn detection boxes* export (`D.boxesAt` → `burnBoxes.at`) and the vehicle-search result labels (`V.cluster` / `V.hitText`) all use the locked colour, so they say the same thing. A search result whose vehicle locked onto a colour that the query excludes ranks lower (×0.5). Readings arriving out of order (export gap filling, search) trigger a full re-chain on the next lookup.
- Replaces the short decaying vote of taillight-fix. The cost is ~0.06 ms per reading (node). Labels only look up the reading's track (O(1)). Pure JS, no new browser APIs.
- Test: `test/color-lock.js` (node + Chromium + WebKit). A synthetic white car with dusk, brake flashes, an overlapping blue car and a 1.2 s loss: one track and no flicker in any of the viewer-playing, viewer-paused, export or search-label paths. A red car in another lane, a red car appearing later where the white car was lost, and a sustained gray→red change all still come through (the change after ≥ 1.5 s). There is also a real-pixel `decorateLive` pass.
- Limits:
  - The lock lives in memory for the open event (cleared when a player opens).
  - Two same-size vehicles crossing closely can swap tracks (position/size only, no appearance re-ID beyond colour).
  - A vehicle that drives out and back in after > 3 s gets a new track.
  - The first ~0.5–1.5 s shows the provisional `~` colour.

## Red tail-light glare no longer turns a grey car red (tag glare-fix, rollback pre-glare-fix = d81084b)
Report 3: the dark grey RAV4 from behind read "red car 50%" at night. It has a lit full-width tail bar, its reflection in the glass, a high brake light, and the whole frame has a red/maroon cast.
- **Where the red cast comes from:** the footage, not the viewer.
  - In the screenshot the cast depends on brightness. r/g is 3.3 in the darkest parts and 2.5 in the dark ones, against 1.15 on the crosswalk and bumper (a fit gives R ≈ 0.69·G + 38). In other words, red is added to the dark parts.
  - Neither viewer path can do that. The SVG feColorMatrix and the Safari brightness() + multiply tint both scale each channel, and the gain sign is right (gain = white / channel).
  - A red-lit paint reference would push the correction toward cyan/blue, not red. That matches the bluish over-correction at 3100 K in report 2. The user's mirror clip (20:53:30–40) gives about 3450 K, with gains [0.87, 1.02, 1.48], so red is reduced. The clip doesn't cover 20:53:46, and there is no front clip.
- **White balance (`js/wb.js`):** a shift of the mirror white point toward red with blue about the same (Δlog r/g > 0.15, Δlog b/g > −0.5×that) means our own lamps are lighting the paint. Such a shift is held off for 54 samples (~12 s, e.g. a stop at a red light with the brake on), even when it is too small to count as a jump, and the last good estimate is kept. A warmer streetlight (red up and blue down) is followed as before. The existing gain clamp stays.
- **Colour (`js/vehicle-attrs.js`):**
  - **Light bar:** a wide (≥ 45 % of the width), thin (≤ 15 % of the height) band of bright red is a lamp. It must be lamp-like: ≥ 3 near-clipped pixels, and ≥ 1.25× brighter than the red just above and below it. Bright red paint in a band of light is not taken for a bar.
  - **Glow gradient:** with the vehicle's own lamps lit, redness is measured by distance from the lamps. While it falls gradually (through ≥ 3 rings) toward the level of the least-lit part of the vehicle, red pixels in that range are left out. A step, such as red paint ending at the road, is not glow.
  - **Scene cast:** `sceneCast()` reads a 96 px copy of the frame outside the vehicle boxes and takes the median log r/g and b/g per brightness band. It is used only at night (median luma < 0.2, or a night white point). When the vehicle's own lamps are lit and the answer is a lamp colour, the crop is judged again with the extra red of the darker bands (relative to the brightest band) divided out, never past neutral. If the colour is then not clearly red (< 50 % of the non-black body or confidence < 0.45), it reads black / grey / silver at ≤ 40 %.
  - Without lit lamps the cast is not divided out: dark red paint at night looks just like the cast (the red Tesla would turn grey).
  - A dark scene now also counts as night when no white point is known. The vehicle-colour White balance setting "off" still means raw pixels only.
- **Colour lock:** own lamps lit ×0.35 (was ×0.6); masked lamps ×max(0.2, 1 − 2.5·share) (was 0.3 / 2·share); light bar ×0.7; judged after taking the cast out ×0.6; strong red cast (> 0.4 log units) ×max(0.35, 1 − 0.6·(cast − 0.4)). A lit bar + strong cast reading counts about 4 % of a clean one.
- Search index colours are judged again (`COLOR_VER` 4).
- Tests:
  - `test/taillight-color.js`: 5 synthetic cases (dark grey SUV rear with a full-width bar, glass reflection, high brake light and an additive red cast in the dark parts of the frame, with and without white balance, plus a stronger version; a red SUV with the same bar and cast stays red).
  - `test/color-lock.js`: glare weights, and a grey SUV whose glare frames read red stays grey.
  - `test/white-balance.js`: red-lamp hold, and a warmer streetlight is still followed.
- Limits:
  - A dark red car seen from behind at night with its lamps lit, in a red-cast frame, can now read dark grey.
  - Vehicles seen from behind at night lock their colour more slowly (their readings count less).
  - The cast measure assumes the surroundings in the brightest band are about neutral after white balance.

## Safari feedback round (tag safari-feedback, rollback pre-safari-feedback = 37317e4)
Six issues from a Mac Safari (Apple Silicon) test.
1. **Plate blur lagging moving cars** (`js/plates.js`, `js/detect.js`, `js/prewarm.js`, `js/redact.js`):
   - The scan now starts at the playhead, and blur tracks are rebuilt every 6 scanned frames, so blur appears before the whole clip is scanned.
   - Fast plates are linked by distance (up to 5 plate widths per second), not only by overlap.
   - Extra detector-only looks are taken between samples where a plate moved more than 0.6× its width or changed size more than 1.25×. Budget: 160 frames on desktop, 40 on mobile.
   - Blur boxes are swept over t ± lead (0.12–0.4 s), padded, and extrapolated past track ends.
   - Each camera is painted at its own presented frame time (`requestVideoFrameCallback`).
   - Models load when a clip opens, with a small "loading detector" badge, and a first detection runs on the paused frame. The live tracker uses the measured speed from its second look.
   - Synthetic fast-plate clip: first blur 8.4 s → 3.5 s, frames fully covered 35 % → 100 %.
   - Test: `test/plate-lag.js`.
2. **White balance too blue at night, red in daylight** (`js/wb.js`): temperature and tint are limited separately.
   - Night: temperature ×0.85, at most ±0.26 log, blue gain at most 1.45, magenta tint halved.
   - Daylight (bright mirror strips): ×0.25, at most ±4 %, so 6300–7700 K daylight is barely touched.
   - Exports are unchanged (viewer only).
3. **Cameras looked different** (`js/wb.js`): all cameras share the mirror white point. "Match cameras" (Settings ▸ White balance, on by default) also nudges each camera toward the mirror cameras.
   - It uses the camera's own near-neutral pixels, offset at most ±7 %, smoothed.
   - The look goes through a per-camera SVG filter, or a per-tile tint on Safari.
4. **Left pillar tile shifting with WB on (Safari grid)**: the Safari path no longer puts a CSS `filter` on `<video>`. Brightness is now a `color-dodge` layer above the `multiply` tint; the redact canvas does the same.
   - Test: `test/wb-grid.js`, which checks tile and video rects with WB on/off in Chromium and WebKit.
   - Limit: the shift did not reproduce in Playwright WebKit on Linux. This fix targets the likely cause and needs a check on real Safari.
5. **Black car read "blue car"** (`js/vehicle-attrs.js`, daylight only): low-saturation, mid-dark blue (sky and glass reflections) now counts weakly, and the glass area counts less.
   - A mostly black/dark-grey body whose blue pixels are clearly brighter than the body reads black/grey (confidence at most 45 %).
   - Test: `test/dark-car-color.js`. The red Tesla, grey RAV4 and bus cases still pass.
   - Limit: a strong blue cast (≥ ~18 %) on a black car can still read blue.
6. **Recognition settings simplified** (`js/recog-settings.js`):
   - One "Recognition (beta)" section with five switches: Find objects in search, Show boxes while playing, Vehicle colour & type, Read licence plates, Blur licence plates. Plus a "Speed while playing" choice.
   - Every other control (same elements and ids) is under "Advanced recognition settings", collapsed by default. Its open/closed state is remembered (`tdc.recogAdv.v1`).
   - Tap targets are 44 px.
   - Test: `test/recog-settings.js` (Chromium, WebKit, WebKit iPhone touch).

## Left Pillar picture moving when White balance is turned on, Mac Safari (tag pillar-shift, rollback pre-pillar-shift = bb94249)
- **Measured:** the user's screenshots (day and night, WB off vs on) are the same to the pixel in position. The best shift is 0,0 and the sub-pixel estimate is ≤ 0.001 px. The picture edges are on the same rows and columns, and only the colour and the badge differ. Safari's own screen captures don't show the shift; it is only visible live. So it is treated as a compositing artifact (Safari re-compositing the video when the WB layers appear), not a layout change.
- **Fix:**
  - In blend mode (Safari / iOS) the two WB layers (multiply tint, color-dodge lift) are always there. On desktop they are added when the player opens; on phones, from the first time WB is turned on, and then kept.
  - With WB off the layers have identity colours (white multiply, black dodge = no change). Toggling WB only changes their colour. No blend mode, filter or will-change is ever added or removed.
  - Every `.tile` is always `isolation: isolate`, so the blend layers never change the stacking or compositing of the grid.
  - The SVG filter defs are absolute, 0×0, with no pointer events.
- **Debug:** `?debug=wb` shows a small readout with each tile's video rect, the contain picture rect, videoWidth × videoHeight, devicePixelRatio, the fractional device-pixel edges and the layers present. "Copy" puts the numbers on the clipboard, and they are logged on every WB toggle.
- **Grid vs single view:** both use `object-fit: contain` on the same video, so the picture has the video's own aspect in both (no crop); only the scale differs.
- **Test:** `test/wb-grid.js` has a full-UI phase in Chromium and WebKit (svg and blend; grid and the Left Pillar single view; badge visible; DPR 2):
  - Rects are identical, and the picture is at 0,0 at 40, 200, 700 and 1500 ms after turning WB on.
  - The layer structure is identical on and off (blend mode).
  - Nothing is in normal flow.
  - The grid tile matches the single view scaled down (within 1 device px).
  - The `?debug=wb` readout works.
- **Limit:** the shift never reproduced in Playwright WebKit (Linux), and Safari's captures don't show it. Whether it is gone can only be confirmed by looking at it live in Safari.

## Live boxes keep up with moving cars on iPhone (tag live-lag, rollback pre-live-lag = dc767dc)
- **Causes (measured with `test/live-lag.js`):**
  - In the 6-camera grid every visible camera got the same share of looks (plain round robin), so the camera with the moving car got one look in six, about 1 per second.
  - Between looks the box was moved for at most 0.5 s and then stopped. In the grid the next look usually comes later than that, so the box stood still and then jumped.
  - When the car moved more than its own width between looks, the match "missed": the box jumped to the car with zero speed and stood still again.
  - The speed was smoothed from the smoothed position, so it was always behind a car that speeds up.
- **Fix (viewer only; the export still uses the frame-exact boxes between two real detections):**
  - Alpha-beta tracker: the predicted centre and the speed are both corrected by the measured miss. The second look, and a car found again after a miss, take the measured speed as it is.
  - Every paint moves the box to the painted frame's own time (rVFC / camTime, as before). It moves at full speed up to about 1.3 looks ahead, then slows down (τ 0.3 s, at most 2 s), and stays inside the picture.
  - Next camera to look at: the one that has waited longest, weighted ×1 with a moving box, ×0.6 with a new box, ×0.25 still or empty, and by tile size on screen (√ share, at least 0.4).
  - Box lifetime per camera follows that camera's own measured gap between looks.
- **Not changed, on purpose:**
  - WebGPU stays off in Safari / iOS because onnxruntime-web 1.22's WebGPU build gets the worker killed there (#26827). It also needs a secure context, and an iPhone that opens the Mac over `http://<LAN address>` has no WebGPU and no WASM threads. `?webgpu=on|off|auto` (kept for later visits) lets you try it.
  - Frames already go to the worker as ImageBitmaps.
  - The Fast model's input is fixed at 320 px.
- **Debug:** `?debug=det` shows a readout with the backend, WASM threads, frame path, cross-origin isolated / secure context, model and input size, looks per second (all cameras and per camera, with the gap and "moving"), look and model ms, and Prediction on/off (a button; also `?pred=0`).
- **Measured** (mock detector answering with the true box after 150 ms; iPhone emulation 440×956 DPR 3; frame identified by a code burned into the picture):

  | Setup | Before: error / lag | After: error / lag |
  | --- | --- | --- |
  | Chromium 4× CPU, grid | 16.3 CSS px / 732 ms | 2.1 CSS px / 75 ms |
  | Chromium 4× CPU, focused | 2.2 CSS px / 54 ms | 1.6 CSS px / 34 ms |
  | Chromium 4× CPU, 300 ms looks, grid | 33.5 CSS px / 1351 ms | 7.8 CSS px / 308 ms |
  | Chromium 4× CPU, 300 ms looks, focused | 6.2 CSS px / 162 ms (p90 565) | 4.5 CSS px / 107 ms (p90 199) |
  | WebKit, focused | 4.4 CSS px / 89 ms | 3.8 CSS px / 82 ms |
  | WebKit, 300 ms looks, focused | 7.4 CSS px / 162 ms (p90 551) | 5.9 CSS px / 127 ms (p90 178) |

  Error and lag are medians unless marked p90.

## Phones: slim playback bar + pull-up sheet (tag mobile-bar, rollback pre-mobile-bar = 5fb3330)

On an iPhone held upright the transport (time row, timeline + sections lane, buttons, trim row, chips) took about a
third of the screen (259 of 932 px at 430×932).

- **Slim bar** (phones: width ≤ 760 px, or a touch screen in landscape ≤ 500 px tall): play / pause, the current time,
  the timeline and a ⌃ button, 62 px plus the home-indicator inset. It is in the page flow, so the cameras get the space.
- **Pull-up sheet** with everything else: stop, frame steps, speed, camera bar, full screen, the timeline with the
  sections lane and its hint, the trim buttons and the Labels / HUD / Map / Self-Driving / Time / White balance chips.
  Open: tap ⌃ or the grip, or drag the grip up. Close: tap again, drag down, tap the cameras (that tap does nothing
  else), or Esc. It overlays the cameras (the grid doesn't resize), slides with `transform` only (no slide with
  reduced motion), starts collapsed and remembers open / closed on the device (`tdc.mbarOpen`).
- **Sections:** adding a section opens the sheet at the trim row; the ⌃ button shows how many sections there are.
- **iOS:** 44 px targets; `touch-action: none` only on the grip and ⌃ (the timeline keeps its own scrub); a handle, not an
  edge swipe, so it doesn't fight the home indicator.
- **Unchanged:** keyboard shortcuts, desktop and tablet layouts. The nodes are moved, not copied (`js/mobile-bar.js`),
  so every handler and id is the same, and widening the window puts the original transport back.

Camera area (`test/mobile-bar.js MEASURE=1`, synthetic footage, WebKit and Chromium give the same numbers):

| 430×932 / 932×430 | before | after |
|---|---|---|
| portrait: transport height | 259 px | 63 px |
| portrait: camera area height | 603 px | 799 px (+196) |
| portrait: 2×3 tile height | 155 px | 155 px (tiles are width-bound when upright; the grid no longer sits under the controls) |
| landscape: transport height | 173 px | 63 px |
| landscape: camera area / 3×2 tile height | 205 / 102 px | 315 / 157 px (+54 %) |

Test: `node test/mobile-bar.js` (126 checks: WebKit + Chromium touch, portrait + landscape, desktop).

## iPhone unlock without an extension (tag ios-unlock, asset ios-unlock-1)
Rollback: `git checkout pre-ios-unlock`. The Tesla connector userscript, the console helper, the paste-keys boxes, decryption, playback and export are unchanged.
- `connector/ios-unlock-bookmarklet.js` is a self-contained "Dashcam Unlock" bookmarklet (built by `tools/build-bookmarklet.js` into `js/ios-unlock-src.js`, about 4.6 KB; Tesla's CSP allows bookmarklets but blocks outside scripts). On the signed-in Tesla tab it takes the clip requests from the page address (`#gridplayer…&gpi=…`), this tab's sessionStorage, or the clipboard ("Paste unlock request"), fetches `/api/1/decrypt/batch` on Tesla's own origin with the same token search as the connector, and hands back **only the keys**: `postMessage` to the opener pinned to its origin (hosted app, localhost, private LAN, `*.local` only) and a big **Copy keys** button. The token is never posted, copied or shown, and a reply containing it is dropped.
- Unlock dialog (`js/ios-unlock.js`): on iPhone / iPad (including the iPadOS desktop user agent) an iPhone card with **Copy bookmarklet**, **Copy unlock request**, a large **Paste keys from clipboard** button (same keys path as "Unlock with pasted keys"; refuses tokens and unlock requests with a clear message; falls back to the paste box if Safari blocks the clipboard read) and the Userscripts-extension steps as a second option. "Sign in with Tesla" also leaves the unlock request on the clipboard on iOS, and the "connector not detected" notice has iPhone wording.
- Limits: if Tesla's sign-in drops the address hash and the opener link, the first tap shows "no clip list" and a second tap (Paste unlock request) is needed; the clipboard read and write need a tap on iOS; the bookmark has to be made by hand once (iOS has no one-tap install).
- Tests: `test/ios-unlock-bookmarklet.test.js` (node, vm + mocked fetch) and `test/ios-unlock.js` (Playwright, WebKit + Chromium).

## Hand-off: layouts, cue, car view, cross-camera matching (tags handoff-m1 … handoff-m4, handoff; assets handoff-N)
Rollback: `git checkout pre-handoff`. Export, redaction, white balance, the 360 view and the Tesla connector are untouched.
- **M1 layout presets** (`js/layout.js`, css order rules): Current / Rear view / Mirrored bottom row / Auto (Sentry → Rear view). CSS `order` only (no re-parenting, videos keep decoding); the mirror is the individual `scale` property on the video, so zoom still uses `transform`. Boxes, labels, redaction and white-balance overlays follow the picture and never flip their text. Test: `test/layout-presets.js`.
- **M2 hand-off cue** (`js/handoff.js`, `js/people.js`, `js/detect.js`): fixed adjacency chain around the car, per-camera track ids, exit prediction, the entry-edge glow with arrow in the person's colour, extra looks on the neighbour (`T.handoff.boost`), weak zoomed person looks accumulate (`D.WEAK`: 3 looks in 3 s) so a single doubtful look never makes a track. Sentry events track people on all cameras by default, also on phones. Tests: `test/handoff.test.js` (node), `test/handoff-cue.js`, `test/handoff-fp.js` (112 zoomed crop-looks of the real model: 3 weak, 1 strong person hit, 0 accumulated into a track).
- **M3 car view** (`js/car-view.js`): SVG top-down car, six wedges that tile the circle, a tiny person per tracked person in their colour, legend chips, tap to highlight, compact on phones. Person boxes get the person's colour and `P1`/`P2?` name (viewer only; `burn-boxes.js` draws `hl` as a thicker outline, the export is unchanged). Test: `test/car-view.js`.
- **M4 cross-camera matching (beta)** (`js/reid.js`, `js/people.js`, `js/detect.js`, `js/detect-worker.js`, `models/reid/`): see README. Colour descriptor (32 bins, upper and lower body, grey-world normalised so exposure and white balance differences between cameras matter less) always; appearance vector from Intel's person-reidentification-retail-0288 (Apache-2.0, 0.77 MB ONNX converted with `tools/ir2onnx-reid.py`) in the detection worker; WebGPU only when the worker's runtime really is WebGPU, otherwise WASM, throttled to hand-off moments; self-test, then fall-through WebGPU → WASM → colour only; self-demotion when too slow; new tracks wait up to ~1 s (wall time) for their descriptor before they get an id. Settings ▸ Object detection ▸ *Cross-camera matching (beta)* (pref `crossCam`: auto | on | off, default **auto = on when the device keeps up**).
- **Measured** (test machine: headless Chromium / WebKit on a server CPU, no GPU; `test/reid-eval.js`, synthetic drawn people seen by two differently exposed "cameras", so a plumbing and robustness check, not an accuracy claim for real people): rank-1 over 12 people (chance 8 %): colour 67 %, appearance model 92 %. Hand-off linking (40 simulated trials, 2–4 people leaving the right repeater at the same moment and appearing on the rear): timing alone links 36 % of people (no wrong links, the rest become "new person"); colour 75 % recall, 91 % precision; appearance model 95 % recall, 99 % precision. One embedding ≈ 12 ms (WASM, box CPU), a colour descriptor 0.1 ms plus the video-frame read-back.
- **WebGPU:** `test/reid-webgpu.js` runs the bundled ONNX on the WebGPU execution provider through Chromium's SwiftShader software adapter (a test-only switch, `localStorage tdc.webgpu.soft=1`): embeddings equal the WASM ones (cosine 1.00000 on 6 crops), 600 ms per crop in software (which is why software adapters are never used normally). Default settings on that machine stay on WASM; `?webgpu=off` forces WASM; WebKit's gate stays closed unless `?webgpu=on` (Linux WebKit has no `navigator.gpu`, so the Safari WebGPU path itself cannot be exercised here). Real-GPU speed is not measured.
- **Perf gate** (`test/reid-perf.js`, iPhone-emulated Chromium, CPU throttle, real model, mock detector answering after 150 ms, 3 walkers on 3 cameras): at 4× throttle p95 frame gap is unchanged with matching on (18.1 vs 18.1 ms), the descriptor cost is under the Auto limit, matching stays on. At 6× throttle the descriptor cost (about 18–26 ms) is over the limit, so Auto switches matching off by itself on such a device.
- **Known limits:** see README. Existing known failures are unchanged (phase4-search 1 check, flaky WB Chromium car-shape, WebKit grid live-lag headless hang, WB-grid time limit).

## ui-v3 (tag `ui-v3`)

### 1. Mirrored bottom row order
- Mirrored bottom row is now LEFT REPEATER | REAR | RIGHT REPEATER (videos still flipped like a mirror). Rear view is unchanged (RIGHT REPEATER | REAR | LEFT REPEATER). Before this change both presets had the same order. To revert: `PRESETS.mirror.bottom` in `js/layout.js` and the `mirror` selectors in `css/app.css` (the landscape and portrait repeater reorder rules).
- The hand-off cue follows the picture: with Mirrored, the glowing REAR edge touches the RIGHT REPEATER tile (checked in `test/handoff-cue.js`). Test: `test/layout-presets.js`.

### 2. Compact bottom bar (desktop browsers only)
- Applies to a mouse (`pointer: fine`) in a window at least 1000 px wide and 501 px high. Phones, tablets and landscape phones keep their own rules.
- Tighter padding, timeline 44 -> 30 px (Advanced 70 -> 52 px), smaller buttons and chips. From 1640 px wide (default mode) the timeline and the controls share one row. Advanced on a window under 1440 px wraps its controls instead of running off the right edge (they used to be clipped).
- Every control is still there and reachable. Test: `test/desktop-bottom.js` (measures the grid and footer, checks controls are on screen and focusable).


### ui-v3 task 3: floating car view, pinnable, in the export
- Car view is now a fixed floating card (header with pin / collapse / close, corner resize handle). Drag anywhere in the window (clamped to the viewport only); pointer events, so touch works on iPhone / Safari. Pin locks position and size; pin, position, size and collapse are remembered per device (`carPanel` pref).
- Export dialog: **Include car view** tick (default on when the car view is visible; hidden when it is off). The wedges, car and coloured person icons are drawn by the compositor at the card's relative position and size; a card outside the grid is clamped to the nearest edge or corner of the picture. All export paths (WebCodecs, MediaRecorder fallback, 360 equirect) use it.
- People in the export: what the viewer showed (recorded history) when available, else a simple tracker over the stored person detections (no cross-camera linking).
- Limits: applies to the open-event export; the exported card is square with no legend chips; the phone card is scaled with the panel; headless WebKit cannot paint decoded video, so the pixel check decodes WebKit's exported file in Chrome.
- Tests: `test/car-float.js` (new, chromium + webkit, desktop + 430x932, includes decoded-frame pixel checks), `test/car-view.js` thresholds adjusted for the compact bar / header.


## decrypt-speed (tag `decrypt-speed`, backup tag `pre-decrypt-speed`)
Fixes "stuck at Reading files" on a phone and makes it installable offline.

**Why it froze.** With saved keys, the import step decrypted the files before it returned, on the main thread, with no progress text. On `http://LAN-address` pages the browser has no `crypto.subtle`, so the old pure-JS AES (about 0.7 MB/s) had to do it: one 40 MB camera file took about a minute, six files about six minutes, with the screen stuck on "Reading N files…".

**What changed**
- `js/crypto.js`: the JS AES is now a T-table AES-128 (32-bit words, precomputed tables). Output is byte-identical to Node crypto and to the old code (`test/crypto-aes.js`: random data, odd lengths, and a real-shaped page/IV flow). The WebCrypto path is still preferred and unchanged.
- `js/crypto-worker.js` (new): the JS fallback runs in Web Workers (one per file, a ready handshake with an 8 s timeout, fall back to the main thread if Workers are missing or fail). The main-thread fallback now yields to the UI every ~25 ms. 2 or 3 cameras decrypt at once only in the JS fallback and only when `navigator.hardwareConcurrency` allows (capped at 3; 1 on small devices).
- `js/library.js`, `js/ui.js`: real progress. "Reading files… n of m", then "Decrypting file i of n · % · MB/s · time left". Reads have timeouts (30 s probe, 45 s per decrypt read). A file that cannot be read is skipped, the others still load, and the error toast names how many and why. After 20 s without progress the overlay says so in plain words.
- `js/pwa.js`, `index.html`: a one-line dismissible "slow mode" note when `crypto.subtle` is missing, with a **How** button that opens the "Install / use offline" card.

**Installable offline app (PWA)**
- `manifest.webmanifest` (name Dashcam Studio, standalone, relative `start_url` and `scope`), `icons/` (made by `tools/make-icons.py` from the existing app icon), `apple-touch-icon` and apple-mobile-web-app meta tags.
- `sw.js`: relative scope (works at `/dashcam-studio/` on GitHub Pages and from any folder), cache-first. Core cache `dcs-core-<version>` holds the app shell, scripts, styles and small vendor files (about 1.3 MB, all or nothing). The extra cache `dcs-extra-1` holds the models, ONNX Runtime wasm and OCR pack (about 57 MB), fetched in the background after the first visit and retried on later visits.
- `precache.json` is generated by `tools/gen-precache.py`; `tools/bump-asset-version.py <ver>` now runs it and rewrites the `VER` line in `sw.js`. The version is in the `sw.js` bytes on purpose: the page itself may come from the offline cache, so a changed byte is what makes the browser install the new worker.
- Updates: a new version installs in the background and waits; a small "New version ready · Reload" bar appears and the new version only takes over when you tap Reload.
- Never cached: your footage (it is read from the device and never fetched), Range requests, video files, other origins, `/api/`, non-GET.
- Registered only on a secure context (https or localhost). Not on plain-http LAN pages, and not in automated browsers unless the URL has `?sw=1`. `?nosw=1` unregisters it and clears the caches.
- iPhone: open `https://shinrajp.github.io/dashcam-studio/` (https gives `crypto.subtle`, so fast WebCrypto), tap Share > Add to Home Screen. Open it once online and it then works offline.

**Tests** (`node test/<name>.js`, `BR=chromium|webkit DEV=desktop|phone`)
- `test/crypto-aes.js`: T-table vs Node crypto vs old code, speed.
- `test/decrypt-slow.js`: real http-IP page (needs `LAN=http://<box-ip>:<port>/index.html`, serve the folder on 0.0.0.0), six encrypted cameras of one clip with saved keys: progress texts, workers and no-Worker fallback, responsiveness, a stuck file (timeout and error toast), slow-mode note, help card, speed (`OLD=` URL of an old build adds the before/after number).
- `test/pwa-offline.js` (Chromium): serves the app under `/dashcam-studio/`, checks manifest and icons, caches, an offline reload, models served offline, no video cached.

**Limits**
- Real devices were not available; WebKit here is Playwright's headless build. Headless WebKit cannot paint decoded video and Playwright's WebKit has no offline service worker support, so the offline test is Chromium only (the code uses only the plain Service Worker and Cache APIs that iOS Safari supports).
- Decrypted files are still held in memory as Blobs (a 6-camera clip is a few hundred MB). At most 3 files decrypt at once.
- Not in the offline pack: `yolo11s`, the WebGPU wasm, `yolo11n-320`, the 640 plates detector, and anything from other origins (CDN files).
- GitHub Pages serves `main`. This branch is not on the live site until it is merged to `main`.


## legs-fix (tag `legs-fix`, backup tag `pre-legs-fix`)
Rear camera: a person very close behind the car (legs / dark lower body only, wide-angle picture) was labelled "cat".

**What I measured** (the real frame, kept out of the repo; same pre-processing as the app): yolo11n, yolo11s and the 320 px yolo11n all say *cat* 70-87% for the whole dark shape and *person* 0.1-0.9%. The person is not "just below the cut-off", the model has no idea. A tight crop of the legs alone gives person about 50% (nano), but only for some crops (bigger crops give cat again, and yolo11s stays at cat), so a second look alone is not reliable.

**Fix** (`js/detect.js`, section "legs-fix")
- Big animal boxes are person candidates (sizes in the README, "Person right behind the car"). Extreme size: person at once. Large: weak person, confirmed over 3 looks by the existing tracker rule (`D.WEAK`), or at once if the zoomed second look on the legs finds a person of 25% or more. The second look runs at most every 1.5 s per camera and only when such a box exists.
- Rear camera only: a person box under the cut-off (down to 20%) that touches the frame edge and is at least 25% tall is kept as a weak look. Other cameras are unchanged.
- Side and front cameras: only cat, dog and teddy bear are re-labelled (a horse or cow in a field can fill the frame). The rear camera takes any animal class.
- If a real person box overlaps the animal box, the animal box is dropped.
- Applies inside `D.detectImage`, so live boxes, search, export, hand-off cue, car view (dot and chip) and the people list all see the same label. Search and export take the box as a person at once (they have no tracker). Off switch: `localStorage tdc.legsfix=0`.
- Limits: the rule is about size and place, not about what the picture shows. A real cat or dog that fills 10% or more of the rear picture (very close to the lens) will be called a person; on weak looks a person-shaped box that disappears after 1-2 looks is dropped. A dark blob that the model labels as something outside the animal classes (bag, chair, bowl) is not fixed. A person who stands completely still right at the lens is a person for as long as the model says "cat" at that size, nothing more is known. Redact (text, plates, faces) does not use object classes and is unchanged.
- Test: `test/legs-fix.js` (mock detector: rules, live track on REAR, people registry, car-view chip, off switch; plus a private-frame check that is skipped when the local file is absent). Run per browser: `BR=chromium|webkit DEV=desktop|phone node test/legs-fix.js`.

## export-panel (branch feature/all-in-one)
Rollback: `git checkout pre-export-panel` (tip before this change, `legs-fix`).

Export dialog: **Map, HUD & car view** = On the picture / Fill black area / Add panel, with **Include HUD / map / car view** ticks, a **Camera order** choice (Match viewer / Standard fixed order) and a live **Output** size line.
- `js/compositor.js`: `C.layout` (planner for fill / add-panel, strip below or at the side, even sizes), `C.arrange`, `C.drawPanels`, `C.cameraOrder`; `drawFrame` follows `geo.order` / `geo.mirror` (flipped bottom row for the mirror layout, boxes mirrored, text not).
- `js/export.js`: `X.candidates` and `X.plan` (hardware-aware strip cap, `isConfigSupported` fallbacks with a note), map tiles are loaded per candidate for the panel map; the real-time recorder uses the same layout.
- `js/ui.js`, `index.html`, `css/app.css`, `js/core.js` (prefs `export.extras`, `export.order`).
- Defaults: Fill black area when the output has a black strip of at least 96 px, otherwise Add panel; Match viewer. `X.run` called without options keeps the old behaviour (overlay, standard order), so Export all and older tests are unchanged.
- Test: `test/export-panel.js`.

## occluded-people (branch feature/all-in-one)
Rollback: `git checkout pre-occluded-people` (tip before this change, `export-panel`).

Report: a black-shirt person with a brown backpack walking behind a parked Model Y's driver-side window (Right Pillar, dark garage) was "Nobody tracked".
- `js/motion.js` (new, pure): motion map per camera (`step`), windows that skip covered people and moving cars and mark glass (`windows`), crop planner, walker test, and `enhance` (stretch, gamma, glare knee, CLAHE-lite).
- `js/detect.js`: motion-seeded second looks (`D.seed`, budget per device, auto-throttle, `?seed=`), weak-look confirmation (`D.SEEDW`), ghost tracks and revive (`?occl=`, default 3.5 s), a cheap motion poll of cameras that get no model look (`SD.poll`), still-false filter with per-camera zones (`D.STATIC`, `D.stillZones`), optional YOLO11 medium (computers only, user-supplied file), two new Settings rows, `D.debugSeed`.
- `js/people.js`: forward-heading prior for same-camera re-linking (`DEF.fwd`). `js/det-debug.js`: motion / second-look overlay. `index.html`: `motion.js` script. `.gitignore`: `models/yolo11m.onnx`.
- Test: `test/occluded-people.js` (synthetic, pixel-based mock). Tool: `tools/clip-eval.js` (private frames only).
- Real-clip replay (private screen recording, 46 s, six tiles at 5 looks/s, small model): seconds with a person tracked 29 → 32 of 46, identities 4 → 3. The close-range miss at 18–23 s was **not** reproduced in the replay (the model sees him at 0.8–0.93 and the old pipeline tracks him), so the real miss is likely look rate or scheduling on the device. Seeded looks did not change coverage at 1.5 looks/s.

## unlock-ux (branch feature/all-in-one)
Rollback: `git checkout pre-unlock-ux` (tip before this change, `occluded-people`).

The "Manual console method (fallback)" in the Unlock dialog is now usable by regular people. Decrypt, the connector and its postMessage protocol, the console helper snippet and its output format, the iOS bookmark, `js/key-import.js` (`K.parse`), `js/tesla-auth.js`, saved keys and Forget are unchanged in behaviour.
- `index.html` / `css/app.css`: numbered step cards (copy helper, open Tesla in a new tab with `rel=noopener`, console, paste result), device-aware text (Mac incl. Safari's "Show features for web developers", Windows / Linux, iPhone / iPad = no console, use the bookmark) with "Show steps for another device", a privacy line, and an **Advanced** section (collapsed) holding the CORS explanation, token hint, the "undocumented" note and `#pendingItemsJson` (same id). Ids `btnCopyHelper`, `pasteKeys`, `btnApplyKeys`, `pendingItemsJson`, `details.manual` are kept.
- `js/unlock-ux.js` (new): device detection, paste → auto-apply (debounced; typing stays quiet until the text is complete keys), plain-English results next to the box (`aria-live`): "N of M clips unlocked", which clips still need keys, none matched, not keys / token / unlock request / wrong shape / empty. Applies through the same `T.library.applyKeys` + decrypt as before.
- `js/key-import.js`: new `K.parseLoose` (wraps `K.parse`; adds fence / quote / `< ` / `undefined` / log-line tolerance by scanning for the keys JSON). `K.parse` is untouched.
- `js/tesla-auth.js`: the Apply keys click hands over to `T.unlockUx.onApplyClick()` (inline messages instead of `alert()`); the original code remains as fallback.
- Test: `test/unlock-ux.js` (Playwright, chromium + webkit separately, synthetic encrypted clips).

## model-picker (branch feature/all-in-one)
Rollback: `git checkout pre-model-picker` (tip before this change, `unlock-ux`).

The optional YOLO11 medium model (AGPL, not in the repo) no longer ends in a bare "HTTP 404": Settings ▸ Object detection ▸ Model ▸ *YOLO11 medium* now has a file picker. Other models, the worker protocol for them, decrypt and export are unchanged.
- `js/model-picker.js` (new, `TDC.modelStore`): validates (≥ 10 MB; the real check is starting the model, a file the runtime can't open is removed again and an earlier stored file is kept), stores the chosen file in IndexedDB `tdc-user-models` (a Blob handle, so it isn't read into memory until the model starts; browsers that can't keep a Blob there get an ArrayBuffer; if IndexedDB refuses, it works until the page is closed and says so), warns (never blocks) if size or sha256 differ from the tested export, shows the status ("Stored on this device: yolo11m.onnx, 80.7 MB"), *Remove stored model*, *Use YOLO11 small instead*, and a collapsed help text (AGPL note, the export command, ultralytics/assets). No third-party mirror is linked.
- `js/detect.js`: for medium the order is stored file → `models/yolo11m.onnx` → `urls.medium`; the stored bytes go to the worker as a Blob (or a transferred ArrayBuffer); a missing model shows "YOLO11 medium isn't included in the app (it's an optional AGPL model). Choose the yolo11m.onnx file from your device." with the Choose button; the panel appears only while medium is selected and only on computers. `js/detect-worker.js`: `user:` pseudo-URL reads the Blob; the load answer also reports `stored` and `outShape`.
- Service worker / pack: unchanged in kind (`js/model-picker.js` is in the core list, the stored model is never cached or listed, and SW updates don't touch `tdc-user-models`). Asset version `model-picker`.
- Test: `test/model-picker.js` (Playwright, chromium + webkit separately; serves a hard-linked copy of the tree without `models/yolo11m.onnx`, and needs the real file at `models/yolo11m.onnx` or `MEDIUM=`).

## export-cams (branch feature/all-in-one)
Rollback: `git checkout pre-export-cams` (tip before this change, `model-picker`).

Export dialog: tick which cameras go into the file. All six by default (output byte-for-byte as before: same layout code path, same size, same name, same encoded bytes, checked in Chromium). Comparable apps (tesla_dashcam: exclude flags; TDashcamStudio: Select Cameras + grid; Focus/TesClip: single vs all) inspired chips + presets; none previews the result, so this one adds a summary and a layout picture.
- `js/export-cams.js` (new, `T.exportCams`): chips, presets (All / Front only / Front + Rear / Sides / Focused camera), last-camera guard, no-footage label, summary, layout picture. Session only (not persisted, comment says why).
- `js/compositor.js`: `C.shape(n, tile)`, `C.cellRect(grid, i, gap, cols, rows)`, geometry / layout take cols and rows (defaults 3 × 2 = unchanged). Free cell (3 or 5 cameras) holds the map / HUD / car view; side fill for 1 and 4 cameras. `drawFrame` uses the shape.
- `js/export.js`: `normCams`, `camsTag`, `shapeFor`, `sizeOptions(ev, shape)`; `Sources` decode only the ticked cameras; `layoutBase` filters order and mirror; real-time recorder uses the same order; file name suffix; result carries `cams, cols, rows`.
- `js/ui.js`, `index.html`, `css/app.css`: Cameras block, size line (free spot / beside the cameras), Original description for the shape, 44 px touch targets at ≤ 520 px. 360 hides the row.
- Service worker / pack: `js/export-cams.js` in the core list. Asset version `export-cams`.
- Test: `test/export-cams.js` (Playwright, chromium + webkit separately, desktop + phone 390×844; WebKit exports decoded in Chrome). Planner invariants for 1–6 cameras, dialog, real short exports (cells, native size, free cell, order/mirror, placeholders, decoder count, box/redact rects, six explicit = default).
- Not done: `burnBoxes.prepare`, `detect.prepareLive`, `plates.exportPrep` still process all six cameras.

## Plate models only from this app (tag plates-local)
Rollback point: tag `pre-plates-local` (= feature/all-in-one 59c36ee).
- The three plate models (YOLOv9-tiny 384 and 640 detectors, CCT-S reader, 20.9 MB) were already committed under `models/plates/`. `js/plates.js` still fell back to a raw.githubusercontent.com copy on the `feature/phase6-plates-ocr` branch; that fallback is removed (`L.BASE` is gone, `L.LOCAL = "models/plates/"`). A custom URL in Settings is still tried first.
- IndexedDB is a cache only: loading works with it empty, blocked or refused; if a cached copy is damaged the worker (`js/detect-worker.js`) drops it and fetches the file again (also for object-detection models).
- The offline pack no longer pre-downloads the plate files (13.0 MB in the background for everyone, for a feature that is off by default). Pre-cache "extra" went from 56.7 MB to 43.7 MB (tools/gen-precache.py). After plates are first used the service worker's run-time cache keeps the files; not tested offline.
- `models/README.md`: upstream licences re-checked (both repos MIT; training-data licence not stated upstream, flagged), 384 px detector and reader re-downloaded and sha256 match.
- Test: `test/plates-local.js` (Chromium + WebKit). Existing `test/phase6-plates.js` 33/33 before and after.

## Follow half-hidden people (tag bytetrack)
Rollback point: tag `pre-bytetrack` (= feature/all-in-one 3a650d4).
- `js/detect-worker.js`: optional `msg.pool` (person boxes from 0.10, returned separately as `pool`, after NMS, not mixed with detections).
- `js/detect.js`: `D.BYTE`, `D.byteOn()`, `btScore`; live `track()` stage 2 (leftover tracks x weak boxes; only tracks with peak >= 0.5, >= 2 sightings, not seeded/weak; retire after "Keep a hidden person" seconds without a strong look, `btStale`); `buildTracks`/`trackAround` the same with `f.pool`; `detectImage(..., {pool})` only full-frame person looks; setting *Follow half-hidden people* (default on, `?byte=0|1`).
- `tools/clip-eval.js`: medium model URL from `location.origin` (so the replay works from any port).
- Not changed: `js/people.js`, `js/handoff.js`, `js/motion.js`, `js/redact.js`, the track output format.
- Real-clip replay (private, not in the repo): small 32 -> 33 of 46 s, ids 1 on the man / 3 total unchanged, false-person seconds 10 -> 10; nano 36 -> 36 s, no change; medium 38 -> 39 s, man 28 -> 30 s, false seconds 7 -> 7, total ids 3 -> 3. First version made nano/medium worse (still headrest boxes kept alive); fixed with the peak >= 0.5 rule.
- Test: `test/bytetrack.js` (Chromium + WebKit, mock detector); existing tracker tests unchanged before/after.
- Ids on the man (replay, off -> on): small 1 -> 1, nano 4 -> 4, medium 4 -> 4 (nano/medium were already split before this change); registry totals 3/2/3 -> 3/2/3. Default stays ON because it is equal or +1 s on every model and the tests are unchanged, but it is a small, unproven gain on one clip.

## Custom redaction regions (tag custom-redact)
Rollback point: tag `pre-custom-redact` (= bytetrack, ccc92e7).
- `js/custom-redact.js` (new, `T.regions`): region model `{cam, shape: rect|poly, x,y,w,h, pts, mode: blur|remove, start, end, on}` in 0..1 of the camera's RAW frame (before mirroring), times in event-timeline seconds (so trims and joined sections need no special case). Limits 40 regions / 96 points. Stored in localStorage `tdc.regions.v1` under an FNV hash of the clip (event id, duration, file names and sizes: nothing readable is stored), LRU of 60 clips, in-memory fallback. JSON import/export.
- Painter: Blur = `R.softBlur` (shrink by halves, enlarge; no canvas `filter`, so it works in Safari), radius max(6, 0.4 x short side), source padded 25 %, clipped to the shape. Remove = opaque black (box snapped outward; freehand has a 1.5 px black edge).
- Viewer: `redact.js paintLive` draws the regions into each tile's `.redact-layer` (which carries the video's CSS zoom and mirror, so raw coordinates land on the right pixels). `focus.applyZoom` now repaints the layer (also fixes a stale redact layer when zooming while paused).
- Export: `compositor.drawFrame` burns inside the flipped cell for mirrored cameras; 360 equirect burns into per-camera copies before projection (`T.regions.prepareFrames`); VideoFrames go through `R.frameCanvas` (WebKit ignores the source rect of decoded frames). Export dialog note `#exportRegionsNote`.
- Editor: Redact panel "Custom regions" (camera, Box / Freehand, Blur / Remove, whole clip or From-to with Now / Use my sections, Draw region, Save region; list with tick / Show / Edit / Delete; Save as file / Load file). Mouse and touch (pointer events, `touch-action:none`); freehand simplified (Ramer-Douglas-Peucker) to at most 96 points. Phones: the docked panel covers the picture, so it steps aside while drawing and the floating `#crBar` carries Save / Draw again / Cancel / Options.
- Cost: no regions = one shared empty list and an early return (no drawing, no allocation); with regions the scratch canvases are reused (0 canvases created per frame; Chromium ~1.7 ms for two blur regions on a 997x748 tile, headless software WebKit ~10-13 ms; real phones unmeasured).
- Not done / limits: no follow tracking (future work); the live 360 look-around view does not show regions; the existing automatic redaction is not applied in the 360 export either.
- Tests: `test/custom-redact.js` (Chromium + WebKit, desktop + phone) on `tools/make-curved-plate-footage.py` (made-up curved plate): model/storage/JSON, painter (blur unreadable, Remove opaque), viewer placement (plain, mirrored, focused, zoomed), editor (mouse, touch, freehand, time range, list), export in five layouts, mirrored Match viewer, joined-section time gating, 360, viewer-vs-file parity (Chromium), phone layout, per-frame cost.
- Existing tests before/after: see the run log in the commit message / STATUS (only the known baseline failures remain).


## ui-quick: Show 360 setting, scrolling Search / Redact window (tag ui-quick)
Rollback point: tag `pre-ui-quick` (= custom-redact, 1a1d9a1).
- 360 hidden by default: new pref `show360` (false), `T.show360On()` in core.js (the pref, overridden by `?show360=1|0` for the visit), `T.apply360()` in pano-toggle.js hides `#btn360` and the 360 export preset (`#presetEquirect`), closes an open 360 view, and moves a selected 360 preset to Most Compatible. `ui.js openExport` also ignores a saved `equirect` preset while it is off. New Settings section "Labs (beta)" with the row "Show 360 view (beta)". Calibration (steering / accel signs) is not 360-only and stays. The 360 view's own Calibrate / Gyro buttons live inside the view, so they are hidden with it. `pano.js` still loads lazily. Everybody starts with it off, including people who had used it.
- Search / Redact window (`css/app.css`, `js/search-ui.js`): `.us-panel` has `overflow-y:auto`; floating max-height = screen height (was min(78vh, 620px)) set from the visual viewport in `placeFloat()`; sticky header; docked max-height capped to screen minus 190 px; phone sheet cap also applies to the docked sheet; results list no longer shrinks to nothing under the Custom regions section; after a resize the window is re-clamped into view (a drag past the screen height is stored as "as tall as fits").
- Draw bar Options: toggle with label "Back to drawing" (custom-redact.js). Not the planned in-bar pop-over.
- Test: `test/ui-quick.js` (Chromium + WebKit, desktop 1280x800 + phone 390x844, mock footage only).

## bar-fix: the draw bar never blocks drawing (tag bar-fix)
Rollback point: tag `pre-bar-fix` (= ui-quick, 10bf875).
- `#crBar` (Save region / Draw again / Cancel / Options) is click-through: `pointer-events: none` on the container, `auto` only on its grip and buttons, so a stroke that starts or runs over the bar still reaches the picture. One compact row (no wrapping at 390 px; the hint text is a small click-through pill above or below it).
- It moves itself: when a stroke starts or grows within 28 px of the bar, or the shape's bounds reach it, the bar glides (200 ms, skipped with reduced motion) to the screen edge away from the finger (never under it), honouring the iOS safe-area insets (`js/custom-redact.js`: `UI.avoidBar`, `applyPos`).
- A grip handle on the left drags the bar anywhere on screen (kept inside the viewport, Up / Down keys pin it to the top / bottom); the spot is remembered for the session only (`sessionStorage` key `dcs.crBarPos.v1`, nothing in `localStorage`).
- Also fixed while testing: while you draw (`body.cr-drawing`), the HUD / map / car-view floating panels and the camera bar's empty parts no longer grab a stroke that begins over them (they used to start dragging the panel instead). The camera bar's buttons and grip still work.
- Region semantics and export are untouched. Test: `test/bar-fix.js` (Chromium + WebKit, desktop, 390x844 phone, 844x390 landscape; real touch on Chromium phone).

## redact-button: a separate Redact button and Find / Redact tabs (tag redact-button)
Rollback point: tag `pre-redact-button` (= bar-fix, 8a9a176).
- New top-level `#rdBtn` ("Redact", `chip us-btn rd-btn`) inserted right after `#usBtn` (`js/search-ui.js`), same styling; on phones both are labelled pills in `.tp-controls` / `body.mbar .transport` (`js/mobile-bar.js` parks and unparks both). While the draw bar is up on a phone only the Redact circle stays so the bar never covers a button.
- `#usPanel` gets a tablist (`#usTabs`: `#usTabFind`, `#usTabRedact`, roving tabindex, Left/Right/Home/End). `U.tab` / `U.setTab` / `U.toggleTab` / `U.show(focus, tab)`; tab is kept in `sessionStorage` (`tdc.us.tab`). `U.find()` and `/` / Ctrl+K open Find; `U.redact()` and `#rdBtn` open Redact.
- Content is moved, not copied (all ids and handlers kept): the automatic redaction controls (`#usAutoH`, plate / face / text presets, `#usShowRow`) and the Custom regions section (`#crSec`, now a `<details>` that is always open on this tab) show on the Redact tab; `#usDrawRow` with `#crActions` (primary **Draw region**, Save region) sits at the top of it. Find shows only the search box, filters and results (`us-t-find` / `us-t-redact`, `data-tab` on the panel).
- Compact: docked and phone-sheet max-height 45% of the screen (a floating window is left as the user sized it, as before); the Redact tab uses two columns for Custom regions' form and, docked on a wide screen, a two-column grid.
- Drawing: the panel hides at every screen size (was phone only) and `S.hid` makes Save / Cancel always bring it back on the Redact tab; `body.cr-bar-on` marks the bar being shown.
- Region semantics, export and the bar-fix bar behaviour are untouched. Test: `test/redact-button.js` (Chromium + WebKit, desktop + 390x844 phone).

## tap-redact: tap the camera to redact, no camera dropdown; bottom bar fits (tag tap-redact)
Rollback point: tag `pre-tap-redact` (= redact-button, d2ad533).
- `js/custom-redact.js`: `#crCam` select removed. `UI.draw()` enters a pick mode when more than one of the event's cameras is visible (`visibleCams()`; a focused camera counts as one): `body.cr-picking`, hint "Tap the camera you want to redact", one real `<button>` per tile (Tab / Enter) that lets the pointer through, so the tap lands on the tile. `choose(cam, how)` focuses that camera and starts drawing; single camera skips the pick. The draw bar gets `#crBarCam`, a chip naming the camera; tapping it re-picks (back to the grid). The panel is hidden before measuring the cameras (a docked panel on a landscape phone squeezed the tiles to 0x0). Save / Cancel of a drawing always reopen the panel on phones.
- Storage format (`cam` per region) and burn-in are unchanged.
- Bottom bar (user report: the Redact button made the bottom too long and things overlapped bottom right): `css/app.css` makes `.tp-controls .chips` a sideways-scrolling strip (`min-width: 0`, hidden scrollbar, fade mask `more-r` when more is to the right, set by `js/search-ui.js`); Search / Redact icon-only at 761-1199 px (fine pointer; `aria-label` + title keep the name); `.tp-clock` hidden at 1000-1199 px in simple mode; on phones the floating Search / Redact pills hide while `body.cr-bar-on`. `js/core.js` `placeToast()` lifts or side-steps the toast around `#crBar`, `#usBtn`, `#rdBtn`, `#usPanel` (re-placed on body class changes); toast transition limited to opacity / transform.
- Tests: new `test/tap-redact.js`, new `test/bottom-overlap.js`; `custom-redact`, `redact-button`, `bar-fix`, `ui-quick` updated for the tap pick.


## map-float (tag `map-float`; rollback `pre-map-float`)
- `js/overlays.js`: a `.map-grip` button on the map. Dragging it (pointer events read on the window, 5 px threshold, as the camera-bar grip) sets `prefs.mapDock = "float"` and re-parents the map to `<body>` as `position: fixed` (z-index 29: under the drawer, bottom bars, dialogs). Position saved as fractions in `prefs.mapFloat {fx, fy}` (new; export keeps using `prefs.panels.map`). Clamped to the window and above the bottom controls (`O.floatFloor()`: top of the visible transport / mobile bar / Search / Redact / camera-bar chip / full-screen buttons) on every render, window resize, orientationchange and visualViewport resize. Dropping on the right strip of the video (`dockSpot()`) docks it (`mapDock = "aside"`); edges snap at 18 px. Keyboard: Enter toggles float / dock, arrows move 16 px (Shift 64). The map-move button reads "Dock" while floating.
- `js/pano-toggle.js`: `apply360()` hides every `.need360` element (Settings ▸ Calibration, `#calibSec`) and any open `#panoCalibPanel` while 360 is off.
- Tests: new `test/map-float.js`; `ui-quick` A2/A3/A7/A8 check Calibration with 360; `bottom-overlap` gets a `mapfloat` state (map pushed into the bottom-right corner).

## ui-glass-1 (tag `ui-glass-1`; rollback `pre-ui-glass-1`)
- `css/glass.css` (new, loaded after app.css): material tokens (`--g-rgb`, `--g-a` tint opacity, `--g-blur` 22 px, sheen, specular rim, two-layer shadow), applied to `.topbar`, `.transport` / `.mb-bar`, `.chip`, `.stage-bar`, `.us-panel`, `.us-btn` (floating), `.cr-bar`, `.drawer`, `.toast`, `.tile-label` / `.tile-expand`, `.car-view`, and the map frame (`.float-panel` drop shadows, `.map-grip` / `.map-move`). Only colours, radii, shadows and backdrop blur change, never sizes or positions (test/ui-glass-1.js check 4 compares every id's box with the sheet on and off).
- Blur: every piece is unblurred by default; `js/glass.js` puts `.g-blur` on at most 3 visible pieces in priority order (dialog, draw bar, floating Search / Redact window, Settings, camera bar, full-screen transport / strip, floating Search / Redact buttons, car view, toast), never one inside another. It re-checks after `hidden` / `class` changes (throttled to 120 ms) and on resize. `backdrop-filter` is always written with `-webkit-backdrop-filter`.
- `js/glass.js` (new, after core.js): pref `glass` ("auto" | "clear" | "solid", default "auto") in `T.DEFAULT_PREFS`; `?glass=` overrides it for one visit; Settings ▸ Appearance (`#appearSec`, `#segGlass`, `#glassNote`). Sets `html.glass`, `html[data-glass]` (the mode in effect) and `html[data-glass-pick]`. The mode is Solid when `CSS.supports` reports no backdrop-filter or `prefers-reduced-transparency: reduce` matches (also enforced in CSS with `@supports not` / `@media`). `prefers-reduced-motion` adds `html.glass-rm`, and the CSS media query removes the pieces' transitions.
- Automatic: about once a second (tab visible, Automatic only), the visible camera videos are drawn into an 8x8 canvas. `luma = 0.5*mean + 0.5*max` sets `--g-a = 0.62..0.9` (0.9 above 0.85; an unreadable frame counts as bright). 0.62 keeps #eef1f5 text at about 4.5:1 or better even over pure white. `T.glass.sample(drawable)` is exposed for tests.
- Export: untouched (the compositor draws on its own canvas; the map/HUD canvases and `D.panel` are not changed).
- Not in this step: the auto-hiding controls, the new layouts, and the SDF refraction (labs/glass-sdf), which is planned as the default for a later step with this frosted look as its fallback.

## ui-glass-2 (tag `ui-glass-2`; rollback `pre-ui-glass-2`)
- `js/autohide.js` (new, after focus.js) owns `body.idle`, which used to be set by `js/focus.js` after 2.8 s whether playing or not (camera bar only, plus the transport in full screen). `F.wake()` now hands over to `T.autohide.wake()`; `F.holdControls()` reports the old reasons to stay (pointer over the camera bar / transport, bar drag, bar hint, camera menu).
- Hides only while playing, after `prefs.autohide` seconds ("2" | "3" | "5" | "never", default "3"; `?autohide=` overrides for one visit; Settings ▸ Appearance `#segAutohide`, `#autohideNote`). Checked every 250 ms and on `state`. Holds (`T.autohide.why`): never, no-video, paused, pointer-down, export (`T.exporter.running`), redact (`cr-drawing` / `cr-picking` / `cr-bar-on`), settings, dialog (`.modal`, `dialog[open]`), panel (`#usPanel` shown), sheet (`#transport.mb-open`), camera-bar (`F.holdControls`), pointer-over (mouse over a control), typing (text field focused). Wakes on pointermove / pointerdown / keydown / wheel / focusin.
- `css/autohide.css` (new): hidden set = the on-video camera bar, `.tile-expand`, the floated map and the map grip / move buttons, and `#transport` (incl. the phone bar and Search / Redact buttons inside it). `body.idle`: opacity 0 + pointer-events none; `body.ah-gone` (260 ms later, at once with reduced motion): visibility hidden. The docked camera bar and the draw bar never hide. `#ahLine` (2 px, bottom of `#stage`; fixed in full screen) shows the play position while hidden. `js/glass.js` skips hidden pieces in the blur budget (`T.autohide.isHidden`).
- Touch: `js/focus.js` swallows the click of a tap that wakes the controls anywhere outside the top bar, sidebar, drawer, dialogs, Search / Redact window, draw bar and toast (it used to need the camera bar on and a tap on the video).
- Layout and export unchanged (hidden pieces keep their boxes).
- `js/core.js` `placeToast`: the on-video camera bar (`#stageBar` inside `#stage`, when not faded) is an obstacle too, now that it stays up while paused (at 844x390 with the Redact window open the toast sat on it).
- `test/bottom-overlap.js`: in the `mapfloat` state on screens ≤ 420 px tall, the floated map over the on-video camera bar is printed as INFO (the map is taller than the free space there; before this step the bar faded after ~3 s, so the check never saw it).

## ui-glass-3 (tag `ui-glass-3`; rollback `pre-ui-glass-3`)
- `css/capsule.css` (new, after autohide.css; skin only). Desktop / tablet: `.transport::before` is the capsule (inset 3 px top/bottom, 6 px sides, radius 24, `--g-sheen` + tint `max(--g-a, .86)`, `--g-rim` + soft shadow, pointer-events none); the transport takes the page colour (`--bg`) and `position: relative` (full screen keeps `fixed`); its rows get `position: relative` without z-index so they paint above the capsule without a new stacking context. Phones (`body.mbar`): `.mb-row::before` is the capsule (5 px past the row each side), `.mb-bar` takes `--bg`; the sheet gets radius 22 and the rim. `.tp-trim` is a small capsule (background + a 3–4 px spread shadow as padding, so nothing moves).
- Full screen: when `js/glass.js` gives `#transport` its blur (`.g-blur`), the blur moves onto the capsule pseudo-element; Solid has none.
- `js/ui.js` `drawTimeline`: radii only (scrub band min(12, h/2), lane 12, section blocks 9, handles and playhead knob fully rounded). `geom()`, `tlGeom()`, hit testing and the drag code are untouched.
- No layout, behaviour or export change: `test/ui-glass-3.js` checks every element with an id, `--tp-h` and `tlGeom()` with the sheet on and off, and that seek + trim drags give identical results both ways.
- Found (not changed): setting `prefs.advanced` from code without the `#advToggle` change handler leaves `body.simple` on, and `drawTimeline` then throws a negative-radius error from the playhead knob (30 px tall timeline with the sections lane). Not reachable from the UI; the test flips Advanced through `#advToggle`.
