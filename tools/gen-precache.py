#!/usr/bin/env python3
"""gen-precache.py — writes precache.json for sw.js: "core" = everything the app needs to start offline (index.html, every local
script / stylesheet it references, ALL js/*.js incl. workers, css, manifest, icons, small vendor files); "extra" = models, ONNX
Runtime wasm and OCR pack, fetched in the background (skips the big optional ones: yolo11s 38 MB, jsep/WebGPU wasm 22 MB).
Run by tools/bump-asset-version.py. Usage: python3 tools/gen-precache.py [version]   (version also written into sw.js)"""
import glob, json, os, re, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
os.chdir(root)
html = open("index.html").read()
core = ["index.html", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"]
core += [m for m in re.findall(r'(?:src|href)="((?:js|vendor|css)/[^"?]+)', html)]
core += sorted(glob.glob("js/*.js")) + sorted(glob.glob("css/*.css"))
core += ["vendor/en_dict.txt", "vendor/ort/ort-wasm-simd-threaded.mjs"]
seen = set(); core = [p for p in core if os.path.isfile(p) and not (p in seen or seen.add(p))]
extra = ["vendor/ort/ort-wasm-simd-threaded.wasm", "models/yolo11n.onnx", "models/reid/person-reidentification-retail-0288.onnx",
         "models/cc/fc4-squeezenet11-int8.onnx"]
# models/plates/* (13.0 MB for the phone finder + reader) are NOT pre-cached: plates are off by default, so nobody pays 13 MB of
# background download for a feature they never switch on. When plates are turned on, the files are fetched once from models/plates/
# and the service worker keeps them (same-origin static files seen at run time), so it works offline afterwards.
extra += sorted(glob.glob("vendor/ocr/*.js"))
extra = [p for p in extra if os.path.isfile(p)]
size = lambda l: sum(os.path.getsize(p) for p in l)
ver = sys.argv[1] if len(sys.argv) > 1 else None
if ver:
    sw = open("sw.js").read(); sw = re.sub(r'const VER = "[^"]*";', 'const VER = "%s";' % ver, sw, count=1); open("sw.js", "w").write(sw)
json.dump({"core": core, "extra": extra}, open("precache.json", "w"), indent=1)
print("precache.json: core %d files %.1f MB, extra %d files %.1f MB" % (len(core), size(core) / 1e6, len(extra), size(extra) / 1e6))
