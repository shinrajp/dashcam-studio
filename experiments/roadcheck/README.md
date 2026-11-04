# Road-surface check (experiment, 2026-11-03): finding anything that isn't flat road

**Idea.** Between two frames of one camera, the car's move (telemetry) and the camera (`js/rig.js`) are known. If everything below the horizon were flat road, the earlier frame warped through the road plane would line up with the later one. What doesn't line up either sticks up from the road (a car, a person, a pole, a tyre) or moves, whatever kind of thing it is. That would make it a detector for objects YOLO doesn't know (debris, tyres, animals).

**What `roadcheck.py` does.**
- It compares each sampled frame with frames about 1.5 m of driving before and after, warped through the road plane, and keeps the smaller difference.
- It first estimates the car's pitch and roll on its suspension between the two frames (±0.8°), from the road itself.
- It learns each camera's view of its own car body from the footage, and leaves it out.
- Blobs of difference are compared with YOLO11s boxes at the same moment.

Usage: `python roadcheck.py <rig.json> <clips dir> <sei dir> <dets.json> <out dir> [--every 2] [--move 1.5]`.

## Results on the two real drives (every 2 s, all six cameras)

How many of the detector's vehicles and people standing on the road it marks, and how many extra blobs it makes:

| Camera | 10-19: found | extra blobs a frame | 10-07: found | extra blobs a frame |
|---|---|---|---|---|
| front | 6/69 (9 %) | 5.1 | 9/36 (25 %) | 0.9 |
| back | 5/31 (16 %) | 3.4 | 2/32 (6 %) | 1.3 |
| left pillar | 10/37 (27 %) | 5.3 | 9/19 (47 %) | 3.1 |
| right pillar | 11/16 (69 %) | 11.7 | 5/24 (21 %) | 2.9 |
| left repeater | 10/53 (19 %) | 2.1 | 3/23 (13 %) | 3.0 |
| right repeater | 9/24 (38 %) | 6.2 | 8/39 (21 %) | 1.0 |

The first version (0.8 m between frames, no pitch and roll, road only to 25 m) found 2–6 % on most cameras. Looking at 48 random extra blobs: most are plain road, kerbs and shadow edges; a few are real but uninteresting (planters, walls, poles).

## What it shows

**Where it works:** objects close beside the car (pillar cameras) and things moving relative to the car (a car right behind us, a car passing). Example pictures were removed from the public repository because they show the drives; `roadcheck.py` writes them again from the footage.

**Where it doesn't:**
- **Cameras looking along the direction of travel (front, rear, and the repeaters' far view).** Distant things barely shift between frames there, so standing up from the road makes almost no difference.
- **Parked cars further than about 10 m.**
- **Plain asphalt.** Compression and motion blur leave road texture and shadow edges that don't line up exactly.

**Verdict:** not good enough as a general "any object" detector on this footage. It finds too few cars and makes too many false finds. Not put into the app.

**What is still worth trying:**
- As a **confirmation cue** next to an object the user highlighted: "this really sticks up from the road / moves".
- Over **many frames** (an object that is off the road in five frames in a row, at the same place on the road), which would cut the false finds.
- The Gaussian Splatting experiment (separate branch), which builds the still scene from all frames at once instead of two.
