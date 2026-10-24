"""Convert Intel OMZ person-reidentification-retail-0288 (OpenVINO IR, FP32) to ONNX, op by op. Dev tool (tools/ir2onnx-reid.py)."""
import sys, numpy as np, xml.etree.ElementTree as ET, onnx
from onnx import helper as H, TensorProto as TP, numpy_helper as NH
xml, binf, out = sys.argv[1:4]
root = ET.parse(xml).getroot(); blob = open(binf, 'rb').read()
layers = {l.get('id'): l for l in root.find('layers')}
edges = {}   # (to_layer, to_port) -> (from_layer, from_port)
for e in root.find('edges'): edges[(e.get('to-layer'), e.get('to-port'))] = (e.get('from-layer'), e.get('from-port'))
NP = {'f32': np.float32, 'i64': np.int64, 'i32': np.int32, 'f16': np.float16}
consts = {}
for i, l in layers.items():
    if l.get('type') == 'Const':
        d = l.find('data'); shp = [int(x) for x in d.get('shape').split(',')] if d.get('shape') else []
        dt = NP[d.get('element_type')]; off, size = int(d.get('offset')), int(d.get('size'))
        consts[i] = np.frombuffer(blob[off:off + size], dtype=dt).reshape(shp).copy()
def tname(lid, port): return f"t{lid}_{port}"
def inp(l, k):
    lid, p = edges[(l.get('id'), str(k))]
    return tname(lid, p), (consts.get(lid))
def ints(s): return [int(x) for x in s.split(',')]
inits, nodes = [], []
cname = {}
def cinit(lid, arr=None, nm=None):
    n = nm or f"c{lid}"
    if n not in cname:
        cname[n] = 1; inits.append(NH.from_array(arr, n))
    return n
def getin(l, k, reshape=None):
    name, c = inp(l, k)
    if c is not None:
        arr = c if reshape is None else c.reshape(reshape)
        return cinit(None, arr, f"k{edges[(l.get('id'), str(k))][0]}" + ("" if reshape is None else "_r" + "x".join(map(str, reshape))))
    return name
# order: file order is topological in IR
inputs = []; outputs = []
for i, l in layers.items():
    ty = l.get('type'); d = l.find('data'); a = d.attrib if d is not None else {}
    oport = [p.get('id') for p in l.find('output')] if l.find('output') is not None else []
    o = tname(i, oport[0]) if oport else None
    if ty == 'Const': continue
    if ty == 'Parameter':
        inputs.append(H.make_tensor_value_info(o, TP.FLOAT, ints(a['shape']))); inp_name = o; continue
    if ty == 'Result':
        src, _ = inp(l, 0); outputs.append(src); continue
    if ty in ('Add', 'Multiply', 'Subtract'):
        nodes.append(H.make_node({'Add': 'Add', 'Multiply': 'Mul', 'Subtract': 'Sub'}[ty], [getin(l, 0), getin(l, 1)], [o])); continue
    if ty == 'Convolution' or ty == 'GroupConvolution':
        w = consts[edges[(i, '1')][0]]; g = 1
        if ty == 'GroupConvolution': g = w.shape[0]; w = w.reshape((g * w.shape[1],) + w.shape[2:])
        wn = cinit(None, w, "w" + edges[(i, '1')][0] + f"_{ty[:1]}")
        pads = ints(a['pads_begin']) + ints(a['pads_end'])
        nodes.append(H.make_node('Conv', [getin(l, 0), wn], [o], strides=ints(a['strides']), pads=pads, dilations=ints(a['dilations']), group=g)); continue
    if ty == 'ReLU': nodes.append(H.make_node('Relu', [getin(l, 0)], [o])); continue
    if ty == 'Sigmoid': nodes.append(H.make_node('Sigmoid', [getin(l, 0)], [o])); continue
    if ty == 'PReLU':
        s = consts[edges[(i, '1')][0]]; s = s.reshape(-1)
        nodes.append(H.make_node('PRelu', [getin(l, 0), cinit(None, s.reshape(-1, 1, 1) if s.size > 1 else s, f"pr{i}")], [o])); continue
    if ty in ('MaxPool', 'AvgPool'):
        kw = dict(kernel_shape=ints(a['kernel']), strides=ints(a['strides']), pads=ints(a['pads_begin']) + ints(a['pads_end']))
        if ty == 'AvgPool': kw['count_include_pad'] = 0 if a.get('exclude-pad') == 'true' else 1
        nodes.append(H.make_node('MaxPool' if ty == 'MaxPool' else 'AveragePool', [getin(l, 0)], [o], **kw)); continue
    if ty == 'ReduceMean':
        ax = consts[edges[(i, '1')][0]].astype(np.int64).reshape(-1)
        nodes.append(H.make_node('ReduceMean', [getin(l, 0), cinit(None, ax, f"ax{i}")], [o], keepdims=1 if a.get('keep_dims') == 'true' else 0)); continue
    if ty == 'MVN':
        ax = consts[edges[(i, '1')][0]].astype(np.int64).reshape(-1); eps = float(a['eps']); x = getin(l, 0); axn = cinit(None, ax, f"ax{i}")
        m, c, sq, v, ve, sd = [f"mvn{i}_{s}" for s in ("m", "c", "sq", "v", "ve", "sd")]
        nodes += [H.make_node('ReduceMean', [x, axn], [m], keepdims=1), H.make_node('Sub', [x, m], [c]), H.make_node('Mul', [c, c], [sq]),
                  H.make_node('ReduceMean', [sq, axn], [v], keepdims=1), H.make_node('Add', [v, cinit(None, np.array(eps, np.float32), f"eps{i}")], [ve]),
                  H.make_node('Sqrt', [ve], [sd]), H.make_node('Div', [c, sd], [o])]; continue
    if ty == 'Reshape':
        nodes.append(H.make_node('Reshape', [getin(l, 0), getin(l, 1)], [o])); continue   # special_zero true == ONNX allowzero=0
    if ty == 'ShapeOf': nodes.append(H.make_node('Shape', [getin(l, 0)], [o])); continue
    if ty == 'Gather':
        ax = int(consts[edges[(i, '2')][0]].reshape(-1)[0]); nodes.append(H.make_node('Gather', [getin(l, 0), getin(l, 1)], [o], axis=ax)); continue
    if ty == 'Concat': nodes.append(H.make_node('Concat', [getin(l, k) for k in range(len(l.find('input')))], [o], axis=int(a['axis']))); continue
    if ty == 'MatMul':
        b = getin(l, 1); tb = a.get('transpose_b') == 'true'
        bn = f"mmt{i}"
        if tb: nodes.append(H.make_node('Transpose', [b], [bn], perm=[1, 0]))
        nodes.append(H.make_node('MatMul', [getin(l, 0), bn if tb else b], [o])); continue
    raise SystemExit("unsupported " + ty)
og = H.make_tensor_value_info(outputs[0], TP.FLOAT, [1, 256])
g = H.make_graph(nodes, "reid0288", inputs, [og], inits)
# rename IO
m = H.make_model(g, opset_imports=[H.make_opsetid("", 18)]); m.ir_version = 8
for n in m.graph.node:
    n.input[:] = ["data" if x == inp_name else ("embedding" if x == outputs[0] else x) for x in n.input]
    n.output[:] = ["embedding" if x == outputs[0] else x for x in n.output]
m.graph.input[0].name = "data"; m.graph.output[0].name = "embedding"
onnx.checker.check_model(m); onnx.save(m, out); print("saved", out)
