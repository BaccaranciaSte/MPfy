# Generates the MPfy adaptive launcher icon layers from brand/mpfy-icon-source.png.
#
#   python gen_icons.py <mpfy-icon-source.png> <app/src/main/res>
#
# Layers (108 dp canvas each, five densities):
#   ic_launcher_background  the logo's dark grainy texture extended to full bleed: the square's
#                           interior is cropped (no rounded corners left) and the area under the
#                           grey circle is filled by mirroring the texture just outside it
#   ic_launcher_foreground  the grey circle with its waveform bars, as big against the tile the
#                           launcher shows (72 dp) as it is against the logo's square: two thirds
#   ic_launcher_monochrome  the same circle as an alpha mask with the bars cut out (themed icons)
# At mdpi the launcher icon is shown at 48 px, so the foreground and the monochrome layer use the
# simplified mark there: fewer, thicker bars, drawn rather than scaled down.
import math
import os
import sys
from PIL import Image, ImageDraw

SRC = sys.argv[1]
RES = sys.argv[2]

# Geometry of the source, measured on 2026-11-17 (see .logs/v2-android-icon-probe.log).
CX = CY = 255.5          # circle center
R_CIRCLE = 137.5         # circle radius (light pixels 118..392)
CROP = (72, 72, 440, 440)  # inside the rounded square (50..461, corner radius about 55)
GREY = (212, 212, 212)
BAR = (90, 90, 90)

DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
CANVAS_DP = 108
SAFE_DP = 66
VISIBLE_DP = 72          # what the launcher shows of the 108 dp canvas
SQUARE = 411.0           # the logo's rounded square in the source (50..461)
# The circle keeps the logo's proportion: in the source it is 2 x R_CIRCLE of the square.
CIRCLE_DP = VISIBLE_DP * (2 * R_CIRCLE) / SQUARE


def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


PATCH = 80  # the crop's top-left PATCH x PATCH square lies wholly outside the fill radius


def tri(v, n):
    """Triangle wave: 0..n-1 then back down, so reflected tiles meet without a seam."""
    m = v % (2 * n)
    return m if m < n else 2 * n - 1 - m


def background_master(src):
    """The cropped square interior with the circle area filled by radial mirroring."""
    rgb = src.convert("RGB")
    px = rgb.load()
    x0, y0, x1, y1 = CROP
    size = x1 - x0
    out = Image.new("RGB", (size, size))
    op = out.load()
    ri = R_CIRCLE + 4.0              # fill radius: past the circle's anti-aliased edge
    band = min(CX - x0, CY - y0) - ri - 3.0  # ring of clean texture available outside it
    for y in range(size):
        for x in range(size):
            sx, sy = x0 + x + 0.5, y0 + y + 0.5
            dx, dy = sx - CX, sy - CY
            r = math.hypot(dx, dy)
            if r >= ri:
                op[x, y] = px[x0 + x, y0 + y]
                continue
            depth = ri - r
            if depth < band:
                # The ring a launcher may show around the circle: mirror the texture across the
                # fill radius, so it continues without a seam.
                rr = ri + depth
                ux, uy = dx / r, dy / r
                tx = min(max(int(CX + ux * rr), x0), x1 - 1)
                ty = min(max(int(CY + uy * rr), y0), y1 - 1)
            else:
                # Deep under the circle: a radial mirror would converge into streaks here, so tile
                # the clean corner patch of the crop instead, reflected so the tiles meet.
                tx = x0 + tri(x, PATCH)
                ty = y0 + tri(y, PATCH)
            op[x, y] = px[tx, ty]
    return out


