# Tesla Dashcam Studio

### ▶ Use it now: **https://shinrajp.github.io/dashcam-studio/**

A Tesla dashcam and Sentry viewer that runs entirely in your browser. Drop in your TeslaCam folder and get:

- **6-camera grid.** Front, rear, both pillars and both repeaters play in sync in a labelled 3×2 grid, with multi-clip events joined into one timeline.
- **Telemetry HUD.** A draggable graphic HUD with speed, gear, steering wheel, brake, accelerator, blinking turn signals, compass, g-force and GPS. It needs clips with Tesla's embedded telemetry, which arrived in firmware 2025.44.25+ on HW3 and newer.
- **Route map.** A map with the route and a dot that moves with playback. Click the map to seek. **Beside video** parks it next to the picture so it doesn't cover a camera. Drag the corner to resize. Export still burns the map onto the video.
- **One search box.** Tap **🔍 Search** (or press `/` or Ctrl/Cmd+K) to find a moment or hide text. It opens **below the video**, so it never covers a camera. Tap the float button to turn it into a window you can drag anywhere (also off the video), and the pin to lock it in place. On phones, full screen gets a strip of result thumbnails to jump between matches.
- **Find in the video.** Describe what you see, for example "a person in a hoodie and a mask." Matches are marked on the timeline. Click one to jump there, or turn them into sections. Frames stay on this computer. The first search downloads a vision model once (about 150 MB). Hits are guesses, not proof.
- **Redact in the window.** Type a name or other words, such as `Jane Doe` or `Taco Bell, Costco`. Only those words are covered. **All text** covers every word. Nothing to install.
- **Self-Driving badge.** It shows Self-Driving, Autosteer or TACC status.
- **Toggles.** Every overlay can be switched on or off, and your choices are saved.
- **Focus & full screen.** Click or tap any camera to enlarge it, switch angles from the camera bar or with keys 1–6, zoom in up to 4× (pinch, Ctrl+scroll or +/−) and drag to pan. You can also hide cameras in the grid and go full screen. The camera bar can be dragged anywhere on the video (grab ⋮⋮; double-click it to put it back), fades when idle, and can be switched off with the **Camera bar** switch or **C**. A small camera button brings it back.
- **Multi-section trim** (turn on **Advanced**). The timeline runs the full width of the window, with a scrub band on top and a tall section lane underneath. Mark several sections, drag their wide edge handles to trim them, drag the middle to move one, or split a section at the playhead. Pinch or Ctrl+scroll zooms the timeline so short cuts are easy to fine-tune. Then play or export the sections joined into one video. The clock and telemetry stay correct at every cut.
- **Export.** *Most Compatible* gives you a 1080p H.264 MP4. *Original* stitches the grid at native camera resolution, pixel for pixel with no upscaling. Overlays are burned into the video.
- **Big libraries.** A saved library index remembers every event you've opened (metadata only, never video), with **All / Undecrypted only / Already decrypted** filters, a reviewed checkbox and **Clear index**.
- **Encrypted clips, the easy way.** **Sign in with Tesla** fetches keys through a small connector userscript (Chrome + Tampermonkey, Safari + Userscripts), in session-aware batches of up to 30 files. You can also import a keys file or paste keys / a Bearer token, and the console helper always works as a fallback. Optional **Remember keys on this device** re-unlocks clips automatically next time.
- **iPhone & iPad.** Touch-sized controls, a 2×3 grid on a phone held upright, and Save / Share to Photos or Files after an export.

![Full screen: front camera at golden hour with the telemetry HUD and Self-Driving badge](screenshots/photo-hero-fullscreen.png)

![Six-camera grid with HUD, route map and Self-Driving badge, with the Find and Redact bars under the video: left blinker on while a Cybercab overtakes, before the lane change](screenshots/photo-grid.png)

![Sentry event at golden hour: a hooded passer-by on the right repeater](screenshots/photo-sentry.png)

<details>
<summary>More screenshots</summary>

![One camera enlarged, with the floating camera bar](screenshots/photo-focus-camera-bar.png)

![Find in the video: "a cyclist in the bike lane" returns two matches, marked in yellow on the timeline, with a gold box on the front camera](screenshots/photo-find.png)
*Find in the video: type what you're looking for. Matches show as chips and yellow marks on the timeline.*

![Redact in use: "blur all text" applied to the front camera, with Show blur on](screenshots/photo-redact.png)
*Redact: one click blurs text, plates or faces on the picture. Export uses the same blur.*

![Unified search on desktop: "Find moment" and "Blur text" in one floating box, with Find matches and blurred text regions listed by time](screenshots/phase4-after-desktop-open.png)
*One search box (new): Find matches and blurred text regions in one list. Click a row to jump there.*

![Phone: the search opens as a bottom sheet that sits above the keyboard; the video is not resized](screenshots/phase4-after-phone-sheet-keyboard.png)
*On a phone the search is a bottom sheet above the keyboard. The video underneath doesn't move.*

![Multi-section trim: three labelled sections on the full-width timeline (Advanced)](screenshots/photo-sections.png)

