/* ios-unlock.js — iPhone / iPad: unlock encrypted clips without a userscript extension.
 * Safari on iOS only runs userscripts through a separate app, so the player offers a "Dashcam Unlock" bookmarklet
 * (connector/ios-unlock-bookmarklet.js, built into js/ios-unlock-src.js) that runs on the signed-in Tesla tab,
 * fetches the keys on Tesla's origin and hands ONLY the keys back: postMessage to this tab, or "Copy keys" →
 * "Paste keys from clipboard" here. The Tesla sign-in token is never copied or sent.
 * Progressive enhancement: if anything here fails, the rest of the Unlock dialog is untouched. */
(function () {
  "use strict";
  const T = window.TDC;
  const I = (T.iosUnlock = {});
  const $ = (id) => document.getElementById(id);
  const say = (text, kind) => { const n = $("iosNotice"); if (!n) return; n.textContent = text || ""; n.className = "notice" + (kind ? " " + kind : ""); n.hidden = !text; };

  /** iPhone, iPad, iPod — including iPadOS, whose Safari sends a Mac ("desktop") user agent. */
  I.isIOS = () => {
    try {
      if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
      return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    } catch (_) { return false; }
  };
  I.show = () => { const c = $("iosUnlock"); if (c) c.hidden = false; };

  I.openedText = () => "Tesla opened in a new tab. Sign in there, then tap your Dashcam Unlock bookmark (Safari's bookmarks, or type its name in the address bar). If this tab doesn't unlock by itself, come back and tap Paste keys from clipboard.";
  I.closedText = () => "The Tesla tab was closed. If you tapped Dashcam Unlock and then Copy keys, tap Paste keys from clipboard below. Otherwise tap Sign in with Tesla again.";
  I.notDetectedText = () => "No connector answered on the Tesla tab. That's normal on iPhone and iPad: Safari doesn't run userscripts unless you installed an extension. Use the Dashcam Unlock bookmark (steps below): sign in on the Tesla tab, tap the bookmark, tap Copy keys, then come back here and tap Paste keys from clipboard. If you signed in first and the bookmark says there's no clip list, tap Copy unlock request here, go back to the Tesla tab, and tap Paste unlock request.";

  const copy = async (text) => {
    if (T.auth && T.auth.copyText) return T.auth.copyText(text);
    await navigator.clipboard.writeText(text);
  };

  /** The unlock request (clip key requests; no secrets) as a Tesla address with the #gridplayer… hash. */
  I.requestText = () => {
    const A = T.auth, items = A.items();
    if (!items.length) return null;
    return A.unlockUrl(items, A.job && !A.job.done ? A.job.nonce : A.newNonce());
  };

  /** Apply keys JSON (or {results:[…]}) from text: the same path as "Unlock with pasted keys". */
  I.applyText = async (raw) => {
    const K = T.keyImport, p = K ? K.parse(raw) : { kind: "bad" };
    if (p.kind === "keys") {
      T.auth.suppressClipboard = false; try { localStorage.removeItem("tdc.noClipboardApply"); } catch (_) {}
      const r = await K.applyKeys(p.results, "Keys from clipboard");
      return r && r.applied ? { ok: true, applied: r.applied } : { ok: false, text: "Those keys don't match the clips loaded here (or Tesla refused them). Reload the folder and unlock again." };
    }
    if (p.kind === "token") return { ok: false, text: "That's a Tesla sign-in token, not keys. Don't paste tokens here — tap Dashcam Unlock on the Tesla tab and use its Copy keys button." };
    if (/gridplayer=/.test(String(raw || ""))) return { ok: false, text: "That's the unlock request, not the keys. Paste it on the Tesla tab (Paste unlock request), tap Copy keys there, then come back." };
    return { ok: false, text: "The clipboard doesn't hold keys yet. On the Tesla tab tap Dashcam Unlock, then Copy keys, then come back and tap this again." };
  };

  I.init = () => {
    try {
      const card = $("iosUnlock"); if (!card) return;
      const src = T.IOS_BOOKMARKLET;
      card.hidden = !I.isIOS();
      const btnBm = $("btnCopyBookmarklet"), btnReq = $("btnCopyUnlockRequest"), btnPaste = $("btnPasteKeysClip");
      btnBm?.addEventListener("click", async () => {
        if (!src) return say("The bookmark isn't available in this build.", "err");
        try { await copy(src); say("Bookmark code copied. Now make the bookmark: in Safari tap Share ▸ Add Bookmark (any page, name it Dashcam Unlock), open Bookmarks, touch and hold it ▸ Edit, replace the address with the copied code and tap Done.", "ok"); }
        catch (_) { say("Copy failed. Touch and hold the box below, choose Select All ▸ Copy, then paste it as the bookmark's address.", "err"); const t = $("iosBookmarkText"); if (t) { t.hidden = false; t.value = src; t.focus(); try { t.select(); } catch (_) {} } }
      });
      btnReq?.addEventListener("click", async () => {
        const t = I.requestText();
        if (!t) return say("No encrypted clips are waiting for keys. Open your clips first.", "err");
        try { await copy(t); say("Unlock request copied. Open the Tesla tab (signed in), tap Dashcam Unlock, then tap Paste unlock request.", "ok"); }
        catch (_) { say("Copy failed. Tap Sign in with Tesla instead; it puts the request in the Tesla address.", "err"); }
      });
      btnPaste?.addEventListener("click", async () => {
        let text = "";
        try { text = await navigator.clipboard.readText(); }
        catch (_) {
          // iOS asks "Paste?" and can refuse; fall back to the paste box that is always there
          const box = $("inAppKeyText"); if (box) { box.scrollIntoView({ block: "center" }); box.focus(); }
          return say("Safari didn't allow reading the clipboard. Touch and hold the box “Paste keys JSON / token” below, choose Paste, then tap Unlock with pasted keys.", "err");
        }
        try {
          const r = await I.applyText(text);
          say(r.ok ? "Applied " + r.applied + " key(s) — decrypting the clips here." : r.text, r.ok ? "ok" : "err");
        } catch (e) { say("Couldn't apply the keys: " + (e.message || e), "err"); }
      });
      $("btnIosDownloadConnector")?.addEventListener("click", () => { try { T.download(new Blob([T.CONNECTOR_SRC], { type: "text/javascript" }), T.CONNECTOR_FILENAME); } catch (_) { say("Download failed. Use the bookmark method instead.", "err"); } });
    } catch (e) { console.warn("iOS unlock card disabled", e); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", I.init); else I.init();
})();
