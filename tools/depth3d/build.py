#!/usr/bin/env python3
"""build.py — the "depth street replay" page from one Tesla HW4 drive folder, in one command.

    python tools/depth3d/build.py <drive folder> <out page dir> --t0 S --t1 S --model model_fp16.onnx

The folder holds the six files of a clip (<stamp>-front.mp4, -back, -left_pillar, -right_pillar, -left_repeater,
-right_repeater; a SavedClips event folder with several clips: pick one with --clip <stamp>). t0, t1: seconds of that clip
(the front file's clock). Steps (each in its own module, see experiments/depth3d/README.md):

  1. telemetry   each file's SEI telemetry and frame times; the files' clock offsets (js/rig.js clockOffsets)   telemetry.js
  2. delays      each camera's picture-vs-telemetry delay: from --rig, or fitted from the clip (rig held fixed)  delay.py
  3. views       level pinhole views + body masks, poses = js/rig.js MEASURED × the telemetry path               dataset.py
  4. vehicles    YOLO tracks (tools/rig/detect-tracks.py) mapped into the views; skipped with a warning if
                 no detector model / onnxruntime                                                              boxes.py
  5. depth       Depth Anything V2 Small (ONNX), in metres from the road plane (or --depth-stub)              depth.py
  6. fuse        road snap, road growing (not inside vehicle boxes), soft seams, mesh rows                     fuse.py
  7. colour      per-camera gains on shared road                                                               colour.py
  8. page        scene.json, depth.json, weights.json, tex/, index.html                                        pack.py

The page and the work folder show the drive: keep them out of the repository (the tool refuses to write inside it).
Needs python3 with numpy, opencv-python-headless, onnxruntime; ffmpeg/ffprobe; node.
"""
import argparse, glob, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from rig import CAMS, Rig, Drive  # noqa: E402
import dataset, depth, boxes, fuse, colour, pack, wb, delay as delayfit  # noqa: E402


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def find_clips(folder, stamp=None):
    """{ cam: path } of one clip in the folder; the stamp is the file name before -<cam>.mp4."""
    found = {}
    for p in glob.glob(os.path.join(folder, "*.mp4")):
        m = re.match(r"^(.*)-(" + "|".join(CAMS) + r")\.mp4$", os.path.basename(p))
        if m: found.setdefault(m.group(1), {})[m.group(2)] = p
    if not found: raise SystemExit(f"no Tesla camera files (<stamp>-front.mp4 …) in {folder}")
    if stamp is None:
        if len(found) > 1: raise SystemExit("several clips in the folder; pick one with --clip: " + ", ".join(sorted(found)))
        stamp = next(iter(found))
    if stamp not in found: raise SystemExit(f"no clip {stamp} in {folder} (have: {', '.join(sorted(found))})")
    clips = found[stamp]
    if "front" not in clips: raise SystemExit(f"{stamp}: the front camera's file is missing (it is the reference clock and path)")
    missing = [c for c in CAMS if c not in clips]
    if missing: log(f"WARNING: {stamp}: no file for {', '.join(missing)} — the replay will have gaps there")
    return stamp, clips


def inside_repo(p):
    p = os.path.realpath(p); return os.path.commonpath([p, ROOT]) == ROOT


