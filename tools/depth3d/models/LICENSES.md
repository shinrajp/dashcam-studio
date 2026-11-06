# Depth-street vehicle model licences

Realistic / game-ready glTF used by `--vehicles proxy`. Attribution is required
where the licence is CC BY. No Tesla trademarks; manufacturer marks on third-party
meshes are not endorsed — models are used as generic silhouettes.

## roadster.glb — sports coupe (Roadster-like)

| | |
|---|---|
| Source | Ferrari 458 Italia model by **vicent091036**, via [three.js examples](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/ferrari.glb) (`webgl_materials_car`) |
| Original | https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6 |
| Licence | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Notes | Kept Draco-compressed (~1.6 MB). Used as a **generic roadster / sports coupe** silhouette; paint is recolored at runtime. No affiliation with Ferrari S.p.A. |

## sedan.glb, hatchback.glb, suv.glb, pickup.glb, van.glb, bus.glb, truck.glb, cybercab.glb

| | |
|---|---|
| Source | **Free Low Poly Vehicles Pack** by **rgsdev** (OpenGameArt) |
| Download | https://opengameart.org/content/free-low-poly-vehicles-pack |
| Licence | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (see `vehicles/Rgsdev-License.txt`) |
| Notes | Converted FBX→glTF, quantized. `cybercab.glb` uses the pack’s Roadster mesh as a compact 2-seat stand-in (Khronos CarConcept was ~1–5 MB after simplify and exceeded the payload budget). Body paint / clearcoat / glass are applied in the viewer. |

## Environment reflections

The viewer uses three.js `RoomEnvironment` (procedural PMREM, MIT) for soft
reflections — no HDR file ships in the page.

## Previously (phase 2)

Kenney Car Kit CC0 models were replaced in phase 3 because they read as toys.
