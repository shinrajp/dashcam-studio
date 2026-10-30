/* i18n.js (ui-glass-12): the UI's English spelling follows the system language.
 *  - navigator.languages[0] / navigator.language: en-US and plain "en" (and any non-English language) → US spelling
 *    (License, Color, Gray, Center, Behavior, Canceled, Normalized…); en-GB, en-AU, en-NZ, en-IE, en-ZA, en-IN, en-CA and the other
 *    en-XX regions → the British spelling the source is written in.
 *  - Debug only: ?lang=en-GB / ?lang=en-US in the address, or Settings ▸ Debug ▸ Spelling, overrides the system language.
 *  - UI text only: text nodes and the title / placeholder / aria-label / alt attributes in the page, converted once and then for
 *    every change (one MutationObserver, nothing at all when the spelling is British). Canvas text, export file names and export
 *    pixels never change (export parity), nor do inputs, textareas, code and anything inside [data-no-l10n].
 *  - T.l10n.t(s): a string in the UI spelling; T.l10n.fold(s): lower case with both spellings folded together, for search
 *    matching (Settings search finds "color" and "colour", "license" and "licence", "gray" and "grey"…). */
(function () {
  "use strict";
  const T = (window.TDC = window.TDC || {});
  const US_REGIONS = /^(US|PH|PR|UM|VI|AS|GU|MP|LR|MH|FM|PW)$/i;
  function sysLang() { try { return (navigator.languages && navigator.languages[0]) || navigator.language || "en-US"; } catch (_) { return "en-US"; } }
  function override() {
    if (!(T.debugOn && T.debugOn())) return null;
    try { const m = /(?:[?&#])lang=([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)\b/.exec(location.search + location.hash); if (m) return { lang: m[1].replace("_", "-"), by: "url" }; } catch (_) {}
    const p = T.prefs && T.prefs.tune && T.prefs.tune.lang; return p ? { lang: p, by: "setting" } : null;
  }
  /** "us" or "gb" for a language tag. */
  function spellingOf(tag) {
    const m = /^([a-z]{2,3})(?:-([a-z0-9]+))?/i.exec(String(tag || "")); if (!m || m[1].toLowerCase() !== "en" || !m[2]) return "us";
    return US_REGIONS.test(m[2]) ? "us" : /^[a-z]{2}$|^\d{3}$/i.test(m[2]) ? "gb" : "us";
  }
  const ov = override(), lang = ov ? ov.lang : sysLang(), spelling = spellingOf(lang);

  // British → US, whole words, case kept (Colour → Color, COLOUR → COLOR)
  const IZE = "normal|optim|recogn|organ|custom|visual|synchron|minim|maxim|initial|priorit|summar|author|final|stabil|real|emphas|categor|util|personal|standard|critic|apolog|central|equal|serial|special|memor|local|capital|neutral|steril|character|harmon|sanit";
  const RULES = [
    [/\blicence(s?)\b/gi, "license$1"], [/\blicenced\b/gi, "licensed"],
    [/\bcolour(s|ed|ful|ing|ise|ised|ize|ized|less|way|ways)?\b/gi, "color$1"], [/\bdiscolour(s|ed|ing|ation)?\b/gi, "discolor$1"],
    [/\bgrey(s|ed|ing|ish|scale|er|est)?\b/gi, "gray$1"],
    [/\bcentre(s)?\b/gi, "center$1"], [/\bcentred\b/gi, "centered"], [/\bcentring\b/gi, "centering"],
    [/\bbehaviour(s|al)?\b/gi, "behavior$1"], [/\bneighbour(s|ing|hood|hoods)?\b/gi, "neighbor$1"], [/\bfavourite(s)?\b/gi, "favorite$1"],
    [/\bhonour(s|ed|ing)?\b/gi, "honor$1"], [/\bharbour(s)?\b/gi, "harbor$1"], [/\barmour(ed)?\b/gi, "armor$1"],
    [/\b(kilo|centi|milli)?metre(s)?\b/gi, "$1meter$2"], [/\btyre(s)?\b/gi, "tire$1"],
    [/\b(label|cancel|travel|model|signal|level|fuel|channel|tunnel|total|dial)l(ed|ing|er|ers)\b/gi, "$1$2"],
    [/\banaly(s)(e|ed|es|ing)\b/gi, "analyz$2"], [/\bcatalogue(s)?\b/gi, "catalog$1"], [/\bprogramme(s)?\b/gi, "program$1"],
    [/\bdefence\b/gi, "defense"], [/\boffence\b/gi, "offense"], [/\bgreyscale\b/gi, "grayscale"], [/\baluminium\b/gi, "aluminum"],
    [new RegExp("\\b(" + IZE + ")is(e|ed|es|ing|ation|ations|er|ers)\\b", "gi"), "$1iz$2"],
  ];
  const keepCase = (src, out) => (src === src.toUpperCase() && src.length > 1 ? out.toUpperCase() : src[0] === src[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out);
  const QUICK = new RegExp("licen[cs]|colour|grey|centr|behaviour|neighbour|favourite|honour|harbour|armour|metre|tyre|ll(ed|ing|er)|analys|catalogue|programme|fence|alumin|(" + IZE + ")is", "i");
  function toUS(s) {
    if (!s || !QUICK.test(s)) return s;
    for (const [re, rep] of RULES) s = s.replace(re, function (m) { const args = arguments, out = rep.replace(/\$(\d)/g, (_, i) => args[+i] || ""); return keepCase(m, out); });
    return s;
  }
  const t = (s) => (spelling === "us" ? toUS(s) : s);
  /** Lower case, both spellings folded to one, for search matching (works for a half-typed word too: "colou" → "colo"). */
  function fold(s) {
    let x = String(s || "").toLowerCase().replace(/\s+/g, " ");
    x = toUS(x).replace(/colou/g, "colo").replace(/licenc/g, "licens").replace(/behaviou/g, "behavio").replace(/neighbou/g, "neighbo").replace(/favou/g, "favo").replace(/centr(?=e?$)/g, "cent").replace(/cente(?=r?$)/g, "cent");
    return x;
  }

  // the page
  const SKIP = /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|NOSCRIPT|CANVAS|VIDEO)$/;
  const ATTRS = ["title", "placeholder", "aria-label", "alt", "aria-description"];
  function skip(el) { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (SKIP.test(e.nodeName) || e.isContentEditable || e.hasAttribute("data-no-l10n")) return true; } return false; }
  function fixText(n) { const v = n.nodeValue; if (!v || !QUICK.test(v) || skip(n.parentElement)) return; const o = toUS(v); if (o !== v) n.nodeValue = o; }
  function fixAttrs(el) { if (el.hasAttribute("data-no-l10n") || el.isContentEditable || skip(el.parentElement)) return; for (const a of ATTRS) { const v = el.getAttribute(a); if (v && QUICK.test(v)) { const o = toUS(v); if (o !== v) el.setAttribute(a, o); } } }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { fixAttrs(root); if (SKIP.test(root.nodeName)) return; }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 1 && SKIP.test(n.nodeName) ? (fixAttrs(n), NodeFilter.FILTER_REJECT) : NodeFilter.FILTER_ACCEPT) });
    for (let n = it.nextNode(); n; n = it.nextNode()) { if (n.nodeType === 3) fixText(n); else fixAttrs(n); }
  }
  let mo = null;
  function start() {
    document.documentElement.setAttribute("lang", spelling === "us" ? "en-US" : (/^en-/i.test(lang) ? lang : "en-GB"));
    document.documentElement.dataset.spelling = spelling;
    if (spelling !== "us" || mo) return;
    walk(document.body || document.documentElement);
    mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "characterData") fixText(m.target);
        else if (m.type === "attributes") { const v = m.target.getAttribute(m.attributeName); if (v && QUICK.test(v)) fixAttrs(m.target); }
        else for (const n of m.addedNodes) walk(n);
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  T.l10n = { lang, spelling, by: ov ? ov.by : "system", system: sysLang(), spellingOf, toUS, t, fold, walk };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
