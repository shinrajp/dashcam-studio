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

## Vehicle details (beta): no new model files

| Stage | Model | Size | License | Source |
|---|---|---|---|---|
| vehicle boxes | YOLO11 n/s (above) | 10.7 / 38.1 MB | AGPL-3.0 | this folder |
| colour | none (pixel statistics in `js/vehicle-attrs.js`) | 0 | — | — |
| type / role, make & model | OpenAI CLIP ViT-B/32, quantised q8 (`Xenova/clip-vit-base-patch32`) via transformers.js 3.8.1 | ~150 MB, downloaded once into the browser cache (shared with picture search) | **MIT** (OpenAI CLIP weights; Xenova ONNX conversion) | huggingface.co/Xenova/clip-vit-base-patch32 |

Make & model is zero-shot CLIP on prompts like "a photo of a Toyota Prius, a type of car." (26 brands, ~90 models), loaded only when the query names a make and the **Also guess make & model** switch is on.

**Considered and not shipped:** `zededa/resnet50-cars` (Stanford Cars, 196 classes). The weights are Apache-2.0, but the model is 94 MB, only knows 2012-and-older models (no Model Y, Cybertruck, Rivian…), and Stanford Cars is distributed for non-commercial research use only, so a model trained on it isn't a clean fit for this app. Other open fine-tuned car classifiers on Hugging Face/GitHub are also Stanford Cars or CompCars (non-commercial). CLIP is already downloaded for picture search, covers new models by name, and its licence is MIT.

**Accuracy** (`test/vehicle-attrs.js`, 37 photos from Wikimedia Commons, public domain or CC0 only, fetched at test time by `tools/fetch-vehicle-fixtures.py` and not stored here because some show real plates):

| What | Chromium | WebKit |
|---|---|---|
| detector class (car / bus / truck) | 37/37 | 37/37 |
| colour exact (23 single-colour photos) | 14/23 (61%) | 16/23 (70%) |
| colour accepted by a colour query | 21/23 (91%) | 22/23 (96%) |
| type / role top-1, all (28) | 24/28 (86%) | 23/28 (82%) |
| · tour bus (7) | 7/7 | 7/7 |
| · city bus (8) | 7/8 | 6/8 |
| · school bus / minibus | 1/1 · 0/1 | 1/1 · 0/1 |
| · police car (3) / ambulance (2) / fire truck (3) | 3/3 · 1/2 · 3/3 | 3/3 · 1/2 · 3/3 |
| · taxi (1) / pickup + delivery van (2) | 0/1 · 2/2 | 0/1 · 2/2 |
| type found by the query (asked type passes) | 25/28 (89%) | 25/28 (89%) |
| make top-1 (10 cars) | 7/10 (70%) | 7/10 (70%) |
| make + model top-1 | 2/10 (20%) | 4/10 (40%) |

Misses: minibus → tour bus, ambulance (van-based) → delivery van, yellow taxi → sports car, one city bus → tour bus (WebKit also one → school bus). Speed, headless box CPU, WASM, one thread (median): detector 0.93 s per frame, colour + CLIP 0.22 s per vehicle (type and make share one CLIP image pass; colour alone ~1 ms).

Type prompts for buses were picked by comparing four prompt sets on the 17 bus photos (the chosen set got 15/17), so the bus numbers are tuned on the same photos and will be lower on new footage. Colour truth is only scored where the photo has one clear body colour (23 photos).

