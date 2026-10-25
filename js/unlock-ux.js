/* unlock-ux.js — the "Manual console method" in the Unlock dialog, made easy for regular users.
 * Device-aware steps (Mac / Windows-Linux PC / iPhone-iPad), numbered cards, "paste and it applies by itself",
 * plain-English results ("3 of 4 clips unlocked", which clips still need keys). It only wraps the existing pieces:
 * the helper snippet (T.auth.helperSource), the key parser (T.keyImport.parseLoose → K.parse) and the same apply path
 * (T.auth.applyAndDecrypt). Progressive enhancement: if this file fails to load, the old buttons and boxes
 * (#btnCopyHelper, #pasteKeys, #btnApplyKeys, #pendingItemsJson) keep working exactly as before. */
(function () {
  "use strict";
  const T = window.TDC;
  const U = (T.unlockUx = {});
  const $ = (id) => document.getElementById(id);
  const NAMES = { mac: "your Mac", pc: "your Windows or Linux PC", phone: "iPhone / iPad" };
  const PICK_NAMES = { mac: "a Mac", pc: "a Windows or Linux PC", phone: "iPhone / iPad" };

  /** "mac" | "pc" | "phone" (iPhone, iPad, iPod — including iPadOS — and Android). */
  U.detectDevice = (ua, platform, touch) => {
    ua = String(ua == null ? navigator.userAgent : ua);
    platform = String(platform == null ? navigator.platform : platform);
    touch = touch == null ? navigator.maxTouchPoints : touch;
    if (/iP(hone|ad|od)|Android/.test(ua)) return "phone";
    if (/Mac/.test(platform) && touch > 1) return "phone"; // iPadOS reports a Mac
    if (/Macintosh|Mac OS X/.test(ua) || /^Mac/.test(platform)) return "mac";
    return "pc";
  };

  const wrap = () => $("uxManual");
  U.device = () => (wrap() && wrap().getAttribute("data-dev")) || "mac";
  U.setDevice = (d) => {
    const w = wrap(); if (!w || !NAMES[d]) return;
    w.setAttribute("data-dev", d);
    const nm = $("uxDeviceName"); if (nm) nm.textContent = NAMES[d];
    w.querySelectorAll("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", b.getAttribute("data-pick") === d ? "true" : "false"));
    const bm = $("uxPhoneBookmark"); // the bookmark card only exists on an iPhone / iPad
    if (bm) { const ios = T.iosUnlock && T.iosUnlock.isIOS && T.iosUnlock.isIOS(); const card = $("iosUnlock"); bm.hidden = !(ios && card && !card.hidden); }
  };

  // ── results ──
  const lockedItems = () => T.library && T.library.items ? [...T.library.items.values()].filter((it) => it.kind === "encrypted" && !it.blob) : [];
  const hasEncrypted = () => T.library && T.library.items ? [...T.library.items.values()].some((it) => it.kind === "encrypted") : false;
  const clipName = (it) => String(it.name || it.path || "clip").split("/").pop();
  function show(text, kind, still) {
    const r = $("uxResult"), ul = $("uxStill"); if (!r) return;
    r.textContent = text || ""; r.className = "notice ux-result" + (kind ? " " + kind : ""); r.hidden = !text;
    if (ul) {
      ul.textContent = "";
      (still || []).slice(0, 8).forEach((n) => { const li = document.createElement("li"); li.textContent = n; ul.appendChild(li); });
      if (still && still.length > 8) { const li = document.createElement("li"); li.textContent = "…and " + (still.length - 8) + " more"; ul.appendChild(li); }
      ul.hidden = !(still && still.length);
    }
    if (text && kind) { try { r.scrollIntoView({ block: "nearest" }); } catch (_) {} }
  }
  U.show = show;

  /** Plain-English reason a pasted text is not usable keys (never JSON, never CORS). */
  U.badMessage = (p) => {
    if (p.kind === "token") return "That looks like a Tesla sign-in token, not keys. Don't paste tokens here. The helper prints the keys; copy that line from the console instead.";
    switch (p.why) {
      case "empty": return "Nothing to apply yet. Paste what the helper printed in the console.";
      case "shape": return "That has no keys in it. The helper's result starts with {\"results\":[…]}. If the console said “No keys fetched” or showed an error, sign in on the Tesla tab and run the helper again.";
      case "request": return "That is the unlock request, not the keys. Paste the helper's printed result instead.";
      default: return "That doesn't look like the helper's result. Copy the whole line that starts with {\"results\": from the console and paste it here.";
    }
  };

  let busy = false, lastAuto = "";
  /** Apply pasted text. mode: "auto" (typed / pasted, stays quiet unless it parses) | "button" | "paste". Returns true when something unlocked. */
  U.apply = async (raw, mode) => {
    const K = T.keyImport, A = T.auth;
    const text = String(raw == null ? "" : raw).trim();
    const p = K && K.parseLoose ? K.parseLoose(text) : { kind: "bad", why: text ? "notjson" : "empty" };
    if (p.kind !== "keys") { if (mode !== "auto") show(U.badMessage(p), "err"); else if (mode === "auto" && p.kind === "token") show(U.badMessage(p), "err"); return false; }
    if (busy) return false;
    const before = lockedItems();
    if (!before.length) {
      show(hasEncrypted() ? "All your clips are already unlocked." : "No encrypted clips are open yet. Open your TeslaCam folder first, then paste the keys.", hasEncrypted() ? "ok" : "err");
      return hasEncrypted();
    }
    A.suppressClipboard = false; try { localStorage.removeItem("tdc.noClipboardApply"); } catch (_) {}
    busy = true; show("Applying keys…", "");
    let r;
    try { r = await K.applyKeys(p.results, "Pasted keys"); }
    catch (e) { console.error(e); busy = false; show("Couldn't apply the keys: " + (e && e.message || e), "err"); return false; }
    busy = false;
    const left = lockedItems(), n = before.length - left.length, m = before.length;
    if (!r || !r.applied) {
      const refused = r && r.errors ? ` Tesla refused ${r.errors} of them (usually an expired sign-in: sign in again on the Tesla tab and re-run the helper).` : "";
      show("None of these keys match the clips open here." + refused + " Make sure the same clips are open, click Copy key helper again and re-run it.", "err", left.map(clipName));
      return false;
    }
    if (!left.length) { show(`✓ ${n} of ${m} clips unlocked. You can close this window and press play.`, "ok"); return true; }
    const errs = T.library.keyErrors ? left.map((it) => T.library.keyErrors.get(it.header && it.header.wrappedHex)).filter(Boolean) : [];
    show(`${n} of ${m} clip${m === 1 ? "" : "s"} unlocked. ${left.length} still need${left.length === 1 ? "s" : ""} keys:`
      + (errs.length ? ` (Tesla refused some: ${errs[0]})` : "") + " Run the helper again to get the rest.", "err", left.map(clipName));
    return n > 0;
  };

  U.onApplyClick = () => { const ta = $("pasteKeys"); lastAuto = ta ? ta.value : ""; return U.apply(ta ? ta.value : "", "button"); };

  U.init = () => {
    try {
      const w = wrap(); if (!w) return;
      U.setDevice(U.detectDevice());
      const pick = $("uxDevicePick"), tog = $("uxDeviceToggle");
      tog?.addEventListener("click", () => { const open = pick.hidden; pick.hidden = !open; tog.setAttribute("aria-expanded", open ? "true" : "false"); });
      w.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => U.setDevice(b.getAttribute("data-pick"))));
      $("uxShowMac")?.addEventListener("click", () => U.setDevice(U.detectDevice() === "pc" ? "pc" : "mac"));
      $("uxGoBookmark")?.addEventListener("click", () => { const c = $("iosUnlock"); if (c) { try { c.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (_) { c.scrollIntoView(); } } });

      // how many clips are waiting
      const need = () => {
        const n = lockedItems().length, el = $("uxNeed"); if (!el) return;
        el.textContent = n ? `${n} encrypted clip${n === 1 ? " is" : "s are"} waiting for keys. The helper fetches them in one go.` : "The helper asks Tesla for the keys of your locked clips. (No locked clips are open right now.)";
      };
      need(); T.on && T.on("library", need);
      const modal = $("unlockModal");
      if (modal && window.MutationObserver) new MutationObserver(() => { if (!modal.hidden) need(); }).observe(modal, { attributes: true, attributeFilter: ["hidden"] });

      // copy feedback right next to the button (the dialog notice is at the top, out of sight on a phone)
      $("btnCopyHelper")?.addEventListener("click", () => setTimeout(() => {
        const n = $("uxCopyNote"), top = ($("unlockNotice") || {}).textContent || ""; if (!n) return;
        n.textContent = /^Helper copied/.test(top) ? "✓ Copied. Now open Tesla (step 2)." : /Copy failed/.test(top) ? "Copy didn't work. Long-press or select the helper text and copy it by hand." : "✓ Copied. Now open Tesla (step 2).";
        n.className = "ux-note" + (/Copy failed|Copy didn't/.test(n.textContent) ? " err" : " ok");
      }, 300));

      // paste → apply by itself (debounced); typing only applies once the text is complete keys
      const ta = $("pasteKeys"); let timer = 0, pasted = false;
      const go = () => {
        const text = ta.value.trim();
        if (!text) { show("", ""); return; }
        if (text === lastAuto) return;
        const wasPaste = pasted; pasted = false;
        const K = T.keyImport, p = K && K.parseLoose ? K.parseLoose(text) : { kind: "bad" };
        if (p.kind === "keys") { lastAuto = text; U.apply(text, "auto"); }
        else if (wasPaste) { lastAuto = text; show(U.badMessage(p), "err"); }
      };
      ta?.addEventListener("paste", () => { pasted = true; clearTimeout(timer); timer = setTimeout(go, 150); });
      ta?.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(go, 500); });
    } catch (e) { console.warn("unlock-ux disabled", e); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", U.init); else U.init();
})();
