# Detection models

| File | Model | Size | License | Source |
|---|---|---|---|---|
| `yolo11n.onnx` | Ultralytics YOLO11 nano, COCO 80 classes, 640×640, opset 17 | 10.7 MB | **AGPL-3.0** | exported from the official `yolo11n.pt` (github.com/ultralytics/assets releases v8.3.0) with `yolo export format=onnx imgsz=640 opset=17 simplify=True` |
| `yolo11s.onnx` | Ultralytics YOLO11 small, same | 38.1 MB | **AGPL-3.0** | from the official `yolo11s.pt`, same command |

Grounding DINO tiny (experimental) is not stored here. It is loaded from Hugging Face (`onnx-community/grounding-dino-tiny-ONNX`, Apache-2.0) by transformers.js.

**License note.** YOLO11 weights are AGPL-3.0. Serving them in a web app counts as distributing them, so the app that serves them must be available under AGPL-3.0-compatible terms, with source, or you need an Ultralytics Enterprise license. Dashcam Studio is open source on GitHub. If you redistribute or host a modified copy, keep it open source, or point Settings ▸ Object detection at a model you are licensed to use (`urls` in localStorage `tdc.detect.v1`).
