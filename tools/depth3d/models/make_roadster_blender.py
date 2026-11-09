"""CC0 own-work generic two-seat EV hypercar for the depth-street replay (roadster.glb).

Run:  blender -b --factory-startup -P make_roadster_blender.py -- [out.glb] [--render DIR]
Built in Blender Z-up with the nose toward +Y, then turned 180° about Z so the exported glTF
(Y-up) has its nose on +Z like the rest of the fleet. No trademarks, names or logos.
"""
from __future__ import annotations
import math, sys
from pathlib import Path
import bpy, bmesh
from mathutils import Vector, Matrix

HERE = Path(__file__).resolve().parent
out = HERE / "vehicles" / "roadster.glb"
render_dir = None
if "--" in sys.argv:
    args = sys.argv[sys.argv.index("--") + 1:]
    if "--render" in args:
        i = args.index("--render"); render_dir = Path(args[i + 1]); del args[i:i + 2]
    if args: out = Path(args[0])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- materials
def mat(name, base, metallic=0.0, rough=0.4, coat=0.0, alpha=1.0, emit=None, em=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Alpha"].default_value = alpha
    if alpha < 0.99:
        m.blend_method = "BLEND"
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = em
    return m

M_BODY  = mat("body", (0.90, 0.91, 0.93), 0.6, 0.18, coat=1.0)
M_GLASS = mat("glass", (0.015, 0.02, 0.03), 0.2, 0.04, alpha=0.78)
M_TRIM  = mat("trim_black", (0.02, 0.02, 0.022), 0.3, 0.45)       # arch liners, sills, diffuser, pillars
M_LIGHT = mat("light", (0.95, 0.97, 1.0), 0.0, 0.2, emit=(0.9, 0.95, 1.0), em=6)
M_TAIL  = mat("lights_red", (0.5, 0.01, 0.01), 0.0, 0.25, emit=(1.0, 0.02, 0.01), em=5)
M_RUBBER= mat("rubber", (0.025, 0.025, 0.027), 0.0, 0.9)
M_RIM   = mat("rim", (0.55, 0.56, 0.58), 0.95, 0.22)
M_BRAKE = mat("brake_disc", (0.30, 0.30, 0.32), 0.8, 0.4)

# ---------------------------------------------------------------- dimensions (m)
L_HALF = 2.22                 # overall length 4.44
W_HALF = 0.97                 # overall width 1.94 (at the haunches)
FLOOR = 0.13                  # ground clearance
AX_F, AX_R = 1.36, -1.30      # wheelbase 2.66
TYRE_R, TYRE_W = 0.345, 0.27
WHEEL_X = W_HALF - TYRE_W / 2 - 0.03   # tyre face just inside the haunch

def smooth(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)

def plan_w(y):
    """half-width in plan: superellipse ends + haunches over each axle."""
    u = y / L_HALF
    p = 3.2 if u > 0 else 2.6           # blunter tail, rounder nose
    base = (max(0.0, 1 - abs(u) ** p)) ** (1 / p)
    w = 0.90 * base
    for ax, amp in ((AX_F, 0.11), (AX_R, 0.12)):
        w += amp * math.exp(-((y - ax) / 0.55) ** 2) * base
    return w

def deck_z(y):
    """top of the lower body (hood / deck line) along the car — smooth analytic crown."""
    u = y / L_HALF                                  # -1 tail .. +1 nose
    base = 0.86 - 0.05 * u - 0.10 * u * u
    nose = 0.40 * smooth(0.55, 1.0, u) ** 1.6       # hood drops to the nose
    tail = 0.20 * smooth(0.80, 1.0, -u) ** 2        # Kamm tail rounds off
    return base - nose - tail
    pts = []
    pts = [(-2.22, 0.62), (-2.10, 0.78), (-1.60, 0.86), (-1.00, 0.88), (-0.40, 0.84),
           (0.40, 0.80), (0.90, 0.74), (1.40, 0.68), (1.90, 0.56), (2.15, 0.44), (2.22, 0.36)]
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        if y0 <= y <= y1:
            t = smooth(y0, y1, y) if False else (y - y0) / (y1 - y0)
            # cosine ease between knots for a smooth crown
            t = 0.5 - 0.5 * math.cos(math.pi * t)
            return z0 + (z1 - z0) * t
    return pts[0][1] if y < pts[0][0] else pts[-1][1]

def floor_z(y):
    """underside rises at the nose (splitter) and tail (diffuser)."""
    return FLOOR + 0.10 * smooth(1.85, 2.22, y) + 0.16 * smooth(-1.75, -2.22, -y) * 0 + 0.16 * smooth(1.75, 2.22, -y)

def section(y, n):
    """closed cross-section (list of (x, z)) — superellipse with tumblehome, n points."""
    w = plan_w(y); zt = deck_z(y); zb = floor_z(y)
    zc = 0.5 * (zt + zb); h = 0.5 * (zt - zb)
    u = abs(y) / L_HALF
    if u > 0.90:
        k = max(0.0, 1 - ((u - 0.90) / 0.10) ** 2) ** 0.5
        h *= 0.10 + 0.90 * k
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        e = 2.0 / 4.5                      # squarish but soft
        x = math.copysign(abs(c) ** e, c) * w
        z = math.copysign(abs(s) ** e, s) * h
        # tumblehome: narrow the upper half, sharpen the shoulder a touch
        if s > 0:
            x *= 1.0 - 0.10 * s ** 2
        else:
            x *= 1.0 - 0.06 * (-s) ** 3
        pts.append((x, zc + z))
    return pts

def loft(name, ys, n, sect, material, cap=True):
    bm = bmesh.new()
    rings = []
    for y in ys:
        rings.append([bm.verts.new((x, y, z)) for x, z in sect(y, n)])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if cap:
        for ring in (rings[0], rings[-1]):
            c = bm.verts.new(sum((v.co for v in ring), Vector()) / len(ring))
            for i in range(n):
                bm.faces.new((ring[i], ring[(i + 1) % n], c))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    obj = bpy.data.objects.new(name, me); scene.collection.objects.link(obj)
    me.materials.append(material)
    for p in me.polygons: p.use_smooth = True
    return obj

def ends(a, b, k, bias=2.2):
    """k samples between a and b, denser near both ends."""
    out_ = []
    for i in range(k):
        t = i / (k - 1)
        t = 0.5 - 0.5 * math.cos(math.pi * t)
        out_.append(a + (b - a) * t)
    return out_

def boolean(obj, cutter, op="DIFFERENCE"):
    m = obj.modifiers.new("b", "BOOLEAN"); m.operation = op; m.solver = "EXACT"; m.object = cutter
    m.material_mode = "TRANSFER"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def cyl(name, r, depth, loc, verts=64, material=None, axis="X"):
    rot = (0, math.pi / 2, 0) if axis == "X" else (0, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object; o.name = name
    if material: o.data.materials.append(material)
    return o

# ---------------------------------------------------------------- body
def build_body():
    ys = ends(-L_HALF + 0.002, L_HALF - 0.002, 80)
    body = loft("body", ys, 60, section, M_BODY)
    # wheel arches: cylinder slightly bigger than the tyre, only through the outer side
    for ax in (AX_F, AX_R):
        for sx in (1, -1):
            c = cyl("arch", TYRE_R + 0.055, 0.60, (sx * (WHEEL_X + 0.18), ax, TYRE_R + 0.01), 64, M_TRIM)
            boolean(body, c)
    for sx in ():
        bpy.ops.mesh.primitive_cube_add(size=1, location=(sx * (plan_w(-0.55) + 0.02), -0.55, 0.46))
        cut = bpy.context.active_object; cut.scale = (0.10, 0.42, 0.16)
        cut.rotation_euler = (0.25, 0, 0); cut.data.materials.append(M_TRIM)
        boolean(body, cut)
    return body

# ---------------------------------------------------------------- greenhouse: tinted teardrop canopy
CAN_Y0, CAN_Y1 = -0.95, 1.05
def can_section(y, n):
    t = (y - CAN_Y0) / (CAN_Y1 - CAN_Y0)
    t = min(max(t, 0), 1)
    # teardrop: steep windscreen at the front (t→1), long tapering fastback at the rear
    prof = math.sin(math.pi * t ** 0.70) ** 0.75
    h = 0.01 + 0.30 * prof
    w = 0.12 + 0.60 * math.sin(math.pi * t ** 0.80) ** 0.45
    w = min(w, plan_w(y) * 0.80)
    zb = deck_z(y) - 0.05
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        e = 2.0 / 3.0
        x = math.copysign(abs(c) ** e, c) * w * (1 - 0.18 * max(s, 0) ** 2)
        z = zb + max(s, 0) ** 0.9 * h if s >= 0 else zb + s * 0.03
        pts.append((x, z))
    return pts

def build_canopy():
    ys = ends(CAN_Y0, CAN_Y1, 36)
    g = loft("glass", ys, 40, can_section, M_GLASS)
    # body-colour targa band across the roof + black A-pillars
    t_roof = (0.10 - CAN_Y0) / (CAN_Y1 - CAN_Y0)
    return g

def build_targa():
    """narrow body-colour roof band (targa) and thin black frame on the canopy sill."""
    def band(y, n):
        pts = can_section(y, n)
        return [(x * 1.012, z + 0.006) for x, z in pts]
    ys = ends(-0.05, 0.22, 6)
    t = loft("targa", ys, 48, band, M_BODY)
    # keep only the top: delete verts below the shoulder
    bm = bmesh.new(); bm.from_mesh(t.data)
    zmin = min(v.co.z for v in bm.verts); zmax = max(v.co.z for v in bm.verts)
    cut = zmin + 0.62 * (zmax - zmin)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < cut], context="VERTS")
    bm.to_mesh(t.data); bm.free()
    sol = t.modifiers.new("s", "SOLIDIFY"); sol.thickness = 0.01
    bpy.context.view_layer.objects.active = t; bpy.ops.object.modifier_apply(modifier="s")
    return t

