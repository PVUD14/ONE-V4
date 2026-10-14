"""
make_brand_assets.py - regenerates every ONE brand asset from the master logo.

Why this exists: the ONE logo arrives as a single 1254x1254 RGB PNG painted on a
dark textured ground, with no transparency. The web app, the pilot and the
Android app need transparent lockups, a light-surface rendition, a square "o"
mark for icons, favicons, adaptive-icon layers and a splash image. Doing that by
hand in an editor is not reproducible, so every derived file is produced here,
deterministically, from docs/design/brand/source/one-logo.png (a byte-for-byte
copy of Divakar's logo/one-logo.png, which is never modified).

Run from the repository root:

    python scripts/brand/make_brand_assets.py

Requires Pillow and numpy only.

Method, in short:
1. Model the dark ground. Mask everything that is clearly logo, then fill the
   masked area from the surrounding ground by normalised convolution at low
   resolution, and upsample. This follows the vignette and the lighter top.
2. Difference-key. A pixel's alpha is how far it rises above the modelled
   ground (max over channels), ramped between a noise floor and a solid level.
   The foreground colour is un-premultiplied against the ground so edges do not
   carry a dark fringe. Bevel shadows that are darker than the ground key out.
3. The glow around the blue ring is kept but softened (alpha raised to a power
   where the pixel is a blue haze rather than solid paint).
4. The o's recess (a dark cavity holding the glowing dot) is paint, not
   ground: it is found by flood-filling the outside and made solid, so the
   "eye" survives on white and on coloured bands.
5. The mark is separated from the "n" along the thin diagonal gap between the
   o's tip and the n's stem.
6. The light-surface rendition keeps every blue pixel and maps the brushed
   silver onto graphite, preserving its shading direction (highlights stay
   lighter), so the metal still reads as metal on white.
7. Icons, favicons, Android adaptive-icon layers, the splash icon and the web
   sign-in backdrop are composed from those pieces.

Deterministic: re-running it on the same master rewrites identical files.
"""
from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SOURCE = os.path.join(ROOT, 'docs', 'design', 'brand', 'source', 'one-logo.png')
WEB_PUBLIC = os.path.join(ROOT, 'apps', 'web', 'public')
WEB_ASSETS = os.path.join(WEB_PUBLIC, 'assets')
ANDROID_RES = os.path.join(ROOT, 'apps', 'android', 'app', 'src', 'main', 'res')
DESIGN_OUT = os.path.join(ROOT, 'docs', 'design', 'brand')

# Regions of the 1254x1254 master (x0, y0, x1, y1), found by inspection.
REGION_WORD = (140, 350, 1130, 850)     # "one" + "by ai8ht"
REGION_MARK = (140, 350, 548, 760)       # the "o" ring with its dot
# The master art carries the line PEOPLE | POTENTIAL | PROGRESS under the lockup. ONE's
# tagline is LEARN | PREPARE | BUILD | GROW (Divakar, 2026-10-01), so the tagline image is
# drawn, not cropped: Inter (the app's typeface, OFL, already shipped in the Android app),
# tracked capitals in the art's silver with its blue dividers.
TAGLINE_WORDS = ('LEARN', 'PREPARE', 'BUILD', 'GROW')
TAGLINE_FONT = os.path.join(ROOT, 'apps', 'android', 'app', 'src', 'main', 'res', 'font', 'inter_medium.ttf')
TAGLINE_SILVER = (204, 208, 214, 255)
TAGLINE_BLUE = (70, 132, 226, 255)

NOISE_FLOOR = 14.0   # ground grain rises about this far above the model
SOLID_LEVEL = 96.0   # at or above this rise a pixel is treated as solid paint
BRAND_GROUND = (11, 12, 15)  # #0B0C0F, the existing dark brand ground


def load_master() -> np.ndarray:
    return np.asarray(Image.open(SOURCE).convert('RGB')).astype(np.float32)


def _box_blur(arr: np.ndarray, radius: int) -> np.ndarray:
    """Separable box blur on a 2-D array (edge-padded)."""
    k = 2 * radius + 1
    pad = np.pad(arr, radius, mode='edge')
    c = np.cumsum(pad, axis=0)
    c = np.vstack([np.zeros((1, c.shape[1]), c.dtype), c])
    v = (c[k:] - c[:-k]) / k
    c = np.cumsum(v, axis=1)
    c = np.hstack([np.zeros((c.shape[0], 1), c.dtype), c])
    return (c[:, k:] - c[:, :-k]) / k


