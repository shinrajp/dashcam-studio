#!/usr/bin/env python3
"""CC0 own-work generic two-seat electric hypercar (roadster.glb).
Sleek low teardrop, long glass canopy, short overhangs, full-width light bars,
dark rear-corner thruster ports. Nose +Z. No trademarks. ~5–12k tris.
"""
from __future__ import annotations
import json, struct, math, argparse
from pathlib import Path
import numpy as np

def wrap_glb(gltf_json, bin_blob):
    j = json.dumps(gltf_json, separators=(',', ':')).encode('utf-8')
    j += b' ' * ((4 - len(j) % 4) % 4)
    bin_blob = bin_blob + b'\x00' * ((4 - len(bin_blob) % 4) % 4)
    total = 12 + 8 + len(j) + 8 + len(bin_blob)
    out = bytearray()
    out += struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<I4s', len(j), b'JSON') + j
    out += struct.pack('<I4s', len(bin_blob), b'BIN\x00') + bin_blob
    return bytes(out)

def cat_parts(parts):
    pos=[]; nor=[]; idx=[]; base=0
    for p, n, i in parts:
        p = np.asarray(p, np.float32).reshape(-1, 3)
        n = np.asarray(n, np.float32).reshape(-1, 3)
        i = np.asarray(i, np.uint32)
        pos.append(p); nor.append(n); idx.append(i + base); base += len(p)
    return np.vstack(pos), np.vstack(nor), np.concatenate(idx)

def lathe_body(zs, half_w, half_h, segs=64):
    rings = []
    for z, hw, hh in zip(zs, half_w, half_h):
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            if math.sin(a) < 0:
                y = 0.035 + 0.06 * abs(math.sin(a))
            else:
                y = 0.08 + math.sin(a) * hh
            x = math.cos(a) * hw
            if math.sin(a) < 0.12:
                x *= 0.93
            ring.append((x, y, z))
        rings.append(ring)
    pos=[]; nor=[]; idx=[]
    def add_v(p, n):
        pos.append(p); nor.append(n); return len(pos) - 1
    ridx = []
    for ring in rings:
        ids = []
        for x, y, z in ring:
            n = np.array([x, max(y - 0.25, 0.05), 0.05 * z], float)
            n = n / (np.linalg.norm(n) + 1e-9)
            ids.append(add_v((x, y, z), tuple(n)))
        ridx.append(ids)
    for ri in range(len(rings) - 1):
        for i in range(segs):
            j = (i + 1) % segs
            a, b = ridx[ri][i], ridx[ri][j]
            c, d = ridx[ri + 1][i], ridx[ri + 1][j]
            idx.extend([a, c, b, b, c, d])
    tip = add_v((0, 0.32, zs[-1] + 0.015), (0, 0.1, 1))
    for i in range(segs):
        j = (i + 1) % segs
        idx.extend([ridx[-1][i], tip, ridx[-1][j]])
    tip2 = add_v((0, 0.38, zs[0] - 0.015), (0, 0.1, -1))
    for i in range(segs):
        j = (i + 1) % segs
        idx.extend([ridx[0][j], tip2, ridx[0][i]])
    return pos, nor, idx

def canopy(zs_glass, half_w, half_h, segs=36):
    rings = []
    for z, hw, hh in zip(zs_glass, half_w, half_h):
        ring = []
        for i in range(segs + 1):
            a = math.pi * i / segs
            ring.append((math.cos(a) * hw, 0.52 + math.sin(a) * hh, z))
        rings.append(ring)
    pos=[]; nor=[]; idx=[]
    def add_v(p, n):
        pos.append(p); nor.append(n); return len(pos) - 1
    ridx = []
    for ring in rings:
        ids = []
        for x, y, z in ring:
            n = np.array([x, y - 0.45, 0.0]); n = n / (np.linalg.norm(n) + 1e-9)
            ids.append(add_v((x, y, z), tuple(n)))
        ridx.append(ids)
    for ri in range(len(rings) - 1):
        for i in range(segs):
            a, b = ridx[ri][i], ridx[ri][i + 1]
            c, d = ridx[ri + 1][i], ridx[ri + 1][i + 1]
            idx.extend([a, c, b, b, c, d])
    return pos, nor, idx

