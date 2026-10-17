#!/usr/bin/env python3
"""make-plate-fixtures.py — synthetic California-style plates (and a street sign) pasted onto the
synthetic mock stills, for test/phase6-plates.js. Every plate number here is made up for testing.
No real footage, no real plates. Output: test/fixtures/plate-*.png + plates.json (ground truth).
Usage: python3 tools/make-plate-fixtures.py"""
import json, os, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STILLS = os.path.join(ROOT, "tools", "mock-stills")
OUT = os.path.join(ROOT, "test", "fixtures")
SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
random.seed(6)

def plate_img(text, w=600):
    """A California-style plate: white, red 'California' script, dark-blue 1ABC234 characters, 2:1."""
    h = w // 2
    im = Image.new("RGB", (w, h), (246, 246, 242))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([3, 3, w - 4, h - 4], radius=w // 30, outline=(40, 40, 60), width=max(2, w // 120))
    f = ImageFont.truetype(SERIF, int(h * 0.20))
    tw = d.textlength("California", font=f)
    d.text(((w - tw) / 2, h * 0.04), "California", fill=(190, 30, 40), font=f)
    # characters: tall and narrow like the real plate font (render wide, squeeze horizontally)
    g = ImageFont.truetype(SANS, int(h * 0.62))
    layer = Image.new("L", (int(w * 1.6), h), 0)
    ld = ImageDraw.Draw(layer)
    tw = ld.textlength(text, font=g)
    ld.text(((layer.width - tw) / 2, h * 0.24), text, fill=255, font=g)
    bbox = layer.getbbox()
    layer = layer.crop((bbox[0], 0, bbox[2], h)).resize((int(w * 0.86), h))
    ink = Image.new("RGB", layer.size, (20, 30, 90))
    im.paste(ink, ((w - layer.width) // 2, 0), layer)
    sm = ImageFont.truetype(SANS, int(h * 0.09))
    d.text((w * 0.08, h * 0.86), "DMV.CA.GOV", fill=(20, 30, 90), font=sm)
    return im

def sign_img(text, w=420):
    h = int(w * 0.24)
    im = Image.new("RGB", (w, h), (16, 110, 60))
    d = ImageDraw.Draw(im)
    d.rectangle([4, 4, w - 5, h - 5], outline=(240, 240, 240), width=3)
    f = ImageFont.truetype(SANS, int(h * 0.62))
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, h * 0.14), text, fill=(245, 245, 245), font=f)
    return im

def place(base, plate, cx, cy, pw, blur=0.6):
    p = plate.resize((pw, pw // 2), Image.LANCZOS).filter(ImageFilter.GaussianBlur(blur))
    x, y = int(cx - pw / 2), int(cy - pw / 4)
    base.paste(p, (x, y))
    W, H = base.size
    return {"x": x / W, "y": y / H, "w": pw / W, "h": (pw // 2) / H}

def zoomed(img, cx, cy, z):
    """Crop around (cx,cy) and scale back to the full size: the car looks z× closer."""
    W, H = img.size
    w, h = W / z, H / z
    x0 = min(max(0, cx - w / 2), W - w); y0 = min(max(0, cy - h / 2), H - h)
    return img.crop((int(x0), int(y0), int(x0 + w), int(y0 + h))).resize((W, H), Image.BICUBIC), (x0, y0)

def main():
    os.makedirs(OUT, exist_ok=True)
    truth = []
    front = Image.open(os.path.join(STILLS, "front.jpg")).convert("RGB")
    # red car rear, plate centre in the 1280×720 still ≈ (651, 441), car ≈ 140 px wide
    plates = ["7TST123", "8DEM042", "4QZX907", "6PLT518"]
    for i, (z, text) in enumerate(zip([1.6, 2.2, 3.0, 4.0], plates)):
        img, (x0, y0) = zoomed(front, 651, 430, z)
        cx, cy = (651 - x0) * z, (441 - y0) * z
        pw = int(23 * z)
        box = place(img, plate_img(text), cx, cy, pw, blur=0.5 + 0.15 * z)
        name = "plate-front-%dpx.jpg" % pw
        img.save(os.path.join(OUT, name), quality=86)
        truth.append({"file": name, "cam": "front", "text": text, "box": box, "plateWidthPx": pw})
    # parked silver car (left pillar still), front plate
    lp = Image.open(os.path.join(STILLS, "left_pillar_plate.jpg")).convert("RGB")
    img, (x0, y0) = zoomed(lp, 360, 340, 2.0)
    box = place(img, plate_img("5SMP260"), (329 - x0) * 2, (398 - y0) * 2, 52, blur=0.8)
    img.save(os.path.join(OUT, "plate-pillar-52px.jpg"), quality=86)
    truth.append({"file": "plate-pillar-52px.jpg", "cam": "left_pillar", "text": "5SMP260", "box": box, "plateWidthPx": 52})
    # street-name sign over the road, for street text search
    img = front.copy()
    sbox = place(img, sign_img("Palm Ave"), 820, 170, 190, blur=0.4)
    img.save(os.path.join(OUT, "street-sign-palm-ave.jpg"), quality=86)
    truth.append({"file": "street-sign-palm-ave.jpg", "cam": "front", "street": "Palm Ave", "box": sbox})
    with open(os.path.join(OUT, "plates.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print("\n".join(t["file"] + "  " + (t.get("text") or t.get("street")) for t in truth))

if __name__ == "__main__":
    main()
