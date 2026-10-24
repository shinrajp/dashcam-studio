#!/usr/bin/env python3
"""make-icons.py — draws the app icons from the same logo as the top bar (rounded camera outline, blue lens, red dot) on the
app's dark background. Output: icons/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180). Needs Pillow."""
from PIL import Image, ImageDraw
import os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons"); os.makedirs(out, exist_ok=True)
BG, FG, BLUE, RED = (18, 20, 25), (232, 234, 240), (62, 106, 225), (255, 90, 79)
def draw(size, scale):          # scale = how much of the canvas the 32-unit logo box fills (maskable keeps a safe zone)
    S = size * 4; im = Image.new("RGB", (S, S), BG); d = ImageDraw.Draw(im)
    u = S * scale / 32.0; ox = oy = (S - S * scale) / 2
    P = lambda x, y: (ox + x * u, oy + y * u)
    d.rounded_rectangle([*P(2, 6), *P(30, 26)], radius=5 * u, outline=FG, width=int(2.4 * u))
    d.ellipse([*P(16 - 5.2, 16 - 5.2), *P(16 + 5.2, 16 + 5.2)], outline=BLUE, width=int(2.4 * u))
    d.ellipse([*P(16 - 1.8, 16 - 1.8), *P(16 + 1.8, 16 + 1.8)], fill=BLUE)
    d.ellipse([*P(25 - 1.4, 10.5 - 1.4), *P(25 + 1.4, 10.5 + 1.4)], fill=RED)
    return im.resize((size, size), Image.LANCZOS)
draw(192, 0.78).save(os.path.join(out, "icon-192.png"))
draw(512, 0.78).save(os.path.join(out, "icon-512.png"))
draw(512, 0.56).save(os.path.join(out, "icon-maskable-512.png"))
draw(180, 0.78).save(os.path.join(out, "apple-touch-icon.png"))
print("icons written to", os.path.normpath(out))
