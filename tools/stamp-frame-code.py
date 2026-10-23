#!/usr/bin/env python3
"""stamp-frame-code.py — burn the frame number into a test video as a row of black/white blocks (test/live-lag.js reads
it back from the frame the detector was handed and from the frame on screen, so the lag is measured by picture, not by a
browser's clock). 9 bits, blocks 24×16 px at x = 8 + 24·i, y = 40 (in the letterbox band of tools/make-plate-footage.py).
Usage: python3 tools/stamp-frame-code.py in.mp4 out.mp4   (needs ffmpeg)"""
import subprocess, sys, json
src, dst = sys.argv[1], sys.argv[2]
info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", src]))["streams"][0]
W, H = info["width"], info["height"]; fps = info["r_frame_rate"]
dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", fps, "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", "-crf", "18", dst], stdin=subprocess.PIPE)
n = 0; size = W * H * 3
while True:
    buf = dec.stdout.read(size)
    if len(buf) < size: break
    f = bytearray(buf)
    for i in range(9):
        v = 255 if (n >> i) & 1 else 0
        for y in range(40, 56):
            row = (y * W + 8 + 24 * i) * 3
            f[row:row + 24 * 3] = bytes([v]) * (24 * 3)
    enc.stdin.write(f); n += 1
enc.stdin.close(); enc.wait(); dec.wait()
print("stamped", n, "frames")
