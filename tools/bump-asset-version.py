#!/usr/bin/env python3
"""bump-asset-version.py — set the ?v= cache-busting query on every local script / stylesheet in index.html, so a browser
(Safari caches heuristically from Last-Modified on simple static servers) never mixes new CSS / HTML with old JS.
Usage: python3 tools/bump-asset-version.py <version>      e.g. python3 tools/bump-asset-version.py wb-color"""
import re, sys, os
v = sys.argv[1]; p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index.html")
s = open(p).read()
s = re.sub(r'((?:src|href)="(?:js|vendor|css)/[^"?]+\.(?:js|css))(?:\?v=[^"]*)?"', lambda m: m.group(1) + "?v=" + v + '"', s)
open(p, "w").write(s); print("index.html assets → ?v=" + v)
import subprocess; subprocess.check_call([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen-precache.py"), v])
