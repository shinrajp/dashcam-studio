#!/usr/bin/env python3
"""Generate a fake TeslaCam drive with synthetic, clearly-labelled six-camera clips.

Each camera is an H.264 MP4 rendered by ffmpeg (big camera label + timecode + moving test pattern).
For "telemetry" events, Tesla-style SEI NAL units (user_data_unregistered, UUID 0x42*15+0x69,
protobuf SeiMetadata) are injected before every frame, simulating a short drive.

Usage: python3 tools/make-samples.py OUT_DIR [--encrypted] [--quick]
Creates OUT_DIR/TeslaCam/{SavedClips,SentryClips,RecentClips}/...
"""
import json, math, os, struct, subprocess, sys, tempfile, hashlib

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
CAMS = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"]
LABEL = {"front": "FRONT", "back": "REAR", "left_repeater": "LEFT REPEATER", "right_repeater": "RIGHT REPEATER",
         "left_pillar": "LEFT PILLAR", "right_pillar": "RIGHT PILLAR"}
COLOR = {"front": "0x1d3557", "back": "0x3d1d57", "left_repeater": "0x1d5747", "right_repeater": "0x57461d",
         "left_pillar": "0x1d4a57", "right_pillar": "0x571d2c"}

# ---------------- protobuf encoding ----------------
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        if n: out.append(b | 0x80)
        else: out.append(b); return bytes(out)
def f_varint(f, v): return varint(f << 3 | 0) + varint(int(v))
def f_float(f, v): return varint(f << 3 | 5) + struct.pack("<f", v)
def f_double(f, v): return varint(f << 3 | 1) + struct.pack("<d", v)

def sei_pb(m):
    b = bytearray()
    b += f_varint(1, 1)
    if m["gear"]: b += f_varint(2, m["gear"])          # proto3: zero values are omitted
    b += f_varint(3, m["seq"])
    if m["speed"]: b += f_float(4, m["speed"])
    if m["pedal"]: b += f_float(5, m["pedal"])
    if m["steer"]: b += f_float(6, m["steer"])
    if m["bl"]: b += f_varint(7, 1)
    if m["br"]: b += f_varint(8, 1)
    if m["brake"]: b += f_varint(9, 1)
    if m["ap"]: b += f_varint(10, m["ap"])
    b += f_double(11, m["lat"]) + f_double(12, m["lon"]) + f_double(13, m["heading"])
    b += f_double(14, m["ax"]) + f_double(15, m["ay"]) + f_double(16, m["az"])
    return bytes(b)

def add_epb(rbsp):
    out = bytearray(); zeros = 0
    for x in rbsp:
        if zeros >= 2 and x <= 3:
            out.append(3); zeros = 0
        out.append(x)
        zeros = zeros + 1 if x == 0 else 0
    return bytes(out)

def sei_nal(pb):
    payload = bytes([0x42] * 15 + [0x69]) + pb
    size = len(payload); sz = bytearray()
    while size >= 255: sz.append(255); size -= 255
    sz.append(size)
    rbsp = bytes([5]) + bytes(sz) + payload + bytes([0x80])
    return b"\x00\x00\x00\x01" + bytes([0x06]) + add_epb(rbsp)

# ---------------- drive simulation ----------------
class Drive:
    """Simple kinematic drive near Palo Alto: start parked, pull away, right turn, brake to a stop."""
    def __init__(self, total, fps, lat0=37.39440, lon0=-122.15030, hd0=35.0):
        self.rows = []
        lat, lon, hd, v = lat0, lon0, hd0, 0.0
        n = int(round(total * fps)); dt = 1.0 / fps
        for k in range(n):
            t = k * dt
            gear = 0 if t < 0.8 else 1
            if t < 1.5: a = 0.0
            elif t < 0.45 * total: a = 3.2
            elif t < 0.80 * total: a = 0.0
            else: a = -4.5
            if v <= 0 and a < 0: a = 0.0
            v = max(0.0, min(v + a * dt, 22.0))
            if v >= 22.0 and a > 0: a = 0.0
            tt0, tt1 = 0.50 * total, 0.68 * total            # right turn window
            steer = 0.0
            if tt0 <= t <= tt1: steer = 95.0 * math.sin(math.pi * (t - tt0) / (tt1 - tt0))
            yaw = (steer / 15.0) * v / 2.9                     # bicycle model, deg/s-ish
            hd = (hd + yaw * dt * 2.2) % 360
            dist = v * dt
            lat += dist * math.cos(math.radians(hd)) / 111320.0
            lon += dist * math.sin(math.radians(hd)) / (111320.0 * math.cos(math.radians(lat)))
            ap = 0
            if 0.30 * total <= t < 0.40 * total: ap = 3
            elif 0.40 * total <= t < 0.50 * total: ap = 2
            elif 0.50 * total <= t < 0.82 * total: ap = 1
            br = 0.42 * total <= t < 0.66 * total             # stalk held: constant flag
            bl = 0.15 * total <= t < 0.25 * total and int(t / 0.33) % 2 == 0   # lamp-rate toggling
            pedal = 0.0
            if a > 0: pedal = 0.45 + 0.1 * math.sin(t)
            elif a == 0 and v > 0: pedal = 0.18
            self.rows.append(dict(gear=gear, seq=k, speed=v, pedal=pedal, steer=steer, bl=bl, br=br,
                                  brake=a < 0 or (gear == 1 and v == 0 and t < 1.5), ap=ap,
                                  lat=lat, lon=lon, heading=hd, ax=a, ay=v * math.radians(yaw), az=9.81))