def model_ground(img: np.ndarray) -> np.ndarray:
    """Estimate the textured dark ground everywhere, including under the logo."""
    peak = img.max(axis=2)
    blueish = img[..., 2] - img[..., 0]
    logo = (peak > 40) | (blueish > 22)
    scale = 8
    h, w = peak.shape
    hs, ws = h // scale, w // scale
    small_mask = Image.fromarray((logo * 255).astype(np.uint8)).resize((ws, hs), Image.BILINEAR)
    small_mask = np.asarray(small_mask.filter(ImageFilter.MaxFilter(7))).astype(np.float32) / 255.0
    keep = (small_mask < 0.02).astype(np.float32)
    out = np.zeros_like(img)
    for ch in range(3):
        small = np.asarray(Image.fromarray(img[..., ch].astype(np.uint8)).resize((ws, hs), Image.BOX)).astype(np.float32)
        num = _box_blur(small * keep, 9)
        den = _box_blur(keep, 9)
        filled = np.where(keep > 0, small, num / np.maximum(den, 1e-3))
        filled = _box_blur(filled, 2)
        out[..., ch] = np.asarray(Image.fromarray(filled).resize((w, h), Image.BICUBIC))
    return out


def key_out(img: np.ndarray, ground: np.ndarray) -> np.ndarray:
    """Return RGBA float array (0..255 colour, 0..1 alpha)."""
    rise = np.clip(img - ground, 0, None).max(axis=2)
    alpha = np.clip((rise - NOISE_FLOOR) / (SOLID_LEVEL - NOISE_FLOOR), 0.0, 1.0)
    # Soften the blue haze: strongly blue, not bright pixels with partial alpha.
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    haze = (b - r > 40) & (img.max(axis=2) < 150) & (alpha < 1.0)
    alpha = np.where(haze, alpha ** 1.6, alpha)
    safe = np.maximum(alpha, 1e-3)[..., None]
    fg = np.clip(ground + (img - ground) / safe, 0, 255)
    fg = np.where(alpha[..., None] > 0, fg, 0)
    return np.dstack([fg, alpha])


def fill_cavity(keyed: np.ndarray, img: np.ndarray) -> np.ndarray:
    """The "o" is an eye: a dark recessed cavity holding the glowing dot.
    Keying treats the cavity as ground, which leaves a hole (and a blue haze)
    on light surfaces. Flood-fill the outside from the o's box corners; the
    low-alpha pixels the fill cannot reach are the cavity, made solid with the
    master's own pixels."""
    x0, y0, x1, y1 = REGION_MARK
    a = keyed[y0:y1, x0:x1, 3]
    solid = Image.fromarray(np.where(a >= 0.55, 255, 0).astype(np.uint8), 'L')
    # Close hairline gaps (between the blue arc's tip and the silver stroke)
    # so the fill cannot leak out through them. copy(): fromarray images are
    # read-only views and floodfill would silently write nowhere.
    closed = solid.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)).copy()
    for seed in [(0, 0), (closed.width - 1, 0), (0, closed.height - 1), (closed.width - 1, closed.height - 1)]:
        if closed.getpixel(seed) == 0:
            ImageDraw.floodfill(closed, seed, 128)
    outside = Image.fromarray(np.where(np.asarray(closed) == 128, 255, 0).astype(np.uint8), 'L')
    # Keep the o's outer anti-aliased edge keyed: leave a 2px band next to outside.
    near_outside = np.asarray(outside.filter(ImageFilter.MaxFilter(5))) > 0
    inside = ~near_outside & (a < 1.0)
    out = keyed.copy()
    region = out[y0:y1, x0:x1]
    region[inside, :3] = img[y0:y1, x0:x1][inside]
    region[inside, 3] = 1.0
    return out


def separate_mark(rgba: np.ndarray) -> np.ndarray:
    """Clear the start of the "n" from the mark crop. The n's stem runs
    parallel to the o's tip across a thin diagonal gap, so the cut follows that
    gap: the line through (496, 489) with direction (41.5, 61) in master
    coordinates, plus everything right of x=497 above it."""
    x0, y0, _, _ = REGION_MARK
    h, w = rgba.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    mx, my = xs + x0, ys + y0
    cross = 41.5 * (my - 489) - 61.0 * (mx - 496)
    n_side = (cross < 0) & (mx >= 497)
    out = rgba.copy()
    out[n_side, 3] = 0
    return out


