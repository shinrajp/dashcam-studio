#!/usr/bin/env python3
"""Redact plates, faces, or on-screen text in a dashcam video. Runs on this computer.

Examples:
  python3 tools/redact.py clip.mp4 "blur the license plate"
  python3 tools/redact.py clip.mp4 "remove faces"
  python3 tools/redact.py clip.mp4 "blur the text and the license plate"

Text uses EasyOCR's CRAFT detector. Boxes are followed with an IoU tracker between
detections. Apple Silicon uses the MPS GPU when PyTorch provides it; an NVIDIA GPU
uses CUDA; otherwise the CPU.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.request
from pathlib import Path

YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
HERE = Path(__file__).resolve().parent


def parse_instruction(text: str) -> tuple[str, list[str]]:
    t = (text or "").lower()
    if re.search(r"\b(remove|erase|inpaint|delete)\b", t):
        action = "remove"
    elif re.search(r"\bblur\b", t) or not t:
        action = "blur"
    else:
        action = "blur"
    targets = []
    if re.search(r"plate|licen[cs]e|number plate", t):
        targets.append("plate")
    if re.search(r"\b(face|faces|person|people|pedestrian)\b", t):
        targets.append("face")
    if re.search(r"\b(text|word|words|sign|letter|letters)\b", t):
        targets.append("text")
    if not targets:
        raise SystemExit(
            "Say what to change. Examples:\n"
            '  "blur the license plate"\n'
            '  "remove faces"\n'
            '  "blur the text"\n'
            "Open-ended objects (a yellow truck, a person in a hoodie) are not supported."
        )
    return action, targets


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1, y1 = max(ax, bx), max(ay, by)
    x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    if inter <= 0:
        return 0.0
    return inter / (aw * ah + bw * bh - inter)


class IoUTracker:
    """Greedy IoU tracker with a constant-velocity hold between detection frames."""

    def __init__(self, thresh: float = 0.25, max_miss: int = 3):
        self.thresh = thresh
        self.max_miss = max_miss
        self.tracks = []
        self._next = 1

    def step(self, detections: list[tuple], detecting: bool, gap: int = 1):
        if not detecting:
            for t in self.tracks:
                t["box"][0] += t["vx"]
                t["box"][1] += t["vy"]
            return self.tracks
        gap = max(1, gap)
        used = set()
        preds = []
        for t in self.tracks:
            preds.append([t["box"][0] + t["vx"] * gap, t["box"][1] + t["vy"] * gap, t["box"][2], t["box"][3]])
        pairs = []
        for ti, pred in enumerate(preds):
            for di, (box, kind) in enumerate(detections):
                if self.tracks[ti]["kind"] != kind:
                    continue
                score = iou(pred, box)
                if score >= self.thresh:
                    pairs.append((score, ti, di))
        pairs.sort(reverse=True)
        matched_t, matched_d = set(), set()
        for score, ti, di in pairs:
            if ti in matched_t or di in matched_d:
                continue
            box, kind = detections[di]
            tr = self.tracks[ti]
            tr["vx"] = (box[0] - tr["box"][0]) / gap
            tr["vy"] = (box[1] - tr["box"][1]) / gap
            tr["box"] = list(box)
            tr["miss"] = 0
            tr["hit"] += 1
            matched_t.add(ti)
            matched_d.add(di)
        for ti, tr in enumerate(self.tracks):
            if ti not in matched_t:
                tr["box"] = preds[ti]
                tr["miss"] += 1
        for di, (box, kind) in enumerate(detections):
            if di in matched_d:
                continue
            self.tracks.append({"id": self._next, "box": list(box), "kind": kind, "vx": 0.0, "vy": 0.0, "miss": 0, "hit": 1})
            self._next += 1
        self.tracks = [t for t in self.tracks if t["miss"] <= self.max_miss]
        return self.tracks


def pick_device(prefer: str = "auto") -> str:
    import torch
    if prefer == "cpu":
        return "cpu"
    if prefer == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("CUDA was requested, but this PyTorch build cannot see an NVIDIA GPU.")
        return "cuda"
    if prefer == "mps":
        if not (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()):
            raise SystemExit("MPS was requested, but this PyTorch build has no Apple Silicon GPU.")
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def looks_like_plate(text: str, w: float, h: float) -> bool:
    s = re.sub(r"[^A-Z0-9]", "", (text or "").upper())
    if len(s) < 4 or len(s) > 8 or h <= 0:
        return False
    if not re.search(r"[A-Z]", s) or not re.search(r"\d", s):
        return False
    ar = w / float(h)
    return 1.3 <= ar <= 8.5


def quad_to_box(quad, sx: float, sy: float, pad: float, W: int, H: int):
    xs = [p[0] * sx for p in quad]
    ys = [p[1] * sy for p in quad]
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    bw, bh = x2 - x1, y2 - y1
    x1 -= bw * pad
    y1 -= bh * pad
    x2 += bw * pad
    y2 += bh * pad
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    return [x1, y1, x2 - x1, y2 - y1]


def ensure_yunet() -> Path:
    dest = HERE / "models" / "face_detection_yunet_2023mar.onnx"
    if dest.exists() and dest.stat().st_size > 100_000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("Downloading the face detector (once, about 0.3 MB)…", flush=True)
    urllib.request.urlretrieve(YUNET_URL, dest)
    return dest


def detect_text(reader, small, sx, sy, W, H, targets):
    rows = reader.readtext(small)
    out = []
    for quad, text, conf in rows:
        if conf < 0.3:
            continue
        box = quad_to_box(quad, sx, sy, 0.35, W, H)
        if not box:
            continue
        if "text" in targets:
            out.append((box, "text"))
        if "plate" in targets and looks_like_plate(text, box[2], box[3]):
            out.append((box, "plate"))
    return out


def detect_faces(detector, frame):
    h, w = frame.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(frame)
    out = []
    if faces is None:
        return out
    for row in faces:
        x, y, bw, bh = row[:4]
        box = quad_to_box([(x, y), (x + bw, y), (x + bw, y + bh), (x, y + bh)], 1, 1, 0.25, w, h)
        if box:
            out.append((box, "face"))
    return out


def apply_boxes(frame, tracks, action: str):
    import cv2
    import numpy as np
    if action == "remove":
        mask = np.zeros(frame.shape[:2], np.uint8)
        any_box = False
        for t in tracks:
            x, y, w, h = [int(round(v)) for v in t["box"]]
            if w < 2 or h < 2:
                continue
            cv2.rectangle(mask, (x, y), (x + w, y + h), 255, -1)
            any_box = True
        if any_box:
            return cv2.inpaint(frame, mask, 4, cv2.INPAINT_TELEA)
        return frame
    for t in tracks:
        x, y, w, h = [int(round(v)) for v in t["box"]]
        x, y = max(0, x), max(0, y)
        w, h = min(w, frame.shape[1] - x), min(h, frame.shape[0] - y)
        if w < 2 or h < 2:
            continue
        k = max(15, (int(max(w, h) * 0.45) | 1))
        k = min(k, w if w % 2 else w - 1, h if h % 2 else h - 1)
        if k < 3:
            continue
        roi = frame[y:y + h, x:x + w]
        frame[y:y + h, x:x + w] = cv2.GaussianBlur(roi, (k, k), 0)
    return frame


def open_writer(out_path: Path, w: int, h: int, fps: float):
    import shutil
    import subprocess
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps:.4f}", "-i", "-",
            "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
            str(out_path),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        return ("ffmpeg", proc)
    import cv2
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        raise SystemExit("Could not open a video writer. Install ffmpeg, then try again.")
    return ("cv", writer)


def process(src: Path, instruction: str, out: Path | None, device_pref: str, every: int):
    import cv2
    action, targets = parse_instruction(instruction)
    device = pick_device(device_pref)
    print(f"{action} {', '.join(targets)}  ·  device {device}", flush=True)
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise SystemExit(f"Could not open {src}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 36
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    We, He = W - (W % 2), H - (H % 2)
    dest = out or src.with_name(src.stem + "-redacted.mp4")
    if dest.resolve() == src.resolve():
        raise SystemExit("Refusing to overwrite the original video. Pick a different output name.")

    reader = None
    if "text" in targets or "plate" in targets:
        import easyocr
        gpu = "mps" if device == "mps" else device == "cuda"
        print("Loading the text detector (first run downloads the CRAFT model)…", flush=True)
        reader = easyocr.Reader(["en"], gpu=gpu, verbose=False)
    face_det = None
    if "face" in targets:
        model = ensure_yunet()
        face_det = cv2.FaceDetectorYN.create(str(model), "", (W, H), 0.6, 0.3, 5000)
        if face_det is None:
            raise SystemExit("This OpenCV build has no YuNet face detector.")

    kind = open_writer(dest, We, He, fps)
    tracker = IoUTracker()
    detect_w = 960 if W > 960 else W
    scale = W / detect_w
    i = 0
    last_detect = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame.shape[1] != We or frame.shape[0] != He:
                frame = frame[:He, :We]
            detecting = i % every == 0
            dets = []
            if detecting:
                if reader is not None:
                    small = cv2.resize(frame, (detect_w, int(round(He / scale)))) if scale != 1 else frame
                    dets.extend(detect_text(reader, small, scale, scale, We, He, targets))
                if face_det is not None:
                    dets.extend(detect_faces(face_det, frame))
                gap = i - last_detect or 1
                last_detect = i
                tracker.step(dets, True, gap)
            else:
                tracker.step([], False)
            frame = apply_boxes(frame, tracker.tracks, action)
            if kind[0] == "ffmpeg":
                kind[1].stdin.write(frame.tobytes())
            else:
                kind[1].write(frame)
            i += 1
            if i % 30 == 0:
                total = f"/{n}" if n else ""
                print(f"  frame {i}{total}  ·  {len(tracker.tracks)} tracked", flush=True)
    finally:
        cap.release()
        if kind[0] == "ffmpeg":
            kind[1].stdin.close()
            code = kind[1].wait()
            if code != 0:
                raise SystemExit(f"ffmpeg failed with code {code}")
        else:
            kind[1].release()
    print(f"Wrote {dest}  ({i} frames). The original was not changed.", flush=True)


def self_test() -> None:
    action, targets = parse_instruction("blur the license plate and faces")
    assert action == "blur" and targets == ["plate", "face"], (action, targets)
    action, targets = parse_instruction("remove the text")
    assert action == "remove" and targets == ["text"]
    assert looks_like_plate("8ABC123", 120, 36)
    assert not looks_like_plate("HELLO", 80, 40)
    tr = IoUTracker()
    tr.step([([10, 10, 40, 16], "plate")], True, 1)
    tr.step([], False)
    tr.step([([22, 10, 40, 16], "plate")], True, 2)
    assert len(tr.tracks) == 1 and tr.tracks[0]["hit"] == 2
    assert abs(tr.tracks[0]["vx"] - 6) < 0.01
    print("self-test ok")


def main(argv: list[str]) -> None:
    if argv and argv[0] == "--self-test":
        self_test()
        return
    p = argparse.ArgumentParser(description="Blur or remove plates, faces, or text in a video.")
    p.add_argument("video", type=Path, help="Input video (the original is not overwritten)")
    p.add_argument("instruction", help='What to do, in plain language. Example: "blur the license plate"')
    p.add_argument("-o", "--output", type=Path, help="Output mp4 (default: <name>-redacted.mp4)")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "mps", "cpu"])
    p.add_argument("--every", type=int, default=8, help="Run the detector every N frames (default 8). The tracker fills the gaps.")
    args = p.parse_args(argv)
    if not args.video.is_file():
        raise SystemExit(f"No such file: {args.video}")
    if args.every < 1:
        raise SystemExit("--every must be at least 1")
    process(args.video, args.instruction, args.output, args.device, args.every)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        sys.exit(130)
