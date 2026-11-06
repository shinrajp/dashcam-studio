#!/usr/bin/env python3
"""Unit tests for US-RHT vehicle heading priors (vehicles.py)."""
from __future__ import annotations
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicles as V

def near(a, b, deg=5):
    return abs(V._wrap(a - b)) < math.radians(deg)

fails = 0
def ok(cond, msg):
    global fails
    if cond: print('  OK', msg)
    else: fails += 1; print('FAIL', msg)

ego_yaw = 0.0  # facing +Z
# right of ego at (2, 10) → same direction
ok(V._side_of_ego(2.0, 10.0, 0.0, 0.0, ego_yaw) > 0, 'right side +')
ok(V._side_of_ego(-2.0, 10.0, 0.0, 0.0, ego_yaw) < 0, 'left side -')
ok(near(V._yaw_from_side(ego_yaw, +1), ego_yaw), 'right kerb faces with ego')
ok(near(V._yaw_from_side(ego_yaw, -1), ego_yaw + math.pi), 'left kerb faces against ego (two-way)')
ok(near(V._yaw_from_side(ego_yaw, -1, two_way=False), ego_yaw), 'one-way left still with ego')

# movers: finalize must NOT flip motion_yaw to match prior
steps = [
    [dict(id=1, cls='car', x=-3.0, z=5.0, yaw=0.0, L=4.5, W=1.8, H=1.5, rgb=[200,200,200], est=True)],
    [dict(id=1, cls='car', x=-3.0, z=2.0, yaw=0.0, L=4.5, W=1.8, H=1.5, rgb=[200,200,200], est=True)],  # moving -Z = oncoming
    [dict(id=1, cls='car', x=-3.0, z=-1.0, yaw=0.0, L=4.5, W=1.8, H=1.5, rgb=[200,200,200], est=True)],
]
ego_path = [(0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 2.0, 0.0)]  # ego advancing +Z
out, n = V._finalize(steps, ego_path=ego_path, two_way=True)
yaws = [v['yaw'] for row in out for v in row if v['id']==1]
ok(n == 1 and yaws, f'moving track kept id n={n} yaws={yaws}')
# world motion Δz=-6 → yaw ≈ π (oncoming); ego_path only for side prior
ok(all(near(y, math.pi, deg=15) for y in yaws), f'oncoming motion yaw≈π got {yaws}')

# parked on left: side prior → π
park = [
    [dict(id=2, cls='car', x=-5.0, z=8.0, yaw=0.1, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
    [dict(id=2, cls='car', x=-5.0, z=8.05, yaw=0.0, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
    [dict(id=2, cls='car', x=-5.0, z=8.02, yaw=-0.05, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
]
ego_p = [(0.0, 0.0, 0.0)] * 3
out2, _ = V._finalize(park, ego_path=ego_p, two_way=True)
py = [v['yaw'] for row in out2 for v in row if v['id']==2]
ok(py and all(v.get('parked') for row in out2 for v in row if v['id']==2), 'left parked flagged')
ok(all(near(y, math.pi, deg=20) for y in py), f'left parked yaw≈π got {py}')

# parked on right → 0
park_r = [
    [dict(id=3, cls='car', x=5.0, z=8.0, yaw=0.0, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
    [dict(id=3, cls='car', x=5.0, z=8.02, yaw=0.05, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
    [dict(id=3, cls='car', x=5.05, z=8.0, yaw=-0.02, L=4.5, W=1.8, H=1.5, rgb=[40,40,40], est=True)],
]
out3, _ = V._finalize(park_r, ego_path=ego_p, two_way=True)
ry = [v['yaw'] for row in out3 for v in row if v['id']==3]
ok(all(near(y, 0.0, deg=20) for y in ry), f'right parked yaw≈0 got {ry}')

# appearance: headlights from front cam → face cam → yaw = cam_yaw+π
g = [dict(cam='front', conf=0.9, rgb=[220,220,230], yaw_cam=0.0, face_hint=+1, app_w=1.5)]
ya = V._appearance_facing(g)
ok(ya is not None and near(ya, math.pi), f'headlights → oncoming yaw {ya}')
g2 = [dict(cam='front', conf=0.9, rgb=[80,20,20], yaw_cam=0.0, face_hint=-1, app_w=1.5)]
ya2 = V._appearance_facing(g2)
ok(ya2 is not None and near(ya2, 0.0), f'taillights → same-dir yaw {ya2}')

print('ALL OK' if fails == 0 else f'{fails} FAILED')
sys.exit(1 if fails else 0)
