# Depth-street vehicle model licences

The GLB files in `vehicles/` are from **Kenney's Car Kit 3.1**
(https://kenney.nl/assets/car-kit), downloaded via OpenGameArt
(https://opengameart.org/content/car-kit).

| File | Kenney source | Role in the replay |
|---|---|---|
| `vehicles/sedan.glb` | `sedan.glb` | car (default) |
| `vehicles/hatchback.glb` | `hatchback-sports.glb` | short / hatch car |
| `vehicles/suv.glb` | `suv.glb` | taller car / SUV |
| `vehicles/pickup.glb` | `truck-flat.glb` | pickup |
| `vehicles/van.glb` | `van.glb` | van |
| `vehicles/bus.glb` | `delivery.glb` | bus / large boxy van |
| `vehicles/truck.glb` | `truck.glb` | truck |
| `vehicles/cybercab.glb` | `race-future.glb` | Cybercab / futuristic stand-in |

**Licence:** Creative Commons Zero (CC0 1.0 Universal) —
https://creativecommons.org/publicdomain/zero/1.0/

You may use these for any purpose, including commercial. Attribution to
Kenney (www.kenney.nl) is appreciated but not required.

Files were quantized with gltf-transform (mesh quantization + dedup) for a
smaller download; geometry and the palette texture are unchanged in meaning.
Motorcycle / bicycle proxies stay procedural in `viewer.html` (no Kenney bike
in this kit).

Copied into each replay page's `models/` folder by `vehicles.py --export` /
`build.py --vehicles proxy`. Never commit real drive footage here.
