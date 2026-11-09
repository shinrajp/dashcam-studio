# Depth-street vehicle model licences

Realistic / game-ready glTF used by `--vehicles proxy`. Attribution is required
where the licence is CC BY. No Tesla trademarks; manufacturer marks on third-party
meshes are not endorsed — models are used as generic silhouettes.

## roadster.glb — two-seat electric hypercar (generic)

| | |
|---|---|
| Source | **Own work** — built in Blender 4.2 by `models/make_roadster_blender.py` (`blender -b --factory-startup -P make_roadster_blender.py`) |
| Licence | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Notes | Lofted low body with haunches, wheel arches cut by boolean, real lathed tyres (rounded shoulders) on 10-spoke rims with brake discs, tinted teardrop canopy, full-width LED light bars, dark intake/diffuser/sills. Grounded (tyre contact at y = 0), nose +Z. 24,858 tris, Draco (~105 KB). Pearl white when sampled paint is light. No manufacturer names, logos or badges. |

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

- Phase 4 shipped a simple procedural CC0 roadster (numpy); phase 5 replaced it with the Blender build above.
- Phase 3 used a CC BY Ferrari sports coupe via three.js examples; replaced in phase 4 with the CC0 own-work hypercar above (user request: Roadster-like teardrop, unbranded).
- Phase 2 Kenney Car Kit CC0 models were replaced earlier because they read as toys.
