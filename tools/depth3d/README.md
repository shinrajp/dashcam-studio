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
