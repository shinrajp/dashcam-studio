#!/usr/bin/env python3
"""make-footage.py — a synthetic six-camera HW4 clip of a KNOWN rig, for testing the in-app calibration end to end
(test/rig-calib-page.js). The car drives the real path of test/fixtures/rig-telemetry-2026-10-19.json (speed + heading);
each camera sees a textured road (and grey sky) through its lens (Kannala-Brandt) and mounting from truth.json, its pictures
lagging its telemetry by that camera's delay. Tesla-style SEI telemetry (tools/make-samples.py) is put on every frame.

    python3 tools/rig/make-footage.py truth.json <out folder> [--sec 30] [--fps 24] [--cams front,back,...]

truth.json: { "cams": { cam: { yaw, pitch, roll (deg), f, cx, cy, k: [k1, k2, k3], pos: [x, y, z], thmax } }, "delay": { cam: s } }
Writes <out>/2026-10-19_10-53-18-<cam>.mp4 (1448×938, the HW4 shape, rendered at half size and scaled up). Needs ffmpeg, numpy."""
import argparse, importlib.util, json, math, os, subprocess, sys, tempfile
from multiprocessing import Pool
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ms", os.path.join(HERE, "..", "make-samples.py")); MS = importlib.util.module_from_spec(spec); spec.loader.exec_module(MS)
FIX = os.path.join(HERE, "..", "..", "test", "fixtures", "rig-telemetry-2026-10-19.json")
W, H, OW, OH = 724, 469, 1448, 938
D2R = math.pi / 180


def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, sp], [0, -sp, cp]]); Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


class Path:   # as js/rig-calib.js Path / calibrate.py Path
    def __init__(self, rows):
        t = np.array([r[0] for r in rows]); v = np.array([r[1] for r in rows]); h = np.unwrap(np.radians([r[2] for r in rows]))
        self.g = np.arange(t[0] - 1, t[-1] + 1, 0.002); self.v = np.interp(self.g, t, v); self.h = np.interp(self.g, t, h)
        dt = np.diff(self.g, prepend=self.g[0])
        self.e = np.cumsum(self.v * dt * np.sin(self.h)); self.n = np.cumsum(self.v * dt * np.cos(self.h)); self.t, self.speed, self.hd = t, v, h

    def at(self, t):
        return np.interp(t, self.g, self.e), np.interp(t, self.g, self.n), np.interp(t, self.g, self.h)


def texture(seed=3, n=2048):
    rng = np.random.default_rng(seed); out = np.zeros((n, n), np.float32)
    fy = np.fft.fftfreq(n)[:, None]; fx = np.fft.fftfreq(n)[None, :]; f2 = fx * fx + fy * fy
    for sigma, amp in [(2.0, 1.0), (5.0, 0.8), (14.0, 0.6), (40.0, 0.5)]:
        z = np.fft.fft2(rng.normal(size=(n, n))); g = np.exp(-2 * (math.pi * sigma) ** 2 * f2)
        r = np.real(np.fft.ifft2(z * g)); out += amp * r / r.std()
    out = 128 + 30 * out / out.std()
    return np.clip(out, 10, 245).astype(np.float32)


def unproject(u, v, c):
    f, cx, cy, k1, k2 = c["f"], c["cx"], c["cy"], c["k"][0], c["k"][1]; a = OH / OW
    dx = (u - 0.5 - cx) / f; dy = ((v - 0.5) * a - cy) / f; rho = np.hypot(dx, dy); th = rho.copy()
    for _ in range(10):
        t2 = th * th; r = th * (1 + t2 * (k1 + t2 * k2)) - rho; d = 1 + t2 * (3 * k1 + t2 * 5 * k2); th = np.clip(th - r / np.maximum(d, 0.05), 0, 3)
    s = np.where(rho > 1e-12, np.sin(th) / np.maximum(rho, 1e-12), 1.0)
    return np.stack([dx * s, -dy * s, np.cos(th)], -1), th


def posts(path, t0, t1, seed=5):
    """posts along the route (kerbside poles, bollards, tree trunks): 3D points off the road plane, as in a real street"""
    rng = np.random.default_rng(seed); out = []
    for t in np.arange(t0 - 3, t1 + 3, 0.25):
        e, n, h = path.at(t)
        for side in (-1, 1):
            if rng.random() < 0.55: continue
            lat = side * rng.uniform(3.5, 10); ah = rng.uniform(-1, 1)
            out.append((e + math.cos(h) * lat + math.sin(h) * ah, n - math.sin(h) * lat + math.cos(h) * ah, rng.uniform(0.15, 0.45), rng.uniform(1.5, 4.5), rng.uniform(0, 100)))
    return np.array(out)


