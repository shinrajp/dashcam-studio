# Depth street replay builder (tools/depth3d)

One command from a Tesla HW4 drive folder to the textured 3D "depth street replay" page:

```bash
python3 tools/depth3d/build.py "<drive folder>" "<page folder>" --t0 8.5 --t1 12.5 --model model_fp16.onnx
```

Options: `--clip <stamp>` (folder with several clips), `--rig rig.json` (a calibrated rig: in-app export or tools/rig output),
`--delays auto|fit|rig|zero`, `--dt` (seconds between time steps, default 1/6), `--detector <yolo.onnx>` / `--no-detector`,
`--no-grow`, `--work <dir>` (default `<page folder>.work`), `--clean`, `--depth-stub` (tests only: no AI model).

Steps, modules and what changed against the prototype: `experiments/depth3d/README.md`. Tests: `test/depth3d.test.py`,
`test/depth3d-e2e.py` (see `test/README.md`).

**The page and the work folder show the drive** — never commit or publish them (the repository is public; the tool refuses
to write inside it).

## Optional: fill blind spots (ground layer)

After a build without `--clean` (it needs the work folder):

```bash
python3 tools/depth3d/ground.py "<page folder>.work"
python3 tools/depth3d/fill_sd.py "<page folder>.work" --model <stable-diffusion-inpainting folder>
python3 tools/depth3d/ground.py "<page folder>.work" --export "<page folder>"
```

`ground.py` makes one top-down picture of the road for the whole stretch from every moment's views (real footage: under the
car and behind the bumper were usually filmed a moment earlier or later; detected vehicles are left out). `fill_sd.py` paints
only what no camera ever saw, with Stable Diffusion 1.5 inpainting (torch + diffusers; a separate environment is fine), from a
plain-road start at strength 0.45 (a free hand drew a car-like shape next to parked cars). The page then shows **Fill blind
spots** and **Mark estimated** (the painted part tinted blue and hatched). Estimated pixels are for the replay's look only:
never for detection, tracking or exports. On 2026-10-19 (8.5–12.5 s): 732 m² from other moments, 115 m² estimated.