![iPhone (portrait): 2×3 camera grid with the full-width timeline and section lane](screenshots/photo-iphone.png)

![Export dialog: Most Compatible MP4, sections joined, overlays burned in](screenshots/photo-export.png)

![Sentry event: all four cameras](screenshots/photo-sentry-grid.png)

![Start screen: drop your TeslaCam folder](screenshots/photo-empty.png)

</details>

<sub>Sample footage is AI-generated mock-up imagery: a made-up street, no real dashcam video, people or plates.</sub>

## All-in-one test branch (`feature/all-in-one`)
This branch combines the work that isn't on `main` yet, so everything can be tried at once: Phase 4 search, the phone portrait grid, the camera bar dock, burn-in and live detection labels, Phase 5 object detection and tracking, connector 1.4.4 (home-network addresses), Phase 6 plates and street names with the optional cloud boost, the docked / floating / pinned search window with the phone thumbnail strip (plate results show their reading, e.g. "7ABC234 91%"), and the 360 view with its export. The beta features (object detection, plates, cloud boost, 360) stay **off** until you turn them on, and manual keys, decryption, playback and export work as before. Rollback: tag `pre-all-in-one` (= `feature/phase6-plates-ocr`), or check out any single feature branch.

## How to use
1. Plug your Tesla USB drive into your computer, or copy its `TeslaCam` folder somewhere.
2. Open the [app](https://shinrajp.github.io/dashcam-studio/). Then either drag the `TeslaCam` folder onto the window or click **Open folder**.
3. Pick an event on the left and press play, or click **Export all** to make one MP4 per event.
4. **Remove** drops one event from the list. **Clear** drops all of them. Neither deletes files on the USB drive. Open the folder again to bring them back.
5. The **library index** in the sidebar remembers events you've opened before, even after you close the browser. Use the filter (**All**, **Undecrypted only**, **Already decrypted**) to find what's left to unlock, and tick **reviewed** as you go. Remembered events show as "not loaded" until you open their folder again (browsers can't reopen a folder by themselves). **Clear index** forgets the list; it does not delete files and does not remove saved keys. If the browser blocks storage, the app still works and simply doesn't remember between visits.

**Phone and tablet layout:** held upright, the cameras stack 2 across and 3 down: **Front | Back**, then **Left pillar | Right pillar**, then **Left repeater | Right repeater**. Older cars without pillar cameras get two rows. Every tile is half the screen wide at the camera's own shape, never shrunk to fit. If the three rows don't fit above the controls (small phones, or with the classic search bars on), swipe the cameras up and down; the timeline and buttons stay put. Bigger screens fit all three rows. Turned sideways, phones use the same layout as a computer, and rotating switches right away. Tap a camera to enlarge it as before (pinch and drag stay inside that camera).

**Camera bar beside the video:** press **Beside video** on the camera bar (or Settings ▸ Camera bar) to move it off the cameras into a strip above the video. Drag its ⋮⋮ grip down to put it below instead. **On video** puts it back. The choice is remembered. On phones the strip sits above or below the grid and the tiles keep their size. Export never includes the camera bar.

![Camera bar docked above the video, covering no camera](screenshots/camera-bar-beside-desktop.png)
*Camera bar beside the video: it no longer covers the top row.*

![iPhone portrait: Front | Back, pillars, repeaters](screenshots/mobile-portrait-iphone-pro-max.png)
*iPhone, upright: 2 × 3 grid. Small phones scroll the grid instead of shrinking it.*

**On iPhone or iPad:** copy the clips into the Files app first, for example from the USB drive with a USB-C adapter. Then tap **Add files** and select the `.mp4` files (and `event.json` if there is one). The app groups them into events by the timestamps in their file names. Safari can't open a whole folder, so pick the files themselves. Use Files rather than the Photos picker, which may convert the videos.

## Search (Find + Redact in one box)
Tap **🔍 Search** next to the clock (on a phone, the round 🔍 button above the controls), or press **/** or **Ctrl+K / Cmd+K**. Type, then:
- **Find moment** (Enter) looks for a scene or object, such as "a cyclist in the bike lane".
- **Blur text** (Shift+Enter) hides those words wherever they appear. The chips (**Blur plates**, **Blur faces**, **Street signs**, **All text**) work as before.

Results drop down in two groups, **Find matches** and **Blurred text / regions**, each with its time. Click or tap one to jump there: a Find match switches to that camera and draws the gold box, and a text region focuses its camera and flashes a gold outline around it. **Esc** closes the box (a second Esc leaves the focused camera as before). The 🔍 button shows how many results there are.

The gold box on the video carries a small label with what was searched for. A picture-search result is labelled as a guess, e.g. "white car? (best match)" or "white car? (match)", never with a %. With object detection on, a detector result shows the real class and confidence, e.g. "car 91%". It's the same text the export burns in. It scales with the camera tile and never covers the buttons. See `screenshots/live-labels.png`.

**Burn detection boxes into the export:** in the Export dialog, tick **Burn detection boxes** (off by default; the choice is remembered). The gold box and its label (e.g. "white car? (best match)", or "car 91%" from the object detector) are then drawn into the exported video on the right camera, for the same few seconds the viewer shows it. Text size follows the video size, with a dark background so it stays readable on a phone. Frames with no box are left untouched. See `screenshots/burn-boxes.png`.

On phones and narrow windows the box is a bottom sheet pinned above the on-screen keyboard. The video grid isn't resized while you type.

**Where the search box sits:** by default it's docked **below the video** in its own strip; the cameras shrink to fit above it and nothing is covered. In its header:
- **Float** (window icon) detaches it into a movable window. Drag the header (mouse, pen or finger) anywhere on screen, including outside the camera grid; it always stays fully on screen. Drag the corner to resize. With the ⋮⋮ grip focused, the arrow keys move it (Shift for bigger steps). Double-click the header to dock or float.
- **Pin** locks the floating window where you put it: no dragging or resizing until you unpin. If the window gets smaller it's kept on screen, and it goes back to your spot when there's room again.
- **Dock** (same button while floating) puts it back below the video.
The mode, position, size and pin are remembered on this device. Clicking the video no longer closes the box; use × or Esc. On a phone, while you type, the docked box lifts above the keyboard and the cameras stay put. See `screenshots/search-float-*.png`.

**Phone thumbnail strip:** on a phone in full screen (or with one camera enlarged), a strip sits just above the controls. **Results** shows a small picture of each match with its time, camera and label; tap one to jump there with the gold box. **Cameras** shows a snapshot of each camera; tap to switch (**All** goes back to the grid). The ⌄ button folds it away. Thumbnails are made only when they scroll into view, at 96 px, and freed when the results are cleared. Upright, the video is fitted above the strip; sideways the strip overlays the bottom like the controls and fades with them.

**Classic search bars:** Settings ▸ Search ▸ *Classic search bars* (or the checkbox at the bottom of the search box) brings back the original Find and Redact bars under the video. You can also open the app with `?search=classic`. If the new search ever fails to start, the classic bars appear on their own.

## Object detection (beta)
Settings ▸ **Object detection** (off until you turn it on). When it's on, a search for an object name (**car**, **person**, **truck**, **bicycle**, **dog**, **traffic light**… any of the 80 COCO classes, plurals and a few synonyms such as "people" or "bike") uses a YOLO11 object detector instead of the picture search. Results show the real class and confidence ("car 91%") on the gold box, and the box **follows the object**: frames ±2.5 s around the match are detected and linked with a simple IoU tracker. Export burns the same boxes in when **Burn detection boxes** is ticked. Any other phrase still uses the existing picture search. With **Grounding DINO** picked, any phrase goes to the detector.

- **Model:** YOLO11 nano (10.7 MB, the default on phones), YOLO11 small (38 MB, the default on computers), or Grounding DINO tiny (experimental: 150–200 MB download, only sensible on a computer with WebGPU).
- **Small objects:** umbrellas, bags, signs and other usually-small classes get a lower threshold (60% of the setting) and, when the whole frame finds none, a second look at four zoomed, overlapping tiles. This costs up to 5× the time for those frames. **Always zoom** applies it to every search; **Off** disables it.
- **Confidence:** the threshold (default 35%). **Detect while playing:** optional, runs on the focused camera about once a second (every 2 s on phones).
- It runs in a background worker with onnxruntime-web: WebGPU when the device has a real GPU adapter, otherwise WASM. The status line shows which one. **Safari (Mac and iPhone) and every iOS browser always use WASM:** onnxruntime-web's WebGPU build runs away with memory in Safari/WebKit 26+ and the browser silently kills the worker. To try WebGPU there anyway, run `localStorage.setItem('tdc.webgpu','on')` in the console (`'off'` forces WASM everywhere). The model is downloaded once, then kept in IndexedDB. That works on plain-http home-network addresses too, where the browser cache isn't available.
- If the model or runtime can't load (offline, blocked CDN, old browser), the app says so and falls back to the picture search. Playback, keys and export are not affected.
- The detection runtime (onnxruntime-web 1.22) is included in `vendor/ort/`, with jsDelivr only as a backup. YOLO needs no internet once the page is served. Grounding DINO still downloads transformers.js and its model from the internet.
- It works with any static web server, including ones that send the wrong file types for `.js`/`.mjs`/`.wasm` (e.g. Windows `python -m http.server`). The worker and runtime are loaded from in-memory copies with the right type.
- **License:** the YOLO11 weights are **AGPL-3.0** (Ultralytics). See [`models/README.md`](models/README.md).

![Real YOLO11 nano detections on the sample clips](screenshots/phase5-live.png)

## Plates & street names (beta)
Settings ▸ **Plates & text** (off until you turn it on). Then type a plate in the search box:

- `plate 7ABC234` (exact), `7ABC 23` (part of a plate, spaces and dashes ignored), `7AB*` or `7A?C234` (wildcards), `plates` (every plate in the event).
- Look-alike characters still match: searching `5SMP26O` finds 5SMP260 (O/0, I/1, B/8, S/5, Z/2, G/6), and one wrong character is allowed for 5+ characters.
- `street Palm Ave` finds street-name signs and other sign text (tick **Also read street names and signs**; slower). "Ave"/"Avenue", "St"/"Street" etc. are treated as the same.

The first plate search on an event reads it once (about one frame per second per camera; the status line counts the frames). The plates and street text are kept in this browser's library index, so later searches on that event, even after a reload, are instant. The index stores only the text, time, camera, box and confidence (never pictures or video). **Forget plate & text index** clears it. Results show as `0:04.2 · Front · 7TST123 98%`; the gold box reads `plate 7TST123 98%` and follows the plate across nearby frames, and **Burn detection boxes** puts the same label in the export.

**Results and Best match:** every reading of the same plate (any camera, any time in the event) is merged into one result; its gold box and thumbnail use the clearest sighting. Each result is labelled the same way in the results list, on the gold box, in the exported video and in the phone strip:

`7ABC234 · match 100% · read 91% · seen 2× · Best match`

- **match** = how closely the reading fits what you typed (100% exact, 95% wildcard, 90% part of a plate, lower for look-alikes or one wrong character). Left out for `plates` / `street` with no words, where everything matches.
- **read** = how sure the on-device reader is about the characters. **checked by Grok / Claude / Gemini** is added after a cloud re-check.
- **seen N×** = the plate showed up N separate times (different cameras, or more than 2 s apart).
- **Best match** = the highest *match × read*. Plates within 2 points of the top all get it (a tie).

Tick **Best match only** in the search box (or **★ Best only** in the phone strip) to show just the best match. The list, gold box, timeline marks, phone thumbnails and *Burn detection boxes* in the export then follow it; plate blurring does not (every plate found is still blurred). The choice is remembered on this device. See `screenshots/plate-bestmatch-*.png`.

**Blur licence plates:** tick it in Settings ▸ Plates & text or in the Export dialog. Plates found by the reader are blurred on the live player and in the exported video. If the event hasn't been read yet, export reads every camera first (one time). The existing **Blur plates** chip in Redact now uses the real plate finder too when Plates & text is on (otherwise it keeps the old text-shape guess).

- **Models** (all MIT, included in `models/plates/`, so it works offline and on plain-http home-network addresses): [open-image-models](https://github.com/ankandrew/open-image-models) YOLOv9-tiny plate finder, **Fast** 384 px (default on phones) or **Accurate** 640 px (default on computers), 7.8 MB each; [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) CCT-S reader, 5.3 MB. Street text uses the PP-OCR text finder already bundled for Redact. Details and checksums: [`models/README.md`](models/README.md).
- **California format:** readings of 7 characters are fitted to the standard 1ABC234 pattern (digit, 3 letters, 3 digits): a character of the wrong kind is replaced by the reader's second choice, or by its look-alike, and its confidence is lowered. Vanity, commercial and other states' plates are kept as read.
- **Settings:** plate finder size, "find plates above" (default 30%), "trust readings above" (default 40%; weaker readings show as *weak*), far plates (zoomed tiles for big HW4 frames on computers; Always / Off), street names, blur.
- **Speed** (headless Chrome, box CPU, WASM, one thread): Fast 0.12 s + reading 0.08 s per frame, Accurate 0.3 s + 0.08 s. An 8 s, 2-camera event was read in 7.9 s. Phones are slower; Fast is the default there.
- **"Plate reading unavailable"** names what went wrong: a file that couldn't be fetched, a script error, or the step the worker was on when the browser stopped it ("the browser stopped the worker while starting the model on WebGPU" usually means out of memory or a WebGPU problem). A worker killed while starting WebGPU is retried once on WASM automatically. Plates start their worker the same way as object detection, whether or not detection is turned on.
- Readings can be wrong. Treat a plate as a lead and check the video. If a model can't load, plate search says why; playback, keys, decryption and export work as before.

![Plate search: the gold box follows the plate](screenshots/phase6-plate-search.png)

## Vehicle details (beta): colour, bus type, police / ambulance / fire, make & model
Settings ▸ **Vehicle details (beta)** (off until you turn it on; **Also guess make & model** is a separate switch, also off). Then type what you are looking for in the search box:

- `red tour bus`, `city bus`, `school bus`, `white police car`, `ambulance`, `red fire truck`, `yellow taxi`, `blue pickup truck`, `silver SUV`, `black Tesla Model Y`, `blue Toyota`. Longer phrases work too ("tour bus and regular local street buses"). Chips under the box show how it was read: `color: red` `type: tour bus` `detector: bus`.
- Plate phrases go to the plate search: `blur the license plate`, `find plate 9DZM`, `licence plates`, `tag starting with 7AB`. "blur …" also turns on **Blur licence plates**. If Plates & text is off it says so instead of running the picture search.

How it works (two stages, all on this device): the object detector (YOLO11) finds cars, buses and trucks; each box is then described. **Colour** comes from the box's pixels (centre-weighted, 12 named colours, a second colour is kept for two-tone vehicles). **Type / role** (tour bus vs city bus, school bus, minibus, police car, ambulance, fire truck, taxi, delivery van, pickup, semi, box truck, SUV, sedan, hatchback, sports car) and **make & model** (26 common US brands, about 90 models) come from the CLIP picture model the picture search already uses, asked "a photo of a … " about each crop. CLIP is only loaded when the query names a type or make; `red bus` uses colour alone.

Results use the same label everywhere (list, gold box that follows the vehicle, live labels, *Burn detection boxes* in the export, phone strip): `red tour bus · bus 95% · type 61% · color red · Best match` (detector confidence, type/make confidence, colour). **Best match only** works as for plates. The detected boxes and their colour/type/make guesses (numbers only, no pictures) are kept in the library index, so a repeat search on the same event is instant (0.3 s instead of 10 s); **Forget vehicle index** clears it.

- **Accuracy** on 37 public-domain / CC0 Wikimedia Commons photos (see `models/README.md`): detector class 37/37; colour exact ~61–70%, accepted by the colour query ~91%; type ~86% top-1 (tour vs city bus 13/15); make ~70% top-1, make + model only ~20–40%. Treat make/model as a hint.
- **Speed** (headless, box CPU, WASM): detector ~0.8 s per frame, CLIP ~0.2 s per vehicle crop, colour ~1 ms. Search samples up to 60 frames (30 on phones) and checks up to 4 vehicles per frame (2 on phones).
- **Limits:** colour is unreliable at night and under orange sodium street lights (the label then reads `color red? (low light)` and the colour counts for less); sky reflections push white/silver towards blue. Double-decker sightseeing buses can be read as city buses. Make & model is zero-shot and weak on look-alikes and recent facelifts. If the CLIP model can't load, it says "Vehicle details unavailable (…)" and plain words keep using the picture search; playback, keys, decryption and export are not affected.

![Vehicle details: red tour bus](screenshots/vehicle-attrs-chromium-tour-bus.png)

## Cloud boost (optional: Grok, Claude or Gemini)
Off by default; the on-device plate reader and detector above always come first. In Settings ▸ **Cloud boost** you can pick **Grok (xAI)**, **Claude (Anthropic)** or **Gemini (Google)** and paste **your own API key**. Then:

- **Re-check weak plates:** after a plate search, a **Re-check N weak plates with Grok/Claude/Gemini** button appears under the search status when some readings are below "trust readings above". It sends a small crop around each unsure plate (one per plate per ~4 s, up to "calls per run"). The answer is stored next to the local reading (the local one is kept), and results say `· checked by Claude`. Search again to use the corrected text.
- **Ask anything:** start a search with `ask `, for example `ask a red umbrella` or `ask a white van with a ladder`. A few frames, spread over the event, are sent downscaled (longest side ≤ 1024 px). The model returns boxes as JSON; they show as gold boxes with its label, text and confidence. These boxes are per frame and aren't tracked.

**Before anything is sent** a dialog shows which host gets the pictures (`api.x.ai`, `api.anthropic.com` or `generativelanguage.googleapis.com`), that frames leave your device, that each call is billed to your account, and roughly how many calls. Cancel sends nothing. "Don't ask again" is remembered per provider until **Forget API keys**.

- **Key storage:** in this tab only (sessionStorage) unless you tick **Remember key on this device** (localStorage, not encrypted). The key goes only to the provider you chose (or to the local companion if you turn on its relay). It is never put in the repo, URLs, logs or the library index. **Forget API keys** clears all keys and consents.
- **Cost control:** one call at a time, at least 1.5 s apart, at most "calls per run" per action (default 12). Default models are small and cheap; you can type another model name: `grok-4.3`, `claude-haiku-5-5`, `gemini-3.5-flash-lite` (as of Oct 2026; see each provider's model list).
- **Browser access (CORS), checked Oct 16, 2026:** all three APIs accept direct calls from a web page (x.ai and Anthropic answer `Access-Control-Allow-Origin: *`; Anthropic needs the `anthropic-dangerous-direct-browser-access` header, which the app sends; Google echoes the page's origin for `x-goog-api-key`). If a provider changes that, the error says so. When the app runs inside the **companion** (`/app/…?companion=1`), tick **Use companion** to relay calls through `127.0.0.1`. The relay only forwards POSTs to those three API paths with their auth headers, needs the companion token, and stores nothing.
- **Honest status:** request formats follow each provider's current docs and are tested against **mocked** providers (Chromium and WebKit). They have **not** been tried with real API keys here. Cloud answers can be wrong too; treat them as leads.

![Consent before the first send](screenshots/phase6-cloud-consent.png)

## 360 view (beta prototype)
Tap **360** in the camera bar. The six cameras are stitched on your device's GPU (WebGL2, or WebGL1 on older browsers) into one view around the car:
- **Look around:** drag to turn, pinch or scroll to zoom, double-click to reset. **Gyro** uses the phone's motion sensor (iPhone asks for permission).
- **Flat 360:** the whole equirectangular 2:1 picture.
- Each camera is undistorted with a lens model (fisheye Kannala–Brandt or rectilinear) and placed by its estimated angle. Overlaps are feather-blended, and areas no camera sees (above the car, and the gaps around it) are dark.
- **The camera angles and fields of view are estimates** from public information: Tesla lists the main forward camera at about 50°, wide 120°, B-pillar "forward-looking side" cameras at 90°, and fender repeaters aimed about 45° toward the rear. They will not line up perfectly on every car. **Advanced ▸ 360 ▸ Calibrate** adjusts yaw, pitch, roll, field of view and k1 per camera with a live preview, saves on this device, and exports/imports JSON. Automatic refinement (feature matching in the overlaps) is not built yet.
- All cameras are projected as if things were far away, so close objects in the overlaps can show double or ghosted.
- With 360 off nothing extra loads (`js/pano.js` is fetched on first use). Phones render at half resolution and at most 30 fps; nothing is drawn while the video is paused and unchanged, or while the tab is hidden.
- **Export:** Advanced ▸ Export ▸ **360 equirectangular (beta)** writes a 2048×1024 MP4 (WebCodecs browsers). The file has **no spherical metadata**. Before uploading to YouTube or a 360 player, run Google's [Spatial Media Metadata Injector](https://github.com/google/spatial-media/releases) on it.

![360 look-around view (sample clips)](screenshots/panorama-look.png)
![360 flat equirectangular (sample clips)](screenshots/panorama-equirect.png)

## Keyboard shortcuts
| Key | Action |
|---|---|
| / or Ctrl/Cmd+K | open search (Esc closes it) |
| Space | play / pause |
| ← → | previous / next frame (Shift: ±5 s) |
| 1 – 6 | focus Front, Back, Left side (pillar), Right side (pillar), Left mirror (repeater), Right mirror (repeater) |
| [ / ] | previous / next camera |
| G or Esc | back to the grid |
| + / − | zoom the focused camera (pinch or Ctrl+scroll also work; drag to pan; double-click resets) |
| F | full screen |
| C | camera bar on / off |
| H · M · D · L | toggle HUD · map · Self-Driving badge · camera labels |

With **Advanced** on: A adds a section, B splits the section at the playhead, I / O set its start / end, S plays only the sections, Delete removes the selected one. On the timeline, Ctrl+scroll or a pinch zooms in, scrolling sideways pans, and double-clicking (or the zoom button) zooms back out.

## Privacy
- **Your footage never leaves your computer** unless you turn on the optional Cloud boost (below). The video files are read and processed locally in your browser. Nothing is uploaded and there's no server or account.
- **Video search** scores frames on this computer. The first search downloads a vision model from Hugging Face (`huggingface.co` and `cdn.jsdelivr.net`). After that the browser keeps the model. The video itself is not sent.
- **Map tiles** come from OpenStreetMap (`tile.openstreetmap.org`), so OSM sees roughly where the map area is. You can turn map tiles off in the app. The route is then drawn on a plain grid.
- **Encrypted clips:** only small key-request records (VIN, key id, wrapped key — never video) go to Tesla's own site, and only when you click *Sign in with Tesla*, run the key helper or use a token you pasted.
- **Library index:** stores file names, sizes, times, camera counts and decrypted/reviewed status in your browser (IndexedDB). Never video, never keys.
- **Plate & text index** (only if you turn on Plates & text): plate numbers and street text read from your footage, with time, camera, box and confidence, in this browser (IndexedDB `tdc-text-index`). Never pictures. **Forget plate & text index** clears it.
- **Cloud boost** (off by default): only when you pick Grok, Claude or Gemini, paste your own key, and confirm the dialog, are downscaled frames or plate crops sent to that one provider's API (billed to you, under their data policy). Your API key stays in this tab unless you tick Remember key.
- **Saved keys:** off by default. Only if you tick **Remember keys on this device** are the 16-byte clip keys stored in this browser (IndexedDB, not encrypted), so anyone using this browser profile could unlock those clips. **Forget saved keys** wipes them, the keys used in the current tab, and clipboard auto-apply, and re-locks open clips. Bearer tokens you paste are kept in memory only and never stored.

## Redact plates, faces, and text
Nothing to install. Open **🔍 Search** (or use the classic **Redact** bar). Type the words to hide, such as a person's name or `Taco Bell, Costco`, and press **Blur text** (**Apply** on the classic bar). Only the text that matches those words is covered. Other words stay visible. **All text** is the switch that covers every word. Plates and faces are separate buttons. The effect shows on the picture and is included when you export. **Clear** takes it off. The original file on the USB drive is not changed.

The text finder is [PP-OCRv4](https://github.com/PaddlePaddle/PaddleOCR) (Apache-2.0), the same kind of detector as the Python tool's CRAFT model, converted so it runs inside the page. The letter models are already in the folder, so Apply works from a downloaded copy with no internet. The video is not uploaded. Plates are the wide text-shaped regions low in the frame. Faces use the browser's face finder. This does not remove an arbitrary object such as "the yellow truck."

Keep the whole folder together. Opening only `index.html` from outside that folder cannot find the letter models.

The same words also work in [`tools/redact.py`](tools/redact.py) if you want the optional GPU path on a long clip. That path is not required.

It understands:

- `Jane Doe`
- `Taco Bell, Costco`
- `blur the license plate`
- `remove the license plate`
- `blur faces`
- `blur all text`

**Remove** fills the box with the surrounding picture. That works best on a plate or a short bit of text. **Blur** is the safer choice for faces.

### Optional GPU tool
Only if you want a faster pass on a long clip. The website does not need this.

```bash
pip install torch torchvision
pip install -r tools/requirements-redact.txt
```

On an NVIDIA PC, install the CUDA build of PyTorch from [pytorch.org](https://pytorch.org) first, then install the requirements file.

```bash
python3 tools/redact.py "/path/to/front.mp4" "blur the license plate"
```

The new file is `front-redacted.mp4` next to the original. Add `-o` to choose another name. The first text run downloads the CRAFT model. A face request downloads a small face model once.

This does not remove an arbitrary object such as "the yellow truck" or "a person in a hoodie." It only tracks plates, faces, and text.

## Browser support
- **Chrome or Edge (desktop): best.** You get fast hardware-accelerated export, and *Export all* can save straight into a folder you pick.
- **Safari (Mac):** playback, overlays and trimming work. Export may be slower, and *Export all* saves each video to Downloads one at a time.
- **Safari on iPhone and iPad (iOS 16.4+):** playback, overlays, focus view and trimming work with touch. Export runs in the browser (WebCodecs). When it finishes, tap **Save / Share** to send the video to Photos or Files. Keep the tab in front while it exports, and prefer short sections, because long or *Original* exports can run out of memory on a phone. Older iOS versions fall back to a slower real-time recording, and if a browser can't do either, the export dialog says so. iPhone Safari has no real full-screen mode, so **Full screen** fills the browser window instead. *Export all* saves the videos one at a time.
- Firefox has not been tested.

## Encrypted clips (optional)
Newer Tesla firmware can encrypt dashcam clips. Unencrypted clips need no account at all. Each key request uses the file's own id from the clip header, and decryption happens in your browser.

**How keys are fetched.** Clips are grouped into recording sessions (4 cameras on older cars, 6 with the pillar cameras) and sent to Tesla in batches of at most 30 files, one batch after another, keeping whole sessions together. If Tesla refuses one batch, the others still go through and the app tells you which failed.

### 1. Install the connector (v1.4.4)

**Running Dashcam Studio from another computer on your home network** (e.g. `http://192.168.1.20:8770`, or a `*.local` name)? Connector 1.4.4 trusts these automatically: localhost, 127.x, 10.x, 172.16–31.x, 192.168.x and `*.local`, on http or https and any port. Older connectors answer "Connector refused: player origin … is not in ALLOWED_PLAYER_ORIGINS"; reinstall to fix it. The Tesla sign-in token is still only handed to players on the same computer (localhost); network players only get the per-clip keys.
The connector is a small userscript that runs only on `dashcam.tesla.com` and hands the keys back to Dashcam Studio. Get it from the app's **Unlock** dialog (**Download connector** / **Copy script**) or open [`connector/Tesla-Grid-Player-Connector.user.js`](connector/Tesla-Grid-Player-Connector.user.js) and click **Raw**.

**Chrome or Edge (Tampermonkey)**
1. Install **Tampermonkey**.
2. Open `chrome://extensions` → Tampermonkey → **Details** → turn on **Allow user scripts** (older Chrome: turn on **Developer mode** at the top right). Without this, Tampermonkey silently runs nothing.
3. Install the connector and make sure it's enabled.

**Safari on Mac (Userscripts)**
1. Install the free **Userscripts** app from the Mac App Store and open it once (note its scripts folder, "Change save location").
2. Safari ▸ Settings ▸ Extensions: tick **Userscripts**, then **Edit Websites…** and set `dashcam.tesla.com` to **Allow**. The Userscripts icon should appear in the toolbar.
3. Put `Tesla-Grid-Player-Connector.user.js` in the Userscripts scripts folder (or open it in Safari and use the Userscripts toolbar icon ▸ Install), and switch it on.
4. **Delete older copies.** Connector 1.4.0 and earlier can't run on Tesla's page in Safari. Remove them, and any empty "NewScript-…" script, so only v1.4.4 is left.

**Check it's running:** open `dashcam.tesla.com`. A small blue badge at the bottom left should say **"Dashcam Studio connector v1.4.4 active"**, followed by:
- **not linked**: it's installed; open Tesla from the app's **Sign in with Tesla** button.
- **linked · N clip(s) to unlock**: connected to the app; sign in if asked.
- **Dashcam Studio window link lost**: the sign-in redirect cut the link; when the keys are fetched, click **Copy keys for Dashcam Studio** and switch back to the app.
A red **connector error** badge shows what went wrong.

### 2. Unlock
1. Open your folder. Locked events show 🔒, and the top button reads **Unlock N encrypted files**.
2. Click it, then **Sign in with Tesla** (the button shows how many clips are waiting). Sign in on the Tesla page if asked. The keys come back and the clips unlock.

**Other ways, in the same dialog:**
- **Import keys or token (no console needed, works on phones):** choose a keys file, or paste keys JSON or a Bearer token. A token can only be used directly if your browser lets the page call Tesla (often it can't, because of CORS); the app says so and points you to the helper.
- **Manual console method (fallback):** **Copy key helper**, open `dashcam.tesla.com`, sign in, open the browser console, paste and press Enter. It fetches the keys in batches, sends them back to the app when the app opened that tab, and copies a clean JSON. Paste it into **Paste keys**, or just return to the app: keys on the clipboard are applied automatically.

### 3. Remember keys (optional)
Tick **Remember keys on this device** in the dialog to store each clip's key in this browser. Next time you open (or re-add) the same clips they unlock automatically, before anything asks Tesla. Each event shows a 🔑 note such as *unlocked with saved keys* or *no saved key match*, and the sidebar shows **🔑 N saved key(s)** (click it to open the key settings). When nothing is locked, the top button stays available as **🔑 Keys (N saved)**. **Forget saved keys** asks first, then forgets everything and re-locks open clips. Saved keys are per browser and per address (`localhost` and `file://` are separate).

![Unlock dialog](screenshots/photo-unlock.png)

![Locked event: encrypted cameras, the sidebar's All/Undecrypted/Decrypted filter, and "0 saved key(s)"](screenshots/07-encrypted-locked.png)

![Official dashcam.tesla.com with the connector v1.4.3 badge: keys sent back to Dashcam Studio](screenshots/09-tesla-connector.png)

![Unlocked and playing: the top button now reads 🔑 Keys (6 saved)](screenshots/10-encrypted-unlocked-playing.png)

![Remembered events panel in the library sidebar](screenshots/photo-library-index.png)

### Troubleshooting
- **"Connector not detected"** after 20 s: there's no badge on the Tesla page, so the script isn't running. Recheck *Allow user scripts* (Chrome) or the Userscripts extension and site permission (Safari), and remove duplicate or old copies.
- **Safari, no badge:** turn on Safari ▸ Settings ▸ Advanced ▸ **Show features for web developers**, then on the Tesla tab choose Develop ▸ **Show JavaScript Console**, reload, and look for lines starting with `[DashcamStudio]`. No `connector 1.4.4 starting` line means Userscripts isn't injecting it.
- **"Connector detected, but no Tesla sign-in token yet":** sign in on the Tesla page, or use its **Paste token** box.
- **"Tesla refused the key request: HTTP …":** your session may have expired, or Tesla changed the endpoint. Sign in again or use the console helper.
- **Sign in with Tesla does nothing:** no clips are waiting. The list was cleared, or every clip already has a key. The message says which.
- **Clips stay locked after Forget:** that's intended. Supply keys again.

Some caveats:
- The Tesla key endpoint is undocumented and may change. The ≤30-files-per-request limit is a cautious guess.
- The connector only hands keys to this site (`https://shinrajp.github.io`) and to copies of the app running on your own computer (`localhost`), or to a local `file://` copy after one confirmation click. A helper you paste yourself can also post keys back to the window that opened the Tesla tab.

## Automatic exports (optional companion helper)
The companion runs in the background on your Mac or PC. Plug in the drive and walk away. It finds new Saved and Sentry events, exports a 1080p MP4 of each with the HUD and map burned in, and notifies you when they're done. It only reads the drive and never writes to it.

1. Download this project: [**Download ZIP**](https://github.com/shinrajp/dashcam-studio/archive/refs/heads/main.zip), then unzip it. Keep the folder together, because the helper uses the app files next to it.
2. Install the requirements:
   - **Mac:** install Homebrew from [brew.sh](https://brew.sh), then run `brew install node ffmpeg`. Google Chrome or Microsoft Edge is recommended for the full graphical HUD.
   - **Windows:** run `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg`.
3. Run the installer:
   - **Mac:** double-click `companion/install-mac.command`. If macOS blocks it, run `bash companion/install-mac.command` in Terminal from the unzipped folder.
   - **Windows:** double-click `companion\install-windows.cmd`.
4. Plug in the Tesla drive. The videos appear in `~/Movies/TeslaCam Exports` on a Mac or `Videos\TeslaCam Exports` on Windows.

Helper commands are run as `node companion/dashcam-companion.js <command>`:
- `doctor` checks your setup.
- `config` changes settings, such as native-resolution export, RecentClips, a cloud share folder or auto-decrypt.
- `uninstall` removes the helper.

The [`companion/`](companion/) folder has the source.

## For developers
- [`PLAN.md`](PLAN.md) describes the architecture. [`CHANGES-v2.md`](CHANGES-v2.md) lists the v2 changes and rollback tags.
- `node test/batching.test.js` runs the batching unit tests. `test/*.js` are headless-Chrome tests (puppeteer-core; serve the folder with `python3 -m http.server`). `test/legacy/` holds the original build-box harness, whose paths need adjusting. `tools/make-samples.py` builds synthetic TeslaCam footage, including encrypted clips.
- After editing `connector/Tesla-Grid-Player-Connector.user.js`, run `node tools/build-connector.js` to refresh the copy the app offers for download.

## Status
This is a working prototype. It has been tested with synthetic TeslaCam footage in Chrome and on an Apple Silicon Mac, but not yet with a wide range of real Tesla footage, real encrypted clips, or on Windows. Feedback and issues are welcome.

Not affiliated with or endorsed by Tesla, Inc. "Tesla" is a trademark of Tesla, Inc.