def circle_master(src, ss=4):
    """RGBA crop of the grey circle with its bars, transparent outside an anti-aliased disk."""
    r = R_CIRCLE - 0.75  # just inside, so no dark fringe from the edge pixels
    left = int(math.floor(CX - R_CIRCLE)) - 1
    top = int(math.floor(CY - R_CIRCLE)) - 1
    size = int(math.ceil(2 * R_CIRCLE)) + 3
    crop = src.convert("RGB").crop((left, top, left + size, top + size))
    mask = Image.new("L", (size * ss, size * ss), 0)
    d = ImageDraw.Draw(mask)
    c = ((CX - left) * ss, (CY - top) * ss)
    d.ellipse((c[0] - r * ss, c[1] - r * ss, c[0] + r * ss, c[1] + r * ss), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = crop.convert("RGBA")
    out.putalpha(mask)
    # Recenter on the exact circle center (the crop starts on whole pixels).
    return out, (CX - left, CY - top), r


def mono_master(circle_rgba):
    """White disk whose alpha drops where the bars are (bars become holes)."""
    w, h = circle_rgba.size
    src = circle_rgba.load()
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            t = (luma((r, g, b)) - BAR[0]) / float(GREY[0] - BAR[0])
            t = min(max(t, 0.0), 1.0)
            op[x, y] = (255, 255, 255, int(round(a * t)))
    return out


def place(layer, center, radius, px_canvas):
    """Scales a circle layer to the logo's proportion and centers it on the canvas."""
    target_d = CIRCLE_DP * px_canvas / CANVAS_DP
    scale = target_d / (2 * radius)
    w, h = layer.size
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    scaled = layer.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (px_canvas, px_canvas), (0, 0, 0, 0))
    ox = int(round(px_canvas / 2.0 - center[0] * scale))
    oy = int(round(px_canvas / 2.0 - center[1] * scale))
    canvas.alpha_composite(scaled, (ox, oy))
    return canvas


def simplified(px_canvas, mono, ss=8):
    """The small-size mark: grey disk with five thick rounded bars (or the monochrome mask)."""
    n = px_canvas * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    diam = CIRCLE_DP * n / CANVAS_DP
    c = n / 2.0
    disk = (255, 255, 255, 255) if mono else GREY + (255,)
    d.ellipse((c - diam / 2, c - diam / 2, c + diam / 2, c + diam / 2), fill=disk)
    heights = [0.26, 0.50, 0.64, 0.42, 0.24]  # of the diameter: a short waveform
    bw = diam * 0.085
    gap = diam * 0.065
    total = len(heights) * bw + (len(heights) - 1) * gap
    x = c - total / 2
    hole = (0, 0, 0, 0)
    for hf in heights:
        hh = diam * hf
        box = (x, c - hh / 2, x + bw, c + hh / 2)
        if mono:
            d.rounded_rectangle(box, radius=bw / 2, fill=hole)
        else:
            d.rounded_rectangle(box, radius=bw / 2, fill=BAR + (255,))
        x += bw + gap
    return img.resize((px_canvas, px_canvas), Image.LANCZOS)


def main():
    src = Image.open(SRC).convert("RGBA")
    bg = background_master(src)
    circ, center, radius = circle_master(src)
    mono = mono_master(circ)
    for name, f in DENSITIES.items():
        px_canvas = int(round(CANVAS_DP * f))
        folder = os.path.join(RES, "mipmap-" + name)
        os.makedirs(folder, exist_ok=True)
        bg.resize((px_canvas, px_canvas), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_background.png"), optimize=True)
        if name == "mdpi":
            fg = simplified(px_canvas, mono=False)
            mn = simplified(px_canvas, mono=True)
        else:
            fg = place(circ, center, radius, px_canvas)
            mn = place(mono, center, radius, px_canvas)
        fg.save(os.path.join(folder, "ic_launcher_foreground.png"), optimize=True)
        mn.save(os.path.join(folder, "ic_launcher_monochrome.png"), optimize=True)
        print(name, px_canvas)
    # A flattened preview (full bleed, then a circle mask as a launcher would) for checking.
    prev = bg.resize((432, 432), Image.LANCZOS).convert("RGBA")
    prev.alpha_composite(place(circ, center, radius, 432))
    prev.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview-xxxhdpi.png"))
    small = bg.resize((108, 108), Image.LANCZOS).convert("RGBA")
    small.alpha_composite(simplified(108, mono=False))
    small.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview-mdpi.png"))


main()