# ---------------------------------------------------------------- lights: LED bars following the plan outline
def tube_along(name, pts, r, material, ring=6):
    bm = bmesh.new(); rings = []
    for i, p in enumerate(pts):
        p = Vector(p)
        tng = (Vector(pts[min(i + 1, len(pts) - 1)]) - Vector(pts[max(i - 1, 0)])).normalized()
        up = Vector((0, 0, 1)); side = tng.cross(up).normalized(); up = side.cross(tng).normalized()
        rings.append([bm.verts.new(p + r * (math.cos(2 * math.pi * k / ring) * side * 0.35 +
                                            math.sin(2 * math.pi * k / ring) * up)) for k in range(ring)])
    for a, b in zip(rings, rings[1:]):
        for k in range(ring):
            bm.faces.new((a[k], a[(k + 1) % ring], b[(k + 1) % ring], b[k]))
    for rr in (rings[0], rings[-1]):
        bm.faces.new(rr)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); scene.collection.objects.link(o); me.materials.append(material)
    for p in me.polygons: p.use_smooth = True
    return o

def half_w_at(y, z):
    pts = section(y, 144); best = 0.0
    for (x0, z0), (x1, z1) in zip(pts, pts[1:] + pts[:1]):
        if (z0 - z) * (z1 - z) <= 0 and z0 != z1:
            best = max(best, abs(x0 + (x1 - x0) * (z - z0) / (z1 - z0)))
    return best