def render_tagline() -> Image.Image:
    """LEARN | PREPARE | BUILD | GROW, drawn large and trimmed; callers scale it down.

    Each word is drawn on its own and cropped to its ink, then the words are laid out with
    equal gaps and a thin blue bar centred in each gap, matching the master art's spacing.
    (Typed "|" glyphs and letter side bearings would sit the dividers off-centre.)"""
    size = 120
    font = ImageFont.truetype(TAGLINE_FONT, size)
    tracking = round(size * 0.42)
    gap = round(size * 1.05)
    bar = max(2, round(size * 0.05))
    _, cap_top, _, cap_bottom = font.getbbox('E')
    words = []
    for word in TAGLINE_WORDS:
        tile = Image.new('RGBA', (size * len(word) * 2, size * 2), (0, 0, 0, 0))
        draw = ImageDraw.Draw(tile)
        x = 0
        for ch in word:
            draw.text((x, 0), ch, font=font, fill=TAGLINE_SILVER)
            x += round(font.getlength(ch)) + tracking
        left, _, right, _ = tile.getbbox()
        words.append(tile.crop((left, 0, right, tile.height)))
    total = sum(w.width for w in words) + (2 * gap + bar) * (len(words) - 1)
    canvas = Image.new('RGBA', (total + 40, size * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    x = 20
    for index, word in enumerate(words):
        if index:
            x += gap
            draw.rectangle((x, cap_top - round(size * 0.12), x + bar - 1, cap_bottom + round(size * 0.12)), fill=TAGLINE_BLUE)
            x += bar + gap
        canvas.alpha_composite(word, (x, 0))
        x += word.width
    return trim(canvas, 4)


def to_image(rgba: np.ndarray) -> Image.Image:
    out = np.dstack([rgba[..., :3], rgba[..., 3] * 255.0])
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGBA')


def graphite(rgba: np.ndarray) -> np.ndarray:
    """Light-surface rendition: silver becomes graphite, blue stays blue."""
    rgb = rgba[..., :3]
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    keep_colour = np.clip((sat - 0.22) / 0.25, 0.0, 1.0)[..., None]
    lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2])
    # Calm the brushed grain: on graphite it reads as noise rather than metal.
    lum_img = Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(5))
    lum = np.asarray(lum_img.filter(ImageFilter.GaussianBlur(2.2))).astype(np.float32)
    # Map brushed silver (roughly 90..235) onto graphite (roughly 34..112),
    # keeping highlights lighter so the bevel still reads.
    g = np.clip(38.0 + (lum - 90.0) * 0.42, 30.0, 104.0)
    slate = np.dstack([g * 0.96, g * 0.99, g * 1.06])  # a touch of cool slate
    blue = rgb * np.array([0.92, 0.92, 0.96])        # deepen blue a little for white
    out = rgba.copy()
    out[..., :3] = keep_colour * blue + (1.0 - keep_colour) * slate
    # The outer blue glow reads as a smudge on white: keep only its core.
    haze = (keep_colour[..., 0] > 0.5) & (out[..., 3] < 0.9)
    out[..., 3] = np.where(haze, out[..., 3] ** 2.5, out[..., 3])
    return out


def mono_white(img: Image.Image) -> Image.Image:
    """Single-colour silhouette for tinting. The o's cavity is dark paint, not
    ground, so brightness decides what is ink: the ring and dot are, the recess
    between them is not."""
    arr = np.asarray(img).astype(np.float32)
    ink = np.clip((arr[..., :3].max(axis=2) - 45.0) / 60.0, 0, 1) * (arr[..., 3] / 255.0)
    return Image.fromarray(np.dstack([np.full(ink.shape + (3,), 255.0), ink * 255.0]).astype(np.uint8), 'RGBA')


def trim(img: Image.Image, pad: int) -> Image.Image:
    a = np.asarray(img)[..., 3]
    ys, xs = np.where(a > 6)
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0),
           min(xs.max() + pad + 1, img.width), min(ys.max() + pad + 1, img.height))
    return img.crop(box)