# ---------------- clip rendering ----------------
def render_cam(path, cam, w, h, fps, dur, title, rows=None):
    vf = (f"drawbox=x=0:y=0:w=iw:h=ih:color=black@0:t=fill,"
          f"drawtext=fontfile={FONT}:text='{LABEL[cam]}':fontcolor=white:fontsize={h//7}:x=(w-tw)/2:y=h*0.30,"
          f"drawtext=fontfile={FONT}:text='{title}':fontcolor=0xbfc7d5:fontsize={h//22}:x=(w-tw)/2:y=h*0.52,"
          f"drawtext=fontfile={FONT}:text='SYNTHETIC TEST CLIP  %{{pts\\:hms}}  frame %{{n}}':fontcolor=0x8a94a6:fontsize={h//26}:x=(w-tw)/2:y=h*0.62")
    src = (f"color=c={COLOR[cam]}:s={w}x{h}:r={fps}:d={dur}[bg];testsrc2=s={w//4}x{h//4}:r={fps}:d={dur}[ts];"
           f"[bg][ts]overlay=x='(W-w)*(0.5+0.4*sin(t*1.3))':y=H*0.72,{vf}")
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, "v.h264")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-filter_complex", src, "-c:v", "libx264", "-preset", "veryfast",
                        "-pix_fmt", "yuv420p", "-profile:v", "high", "-bf", "0", "-g", str(fps), "-crf", "30",
                        "-f", "h264", raw], check=True)
        data = open(raw, "rb").read()
        if rows is not None:
            data = inject_sei(data, rows)
            open(raw, "wb").write(data)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(fps), "-i", raw, "-c", "copy",
                        "-video_track_timescale", "90000", path], check=True)

def split_nals(data):
    i, n, starts = 0, len(data), []
    while i < n - 3:
        if data[i] == 0 and data[i + 1] == 0 and (data[i + 2] == 1 or (data[i + 2] == 0 and i + 3 < n and data[i + 3] == 1)):
            sc = 3 if data[i + 2] == 1 else 4
            starts.append((i, i + sc)); i += sc
        else: i += 1
    out = []
    for k, (s, p) in enumerate(starts):
        e = starts[k + 1][0] if k + 1 < len(starts) else n
        out.append(data[p:e])
    return out

def inject_sei(data, rows):
    out = bytearray(); f = 0
    for nal in split_nals(data):
        t = nal[0] & 0x1F
        if t in (1, 5):
            if f < len(rows): out += sei_nal(sei_pb(rows[f]))
            f += 1
        out += b"\x00\x00\x00\x01" + nal
    return bytes(out)

# ---------------- encryption (Tesla-style container, synthetic) ----------------
def encrypt_file(src, dst, key, vin, key_id, ts):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    plain = open(src, "rb").read()
    psize = len(plain)
    pages = (psize + 4095) // 4096
    plain = plain + b"\x00" * (pages * 4096 - psize)
    root = hashlib.md5(key).digest()
    hdr = bytearray(0x2000)
    struct.pack_into(">Q", hdr, 0, psize)
    a = int.from_bytes(os.urandom(4), "big")
    struct.pack_into(">II", hdr, 8, a, a ^ 0x3C81B7F5)
    struct.pack_into(">IIH", hdr, 16, 0x03000002, 0x1000, 2)
    pk = bytes([4]) + bytes((b % 255) + 1 for b in os.urandom(64))      # no zero bytes inside
    wrapped = os.urandom(44)
    ka = struct.pack(">I", key_id) + pk + b"\x00" + vin.encode() + struct.pack(">Q", ts) + wrapped
    hdr[0x1000:0x1000 + len(ka)] = ka
    ct = bytearray()
    for p in range(pages):
        iv = hashlib.md5(root + str(p).encode().ljust(16, b"\x00")).digest()
        enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        ct += enc.update(plain[p * 4096:(p + 1) * 4096]) + enc.finalize()
    open(dst, "wb").write(bytes(hdr) + bytes(ct))
    import base64
    return base64.b64encode(wrapped).decode()