def job(a):
    cam, c, delay, ftimes, rows, out, fps = a
    np.seterr(all="ignore")   # (rays that miss: inf × 0)
    path = Path(rows); tex = texture(); TS = 0.04; N = tex.shape[0]; PO = posts(path, ftimes[0], ftimes[-1])
    ys, xs = np.mgrid[0:H, 0:W]; b, th = unproject((xs + 0.5) / W, (ys + 0.5) / H, c)
    d = b @ rot(c["yaw"] * D2R, c["pitch"] * D2R, c["roll"] * D2R).T           # rays in car axes
    P = np.array(c["pos"]); ground = (d[..., 1] < -1e-3) & (th < c.get("thmax", 100) * D2R)
    s = np.where(ground, -P[1] / np.minimum(d[..., 1], -1e-3), 0); gx = P[0] + s * d[..., 0]; gz = P[2] + s * d[..., 2]
    dist = np.hypot(gx - P[0], gz - P[2]); fog = np.exp(-dist / 30.0)
    sky = 175 + 25 * np.clip(d[..., 1], 0, 1)
    rng = np.random.default_rng(abs(hash(cam)) % 1000)
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "v.h264")
        p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
                              "-vf", f"scale={OW}:{OH}:flags=bicubic", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-profile:v", "high",
                              "-bf", "0", "-g", str(fps), "-crf", "18", "-f", "h264", raw], stdin=subprocess.PIPE)
        for t in ftimes:
            e, n, h = path.at(t + delay)
            E = e + gx * math.cos(h) + gz * math.sin(h); Nn = n - gx * math.sin(h) + gz * math.cos(h)
            u = (E / TS) % N; v = (Nn / TS) % N; u0 = np.floor(u).astype(int); v0 = np.floor(v).astype(int); fu = u - u0; fv = v - v0; u1 = (u0 + 1) % N; v1 = (v0 + 1) % N
            g = (tex[v0, u0] * (1 - fu) + tex[v0, u1] * fu) * (1 - fv) + (tex[v1, u0] * (1 - fu) + tex[v1, u1] * fu) * fv
            img = np.where(ground, g * fog + 128 * (1 - fog), sky)
            # posts: nearest hit of each ray with a vertical cylinder (car axes), in front of the road / sky behind it
            pc = PO[:, 0] - e; pn = PO[:, 1] - n
            px_ = pc * math.cos(h) - pn * math.sin(h); pz_ = pc * math.sin(h) + pn * math.cos(h)
            near = np.hypot(px_ - P[0], pz_ - P[2]) < 28
            best = np.where(ground, s, np.inf); shade = None
            dxz = np.hypot(d[..., 0], d[..., 2]) + 1e-12
            for (cx_, cz_, (_, _, rad, ht, ph)) in zip(px_[near], pz_[near], PO[near]):
                ox, oz = P[0] - cx_, P[2] - cz_
                A = d[..., 0] ** 2 + d[..., 2] ** 2; B = 2 * (ox * d[..., 0] + oz * d[..., 2]); Cc = ox * ox + oz * oz - rad * rad
                disc = B * B - 4 * A * Cc; hit = disc > 0
                sh = np.where(hit, (-B - np.sqrt(np.maximum(disc, 0))) / (2 * A + 1e-12), np.inf)
                yy = P[1] + sh * d[..., 1]; hit &= (sh > 0.2) & (yy > 0) & (yy < ht) & (sh < best)
                if not hit.any(): continue
                ang = np.arctan2(oz + sh * d[..., 2], ox + sh * d[..., 0])
                val = 120 + 60 * np.sin(ang * 5 + ph) * np.cos(yy * 9 + ph) + 40 * np.sin(yy * 23 + ang * 2)
                img = np.where(hit, val * np.exp(-sh * dxz / 30) + 128 * (1 - np.exp(-sh * dxz / 30)), img); best = np.where(hit, sh, best)
            img = img + rng.normal(0, 1.5, (H, W))
            p.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
        p.stdin.close(); p.wait()
        # SEI on every frame: the telemetry at the frame's own (video) time
        sei = []
        for k, t in enumerate(ftimes):
            sp = float(np.interp(t, path.t, path.speed)); hd = math.degrees(float(np.interp(t, path.t, path.hd))) % 360
            sei.append(dict(gear=1, seq=k, speed=sp, pedal=0, steer=0, bl=0, br=0, brake=0, ap=0, lat=37.39, lon=-122.15, heading=hd, ax=0, ay=0, az=0))
        data = MS.inject_sei(open(raw, "rb").read(), sei); open(raw, "wb").write(data)
        dst = os.path.join(out, f"2026-10-19_10-53-18-{cam}.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", raw, "-c", "copy", "-video_track_timescale", "90000", dst], check=True)
    return dst


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("truth"); ap.add_argument("out"); ap.add_argument("--sec", type=float, default=30)
    ap.add_argument("--fps", type=int, default=24); ap.add_argument("--cams", default="front,back,left_pillar,right_pillar,left_repeater,right_repeater")
    a = ap.parse_args(); truth = json.load(open(a.truth)); fx = json.load(open(FIX))
    rows = fx["cams"]["front"]
    # the window of the drive with the biggest turn
    t = np.array([r[0] for r in rows]); hd = np.unwrap(np.radians([r[2] for r in rows]))
    best, t0 = -1, t[0] + 1
    for s in np.arange(t[0] + 1, t[-1] - a.sec - 1, 0.5):
        dd = abs(np.interp(s + a.sec, t, hd) - np.interp(s, t, hd))
        if dd > best: best, t0 = dd, s
    # the clip starts at video time 0 = drive time t0: shift the rows
    rows = [[r[0] - t0, r[1], r[2]] for r in rows]
    ftimes = [k / a.fps for k in range(int(a.sec * a.fps))]
    os.makedirs(a.out, exist_ok=True)
    jobs = [(c, truth["cams"][c], truth.get("delay", {}).get(c, 0.0), ftimes, rows, a.out, a.fps) for c in a.cams.split(",")]
    with Pool(min(len(jobs), os.cpu_count() or 2)) as pool:
        for p in pool.imap_unordered(job, jobs): print("  wrote", p, flush=True)
    print(f"turn in the window: {math.degrees(best):.0f}°, {a.sec:.0f} s from {t0:.1f} s of the drive")


if __name__ == "__main__":
    main()
