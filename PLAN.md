# Tesla Dashcam Studio: plan

## Headline
**Automation first:** plug in the Tesla USB drive or SSD, walk away, come back to finished videos.
- The default path has no menus. Everything else sits behind an **Advanced** toggle.
- Two front doors share one rendering engine:
  1. **Companion** (Node, runs at login). It detects the drive, indexes it read-only, optionally decrypts, renders each new event to a 1080p H.264 MP4, writes a library page and notifies you.
  2. **Web app** (`index.html`, works from file://). Drop the drive → **Export all**. It is also the full manual player and editor.

## Goals → design
| Requirement | Design |
|---|---|
| Opens by double-click in Safari (Apple Silicon) and Chrome/Edge (Windows) | Classic `<script>` IIFEs under `window.TDC` (ES modules break on file://). No build step; vendored MIT muxers. |
| Load six cameras, whole TeslaCam folder | Drag-and-drop (recursive `webkitGetAsEntry`) or a folder or file picker. `teslacam.js` parses `YYYY-MM-DD_HH-MM-SS-<cam>.mp4`, groups by folder and timestamp, and joins clips less than 90 s apart into one event. |
| 3×2 synced grid | Two `<video>` elements per tile (double buffer, next clip preloaded 4 s early). Master clock = first available camera; followers are resynced past 0.15 s of drift. Labels and placeholders for missing, locked or broken files. |
| Telemetry HUD | Own SEI parser (`sei.js`): NAL 6 → payload 5 → Tesla UUID → protobuf SeiMetadata. Written from scratch because the reference repo has no licence. Units-based canvas renderers shared by the live view and export. |
| Map | OSM tiles (`crossOrigin`, attribution), track-only fallback offline, route + moving dot, click-to-seek. |
| Self-driving badge | Self-Driving `#3E6AE1`; Autosteer and TACC styled differently; none = hidden. |
| Toggles | Every overlay and HUD item, units, invert steering, swap accel axes, all in localStorage (`tdc.prefs.v1`). |
| Export | WebCodecs with hardware preferred, then software, then smaller sizes (never upscale). mp4-muxer / webm-muxer; MediaRecorder fallback. Presets: Most Compatible (1920×1080 H.264) and Original (tileW·3 × tileH·2; H.264, HEVC, AV1 or VP9). Progress, Cancel. Range = whole event or several sections joined into one file: output timestamps run continuously, each frame is drawn at its source time, and every section starts on a key frame. |
| Encrypted clips | Format and AES page decryption in `crypto.js` (Web Crypto + pure-JS fallback). Keys come via the connector userscript on dashcam.tesla.com (undocumented endpoint; honest README). |
| **Automation** | `companion/`: watcher → indexer → (decrypt) → renderer (headless Chrome/Edge running the web app; ffmpeg fallback) → library page, thumbnails, share-folder copy, notification. Installs as a LaunchAgent (macOS) or Startup launcher / Task Scheduler entry (Windows). |

## Companion architecture (`companion/`)
```
dashcam-companion.js   CLI: install | uninstall | run [--once] | scan | index | signin | signout | doctor | config
lib/platform.js        config dir, export dir, cloud folders (iCloud/OneDrive/Dropbox), browser + font discovery, volume roots
lib/readonly.js        the ONLY drive access (O_RDONLY reads, stat, readdir) + assertNotOnDrive() guard on every write
lib/indexer.js         walk TeslaCam → classify (plain/encrypted) → teslacam.group → durations → SEI GPS fallback
lib/state.js           content fingerprints of exported events (skip on re-plug; 3 retries for failures)
lib/library-page.js    library.json → <exports>/index.json + index.html (static, offline) and the live page
lib/server.js          127.0.0.1-only HTTP: web app files, job files, /api/{job,progress,result,done,signin-job,token,keys}
lib/render-browser.js  spawn Chrome/Edge --headless=new → index.html?companion=1 → MP4 uploaded back
lib/render-ffmpeg.js   fallback: filter_complex (scale/pad/fps/concat per cam → xstack) + ASS overlays from SEI; HW encoder probe
lib/tesla.js           key requests (undocumented endpoint) + Node AES page decryption into a temp cache
lib/keychain.js        macOS Keychain (security -i, stdin) · Windows Credential Locker (PowerShell) · libsecret · memory
lib/notify.js          osascript · Windows toast (PowerShell) · notify-send
lib/install.js         LaunchAgent plist · Startup .vbs (hidden) / schtasks · XDG autostart
```
**Why a headless browser rather than reimplementing the overlays in ffmpeg:**
- One renderer means the automatic export is pixel-identical to the preview, with the graphical HUD, map and badge.
- WebCodecs already reaches the platform hardware encoders.
- Chrome or Edge is on nearly every Windows PC and most Macs.
- The ffmpeg path keeps everything working without a browser, with text overlays instead.

## Milestones (status as of 2026-10-08, after the first real-Mac test)
| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold, PLAN, vendor muxers | ✅ done |
| 2 | Library: ingest, grouping, event.json triggers and location | ✅ done; tested with synthetic tree |
| 3 | Player: synced grid, transport, timeline | ✅ done; drift 0.019 s across the clip boundary in headless Chrome. Fixed: seeks issued before metadata painted frame 0 |
| 4 | SEI parser + telemetry HUD | ✅ done; field numbers checked against Tesla's published `dashcam.proto`. SEI is now also found when it comes after the picture data. Tested on synthetic SEI only, **not on real Tesla footage** |
| 5 | Map (OSM, offline track, click-to-seek) | ✅ done |
| 6 | Export (compat and original) | ✅ done; verified with ffprobe in headless Chrome on Linux and on the **real Mac**. On the Mac, 1080p used VideoToolbox; native 4344×1876 used Chrome's software H.264, because VideoToolbox H.264 tops out at 4096 wide. The ffmpeg fallback works with `h264_videotoolbox` after the ffmpeg 8+ fix. **Safari only reviewed in code** |
| 7 | Encrypted clips + connector | ✅ done; end-to-end against a **mock** dashcam.tesla.com. **Real endpoint untested** |
| 8 | Auto path in the web app (Export all, Advanced toggle) | ✅ done; Export all exercised through companion mode, interactive Export all only partially |
| 9 | Companion: watch, index, skip, render (browser + ffmpeg), library, notify | ✅ done; **real Mac**: the LaunchAgent picked up a mounted disk image (TESLADRIVE) within 4 s and exported 2 events in 7 s. The drive's SHA-256 and mtimes were unchanged and re-plugging skipped both events. The log shows the notification attempt; whether it appeared on screen wasn't checked |
| 10 | Companion: decrypt with sign-in, keychain, stored-token reuse, expiry handling | ✅ done against the mock. **macOS Keychain verified on the real Mac** with tokens of 1.2–9 KB, after fixing silent truncation above 4 KB. Windows Credential Locker **not run** |
| 11 | Installers (LaunchAgent, Startup / Task Scheduler) | ✅ LaunchAgent installed and running on the real Mac. It now points at the stable `/opt/homebrew/bin/node` instead of the versioned Cellar path. ⚠️ Windows **not run** |
| 12 | Real-hardware validation (Mac Safari, Windows Edge, real drive, real encrypted clips) | 🟡 partly done: real Mac with Chrome and a disk image. Still needed: Safari, a physical USB drive, real Tesla footage and SEI, real encrypted clips, Windows |
| 13 | Multi-section trim (ported from the Grid Player): add, select, drag edges or move, delete, clear; Play sections; Stop → first section; export sections joined (WebCodecs and real-time paths) | ✅ done 2026-10-08; tested in headless Chrome on Linux with synthetic samples (see the log below). **Not yet tried on the real Mac, on a touch device or in Safari** |

## Test plan
- Synthetic data from `tools/make-samples.py`:
  - HW4 (2896×1876 front + 1448×938 others) two-clip Saved event with SEI covering P→D, TACC→Autosteer→Self-Driving, turn signals and braking
  - HW3 Sentry event without SEI or pillars
  - RecentClips with a missing camera
  - a synthetic encrypted event
- Headless Chrome via puppeteer-core (`test/`):
  - layouts at 1024×700 to 1920×1080
  - sync across the clip boundary
  - both export presets, verified with ffprobe and extracted frames
  - unlock flow against the mock
- Companion:
  - simulated mount, 3 events × 2 presets
  - re-plug skip
  - sign-in page → keys and token
  - stored-token reuse
  - expired token → notification and plain events still exported
  - ffmpeg renderer
  - SHA-256 + mode + mtime manifest of the drive before and after (unchanged)

## Open questions
- Real Tesla SEI field numbering may differ by firmware. This needs one real clip to confirm.
- Does `dashcam.tesla.com` still expose the token and key endpoint the way the connector expects?
- Should RecentClips be exported automatically? It is off by default because it can be hours of footage.
- Should the companion delete its exports after N days, or after they are copied to the cloud? It doesn't today.

## Safari review (code reading; Safari can't easily be automated)
- **WebCodecs.** `VideoEncoder` and `VideoDecoder` exist from Safari 16.4 (H.264 and HEVC; no VP9 or AV1 encode). The exporter tries hardware, then software, then steps down in size (0.75×, 0.5×, then 1080p). If Safari's VideoToolbox refuses 4344-wide H.264, the export lands at 3258×1408 or HEVC; it never fails outright.
- **Fixed for Safari.** The exporter waited only on the `dequeue` event, which Safari doesn't fire, so an export could hang. It now also wakes on a 15 ms timer.
- **Already handled.**
  - no `showDirectoryPicker`, so Safari downloads files one by one
  - `ctx.filter` checked through `M.canFilter`
  - MediaRecorder fallback when WebCodecs is missing
  - pure-JS AES and MD5 when `crypto.subtle` is missing
  - `._` AppleDouble files are skipped (the disk image test produced them)
- **Not verified.** Whether Safari treats `file://` as a secure context, which the WebCodecs and `crypto.subtle` checks depend on. If it doesn't, the app falls back to real-time MediaRecorder.

## Real-Mac test log (2026-10-08)
- **Setup.** A 64 MB ExFAT disk image named TESLADRIVE, holding the synthetic `--quick` tree: Saved, 2 clips, 12 s, with SEI; Sentry on HW3, 5 s; RecentClips, which is skipped by default.
- **Run.** The LaunchAgent detected the drive 4 s after attach. Indexing took under 0.1 s, and both exports were done 7 s after detection: 1920×1080 H.264 High in VideoToolbox, 360 frames / 12.000 s (7.7 MB) and 150 frames / 5.000 s (1.7 MB).
- **Native size.** The HW4 full-size event at 4344×1876 / 36 fps (432 frames, 20.2 MB) took about 6 s with software H.264. Sentry at 3840×1920 used hardware.
- **Drive untouched.** SHA-256 of all 51 files (23 clips plus macOS `._` files) and the stat manifest were identical before and after. Re-attaching skipped both events.

## Multi-section trim test log (2026-10-08, headless Chrome 154 on the Linux box)
- **Data.** `make-samples.py --quick`: Saved event, 2 clips × 6 s (boundary at 6.0 s), with SEI. Sections were S1 1.0–3.0, S2 5.0–7.5 (across the clip boundary, right blinker flashing, Autosteer → Self-Driving) and S3 9.0–11.0, 6.5 s in total.
- **UI** (`test/mt-test.js`, real CDP mouse and touch input). It added sections with + and A and dragged edges with the mouse (landed within 0.03 s) and with touch (within 0.04 s). It moved S2's body by +1.25 s (exact), then set the exact edges with I/O from both keys and buttons. Scrubbing the upper timeline over a section left the sections untouched, and a tap selected a section. The Delete key and the button each removed the selected section and selected the next one.
- **Play sections.** 397 time samples were all inside the sections and in order. Section durations were 1.99, 2.50 and 2.02 s wall time, and playback ended paused at 10.999. Stop and Home both went to 1.000.
- **WebCodecs export** (Most Compatible, from the dialog with Sections joined): 195 frames, 6.500 s, H.264 High, 5.2 MB, done in about 5 s. Source times ran 1.000–2.967, 5.000–7.467 and 9.000–10.967, and key frames were at 0, 60, 120 and 135. The burned-in source frame numbers around the cuts were 106 | 180 and clip 2 #52 | #108. The clock read 14:32:43 | 14:32:46 and 14:33:42 | 14:33:44, as expected. The blinker, Autopilot badge and speed matched the source times (screenshot 17d).
- **Real-time export** (WebCodecs hidden): MediaRecorder MP4, 6.43 s, 111 frames at the headless frame rate. Draws covered only the three sections, and the frames around the cuts show the right source frames and clocks. It's real time, so the length is only accurate to a few frames. A stall watchdog now re-issues a hung `<video>` seek; with a forced stall the export recovered, or failed cleanly after 4 retries, instead of hanging forever.
- **Unchanged paths.** After clearing the sections the range is the whole event and *Sections* is disabled. With Advanced off, the range is the whole event and Stop goes to 0. The companion-style `auto.exportEvent` still gives 360 frames / 12.000 s.
