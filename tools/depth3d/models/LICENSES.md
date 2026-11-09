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

## future/ — 2.5D concept cars (crossover, coupe)

| | |
|---|---|
| Source | AI-generated images (Grok Bot image tool) of two futuristic concept designs the project owner approved (v3 boards), regenerated with **red** tail / brake lights; background removed with rembg (isnet-general-use), cropped, WebP with alpha |
| Files | `crossover-{000,045,090,135,180}.webp`, `coupe-{000,045,090,135,180}.webp`, `futurecars.json` (views, design size, provenance) — 432 KB total |
| Provenance | 045 / 135 follow the approved front / rear three-quarter boards; **000, 090, 180 are generated extra views that were not in the approved boards** (front, side, rear are the image model's guess). Side-view tail glow recoloured to red in code. |
| Notes | The designs were edited from owner-supplied reference photos; those photos (and any drive footage) are **not** in the repository. No plates, no readable text; wheels carry small generic hub caps. These are pictures, **not 3D geometry**: the viewer shows the nearest view on a camera-facing plane (mirrored for the right flank) and falls back to the glTF for top-down views. |

## Environment reflections

The viewer uses three.js `RoomEnvironment` (procedural PMREM, MIT) for soft
reflections — no HDR file ships in the page.

## Previously

- Phase 4 shipped a simple procedural CC0 roadster (numpy); phase 5 replaced it with the Blender build above.
- Phase 3 used a CC BY Ferrari sports coupe via three.js examples; replaced in phase 4 with the CC0 own-work hypercar above (user request: Roadster-like teardrop, unbranded).
- Phase 2 Kenney Car Kit CC0 models were replaced earlier because they read as toys.