def surface_y(x, z, front=True):
    ys = [L_HALF * k / 600 for k in range(601)]
    if not front: ys = [-v for v in ys]
    best = 0.0
    for y in ys:
        if half_w_at(y, z) >= abs(x): best = y
    return best

def outline_y(x, front=True):
    """y on the plan outline at lateral offset x (search)."""
    lo, hi = (0.0, L_HALF) if front else (-L_HALF, 0.0)
    best = None
    for k in range(400):
        y = lo + (hi - lo) * k / 399
        if abs(plan_w(y) * 0.97 - abs(x)) < 0.01:
            if best is None or (front and y > best) or (not front and y < best):
                best = y
    return best if best is not None else (L_HALF if front else -L_HALF)

def smooth_bar(pts, inset, front):
    """5-tap smooth the bar's y, clamp the centre so it never pokes into the nose/tail tip, inset."""
    ys = [p[1] for p in pts]
    lim = min(ys, key=abs) if False else None
    out_ = []
    for i, (x, y, z) in enumerate(pts):
        win = ys[max(0, i - 5): i + 6]
        ym = sum(win) / len(win)
        out_.append((x, ym - inset if front else ym + inset, z))
    # centre clamp: no more forward than the value at |x| = 0.25 plus a gentle bow
    ref = [p for p in out_ if abs(abs(p[0]) - 0.25) < 0.03]
    if ref:
        yr = ref[0][1]
        out_ = [(x, (min(y, yr + 0.05 * (1 - (x / 0.25) ** 2)) if front else max(y, yr - 0.05 * (1 - (x / 0.25) ** 2)))
                 if abs(x) < 0.25 else y, z) for x, y, z in out_]
    return out_

