"""Regenerate app/tray/extension icons from the 跡 kanji.

Run after changing the wordmark: `py make_icons.py`.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO   = Path(__file__).resolve().parent.parent   # tools/ -> repo root
ASSETS = REPO / "src" / "assets"
EXT    = REPO / "ext"
ACCENT = (91, 140, 255, 255)   # --accent #5B8CFF
TEXT   = (255, 255, 255, 255)
FONT   = r"C:\Windows\Fonts\YuGothB.ttc"


def _render(text: str, size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # rounded-square background in the app accent color
    pad    = max(1, round(size * 0.06))
    radius = round(size * 0.22)
    d.rounded_rectangle([pad, pad, size - pad, size - pad],
                        radius=radius, fill=ACCENT)

    # largest font that fits the inner box
    inner = size - 2 * pad - round(size * 0.10)
    fsize = inner
    while fsize > 4:
        font = ImageFont.truetype(FONT, fsize)
        l, t, r, b = d.textbbox((0, 0), text, font=font)
        if (r - l) <= inner and (b - t) <= inner:
            break
        fsize -= 1

    l, t, r, b = d.textbbox((0, 0), text, font=font)
    x = (size - (r - l)) / 2 - l
    y = (size - (b - t)) / 2 - t
    d.text((x, y), text, font=font, fill=TEXT)
    return img


def main() -> None:
    # App / Windows taskbar icon — multi-resolution .ico
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    base = _render("跡", 256)
    base.save(ASSETS / "icon.ico",
              sizes=[(s, s) for s in ico_sizes])
    print("wrote src/assets/icon.ico (跡)")

    # Tray icon — single kanji
    _render("跡", 256).save(ASSETS / "tray.png")
    print("wrote src/assets/tray.png (跡)")

    # Browser extension icons — single kanji
    for s in (16, 48, 128):
        _render("跡", s).save(EXT / f"icon{s}.png")
        print(f"wrote ext/icon{s}.png (跡)")


if __name__ == "__main__":
    main()
