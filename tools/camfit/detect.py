# YOLO11n vehicle detections on all six cameras at 6 fps → dets.json {cam: [{t, d:[[x,y,w,h,label,conf],..]}]} (x,y top-left, 0..1)
import subprocess, numpy as np, onnxruntime as ort, json, sys, os
import sys
# usage: python3 detect.py /path/to/2026-10-19_10-53-18/2026-10-19_10-53-18-   (prefix of the six camera files)
D = sys.argv[1]
M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../models/yolo11n.onnx")
so = ort.SessionOptions(); so.log_severity_level = 3; so.intra_op_num_threads = os.cpu_count()
S = ort.InferenceSession(M, so, providers=["CPUExecutionProvider"]); IN = S.get_inputs()[0]; SZ = IN.shape[2] if isinstance(IN.shape[2], int) else 640
VEH = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 0: "person", 1: "bicycle"}
FPS = 6; W, H = 960, 622
def nms(b, s, th=0.5):
    o = s.argsort()[::-1]; keep = []
    while o.size:
        i = o[0]; keep.append(i)
        xx1 = np.maximum(b[i,0], b[o[1:],0]); yy1 = np.maximum(b[i,1], b[o[1:],1]); xx2 = np.minimum(b[i,2], b[o[1:],2]); yy2 = np.minimum(b[i,3], b[o[1:],3])
        inter = np.clip(xx2-xx1, 0, None)*np.clip(yy2-yy1, 0, None); a = (b[o[1:],2]-b[o[1:],0])*(b[o[1:],3]-b[o[1:],1]); ai = (b[i,2]-b[i,0])*(b[i,3]-b[i,1])
        o = o[1:][inter/(a+ai-inter+1e-9) < th]
    return keep
out = {}
for cam in ["front","left_pillar","right_pillar","left_repeater","right_repeater","back"]:
    p = subprocess.Popen(["ffmpeg","-loglevel","error","-i",D+cam+".mp4","-vf",f"fps={FPS},scale={W}:{H}","-f","rawvideo","-pix_fmt","rgb24","-"], stdout=subprocess.PIPE)
    rows = []; k = 0
    while True:
        buf = p.stdout.read(W*H*3)
        if len(buf) < W*H*3: break
        im = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        s = SZ / max(W, H); nw, nh = int(W*s), int(H*s)
        # letterbox (nearest resize via indexing: fast enough)
        yi = (np.arange(nh)/s).astype(int).clip(0, H-1); xi = (np.arange(nw)/s).astype(int).clip(0, W-1)
        lb = np.full((SZ, SZ, 3), 114, np.uint8); oy, ox = (SZ-nh)//2, (SZ-nw)//2; lb[oy:oy+nh, ox:ox+nw] = im[yi][:, xi]
        x = (lb.astype(np.float32)/255.).transpose(2,0,1)[None]
        y = S.run(None, {IN.name: x})[0][0]   # [84, N]
        cls = y[4:].argmax(0); conf = y[4:].max(0); m = (conf > 0.3) & np.isin(cls, list(VEH))
        bx = y[:4, m].T; c = conf[m]; cl = cls[m]; dets = []
        if len(c):
            xyxy = np.stack([bx[:,0]-bx[:,2]/2, bx[:,1]-bx[:,3]/2, bx[:,0]+bx[:,2]/2, bx[:,1]+bx[:,3]/2], 1)
            for i in nms(xyxy, c):
                x0, y0, x1, y1 = xyxy[i]; x0 = (x0-ox)/s/W; x1 = (x1-ox)/s/W; y0 = (y0-oy)/s/H; y1 = (y1-oy)/s/H
                x0, y0, x1, y1 = max(0,x0), max(0,y0), min(1,x1), min(1,y1)
                if x1-x0 > 0.005 and y1-y0 > 0.005: dets.append([round(float(x0),4), round(float(y0),4), round(float(x1-x0),4), round(float(y1-y0),4), VEH[int(cl[i])], round(float(c[i]),3)])
        rows.append({"t": round(k/FPS, 3), "d": dets}); k += 1
    p.wait(); out[cam] = rows; print(cam, len(rows), "frames", sum(len(r["d"]) for r in rows), "dets", flush=True)
json.dump(out, open("dets.json", "w"))
