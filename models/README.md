# Detection models

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `yolo11n.onnx` | Ultralytics YOLO11 nano, COCO 80 classes, 640×640, opset 17 | 10.7 MB | **AGPL-3.0** | exported from the official `yolo11n.pt` (github.com/ultralytics/assets releases v8.3.0) with `yolo export format=onnx imgsz=640 opset=17 simplify=True` |
| `yolo11s.onnx` | Ultralytics YOLO11 small, same | 38.1 MB | **AGPL-3.0** | from the official `yolo11s.pt`, same command |
| `yolo11n-320.onnx` | YOLO11 nano at 320×320 (Detection speed: *Fast*), opset 17 | 10.6 MB | **AGPL-3.0** | from the official `yolo11n.pt` with ultralytics 8.4.177: `yolo export model=yolo11n.pt format=onnx imgsz=320 opset=17 simplify=True`; sha256 `7648a68d4b9746f768c22ef7f9b083dfdb9e358fe38dcbead63d43daebbf5266` |
| `yolo11m.onnx` (**not in this repo, not in the offline pack**) | Ultralytics YOLO11 medium, COCO 80 classes, 640×640, opset 17 | 80.7 MB | **AGPL-3.0** | optional, computers only (Settings ▸ Object detection ▸ Model ▸ *YOLO11 medium*). **Easiest: press *Choose model file…* there and pick your `yolo11m.onnx`**; the app keeps it in this browser (IndexedDB `tdc-user-models`) so you pick it once per device, on any address, and nothing is uploaded. Export it yourself from the official `yolo11m.pt` (github.com/ultralytics/assets releases v8.3.0) with `yolo export model=yolo11m.pt format=onnx imgsz=640 opset=17 simplify=True` and either pick it in the app as above, or put the file at `models/yolo11m.onnx` (it is git-ignored), or point the `urls.medium` pref at a copy you host. The export used for the tests had sha256 `cae48f8e2f78e2e5d91e47daab545258cc5f7720fe5c97eb83faaa4aca6297a4`. Same AGPL-3.0 terms as the other YOLO11 weights. It is roughly 2–3× slower than small, so phones never offer it. |

Grounding DINO tiny (experimental) is not stored here. It is loaded from Hugging Face (`onnx-community/grounding-dino-tiny-ONNX`, Apache-2.0) by transformers.js.

**License note.** YOLO11 weights are AGPL-3.0. Serving them in a web app counts as distributing them, so the app that serves them must be available under AGPL-3.0-compatible terms, with source, or you need an Ultralytics Enterprise license. Dashcam Studio is open source on GitHub. If you redistribute or host a modified copy, keep it open source, or point Settings ▸ Object detection at a model you are licensed to use (`urls` in localStorage `tdc.detect.v1`).

## Phase 6: licence plates (`models/plates/`)

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `plates/yolo-v9-t-384-license-plates-end2end.onnx` | YOLOv9-tiny licence-plate detector, 384×384, NMS inside ("end2end": output `[N, 7]`) | 7.8 MB | **MIT** (open-image-models) | `github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx` (sha256 `888397b9…a77a8`) |
| `plates/yolo-v9-t-640-license-plates-end2end.onnx` | same, 640×640 | 7.8 MB | **MIT** | same release, `…-640-…` (sha256 `c3c1026c…c076`) |
| `plates/cct_s_v2_global.onnx` | fast-plate-ocr CCT-S v2 "global" plate reader: uint8 RGB `[n, 64, 128, 3]` → `[n, 10, 37]` per-slot probabilities over `0-9 A-Z _`, plus a 66-way region head (includes United States) | 5.3 MB | **MIT** (fast-plate-ocr) | `github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_s_v2_global.onnx` (sha256 `384bbbd2…c6e47b`) |

