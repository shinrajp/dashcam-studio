# Colour-constancy prototype models (Settings ▸ White balance ▸ Colour constancy, off by default)

## fc4-squeezenet11-int8.onnx (1.8 MB)
- What: FC4 "Fully Convolutional Color Constancy with Confidence-weighted Pooling" (Hu, Wang, Lin, CVPR 2017),
  SqueezeNet 1.1 backbone, confidence-weighted pooling. Input: 1×3×H×W, linear RGB normalised by its max, gamma 1/2.2.
  Outputs: `illum` (1×3, the light's linear RGB), `patch_rgb`, `patch_conf` (per-patch estimates and confidences).
- Source: PyTorch port https://github.com/matteo-rizzo/fc4-pytorch (MIT License, © 2021 Matteo Rizzo),
  `trained_models/fc4_cwp/fold_0/model.pth`. Original method/code: https://github.com/yuanming-hu/fc4 (MIT License).
  Backbone architecture: torchvision SqueezeNet 1.1 (BSD-3-Clause).
- Converted here: `torch.onnx.export` (opset 17), then onnxruntime dynamic int8 quantisation (weights uint8);
  max deviation from fp32 on random input 0.3°. Script: `tools/cc-export-fc4.py`.
- Training data caveat: the weights were trained on the Gehler–Shi ColorChecker dataset (linear Canon camera RAW).
  The dataset is distributed for research without a stated licence; the MIT licence covers the code and the released
  weights as published by the repo author. Check this before turning the feature on for everyone.
- Domain caveat: trained on linear camera RAW, not on compressed, tone-mapped dashcam video; the app linearises sRGB
  first and maps the output to linear sRGB with a 3×3 fitted on synthetic data (`CC.C.FC4_CAL`).
