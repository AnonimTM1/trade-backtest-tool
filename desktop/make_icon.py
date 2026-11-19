"""Draws the app icon (candlesticks + rising trend arrow) -> desktop/icon.ico + icon.png.

Rendered at 1024 px and downscaled, so every size is antialiased. Run with
a Python that has Pillow:  python desktop/make_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parent

GREEN = (38, 166, 154, 255)
RED = (239, 83, 80, 255)
BLUE = (41, 98, 255, 255)
WHITE = (240, 243, 250, 255)


def vertical_gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    return img


def draw() -> Image.Image:
    # rounded-square tile with a subtle navy gradient
    bg = vertical_gradient(S, (30, 36, 54), (14, 17, 26))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=210, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # faint grid (drawn on its own layer: ImageDraw replaces pixels, it doesn't blend)
    grid = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for y in (300, 500, 700):
        gd.line([(120, y), (S - 120, y)], fill=(255, 255, 255, 26), width=6)
    img = Image.alpha_composite(img, grid)
    d = ImageDraw.Draw(img)

    # candles: (center x, wick top, body top, body bottom, wick bottom, colour)
    candles = [
        (250, 560, 610, 790, 850, RED),
        (430, 470, 520, 700, 760, GREEN),
        (610, 420, 470, 600, 680, RED),
        (790, 230, 290, 560, 640, GREEN),
    ]
    body_w = 120
    for cx, wt, bt, bb, wb, col in candles:
        d.rounded_rectangle([cx - 14, wt, cx + 14, wb], radius=14, fill=col)  # wick
        d.rounded_rectangle([cx - body_w // 2, bt, cx + body_w // 2, bb], radius=22, fill=col)  # body

    # rising trend line with arrowhead
    pts = [(150, 820), (430, 610), (600, 680), (860, 300)]
    d.line(pts, fill=WHITE, width=46, joint="curve")
    for p in pts[:-1]:
        d.ellipse([p[0] - 23, p[1] - 23, p[0] + 23, p[1] + 23], fill=WHITE)
    tip = (905, 230)
    d.polygon([tip, (770, 285), (880, 390)], fill=WHITE)
    return img


def main():
    big = draw()
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    big.save(OUT / "icon.ico", sizes=[(s, s) for s in sizes])
    print("wrote", OUT / "icon.ico", "and", OUT / "icon.png")


if __name__ == "__main__":
    main()