**Where they are served from.** Only from `models/plates/` in this app (they are committed here, ~20.5 MB: 7.8 + 7.8 + 5.3 MB). `js/plates.js` has no
other address (it used to fall back to a raw.githubusercontent.com copy on the `feature/phase6-plates-ocr` branch; that is gone), apart from an
optional custom URL you set yourself (Settings, `urls` in `tdc.plates.v1`), which is tried first. The browser's IndexedDB (`tdc-models`) is only a
speed-up cache: loading works with it empty, blocked or refused, and if a cached copy is damaged the worker drops it and fetches the file again
(`test/plates-local.js`). **Offline pack:** not included. Plates are off by default, and 13.0 MB (reader + 384 px finder) of background download
for everyone is not worth it; once plates are turned on the files are fetched once and kept by the service worker's run-time cache.

**What was checked (Oct 28, 2026).** Both upstream repositories (`ankandrew/open-image-models`, `ankandrew/fast-plate-ocr`) carry an MIT `LICENSE`
(copyright 2024 ankandrew) and say `license = "MIT"` in `pyproject.toml`. The 384 px detector and the CCT-S reader were downloaded again from the
release URLs above and their sha256 match the committed files. The 640 px detector's checksum is the one recorded when it was added (not re-downloaded).
**Not verified:** neither upstream README states the licence or provenance of the *training data* behind the weights, and the YOLOv9 architecture
the detector is based on is GPL-3.0 code (WongKinYiu); the weights are published by open-image-models under MIT. Nothing here is legal advice.

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

## Hand-off milestone 4: person re-identification (`models/reid/`)

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `reid/person-reidentification-retail-0288.onnx` | Intel Open Model Zoo **person-reidentification-retail-0288**: a small OSNet-style network, input BGR `[1, 3, 256, 128]` (0–255, the model normalises inside), output a 256-d appearance vector. 0.18 M parameters, 0.17 GFLOPs. Market-1501 rank-1 86.1 %, mAP 58.9 % (Intel's figures; "standing upright" pedestrians, not seen from a car at night) | 0.77 MB | **Apache-2.0** (Open Model Zoo; `model.yml` of the model names the Apache licence file of the repository, the repository README says the pre-trained models are Apache-2.0 too) | `https://storage.openvinotoolkit.org/repositories/open_model_zoo/2023.0/models_bin/1/person-reidentification-retail-0288/FP32/person-reidentification-retail-0288.{xml,bin}` (sha256 of `.xml` 30f452b2…, of `.bin` 6496b8d5…) |

* **Modified:** converted from OpenVINO IR to ONNX (opset 18) with `tools/ir2onnx-reid.py` (a small converter written for this model; MVN is written out as mean / variance ops, grouped convolutions keep their weights). Checked against OpenVINO in f32: cosine 1.0 on test crops. sha256 of the stored file `238587228c513e797278006320a2c24ac047d8fb808eee86571a5068b7622d91`.
* `reid/LICENSE-Apache-2.0.txt` is the licence text. This notice is the "modified" statement the licence asks for. This is a note, not legal advice: Intel trained the weights on person re-identification data; check that this is acceptable for your use.
* **Where it runs:** in the detection worker (`js/detect-worker.js`, messages `loadReid` / `embed`). WebGPU only when that worker's runtime really is WebGPU (a real GPU adapter, not SwiftShader / llvmpipe, and the app's gate is open: Safari and every iOS browser stay on WASM unless `?webgpu=on`); otherwise WASM, throttled (`js/reid.js`, `budget()`). On load it runs a self-test (256 finite, non-zero numbers) and falls through WebGPU → WASM → colour descriptor only.
* **Another model:** put an ONNX with input `[1, 3, 256, 128]` (BGR, 0–255) and a single 256-d output in this folder and change the file name in `D.loadReid` (`js/detect.js`). Anything else needs `reidInput` / the output size in `js/detect-worker.js` and `BINS`-independent code in `js/people.js` (`cosine` works for any length).
* **Considered and not shipped:** larger OSNet / FastReID models (several MB, licences that need a closer look), CLIP crops (150 MB, already used for search but far too slow per person).