def crop(rgba: np.ndarray, region: tuple[int, int, int, int]) -> np.ndarray:
    x0, y0, x1, y1 = region
    return rgba[y0:y1, x0:x1].copy()


def fit_square(img: Image.Image, size: int, fill_fraction: float, background=None) -> Image.Image:
    """Centre img inside a size x size canvas occupying fill_fraction of it."""
    canvas = Image.new('RGBA', (size, size), background or (0, 0, 0, 0))
    target = int(round(size * fill_fraction))
    scale = target / max(img.width, img.height)
    scaled = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return canvas


def resize_h(img: Image.Image, height: int) -> Image.Image:
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


def ensure(path: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def main() -> int:
    img = load_master()
    ground = model_ground(img)
    keyed = fill_cavity(key_out(img, ground), img)

    word_dark = trim(to_image(crop(keyed, REGION_WORD)), 6)
    mark_arr = separate_mark(crop(keyed, REGION_MARK))
    mark_dark = trim(to_image(mark_arr), 6)
    tag_dark = render_tagline()

    word_light = trim(to_image(graphite(crop(keyed, REGION_WORD))), 6)
    mark_light = trim(to_image(graphite(mark_arr)), 6)

    # --- Web --------------------------------------------------------------
    # Lockups are stored at 240px tall: crisp at the largest web slot (44px)
    # on a 3x display, and small enough to ship.
    resize_h(word_dark, 240).save(ensure(os.path.join(WEB_ASSETS, 'one-logo-dark.png')), optimize=True)
    resize_h(word_light, 240).save(ensure(os.path.join(WEB_ASSETS, 'one-logo-light.png')), optimize=True)
    # Full-resolution lockups (the crop's own size, never enlarged) for high-density screens
    # and large slots such as the sign-in panel, so a bigger logo is never a stretched one.
    word_dark.save(os.path.join(WEB_ASSETS, 'one-logo-dark@2x.webp'), 'WEBP', quality=92, method=6)
    word_light.save(os.path.join(WEB_ASSETS, 'one-logo-light@2x.webp'), 'WEBP', quality=92, method=6)
    fit_square(mark_dark, 256, 0.96).save(ensure(os.path.join(WEB_ASSETS, 'one-mark-dark.png')), optimize=True)
    fit_square(mark_light, 256, 0.96).save(ensure(os.path.join(WEB_ASSETS, 'one-mark-light.png')), optimize=True)

    # Favicons: the ring on the dark brand ground, rounded tile, so it reads on
    # both light and dark browser chrome.
    def icon_tile(size: int, radius_fraction: float = 0.22, fill: float = 0.78) -> Image.Image:
        tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_fraction), fill=255)
        ground_tile = Image.new('RGBA', (size, size), BRAND_GROUND + (255,))
        tile.paste(ground_tile, (0, 0), mask)
        tile.alpha_composite(fit_square(mark_dark, size, fill))
        return tile

    favicon_sizes = [16, 32, 48, 64, 180, 192, 512]
    tiles = {s: icon_tile(s) for s in favicon_sizes}
    tiles[32].save(ensure(os.path.join(WEB_PUBLIC, 'favicon-32.png')), optimize=True)
    tiles[180].save(os.path.join(WEB_PUBLIC, 'apple-touch-icon.png'), optimize=True)
    tiles[192].save(os.path.join(WEB_PUBLIC, 'one-icon-192.png'), optimize=True)
    tiles[512].save(os.path.join(WEB_PUBLIC, 'one-icon-512.png'), optimize=True)
    tiles[64].save(os.path.join(WEB_PUBLIC, 'one-favicon.png'), optimize=True)
    icon_tile(256).save(os.path.join(WEB_PUBLIC, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    # favicon.svg wraps the 64px tile so a browser asking for the SVG icon gets
    # ONE too (the art is raster; there is no vector master to trace).
    import base64
    import io
    buf = io.BytesIO()
    tiles[64].save(buf, format='PNG', optimize=True)
    data = base64.b64encode(buf.getvalue()).decode('ascii')
    with open(os.path.join(WEB_PUBLIC, 'favicon.svg'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="ONE by AI8HT">'
                 f'<image width="64" height="64" href="data:image/png;base64,{data}"/></svg>\n')

    # --- Android -----------------------------------------------------------
    densities = {'mdpi': 1.0, 'hdpi': 1.5, 'xhdpi': 2.0, 'xxhdpi': 3.0, 'xxxhdpi': 4.0}
    for name, factor in densities.items():
        px108 = round(108 * factor)
        # Adaptive-icon foreground: the ring inside the 66dp safe zone
        # (61% of 108dp; 50% keeps the ring from crowding the mask).
        fit_square(mark_dark, px108, 0.50).save(
            ensure(os.path.join(ANDROID_RES, f'mipmap-{name}', 'ic_launcher_foreground.png')), optimize=True)
        # Themed-icon (Android 13+) monochrome layer: the ring's silhouette.
        fg = fit_square(mark_dark, px108, 0.50)
        mono = mono_white(fg)
        mono.save(os.path.join(ANDROID_RES, f'mipmap-{name}', 'ic_launcher_monochrome.png'), optimize=True)
        # minSdk is 26, so the adaptive icon is always used; no legacy PNGs.

    nodpi = os.path.join(ANDROID_RES, 'drawable-nodpi')
    resize_h(word_dark, 240).save(ensure(os.path.join(nodpi, 'one_logo_dark.png')), optimize=True)
    resize_h(word_light, 240).save(os.path.join(nodpi, 'one_logo_light.png'), optimize=True)
    resize_h(mono_white(word_dark), 240).save(os.path.join(nodpi, 'one_logo_mono.png'), optimize=True)
    fit_square(mark_dark, 384, 0.96).save(os.path.join(nodpi, 'one_mark_dark.png'), optimize=True)
    resize_h(tag_dark, 48).save(os.path.join(nodpi, 'one_tagline_dark.png'), optimize=True)
    # Android 12+ system splash icon: 288dp canvas, the visible circle is
    # 192dp, so the ring sits inside ~60% of the canvas.
    fit_square(mark_dark, 576, 0.5).save(os.path.join(nodpi, 'one_splash_icon.png'), optimize=True)

    # --- Web sign-in background -------------------------------------------
    # The sign-in page's backdrop (styles.css stretches it to the viewport) was
    # a black-to-white fade carrying the old serif "ONE" and the AI8HT wordmark.
    # Rebuilt with the same fade profile and the ONE lockup + tagline in the
    # dark half. The CSS stretch is 100% x 100%, so on common laptop screens
    # the image is squeezed horizontally by roughly 8-18%; the lockup is
    # pre-widened by 12% so the ring stays round on the typical screen.
    bw, bh = 1914, 985
    xs_profile = [0, 830, 860, 900, 940, 980, 1020, 1060, 1100, 1140, 1180, 1220, 1260, 1300, 1340, 1380, 1420, 1460, bw]
    vs_profile = [0, 0, 7, 17, 31, 48, 65, 83, 102, 122, 142, 163, 181, 199, 215, 230, 243, 252, 252]
    fade = np.interp(np.arange(bw), xs_profile, vs_profile).astype(np.float32)
    backdrop = Image.fromarray(np.repeat(np.repeat(fade[None, :, None], bh, axis=0), 3, axis=2).astype(np.uint8), 'RGB').convert('RGBA')
    lock = word_dark.resize((round(560 * 1.12), round(560 * word_dark.height / word_dark.width)), Image.LANCZOS)
    tag = tag_dark.resize((round(430 * 1.12), round(430 * tag_dark.height / tag_dark.width)), Image.LANCZOS)
    cx, cy = 463, 450
    backdrop.alpha_composite(lock, (cx - lock.width // 2, cy - lock.height // 2))
    backdrop.alpha_composite(tag, (cx - tag.width // 2, cy + lock.height // 2 + 34))
    backdrop.convert('RGB').save(os.path.join(WEB_ASSETS, 'login-background.png'), optimize=True)

    # --- Design reference copies ------------------------------------------
    word_dark.save(ensure(os.path.join(DESIGN_OUT, 'one-logo-dark-full.png')), optimize=True)
    word_light.save(os.path.join(DESIGN_OUT, 'one-logo-light-full.png'), optimize=True)
    mark_dark.save(os.path.join(DESIGN_OUT, 'one-mark-dark-full.png'), optimize=True)
    tag_dark.save(os.path.join(DESIGN_OUT, 'one-tagline-dark-full.png'), optimize=True)
    print('brand assets written')
    return 0


if __name__ == '__main__':
    sys.exit(main())
