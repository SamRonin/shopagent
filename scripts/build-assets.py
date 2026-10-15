#!/usr/bin/env python3
"""
build-assets.py — generate the ShopAgent icon set and the repo preview art.

Everything is drawn once at 1024px (gradients are computed on a small
buffer and upscaled, so the script finishes in ~1s instead of minutes)
and then downscaled with LANCZOS for each target size.

No text is rasterised into the icon, which avoids Arabic-script shaping
problems entirely — the mark is pure vector geometry.

Usage:  python3 scripts/build-assets.py
Output: icons/icon{16,32,48,128}.png, docs/logo-512.png, docs/social-preview.png
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

MASTER = 1024
OUT_ICONS = "icons"
OUT_DOCS = "docs"

TEAL = (13, 148, 136)   # #0d9488
SKY = (2, 132, 199)     # #0284c7
DEEP = (8, 47, 73)
AMBER = (251, 191, 36)  # #fbbf24
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


# ----------------------------------------------------------------------
# Background
# ----------------------------------------------------------------------

def gradient_bg(size: int, radius: int) -> Image.Image:
    """Diagonal teal -> sky gradient with a soft deep corner, masked to a squircle."""
    small = 96
    g = Image.new("RGBA", (small, small))
    gp = g.load()
    for y in range(small):
        for x in range(small):
            t = (x + y) / (2 * (small - 1))
            gp[x, y] = lerp(TEAL, SKY, t) + (255,)
    img = g.resize((size, size), Image.BICUBIC)

    # depth vignette toward the bottom-left
    sh = Image.new("L", (small, small), 0)
    sp = sh.load()
    for y in range(small):
        for x in range(small):
            d = math.hypot(x, small - y) / (small * 1.42)
            sp[x, y] = int(max(0.0, 0.66 - d) * 255)
    sh = sh.resize((size, size), Image.BICUBIC)
    shade = Image.new("RGBA", (size, size), DEEP + (0,))
    shade.putalpha(sh.point(lambda a: int(a * 0.42)))
    img = Image.alpha_composite(img, shade)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


# ----------------------------------------------------------------------
# Glyph
# ----------------------------------------------------------------------

def draw_bag(d: ImageDraw.ImageDraw, S: int, dy: int = 0) -> None:
    """White shopping bag with a teal 'smart spark' punched into its face."""
    cx = S / 2
    body_w = S * 0.46
    body_h = S * 0.38
    y0 = S * 0.435 + dy
    y1 = y0 + body_h
    x0, x1 = cx - body_w / 2, cx + body_w / 2

    d.rounded_rectangle([x0, y0, x1, y1], radius=S * 0.055, fill=WHITE)

    # handle
    hw = body_w * 0.50
    hh = S * 0.20
    stroke = max(2, int(S * 0.040))
    hb = [cx - hw / 2, y0 - hh * 0.86, cx + hw / 2, y0 + hh * 0.86]
    d.arc(hb, start=180, end=360, fill=WHITE, width=stroke)
    d.rectangle([hb[0], y0 - stroke / 2, hb[0] + stroke, y0 + S * 0.035], fill=WHITE)
    d.rectangle([hb[2] - stroke, y0 - stroke / 2, hb[2], y0 + S * 0.035], fill=WHITE)

    # spark inside the bag
    scx, scy = cx, y0 + body_h * 0.52
    arm = S * 0.088
    pts = [
        (scx + (arm if i % 2 == 0 else arm * 0.36) * math.cos(math.pi / 4 * i - math.pi / 2),
         scy + (arm if i % 2 == 0 else arm * 0.36) * math.sin(math.pi / 4 * i - math.pi / 2))
        for i in range(8)
    ]
    d.polygon(pts, fill=lerp(TEAL, SKY, 0.55))


def draw_corner_spark(d: ImageDraw.ImageDraw, S: int) -> None:
    """Amber four-point star, top-right: the AI accent."""
    cx, cy = S * 0.795, S * 0.205
    arm = S * 0.115
    pts = [
        (cx + (arm if i % 2 == 0 else arm * 0.30) * math.cos(math.pi / 4 * i - math.pi / 2),
         cy + (arm if i % 2 == 0 else arm * 0.30) * math.sin(math.pi / 4 * i - math.pi / 2))
        for i in range(8)
    ]
    d.polygon(pts, fill=AMBER)


def build_master(size: int = MASTER) -> Image.Image:
    radius = int(size * 0.225)          # Chrome squircle-ish
    canvas = gradient_bg(size, radius)

    # glyph shadow
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_bag(ImageDraw.Draw(shadow), size, dy=int(size * 0.014))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))
    shadow.putalpha(shadow.getchannel("A").point(lambda a: int(a * 0.38)))
    canvas = Image.alpha_composite(canvas, shadow)

    # glyph + accent
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    draw_bag(d, size)
    draw_corner_spark(d, size)
    canvas = Image.alpha_composite(canvas, layer)

    # 1px inner rim light
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).rounded_rectangle(
        [1, 1, size - 2, size - 2], radius=radius, outline=(255, 255, 255, 58), width=max(2, size // 190)
    )
    return Image.alpha_composite(canvas, gloss)


# ----------------------------------------------------------------------
# Social preview
# ----------------------------------------------------------------------

def build_social(master: Image.Image) -> None:
    W, H = 1280, 640
    base = Image.new("RGB", (W, H), (9, 14, 26))
    d = ImageDraw.Draw(base, "RGBA")
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp((9, 15, 28), (10, 30, 44), y / H))

    img = base.convert("RGBA")
    for cx, cy, rad, col in [
        (1130, 70, 300, (13, 148, 136, 95)),
        (110, 570, 265, (2, 132, 199, 85)),
        (720, 640, 210, (20, 184, 166, 48)),
    ]:
        blob = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(blob).ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=col)
        img = Image.alpha_composite(img, blob.filter(ImageFilter.GaussianBlur(95)))

    d = ImageDraw.Draw(img, "RGBA")
    for gx in range(0, W, 46):
        for gy in range(0, H, 46):
            d.ellipse([gx, gy, gx + 2, gy + 2], fill=(148, 163, 184, 24))

    def font(path, size, fallback_bold=False):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            return ImageFont.load_default()

    FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    f_title, f_sub, f_pill = font(FB, 106), font(FR, 38), font(FB, 26)

    ic = master.resize((152, 152), Image.LANCZOS)
    img.paste(ic, (96, 92), ic)

    d.text((284, 108), "ShopAgent", font=f_title, fill=(241, 248, 255))
    d.text((288, 246), "AI shopping copilot for Digikala & Basalam", font=f_sub, fill=(167, 197, 222))

    x, y = 96, 424
    for label, fg, bgc, oc in [
        ("100% free", (94, 234, 212), (20, 184, 166, 34), (45, 212, 191, 150)),
        ("local Ollama", (125, 211, 252), (2, 132, 199, 32), (56, 189, 248, 150)),
        ("Manifest V3", (253, 224, 71), (202, 138, 4, 28), (250, 204, 21, 140)),
        ("zero build step", (216, 180, 254), (126, 34, 206, 30), (167, 139, 250, 145)),
    ]:
        w = d.textlength(label, font=f_pill)
        pad = 24
        d.rounded_rectangle([x, y, x + w + pad * 2, y + 58], radius=29, fill=bgc, outline=oc, width=2)
        d.text((x + pad, y + 14), label, font=f_pill, fill=fg)
        x += w + pad * 2 + 14

    f_foot = font(FR, 30)
    d.text((98, 546), "Type in plain Persian  ·  your tab searches, scrolls & compares live",
           font=f_foot, fill=(126, 156, 186))

    img.convert("RGB").save(os.path.join(OUT_DOCS, "social-preview.png"), optimize=True)
    print("wrote", os.path.join(OUT_DOCS, "social-preview.png"))


def main() -> None:
    os.makedirs(OUT_ICONS, exist_ok=True)
    os.makedirs(OUT_DOCS, exist_ok=True)

    master = build_master(MASTER)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_ICONS, f"icon{size}.png")
        master.resize((size, size), Image.LANCZOS).save(path, optimize=True)
        print("wrote", path)

    logo = os.path.join(OUT_DOCS, "logo-512.png")
    master.resize((512, 512), Image.LANCZOS).save(logo, optimize=True)
    print("wrote", logo)

    build_social(master)


if __name__ == "__main__":
    main()
