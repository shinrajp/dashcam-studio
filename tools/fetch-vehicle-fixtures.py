#!/usr/bin/env python3
"""fetch-vehicle-fixtures.py — download the public-domain / CC0 vehicle photos used by test/vehicle-attrs.js
(Wikimedia Commons, 640 px thumbnails) into a temp folder. Not stored in the repo (some show real plates).
The list with ground truth is tools/vehicle-fixtures.json; each file's licence is re-checked from Commons and
anything that isn't Public domain or CC0 is skipped. Usage: python3 tools/fetch-vehicle-fixtures.py [out_dir]"""
import json, os, sys, time, urllib.parse, urllib.request
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vehicle-fixtures"
UA = {"User-Agent": "dashcam-studio-tests/1.0 (https://github.com/shinrajp/dashcam-studio)"}
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)
meta = []
for key, title, truth in json.load(open(os.path.join(HERE, "vehicle-fixtures.json"))):
    u = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "titles": title, "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": 640, "format": "json"})
    p = list(json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA)))["query"]["pages"].values())[0]
    ii = p["imageinfo"][0]; lic = ii["extmetadata"].get("LicenseShortName", {}).get("value", "")
    if not any(k in lic.lower() for k in ("public domain", "cc0")):
        print("skip (licence %s): %s" % (lic, title)); continue
    fn = os.path.join(OUT, key + ".jpg")
    if not os.path.exists(fn):
        open(fn, "wb").write(urllib.request.urlopen(urllib.request.Request(ii["thumburl"], headers=UA)).read()); time.sleep(0.4)
    meta.append({"key": key, "file": key + ".jpg", "title": title, "page": ii["descriptionurl"], "license": lic, "truth": truth})
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
print(len(meta), "photos in", OUT)
