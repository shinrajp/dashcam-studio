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
