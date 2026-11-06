# Depth-street vehicle model licences

Realistic / game-ready glTF used by `--vehicles proxy`. Attribution is required
where the licence is CC BY. No Tesla trademarks; manufacturer marks on third-party
meshes are not endorsed — models are used as generic silhouettes.

## roadster.glb — two-seat electric hypercar (generic)

| | |
|---|---|
| Source | **Own work** — procedural mesh from `models/make_roadster.py` |
| Licence | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Notes | Sleek low teardrop body, long glass canopy, short overhangs, full-width light bars, dark rear-corner thruster ports. Pearl-white default when sampled paint is light. ~9k tris, Draco. No manufacturer logos or names in the mesh. Generic “roadster” silhouette only. |

## sedan.glb, hatchback.glb, suv.glb, pickup.glb, van.glb, bus.glb, truck.glb, cybercab.glb

| | |
|---|---|
| Source | **Free Low Poly Vehicles Pack** by **rgsdev** (OpenGameArt) |
| Download | https://opengameart.org/content/free-low-poly-vehicles-pack |
| Licence | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (see `vehicles/Rgsdev-License.txt`) |
| Notes | Converted FBX→glTF, quantized. `cybercab.glb` uses the pack’s Roadster mesh as a compact 2-seat stand-in. Body paint / clearcoat / glass are applied in the viewer. |

## Environment reflections

The viewer uses three.js `RoomEnvironment` (procedural PMREM, MIT) for soft
reflections — no HDR file ships in the page.

## Previously

- Phase 3 used a CC BY Ferrari sports coupe via three.js examples; replaced in phase 4 with the CC0 own-work hypercar above (user request: Roadster-like teardrop, unbranded).
- Phase 2 Kenney Car Kit CC0 models were replaced earlier because they read as toys.
