"""video.py — decode a clip's frames with ffmpeg (as the prototype and tools/rig do). Frames are counted from the first, so
frame i is the i-th display-order time telemetry.js lists for that file (no seeking: a seek can land a frame off)."""
import subprocess
import numpy as np


def size(path):
    sw, sh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                                      "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip().split(",")[:2])
    return sw, sh


def frames(path, w, gray=False, stop=None):
    """yield (index, frame) at width w (BGR, or grey), up to frame index `stop` (exclusive)."""
    sw, sh = size(path); h = round(sh * w / sw / 2) * 2; ch = 1 if gray else 3
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area", "-fps_mode", "passthrough",
           "-f", "rawvideo", "-pix_fmt", "gray" if gray else "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=w * h * ch * 4)   # (a stop early is a broken pipe)
    n = w * h * ch; i = 0
    try:
        while stop is None or i < stop:
            b = p.stdout.read(n)
            if len(b) < n: break
            yield i, np.frombuffer(b, np.uint8).reshape((h, w) if gray else (h, w, 3))
            i += 1
    finally:
        p.stdout.close(); p.kill(); p.wait()
