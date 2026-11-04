import json, base64, cv2, shutil, os, sys
SRC, DST = sys.argv[1:3]
d = json.load(open(SRC + '/frames.json')); cams = d['cams']; steps = d['steps']
by = {c: [f for f in d['frames'] if f['cam'] == c] for c in cams}
os.makedirs(DST + '/tex', exist_ok=True); dep = {}; wts = {}; meta = []
for k in range(steps):
    row = []
    for c in cams:
        f = by[c][k]; z = cv2.imread(SRC + '/' + f['name'].replace('.jpg', '.png'), cv2.IMREAD_UNCHANGED).astype('<u2')
        dep[f['name']] = base64.b64encode(z.tobytes()).decode()
        wp = SRC + '/' + f['name'].replace('.jpg', '_w.png')
        if os.path.exists(wp): wts[f['name']] = base64.b64encode(cv2.imread(wp, cv2.IMREAD_GRAYSCALE).tobytes()).decode()
        shutil.copy(SRC + '/' + f['name'], DST + '/tex/' + f['name'])
        row.append(dict(name=f['name'], cam=c, t=f['t'], R=[[round(v, 6) for v in r] for r in f['R']], C=[round(v, 4) for v in f['C']], f=f['f'], cx=f['cx'], cy=f['cy'], w=f['w'], h=f['h'], gw=z.shape[1], gh=z.shape[0], **({"rows": json.load(open(SRC + "/" + f["name"].replace(".jpg", "_rows.json")))} if os.path.exists(SRC + "/" + f["name"].replace(".jpg", "_rows.json")) else {})))
    meta.append(row)
json.dump(dict(steps=meta), open(DST + '/scene.json', 'w')); json.dump(dep, open(DST + '/depth.json', 'w')); json.dump(wts, open(DST + '/weights.json', 'w'))
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "viewer.html"), DST + "/index.html")   # the replay page
