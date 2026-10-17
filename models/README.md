# Detection models

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `yolo11n.onnx` | Ultralytics YOLO11 nano, COCO 80 classes, 640×640, opset 17 | 10.7 MB | **AGPL-3.0** | exported from the official `yolo11n.pt` (github.com/ultralytics/assets releases v8.3.0) with `yolo export format=onnx imgsz=640 opset=17 simplify=True` |
| `yolo11s.onnx` | Ultralytics YOLO11 small, same | 38.1 MB | **AGPL-3.0** | from the official `yolo11s.pt`, same command |

Grounding DINO tiny (experimental) is not stored here. It is loaded from Hugging Face (`onnx-community/grounding-dino-tiny-ONNX`, Apache-2.0) by transformers.js.

**License note.** YOLO11 weights are AGPL-3.0. Serving them in a web app counts as distributing them, so the app that serves them must be available under AGPL-3.0-compatible terms, with source, or you need an Ultralytics Enterprise license. Dashcam Studio is open source on GitHub. If you redistribute or host a modified copy, keep it open source, or point Settings ▸ Object detection at a model you are licensed to use (`urls` in localStorage `tdc.detect.v1`).

## Phase 6: licence plates (`models/plates/`)

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `plates/yolo-v9-t-384-license-plates-end2end.onnx` | YOLOv9-tiny licence-plate detector, 384×384, NMS inside ("end2end": output `[N, 7]`) | 7.8 MB | **MIT** (open-image-models) | `github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx` (sha256 `888397b9…a77a8`) |
| `plates/yolo-v9-t-640-license-plates-end2end.onnx` | same, 640×640 | 7.8 MB | **MIT** | same release, `…-640-…` (sha256 `c3c1026c…c076`) |
| `plates/cct_s_v2_global.onnx` | fast-plate-ocr CCT-S v2 "global" plate reader: uint8 RGB `[n, 64, 128, 3]` → `[n, 10, 37]` per-slot probabilities over `0-9 A-Z _`, plus a 66-way region head (includes United States) | 5.3 MB | **MIT** (fast-plate-ocr) | `github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_s_v2_global.onnx` (sha256 `384bbbd2…c6e47b`) |

Copied unchanged from the authors' GitHub releases. The plate detector's architecture is YOLOv9 (WongKinYiu, GPL-3.0 code);
the released weights are distributed by open-image-models under MIT. Both are compatible with this AGPL-3.0-style open-source
app. Training data is the authors' (a global plate dataset); nothing is trained in the app.

**Checked on US / California plates:** 5/5 synthetic California-style plates (36–92 px wide, made-up numbers, `test/fixtures/plate-*.jpg`)
found and read exactly by both detector sizes. Outside the repo, six public Wikimedia Commons photos of real California plates
(1990s–2010s styles) were read correctly by the CCT-S reader (the smaller CCT-XS got 2 of 6 wrong, so it isn't shipped); those photos
and their numbers are not stored here.

Street names and sign text reuse the PP-OCRv4 text finder already bundled in `vendor/ocr/` (Apache-2.0, see the Redact section of the README).

## Cloud boost (optional, not a model in this repo)
Phase 6B can send plate crops or downscaled frames to the user's own Grok (xAI), Claude (Anthropic) or Gemini (Google) account. Nothing from those providers is downloaded or bundled; no training happens. Defaults (editable in Settings ▸ Cloud boost): `grok-4.3`, `claude-haiku-5-5`, `gemini-3.5-flash-lite`, names as listed in the providers' model docs on Oct 16, 2026. Off by default. Tested with mocked responses only.