def build_lights():
    f = []; r = []
    zf = deck_z(2.05) - 0.03; zr = deck_z(-2.10) - 0.05
    for i in range(41):
        x = -0.68 + 1.36 * i / 40
        f.append((x, surface_y(x, zf, True), zf))
        r.append((x, surface_y(x, zr, False), zr))
    f = smooth_bar(f, -0.004, True); r = smooth_bar(r, -0.004, False)
    tube_along("light", f, 0.018, M_LIGHT)
    zi = floor_z(1.9) + 0.10; zd = floor_z(-2.0) + 0.06
    intake = []; diff = []
    for i in range(31):
        x = -0.58 + 1.16 * i / 30
        intake.append((x, surface_y(x, zi, True), zi))
        diff.append((x, surface_y(x, zd, False), zd))
    intake = smooth_bar(intake, 0.01, True); diff = smooth_bar(diff, 0.01, False)
    tube_along("trim_black", intake, 0.05, M_TRIM)
    tube_along("trim_black", diff, 0.06, M_TRIM)
    tube_along("lights_red", r, 0.020, M_TAIL)

# ---------------------------------------------------------------- trim: sills, splitter, diffuser
def build_trim():
    # rocker / sill strip between the arches (dark)
    def sill(y, n):
        w = plan_w(y) * 0.995; zb = floor_z(y)
        return [(math.cos(2*math.pi*i/n) * w, zb + 0.045 + math.sin(2*math.pi*i/n) * 0.05) for i in range(n)]
    loft("trim_black", ends(AX_R + TYRE_R + 0.08, AX_F - TYRE_R - 0.08, 10), 24, sill, M_TRIM)
    # rear diffuser fins
    for x in ():
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, -L_HALF + 0.22, FLOOR + 0.05))
        o = bpy.context.active_object; o.scale = (0.025, 0.40, 0.09); o.name = "trim_black"
        o.data.materials.append(M_TRIM)