def telemetry(clips, out, rig_file=None):
    cmd = ["node", os.path.join(HERE, "telemetry.js"), out] + [f"{c}={p}" for c, p in clips.items()] + (["--rig", rig_file] if rig_file else [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: raise SystemExit("telemetry.js failed:\n" + r.stderr)
    for line in r.stderr.strip().splitlines(): log("  " + line)
    return json.load(open(out))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("drive", help="folder with the six camera files of a clip"); ap.add_argument("out", help="page folder to write")
    ap.add_argument("--t0", type=float, required=True); ap.add_argument("--t1", type=float, required=True)
    ap.add_argument("--model", help="Depth Anything V2 Small ONNX (model_fp16.onnx, input pixel_values 518×336)")
    ap.add_argument("--depth-stub", action="store_true", help="no AI model: flat-road stand-in disparity (for tests only)")
    ap.add_argument("--clip", help="clip stamp when the folder holds several (e.g. 2026-10-19_10-53-18)")
    ap.add_argument("--rig", help="rig JSON for js/rig.js set() (in-app calibration export / tools/rig output); default js/rig.js MEASURED")
    ap.add_argument("--delays", default="auto", choices=["auto", "fit", "rig", "zero"],
                    help="auto: from --rig when it has them, else fitted from the clip; fit: always fit; rig: --rig only (0 where missing); zero")
    ap.add_argument("--dt", type=float, default=1 / 6, help="seconds between time steps (default 1/6)")
    ap.add_argument("--detector", default=os.path.join(ROOT, "models", "yolo11s.onnx"), help="YOLO ONNX for the vehicle boxes")
    ap.add_argument("--no-detector", action="store_true", help="skip vehicle boxes (road growing then has no exclusion)")
    ap.add_argument("--no-grow", action="store_true", help="no road growing (fuse.py GROW=0)")
    ap.add_argument("--wb-mode", default=None, choices=["off", "ref", "neutral", "neutral+global"],
                    help="white balance: off; ref (wb.py fit to the front camera); neutral (wb.py stage 1: every camera to neutral road, "
                         "exposure apart from chroma); neutral+global (stage 1, then the seam colour solve with no reference camera)")
    ap.add_argument("--no-colour-match", action="store_true", help="skip the seam colour gains (colour.py measures only)")
    ap.add_argument("--wb", action="store_true", help="per-camera white balance before depth (wb.py); off by default: on the two test drives it worsened the 10-19 kerb gap and the 10-07 seam")
    ap.add_argument("--no-wb", action="store_true", help="no white balance (the default; kept for scripts)")
    ap.add_argument("--no-road-colour", action="store_true", help="seam colour match on the old road test only, no depth-agreement check (colour.py)")
    ap.add_argument("--no-kerb", action="store_true", help="no raised kerb band: kerbs snap onto the road (kerb.py)")
    ap.add_argument("--no-local-scale", action="store_true", help="no local depth-scale refit in camera overlaps (localscale.py)")
    ap.add_argument("--work", help="work folder (default <out>.work)"); ap.add_argument("--clean", action="store_true", help="delete the work folder at the end")
    ap.add_argument("--force-in-repo", action="store_true", help="allow writing inside the repository (it is public: never commit drive data)")
    a = ap.parse_args(argv)
    if not a.model and not a.depth_stub: ap.error("--model <model_fp16.onnx> is required (or --depth-stub for a test without the AI model)")
    if a.model and not os.path.exists(a.model): ap.error(f"model not found: {a.model}")
    if a.t1 <= a.t0: ap.error("--t1 must be after --t0")
    work = a.work or a.out.rstrip("/") + ".work"
    for p in (a.out, work):
        if inside_repo(p) and not a.force_in_repo:
            raise SystemExit(f"refusing to write {p} inside the repository ({ROOT}): it is public and the output shows the drive. "
                             "Pick a folder outside it (or --force-in-repo).")
    os.makedirs(work, exist_ok=True); os.makedirs(a.out, exist_ok=True)
    T = time.time(); report = dict(drive=os.path.abspath(a.drive), t0=a.t0, t1=a.t1, warnings=[])
    warn = lambda m: (log("WARNING: " + m), report["warnings"].append(m))

    stamp, clips = find_clips(a.drive, a.clip); report["clip"] = stamp
    log(f"[1/8] telemetry and file clocks — {stamp}")
    tel = telemetry(clips, os.path.join(work, "telemetry.json"), a.rig)
    if not tel["cams"]["front"]["rows"]:
        raise SystemExit("the front file has no SEI telemetry (speed/heading): this tool needs it for the car's path")
    rig = Rig.from_telemetry(tel); report["rig"] = tel["rigSource"]
    ftimes = {c: tel["cams"][c]["frames"] for c in clips}
    clocks = dict(tel["clocks"])
    for c in clips:
        if c not in clocks:
            warn(f"{c}: no clock offset from the telemetry (none, or the car hardly moved): taken as 0"); clocks[c] = 0.0
    log("  clocks (s to add to each file's time for the front's): " + json.dumps({c: round(v, 3) for c, v in clocks.items()}))
    report["clocks"] = clocks

    log("[2/8] telemetry delays")
    rig_delays = {c: rig.cams[c]["delay"] for c in clips if "delay" in rig.cams.get(c, {})}
    mode = a.delays if a.delays != "auto" else ("rig" if rig_delays else "fit")
    delays, dinfo, dsrc = {}, {}, {}
    from rig import Path
    path = Path(tel["cams"]["front"]["rows"])
    SRC = {"fit": "fitted from this clip", "rig": "the rig's delay (rig JSON / js/rig.js)",
           "none": "0: no usable fit and the rig has no delay for it (js/rig.js MEASURED has none; file clocks still applied)", "zero": "0 (--delays zero)"}
    for c in clips:
        if mode == "zero": delays[c], dsrc[c] = 0.0, "zero"
        elif mode == "rig": delays[c], dsrc[c] = delayfit.choose(c, 0.0, None, rig_delays)
        else:
            d, info = delayfit.fit(rig, c, clips[c], ftimes[c], clocks[c], path, a.t0 - 4, a.t1 + 4)
            dinfo[c] = info
            delays[c], dsrc[c] = delayfit.choose(c, d, info, rig_delays)
            if not info["ok"]: warn(f"{c}: delay fit rejected ({info['why']}): using {delays[c]:+.3f} s from {SRC[dsrc[c]]}")
        log(f"  {c}: delay {delays[c]:+.4f} s, source: {SRC[dsrc[c]]}")
    log(f"  delays ({mode}): " + json.dumps({c: round(v, 4) for c, v in delays.items()}))
    report.update(delays=delays, delay_mode=mode, delay_fit=dinfo, delay_source=dsrc)

    log("[3/8] level views and poses")
    drive = Drive(rig, tel["cams"]["front"]["rows"], a.t0, clocks, delays)
    data = os.path.join(work, "data")
    F = dataset.build(drive, clips, ftimes, a.t0, a.t1, a.dt, data, log=log)

    log("[4/8] vehicle boxes")
    vb = {}
    try:
        import onnxruntime  # noqa: F401
        have_ort = True
    except ImportError:
        have_ort = False
    if a.no_detector or not os.path.exists(a.detector) or not have_ort:
        why = "--no-detector" if a.no_detector else (f"no detector model at {a.detector}" if have_ort else "onnxruntime is not installed")
        warn(f"vehicle boxes skipped ({why}): road growing may run into cars that look like the road")
    else:
        win = {}
        for c in clips:
            idx = [f["frame"] for f in F["frames"] if f["cam"] == c]; win[c] = (max(0, min(idx) - 4), max(idx) + 4)
        dets = boxes.detect(clips, ftimes, win, a.detector, log=log)
        json.dump(dets, open(os.path.join(work, "dets.json"), "w"))
        vb = boxes.to_views(rig, F["frames"], dets)
        json.dump(vb, open(os.path.join(work, "vboxes.json"), "w"))
        log(f"  {sum(len(v) for v in vb.values())} vehicle boxes in {len(vb)} views")

    wbm = a.wb_mode or ("ref" if a.wb and not a.no_wb else "off")
    if wbm == "off": log("  white balance: off (--wb-mode)")
    elif wbm == "ref":
        log("  white balance: per-camera gains on shared road, front camera as reference (wb.py)")
        report["wb"] = wb.run(data, vb, log=log)
    else:
        log("  white balance: stage 1, every camera to neutral road (wb.py)")
        report["wb"] = wb.run_neutral(data, vb, log=log)

    log("[5/8] depth")
    fn = depth.PlaneStub() if a.depth_stub else depth.OnnxDepth(a.model)
    if a.depth_stub: warn("depth from the PLANE STUB, not the AI model: the page shows a flat world (test only)")
    D = depth.run(data, os.path.join(work, "depth"), fn, log=log)
    report["depth_model"] = fn.name
    fits = [f["fit"] for f in D["frames"] if f["fit"] is not None]
    report["road_fit_median"] = float(sorted(fits)[len(fits) // 2]) if fits else None

    log("[6/8] fuse: road snap, road growing, seams")
    report["fuse"] = fuse.run(data, os.path.join(work, "depth"), os.path.join(work, "fused"), vb, grow_road=not a.no_grow,
                              kerb_band=not a.no_kerb, local_scale=not a.no_local_scale, log=log)

    log("[7/8] colour")
    report["colour"] = colour.run(os.path.join(work, "fused"), data, log=log, road_only=not a.no_road_colour, vboxes=vb,
                                  global_match=(wbm == "neutral+global"), match=not a.no_colour_match)

    log("[8/8] page")
    info = dict(drive=stamp.split("_")[0] if "_" in stamp else stamp, clip=stamp, t0=a.t0, t1=a.t1,
                model=("a stand-in flat-road depth (test, no AI model)" if a.depth_stub else "an AI depth model (Depth Anything V2 Small)"))
    report["page"] = pack.run(os.path.join(work, "fused"), a.out, info)
    report["seconds"] = round(time.time() - T, 1)
    clean = lambda o: {k: clean(v) for k, v in o.items()} if isinstance(o, dict) else [clean(v) for v in o] if isinstance(o, list) else \
        (None if isinstance(o, float) and o != o else o)
    json.dump(clean(report), open(os.path.join(work, "report.json"), "w"), indent=1, default=float)
    log(f"done in {report['seconds']} s: {a.out}/index.html ({report['page']['steps']} time steps × {len(F['cams'])} cameras); "
        f"report {work}/report.json" + (f"; {len(report['warnings'])} warning(s)" if report["warnings"] else ""))
    log("  serve it (e.g. python3 -m http.server -d <out>) and open index.html; it shows the drive — don't commit or publish it")
    if a.clean: shutil.rmtree(work, ignore_errors=True)
    return report


if __name__ == "__main__":
    main()
