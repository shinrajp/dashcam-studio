# Test harness (as used on the build box)

These scripts were written for the Linux build box and use its absolute paths (`/workspace/tdc-test/...`).
Adjust the paths to rerun them elsewhere. They need `npm i puppeteer-core` in the test folder, Google Chrome, ffmpeg and Python 3 (`cryptography` package for the synthetic encrypted clips).

| File | What it does |
|---|---|
| `../tools/make-samples.py OUT [--encrypted] [--quick]` | Builds a fake `TeslaCam/` tree: HW4 two-clip Saved event with SEI telemetry, HW3 Sentry event without telemetry or pillars, RecentClips with 5 cameras, and a synthetic **encrypted** Saved event (+ `synthetic-keys.json`). |
| `serve.js` | Tiny CORS static server (port 18765) so the headless page can fetch the sample files. |
| `test1.js`, `test2.js` | Web app: ingest, grouping, playback sync across the clip boundary, layouts at 4 window sizes, compatible and original exports. |
| `mock-tesla.js` | **Mock** `dashcam.tesla.com` on https://127.0.0.1:18443. It serves a page that runs the real connector userscript and a fake `/api/1/decrypt/batch` that answers from `synthetic-keys.json`. It never contacts Tesla. |
| `test3.js` | Encrypted flow in the web app (file:// origin → one-click confirm in the popup): unlock, decrypt and play. |
| `companion-env.sh` | Env for companion tests: test-only token file, mock endpoint, mock CA, no browser auto-open. |
| `test4.js` | Companion sign-in page → Unlock with Tesla → mock popup → token and keys are handed to the companion. |
| `test5.js` | Screenshots of the generated library pages. |
| `mt-test.js` | Multi-section trim: adds, drags (mouse and touch), moves and deletes sections; Play sections; Stop; exports the sections joined via WebCodecs and real-time MediaRecorder (logs the source time of every frame); then clears; Advanced off; and the companion-style full export. Needs `serve.js` on port 18766 serving a `make-samples.py --quick` tree. |
| `mt-stall.js` | Forces a playback stall during a real-time export to check the watchdog: it recovers, or fails cleanly. |
| `dec1.js` | Decrypts one synthetic clip with `js/crypto.js` in Node (for cross-checking). |

Companion end-to-end (what was run):
```bash
. test/companion-env.sh
node companion/dashcam-companion.js run --volumes-root /workspace/tdc-test/volumes &
mkdir -p /workspace/tdc-test/volumes/TESLADRIVE
ln -s /workspace/tdc-test/fake/TeslaCam /workspace/tdc-test/volumes/TESLADRIVE/TeslaCam   # "plug in" the drive
```
