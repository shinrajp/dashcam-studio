#!/usr/bin/env python3
"""to-js.py — write a measured rig into js/rig.js (the block between "── measured" and "── end measured").

Lens and angles from calibrate.py, heights from roadheight.py ("road"), the along/across positions kept from js/rig.js's car
(they are priors), and the files' clock offsets from their telemetry (node: js/rig.js clockOffsets on the sei-*.json).

    python tools/rig/to-js.py rig-all.json <sei dir>
"""
import json, os, re, subprocess, sys

CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"]
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
# along / across positions (priors, 2024 Model X); the camera sits on the body's surface (js/rig.js BODY)
POS = {"front": [0, None, 2.05], "back": [0, None, -1.04], "left_pillar": [-0.92, None, 1.55], "right_pillar": [0.92, None, 1.55],
       "left_repeater": [-1.02, None, 2.45], "right_repeater": [1.02, None, 2.45]}


def main():
    rig, sei = json.load(open(sys.argv[1])), sys.argv[2]
    js = r"""const R=require(%s),fs=require("fs"),rows={};for(const c of R.CAMS){try{rows[c]=JSON.parse(fs.readFileSync(%s+"/sei-"+c+".json")).rows.map(r=>[r.t,r]);}catch(_){}}
process.stdout.write(JSON.stringify(R.clockOffsets(rows)));""" % (json.dumps(os.path.join(ROOT, "js/rig.js")), json.dumps(sei))
    clk = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    lines = []
    for cam in CAMS:
        c = rig[cam]; pos = list(POS[cam]); pos[1] = round((c.get("road") or {}).get("height") or (c.get("ground") or {}).get("height") or 1.0, 3)
        k = [round(v, 5) or 0.0 for v in c["k"]]
        lines.append(f'    {cam + ":":16}{{ yaw: {c["yaw"]}, pitch: {c["pitch"]}, roll: {c["roll"]}, f: {c["f"]}, cx: {c["cx"]}, cy: {c["cy"]}, '
                     f'k: {json.dumps([v + 0.0 for v in k])}, thmax: {c.get("thmax", 60)}, pos: {json.dumps(pos)}, px: {c["fit"]["median_px"]} }},')
    asp = rig["front"]["height"] / rig["front"]["width"]
    block = ("  const MEASURED = {\n" + "\n".join(lines) + "\n  };\n" + f"  const ASPECT = {rig['front']['height']} / {rig['front']['width']};\n"
             + "  const CLOCK0 = { " + ", ".join(f"{c}: {round(clk.get(c, 0), 3)}" for c in CAMS) + " };\n")
    p = os.path.join(ROOT, "js/rig.js"); s = open(p).read()
    a = s.index("  const MEASURED = {"); b = s.index("  // ── end measured ──")
    open(p, "w").write(s[:a] + block + s[b:])
    print(f"js/rig.js: {len(lines)} cameras, aspect {asp:.4f}, clocks {clk}", file=sys.stderr)


if __name__ == "__main__":
    main()