def make_event(folder, stamps, cams, sizes, fps, clip_dur, title, telemetry, event_json=None, drive=None):
    os.makedirs(folder, exist_ok=True)
    for ci, st in enumerate(stamps):
        rows = None
        if telemetry:
            per = int(round(clip_dur * fps))
            rows = drive.rows[ci * per:(ci + 1) * per]
        for cam in cams:
            w, h = sizes["front"] if cam == "front" else sizes["side"]
            render_cam(os.path.join(folder, f"{st}-{cam}.mp4"), cam, w, h, fps, clip_dur, f"{title}  clip {ci + 1}/{len(stamps)}", rows)
    if event_json:
        json.dump(event_json, open(os.path.join(folder, "event.json"), "w"), indent=1)

def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "samples"
    quick = "--quick" in sys.argv
    enc = "--encrypted" in sys.argv
    tc = os.path.join(out, "TeslaCam")
    HW4 = {"front": (2896, 1876), "side": (1448, 938)}
    HW3 = {"front": (1280, 960), "side": (1280, 960)}
    fps = 36
    if quick: HW4 = {"front": (1448, 938), "side": (724, 470)}   # even height (yuv420p needs even dims)
    # 1) SavedClips, HW4, 2 consecutive clips, telemetry
    d = 6.0
    drv = Drive(2 * d, fps)
    make_event(os.path.join(tc, "SavedClips", "2026-10-07_14-33-41"), ["2026-10-07_14-32-41", "2026-10-07_14-33-41"],
               CAMS, HW4, fps, d, "SavedClips  HW4", True,
               {"timestamp": "2026-10-07T14:33:41", "city": "Palo Alto", "est_lat": "37.3944", "est_lon": "-122.1503",
                "reason": "user_interaction_dashcam_icon_tapped", "camera": "0"}, drv)
    # 2) SentryClips, HW3 (no pillar cams), no telemetry, event.json
    make_event(os.path.join(tc, "SentryClips", "2026-10-06_22-10-05"), ["2026-10-06_22-09-05"],
               ["front", "back", "left_repeater", "right_repeater"], HW3, fps, 5.0, "SentryClips  HW3  no telemetry", False,
               {"timestamp": "2026-10-06T22:09:07", "city": "Fremont", "est_lat": "37.5485", "est_lon": "-121.9886",
                "reason": "sentry_aware_object_detection", "camera": "5"})
    # 3) RecentClips (flat folder), 1 clip with telemetry, missing right_pillar
    drv2 = Drive(5.0, fps, 37.4419, -122.1430, 300.0)
    make_event(os.path.join(tc, "RecentClips"), ["2026-10-08_08-15-00"],
               [c for c in CAMS if c != "right_pillar"], HW4 if not quick else HW4, fps, 5.0, "RecentClips  missing R pillar", True, None, drv2)
    keys = {}
    if enc:
        import base64
        ev = os.path.join(tc, "SavedClips", "2026-10-08_09-01-00")
        tmp = tempfile.mkdtemp()
        drv3 = Drive(4.0, fps, 37.4000, -122.1100, 90.0)
        make_event(tmp, ["2026-10-08_09-00-00"], CAMS, HW4, fps, 4.0, "ENCRYPTED (synthetic)", True, None, drv3)
        os.makedirs(ev, exist_ok=True)
        key = os.urandom(16)
        for i, cam in enumerate(CAMS):
            wk = encrypt_file(os.path.join(tmp, f"2026-10-08_09-00-00-{cam}.mp4"), os.path.join(ev, f"2026-10-08_09-00-00-{cam}.mp4"),
                              key, "7SAYGDEE0PF000001", 7, 1791475200000)
            keys[wk] = base64.b64encode(key).decode()
        json.dump({"timestamp": "2026-10-08T09:00:30", "city": "Mountain View", "est_lat": "37.4000", "est_lon": "-122.1100",
                   "reason": "vehicle_auto_emergency_braking", "camera": "0"}, open(os.path.join(ev, "event.json"), "w"))
        json.dump(keys, open(os.path.join(out, "synthetic-keys.json"), "w"), indent=1)
    print("done", out)

if __name__ == "__main__":
    main()
