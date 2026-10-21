#!/usr/bin/env python3
"""Real night photos of vehicles for the colour-constancy prototype (test/cc-eval.js), from Wikimedia Commons.
Searches Commons for '<colour> <vehicle> night', keeps only CC0 / public domain / CC BY (ALLOW_SA=1 also CC BY-SA; never NC / ND),
takes the colour from the title (exactly one colour word and a vehicle word), keeps only dark photos (median < 30 %), downloads a 1024 px thumbnail and
writes truth.json with title, page URL, author and licence for every file. Images stay in /tmp (not in the repo).
Usage: fetch-cc-night.py [outdir=/tmp/cc-night] [max=40]"""
import json, os, re, sys, time, urllib.parse, urllib.request
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cc-night"; MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 40
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "dashcam-studio-test/1.0 (https://github.com/shinrajp/dashcam-studio)"}
API = "https://commons.wikimedia.org/w/api.php"
COLS = ["white", "black", "silver", "grey", "gray", "red", "blue", "green", "yellow", "orange"]
VEH = ["taxi", "bus", "car", "van", "truck", "tram", "cab", "coach", "lorry", "minibus"]
OKLIC = re.compile(r"^(cc0|public domain|pd|cc by \d|cc-by-\d|cc by \d\.\d)", re.I)
def get(params):
    q = urllib.parse.urlencode({**params, "format": "json"}); r = urllib.request.urlopen(urllib.request.Request(API + "?" + q, headers=UA), timeout=30); return json.load(r)
items, seen = [], set()
QUERIES = ["%s %s night" % (c, v) for c in ["white", "yellow", "red", "blue", "black", "silver", "green", "orange", "gray"] for v in ["taxi", "bus", "car", "van", "truck"]]
QUERIES += ["%s %s at night" % (c, v) for c in ["white", "red", "blue", "black", "silver", "yellow"] for v in ["car", "bus", "taxi", "van"]]
for qq in QUERIES:
        if len(items) >= MAX: break
        d = get({"action": "query", "generator": "search", "gsrsearch": qq + " filetype:bitmap", "gsrnamespace": 6, "gsrlimit": 40,
                 "prop": "imageinfo", "iiprop": "url|extmetadata|size", "iiurlwidth": 1024})
        for pg in (d.get("query", {}).get("pages", {}) or {}).values():
            t = pg["title"]; tl = t.lower()
            if t in seen or not pg.get("imageinfo"): continue
            words = re.findall(r"[a-z]+", tl)
            cw = [c for c in COLS if c in words]
            if len(set("gray" if c == "grey" else c for c in cw)) != 1 or not any(v in words for v in VEH) or any(x in words for x in ("interior", "seats", "deck", "stop", "sign", "station", "terminus", "shop", "light", "lights")): continue
            ii = pg["imageinfo"][0]; md = ii.get("extmetadata", {})
            lic = (md.get("LicenseShortName", {}) or {}).get("value", "")
            bad = r"nc|nd" if os.environ.get("ALLOW_SA") == "1" else r"sa|nc|nd"
            if not OKLIC.match(lic.strip()) or re.search(bad, lic.lower().replace("cc by", "")): continue
            if ii.get("width", 0) < 640: continue
            seen.add(t)
            fn = "n%02d.jpg" % len(items)
            try:
                with urllib.request.urlopen(urllib.request.Request(ii["thumburl"], headers=UA), timeout=60) as r, open(os.path.join(OUT, fn), "wb") as f: f.write(r.read())
            except Exception as e:
                print("skip", t, e); continue
            try:   # a night photo: dark overall (median brightness < 30 %), else drop it
                from PIL import Image; import numpy as np
                a = np.asarray(Image.open(os.path.join(OUT, fn)).convert("L").resize((128, 96)), dtype=float) / 255
                if np.median(a) > 0.3: os.remove(os.path.join(OUT, fn)); continue
            except Exception as e: print("check", e)
            art = re.sub("<[^>]+>", "", (md.get("Artist", {}) or {}).get("value", ""))[:120]
            items.append({"file": fn, "title": t, "page": ii.get("descriptionurl"), "license": lic, "author": art, "color": "gray" if cw[0] == "grey" else cw[0]})
            print(len(items), cw[0], lic, t[:90]); time.sleep(0.3)
            if len(items) >= MAX: break
# checked by eye (contact sheet): the title's colour word isn't always the main vehicle's colour, or there is no vehicle
REVIEW = {"File:1974 Dodge Monaco": None, "File:Portret van Herman Besselaar": None, "File:Frankenbus vs White Van Man": None,
          "File:Decorated truck with blue neons": ("orange", ["red"]), "File:Green Line bus (London)": ("white", [])}
kept = []
for it in items:
    r = next((v for k, v in REVIEW.items() if it["title"].startswith(k)), "keep")
    if r is None: os.remove(os.path.join(OUT, it["file"])); continue
    if r != "keep": it["titleColor"], it["color"], it["alt"] = it["color"], r[0], r[1]
    kept.append(it)
items = kept
json.dump({"items": items}, open(os.path.join(OUT, "truth.json"), "w"), indent=1)
print(len(items), "photos in", OUT)