def box(cx, cy, cz, sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    corners = [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]
    faces = [
        (0, 1, 2, 3, (0, 0, -1)), (4, 7, 6, 5, (0, 0, 1)),
        (0, 3, 7, 4, (-1, 0, 0)), (1, 5, 6, 2, (1, 0, 0)),
        (0, 4, 5, 1, (0, -1, 0)), (3, 2, 6, 7, (0, 1, 0)),
    ]
    pos=[]; nor=[]; idx=[]
    for a, b, c, d, n in faces:
        base = len(pos)
        for k in (a, b, c, d):
            pos.append(corners[k]); nor.append(n)
        idx.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    return pos, nor, idx

def cylinder(cx, cy, cz, radius, width, segs=24):
    pos=[]; nor=[]; idx=[]
    def add(p, n):
        pos.append(p); nor.append(n); return len(pos) - 1
    for i in range(segs):
        a = 2 * math.pi * i / segs; b = 2 * math.pi * ((i + 1) % segs) / segs
        ca, sa = math.cos(a), math.sin(a); ca2, sa2 = math.cos(b), math.sin(b)
        y, z = cy + ca * radius, cz + sa * radius
        y2, z2 = cy + ca2 * radius, cz + sa2 * radius
        p0 = (cx - width / 2, y, z); p1 = (cx + width / 2, y, z)
        p2 = (cx + width / 2, y2, z2); p3 = (cx - width / 2, y2, z2)
        n2 = np.array([0, 0.5 * (ca + ca2), 0.5 * (sa + sa2)])
        n2 = n2 / (np.linalg.norm(n2) + 1e-9)
        base = len(pos)
        for p in (p0, p1, p2, p3):
            pos.append(p); nor.append(tuple(n2))
        idx.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    for sign, nx in ((-1, -1), (1, 1)):
        center = add((cx + sign * width / 2, cy, cz), (nx, 0, 0))
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            y, z = cy + math.cos(a) * radius, cz + math.sin(a) * radius
            ring.append(add((cx + sign * width / 2, y, z), (nx, 0, 0)))
        for i in range(segs):
            j = (i + 1) % segs
            if sign < 0: idx.extend([center, ring[j], ring[i]])
            else: idx.extend([center, ring[i], ring[j]])
    return pos, nor, idx

def light_bar(z, y, width, height, depth, segs=20):
    parts = []
    for i in range(segs):
        t0 = i / segs; t1 = (i + 1) / segs
        x0 = -width / 2 + t0 * width; x1 = -width / 2 + t1 * width
        yo = y + 0.01 * math.sin(math.pi * (t0 + t1) / 2)
        parts.append(box((x0 + x1) / 2, yo, z, x1 - x0 + 0.002, height, depth))
    return cat_parts(parts)

def profile_w(z):
    t = min(max((z + 2.05) / 4.15, 0), 1)
    return 0.52 + 0.42 * math.sin(math.pi * t ** 0.85) * (1.0 - 0.12 * t)

def profile_h(z):
    t = min(max((z + 2.05) / 4.15, 0), 1)
    return 0.26 + 0.44 * math.sin(math.pi * (t * 1.02) ** 0.9) * (1.0 - 0.22 * max(t - 0.55, 0))

def build():
    zs = np.linspace(-2.05, 2.10, 48)
    body = lathe_body(zs, [profile_w(z) for z in zs], [profile_h(z) for z in zs], segs=64)
    gz = np.linspace(-0.40, 1.30, 24)
    glass = canopy(gz, [profile_w(z) * 0.70 for z in gz],
                   [0.20 + 0.20 * math.sin(math.pi * (z + 0.40) / 1.70) for z in gz], segs=36)
    lights_f = light_bar(2.08, 0.40, 1.60, 0.055, 0.045, segs=20)
    lights_r = light_bar(-2.02, 0.46, 1.55, 0.05, 0.04, segs=20)
    thr = cat_parts([
        box(-0.58, 0.26, -2.00, 0.20, 0.14, 0.10), box(0.58, 0.26, -2.00, 0.20, 0.14, 0.10),
        box(-0.58, 0.26, -2.04, 0.12, 0.08, 0.04), box(0.58, 0.26, -2.04, 0.12, 0.08, 0.04),
    ])
    tires=[]; rims=[]
    for x, z in ((0.90, 1.22), (-0.90, 1.22), (0.90, -1.38), (-0.90, -1.38)):
        tires.append(cylinder(x, 0.32, z, 0.32, 0.24, segs=24))
        rims.append(cylinder(x, 0.32, z, 0.19, 0.17, segs=20))
    sill = box(0, 0.055, 0.0, 1.72, 0.04, 3.7)
    diff = [box(dx, 0.10, -1.95, 0.08, 0.06, 0.25) for dx in (-0.35, -0.12, 0.12, 0.35)]
    return {
        'body': cat_parts([body, sill] + diff),
        'glass': cat_parts([glass]),
        'light': lights_f,
        'lights_red': lights_r,
        'thruster': thr,
        'rubber': cat_parts(tires),
        'rim': cat_parts(rims),
    }

def recompute_normals(pos, idx):
    nor = np.zeros_like(pos)
    for t in range(0, len(idx), 3):
        i0, i1, i2 = int(idx[t]), int(idx[t + 1]), int(idx[t + 2])
        n = np.cross(pos[i1] - pos[i0], pos[i2] - pos[i0])
        n = n / (np.linalg.norm(n) + 1e-9)
        nor[i0] += n; nor[i1] += n; nor[i2] += n
    return nor / (np.linalg.norm(nor, axis=1, keepdims=True) + 1e-9)

def write_glb(path: Path):
    parts = build()
    mats = [
        {'name': 'body', 'pbrMetallicRoughness': {'baseColorFactor': [0.93, 0.94, 0.96, 1], 'metallicFactor': 0.55, 'roughnessFactor': 0.22}},
        {'name': 'glass', 'pbrMetallicRoughness': {'baseColorFactor': [0.12, 0.16, 0.22, 0.42], 'metallicFactor': 0.05, 'roughnessFactor': 0.04}, 'alphaMode': 'BLEND'},
        {'name': 'light', 'pbrMetallicRoughness': {'baseColorFactor': [0.95, 0.96, 0.92, 1], 'metallicFactor': 0.15, 'roughnessFactor': 0.25}, 'emissiveFactor': [0.85, 0.88, 0.75]},
        {'name': 'lights_red', 'pbrMetallicRoughness': {'baseColorFactor': [0.55, 0.04, 0.04, 1], 'metallicFactor': 0.15, 'roughnessFactor': 0.3}, 'emissiveFactor': [0.55, 0.02, 0.02]},
        {'name': 'thruster', 'pbrMetallicRoughness': {'baseColorFactor': [0.06, 0.06, 0.08, 1], 'metallicFactor': 0.75, 'roughnessFactor': 0.35}},
        {'name': 'rubber', 'pbrMetallicRoughness': {'baseColorFactor': [0.04, 0.04, 0.04, 1], 'metallicFactor': 0.0, 'roughnessFactor': 0.95}},
        {'name': 'rim', 'pbrMetallicRoughness': {'baseColorFactor': [0.72, 0.73, 0.76, 1], 'metallicFactor': 0.9, 'roughnessFactor': 0.22}},
    ]
    mat_index = {m['name']: i for i, m in enumerate(mats)}
    blobs=[]; accessors=[]; bufferViews=[]; meshes=[]; nodes=[]
    byte_offset = 0

    def add_accessor(arr, typ, ctype):
        nonlocal byte_offset
        arr = np.ascontiguousarray(arr)
        raw = arr.tobytes()
        pad = (4 - len(raw) % 4) % 4
        raw = raw + b'\x00' * pad
        bv = len(bufferViews)
        bufferViews.append({'buffer': 0, 'byteOffset': byte_offset, 'byteLength': len(raw) - pad})
        byte_offset += len(raw)
        blobs.append(raw)
        acc = {'bufferView': bv, 'componentType': ctype, 'count': len(arr) if arr.ndim == 1 else len(arr), 'type': typ}
        if typ == 'VEC3':
            acc['max'] = arr.max(0).tolist(); acc['min'] = arr.min(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    mesh_nodes = []
    for name, (pos, nor, idx) in parts.items():
        if name in ('body', 'glass'):
            nor = recompute_normals(pos, idx)
        ai_pos = add_accessor(pos.astype(np.float32), 'VEC3', 5126)
        ai_nor = add_accessor(nor.astype(np.float32), 'VEC3', 5126)
        ai_idx = add_accessor(idx.astype(np.uint32), 'SCALAR', 5125)
        mi = len(meshes)
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': ai_pos, 'NORMAL': ai_nor}, 'indices': ai_idx, 'material': mat_index[name]}]})
        ni = len(nodes)
        nodes.append({'name': name, 'mesh': mi})
        mesh_nodes.append(ni)
    root_idx = len(nodes)
    nodes.append({'name': 'RootNode', 'children': mesh_nodes})
    bin_blob = b''.join(blobs)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'dashcam-studio depth3d CC0 roadster'},
        'scene': 0, 'scenes': [{'name': 'Scene', 'nodes': [root_idx]}],
        'nodes': nodes, 'meshes': meshes, 'materials': mats,
        'accessors': accessors, 'bufferViews': bufferViews,
        'buffers': [{'byteLength': len(bin_blob)}],
    }
    path.write_bytes(wrap_glb(gltf, bin_blob))
    tris = sum(len(parts[n][2]) // 3 for n in parts)
    return tris, path.stat().st_size

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', default=str(Path(__file__).with_name('vehicles') / 'roadster.glb'))
    a = ap.parse_args()
    out = Path(a.o); out.parent.mkdir(parents=True, exist_ok=True)
    tris, sz = write_glb(out)
    print(f'wrote {out} tris={tris} bytes={sz}')