# ---------------------------------------------------------------- wheels
def build_wheel(sx, y):
    R, W = TYRE_R, TYRE_W
    x = sx * WHEEL_X
    # tyre: torus-ish profile lathed around the axle (rounded shoulders, sidewall bulge)
    bm = bmesh.new()
    prof = []
    rim_r = R * 0.68
    for k in range(15):
        a = math.pi * k / 14                # sidewall → tread → sidewall
        c, s = -math.cos(a), math.sin(a)
        px = (W / 2) * math.copysign(abs(c) ** 0.30, c)
        pr = rim_r + (R - rim_r) * (abs(s) ** 0.22)
        prof.append((px, pr))
    segs = 48
    rings = []
    for i in range(segs):
        th = 2 * math.pi * i / segs
        rings.append([bm.verts.new((x + px, y + pr * math.cos(th), R + pr * math.sin(th))) for px, pr in prof])
    for i in range(segs):
        a, b = rings[i], rings[(i + 1) % segs]
        for k in range(len(prof) - 1):
            bm.faces.new((a[k], a[k + 1], b[k + 1], b[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("rubber"); bm.to_mesh(me); bm.free()
    tyre = bpy.data.objects.new("rubber", me); scene.collection.objects.link(tyre); me.materials.append(M_RUBBER)
    for p in me.polygons: p.use_smooth = True
    # make normals point outward from the torus centre line
    bm = bmesh.new(); bm.from_mesh(me)
    for f in bm.faces:
        c = f.calc_center_median(); radial = Vector((0, c.y - y, c.z - R))
        if f.normal.dot(radial) < 0 and abs(c.x - x) < W * 0.45: f.normal_flip()
    bm.to_mesh(me); bm.free()

    parts = []
    face_x = x + sx * (W / 2 - 0.035)       # rim face sits slightly inside the sidewall
    # rim barrel (dark, recessed) and outer lip
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=rim_r * 0.99, depth=W * 0.80, location=(x, y, R),
                                        rotation=(0, math.pi / 2, 0), end_fill_type="NOTHING")
    barrel = bpy.context.active_object; barrel.data.materials.append(M_TRIM); parts.append(barrel)
    bpy.ops.mesh.primitive_torus_add(major_radius=rim_r * 0.97, minor_radius=0.014, major_segments=48, minor_segments=6,
                                     location=(face_x, y, R), rotation=(0, math.pi / 2, 0))
    lip = bpy.context.active_object; lip.data.materials.append(M_RIM); parts.append(lip)
    # dark dish behind the spokes
    parts.append(cyl("rim", rim_r * 0.92, 0.01, (face_x - sx * 0.05, y, R), 40, M_TRIM))
    # brake disc + caliper
    parts.append(cyl("rim", rim_r * 0.72, 0.03, (face_x - sx * 0.09, y, R), 40, M_BRAKE))
    bpy.ops.mesh.primitive_cube_add(size=1, location=(face_x - sx * 0.07, y - 0.12 * (1 if y > 0 else -1), R + 0.10))
    cal = bpy.context.active_object; cal.scale = (0.05, 0.09, 0.12); cal.data.materials.append(M_TRIM); parts.append(cal)
    # hub
    parts.append(cyl("rim", rim_r * 0.20, 0.05, (face_x, y, R), 24, M_RIM))
    # 5 twin spokes (aero turbine look)
    for i in range(10):
        a = 2 * math.pi * i / 10 + (0.12 if i % 2 else -0.12)
        bpy.ops.mesh.primitive_cube_add(size=1)
        sp = bpy.context.active_object
        sp.scale = (0.035, 0.045, rim_r * 0.78)
        sp.rotation_euler = (a, 0, 0)
        mid = rim_r * 0.52
        sp.location = (face_x - sx * 0.012, y + math.sin(a) * -mid, R + math.cos(a) * mid)
        sp.data.materials.append(M_RIM); parts.append(sp)
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    rim = bpy.context.active_object; rim.name = "rim"
    for p in rim.data.polygons: p.use_smooth = True
    return tyre, rim

# ---------------------------------------------------------------- assemble
def main():
    build_body(); build_canopy(); build_lights(); build_trim()
    for ax in (AX_F, AX_R):
        for sx in (1, -1):
            build_wheel(sx, ax)
    meshes = [o for o in scene.objects if o.type == "MESH"]
    # ground: lowest point (tyre contact) to z = 0
    zmin = min((o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices)
    for o in meshes:
        o.location.z -= zmin
    # nose +Y → turn 180° about Z so glTF (Y-up) has the nose on +Z
    for o in meshes:
        o.matrix_world = Matrix.Rotation(math.pi, 4, "Z") @ o.matrix_world
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # auto-smooth-ish: split sharp edges so the boolean rims stay crisp
    for o in meshes:
        bm = bmesh.new(); bm.from_mesh(o.data)
        sharp = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(40)]
        bmesh.ops.split_edges(bm, edges=sharp)
        bm.to_mesh(o.data); bm.free()
    tris = 0
    for o in meshes:
        o.data.calc_loop_triangles(); tris += len(o.data.loop_triangles)
    print("TRIS", tris)
    zmin = min((o.matrix_world @ v.co).z for o in meshes for v in o.data.vertices)
    print("ZMIN", round(zmin, 4))
    if render_dir:
        render(render_dir, meshes)
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
    print("WROTE", out, out.stat().st_size)

def render(d, meshes):
    d.mkdir(parents=True, exist_ok=True)
    scene.render.engine = "CYCLES"; scene.cycles.samples = 48; scene.cycles.use_denoising = True
    scene.cycles.device = "CPU"
    scene.render.resolution_x, scene.render.resolution_y = 960, 600
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("w"); scene.world = world; world.use_nodes = True
    nt = world.node_tree; bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky"); sky.sky_type = "NISHITA"; sky.sun_elevation = math.radians(18)
    sky.sun_rotation = math.radians(210)
    nt.links.new(sky.outputs[0], bg.inputs[0]); bg.inputs[1].default_value = 0.35
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    gp = bpy.context.active_object; gm = mat("asphalt", (0.09, 0.09, 0.095), 0.0, 0.85); gp.data.materials.append(gm)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); scene.collection.objects.link(cam)
    scene.camera = cam; cam.data.lens = 50
    # model nose is now on -Y (after the 180° turn)
    views = {
        "34front": (Vector((3.6, -5.2, 1.9)), Vector((0, -0.2, 0.45))),
        "side":    (Vector((7.2, 0.0, 1.1)), Vector((0, 0.0, 0.50))),
        "34rear":  (Vector((-3.6, 5.2, 2.0)), Vector((0, 0.2, 0.45))),
        "chase":   (Vector((0.0, 7.5, 3.4)), Vector((0, -0.5, 0.5))),   # viewer Chase: behind & above
    }
    for k, (pos, tgt) in views.items():
        cam.location = pos
        cam.rotation_euler = (tgt - pos).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(d / f"roadster-{k}.png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(gp, do_unlink=True); bpy.data.objects.remove(cam, do_unlink=True)

main()
