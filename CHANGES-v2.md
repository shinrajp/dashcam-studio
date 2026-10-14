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
