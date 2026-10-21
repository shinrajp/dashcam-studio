# Export FC4 (matteo-rizzo/fc4-pytorch, MIT) to ONNX + int8 for the colour-constancy prototype.
# Usage: git clone https://github.com/matteo-rizzo/fc4-pytorch /workspace/fc4-pytorch && (cd it; unzip trained_models.zip -d tm)
#        python tools/cc-export-fc4.py   (needs torch, onnx, onnxruntime); then the quantisation step at the end.
import sys, torch, os
sys.path.insert(0, "/workspace/fc4-pytorch")
import classes.fc4.squeezenet.SqueezeNetLoader as L
orig = L.SqueezeNetLoader.load
L.SqueezeNetLoader.load = lambda self, pretrained=False: orig(self, False)
from classes.fc4.FC4 import FC4
m = FC4(1.1); sd = torch.load("/workspace/fc4-pytorch/tm/trained_models/fc4_cwp/fold_0/model.pth", map_location="cpu")
print(type(sd), list(sd.keys())[:3] if isinstance(sd, dict) else "")
m.load_state_dict(sd); m.eval()
class Wrap(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, x):
        pred, rgb, conf = s.m(x); return pred, rgb, conf
w = Wrap(m); x = torch.rand(1, 3, 256, 384)
with torch.no_grad(): p = w(x); print([t.shape for t in p])
torch.onnx.export(w, x, "/workspace/fc4.onnx", input_names=["image"], output_names=["illum", "patch_rgb", "patch_conf"], dynamic_axes={"image": {2: "h", 3: "w"}, "patch_rgb": {2: "ph", 3: "pw"}, "patch_conf": {2: "ph", 3: "pw"}}, opset_version=17, dynamo=False)
print(os.path.getsize("/workspace/fc4.onnx"))
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.shape_inference import quant_pre_process
quant_pre_process("/workspace/fc4.onnx", "/workspace/fc4-pre.onnx")
quantize_dynamic("/workspace/fc4-pre.onnx", "models/cc/fc4-squeezenet11-int8.onnx", weight_type=QuantType.QUInt8)
