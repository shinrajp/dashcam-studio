"""fill_sd.py — fill the road no camera ever saw (ground.py's holes) with Stable Diffusion inpainting. ESTIMATED pixels.

The diffusion model paints what such a road usually looks like there, not what was there: the result is for the 3D replay's
look only (shown tinted as estimated, switchable), never for detection, tracking or exports.

    python fill_sd.py <work folder> --model <stable-diffusion-inpainting folder> [--steps 25] [--seed 1]

Needs torch + diffusers (a separate environment is fine). The picture is cut into 512-px tiles (overlapping by 128); only tiles
with holes are run, in order, each seeing the previous tiles' fill. Everything the cameras never saw inside a tile is masked
(so the model doesn't take black for road), but only the holes near the car's path are kept.
Writes <work>/ground/fill.png (RGBA: seen road + filled holes) and est.png (white = estimated).
"""
import argparse, json, os, time
import numpy as np
from PIL import Image

PROMPT = "aerial top-down photo of a city street, asphalt road surface, kerb, pavement, realistic, sharp, daylight"
NEG = "car, vehicle, truck, person, text, watermark, logo, blurry, cartoon, painting"


def _ring(mask, r):
    """pixels within r px of mask (box dilation, numpy only)"""
    m = mask.copy()
    for _ in range(r):
        n = m.copy(); n[1:] |= m[:-1]; n[:-1] |= m[1:]; n[:, 1:] |= m[:, :-1]; n[:, :-1] |= m[:, 1:]; m = n
    return m & ~mask


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument("work"); ap.add_argument("--model", required=True)
    ap.add_argument("--steps", type=int, default=25); ap.add_argument("--seed", type=int, default=1); ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--strength", type=float, default=0.45, help="how much the model may change the plain-road start (1 = free hand)")
    a = ap.parse_args(argv)
    import torch
    from diffusers import StableDiffusionInpaintPipeline
    g = os.path.join(a.work, "ground")
    real = np.array(Image.open(os.path.join(g, "real.png")).convert("RGBA"))
    hole = np.array(Image.open(os.path.join(g, "hole.png")).convert("L")) > 127
    rgb = real[:, :, :3].copy(); seen = rgb.any(2) & ~hole        # every pixel any camera saw (also beyond the shown strip)
    H, W = hole.shape; T = a.tile
    if not hole.any():
        print("nothing to fill"); est = np.zeros((H, W), bool)
    else:
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        pipe = StableDiffusionInpaintPipeline.from_pretrained(a.model, torch_dtype=torch.float16 if dev == "mps" else torch.float32,
                                                              variant="fp16", safety_checker=None, requires_safety_checker=False).to(dev)
        pipe.set_progress_bar_config(disable=True)
        pad = lambda n: max(0, T - n)
        img = np.pad(rgb, ((0, pad(H)), (0, pad(W)), (0, 0))); known = np.pad(seen, ((0, pad(H)), (0, pad(W))))
        want = np.pad(hole, ((0, pad(H)), (0, pad(W)))); est = np.zeros_like(want)
        HH, WW = want.shape
        ys = sorted(set(list(range(0, HH - T + 1, T - 128)) + [HH - T])); xs = sorted(set(list(range(0, WW - T + 1, T - 128)) + [WW - T]))
        gen = torch.Generator("cpu").manual_seed(a.seed); n = 0; t0 = time.time()
        for y in ys:
            for x in xs:
                w = want[y:y + T, x:x + T] & ~est[y:y + T, x:x + T]
                if w.sum() < 20: continue
                m = ~known[y:y + T, x:x + T] & ~est[y:y + T, x:x + T]
                # start from plain road: the median colour of what was seen round the holes (not the parked cars' dark smears),
                # so the model only adds road texture (strength 0.45: at 0.6 and 1 it still drew a car-like shape on 10-19) instead of continuing whatever stands next to the hole
                tile = img[y:y + T, x:x + T].copy(); ring = _ring(w, 24) & ~m
                lum = tile[ring].mean(1) if ring.any() else np.zeros(0)
                base = np.median(tile[ring][lum >= np.quantile(lum, 0.4)], 0) if ring.sum() > 50 else np.median(tile[~m], 0)
                tile[m] = base.astype(np.uint8)
                out = pipe(prompt=PROMPT, negative_prompt=NEG, image=Image.fromarray(tile), strength=a.strength,
                           mask_image=Image.fromarray((m * 255).astype(np.uint8)), height=T, width=T,
                           num_inference_steps=a.steps, guidance_scale=7.0, generator=gen).images[0]
                o = np.array(out)
                img[y:y + T, x:x + T][w] = o[w]; est[y:y + T, x:x + T] |= w; n += 1
                print(f"  tile {n} at ({x}, {y}): {int(w.sum())} px filled ({time.time() - t0:.0f} s)", flush=True)
        rgb = img[:H, :W]; est = est[:H, :W]
    alpha = (real[:, :, 3] > 0) | est
    Image.fromarray(np.dstack([rgb, alpha.astype(np.uint8) * 255])).save(os.path.join(g, "fill.png"))
    Image.fromarray((est * 255).astype(np.uint8)).save(os.path.join(g, "est.png"))
    meta = json.load(open(os.path.join(g, "meta.json"))); res = meta["res"]
    meta.update(estimated_m2=float(est.sum() * res ** 2), fill_model="Stable Diffusion 1.5 inpainting", fill_prompt=PROMPT)
    json.dump(meta, open(os.path.join(g, "meta.json"), "w"), indent=1)
    print(f"estimated (diffusion) {meta['estimated_m2']:.0f} m² of road; the rest of the strip is real footage")


if __name__ == "__main__":
    main()
