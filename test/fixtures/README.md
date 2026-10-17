`small-umbrella-{70,45,30}.png`: a frame from the synthetic sample footage (tools/make-photo-footage.py) with one umbrella pasted in, 70, 45 or 30 px wide, at the right-hand storefront side. The umbrella is cropped from "Les Parapluies de Viborg" (Wikimedia Commons, **public domain**). Used by test/phase5-worker.js to measure small-object recall with and without tiles.

`plate-front-{36,50,69,92}px.jpg`, `plate-pillar-52px.jpg`, `street-sign-palm-ave.jpg` + `plates.json` (ground truth): synthetic
California-style plates with **made-up numbers** (7TST123, 8DEM042, 4QZX907, 6PLT518, 5SMP260) and a "Palm Ave" street sign,
pasted onto the synthetic mock stills by `tools/make-plate-fixtures.py`. No real footage, no real plates. `tools/make-plate-footage.py`
builds a short synthetic TeslaCam event from the same parts for the end-to-end test (written to /tmp, not stored here).
