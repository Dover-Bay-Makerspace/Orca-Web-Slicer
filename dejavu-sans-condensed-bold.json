#!/usr/bin/env python3
"""Turn TrueType fonts into the small outline files the Text tool uses.

Each output file (vendor/fonts/<id>.json) holds, per character, the advance
width and the outline as an SVG-style path ("M x y L x y Q cx cy x y Z") in
font units, plus unitsPerEm and the cap height. Needs fontTools.

  python3 tools/build-fonts.py
"""
import json, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'vendor', 'fonts')
FONTS = [
    ('poppins-bold', 'Rounded (Poppins Bold)', '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'),
    ('dejavu-sans-bold', 'Plain (DejaVu Sans Bold)', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
    ('dejavu-sans-condensed-bold', 'Narrow (DejaVu Sans Condensed Bold)', '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'),
    ('dejavu-serif-bold', 'Classic (DejaVu Serif Bold)', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'),
]
CHARS = [chr(c) for c in range(32, 127)] + [chr(c) for c in range(160, 256)] + list('ŒœŠšŽžŸ€‘’“”–—•…')


def build(fid, label, path):
    font = TTFont(path)
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font['hmtx']
    out = {}
    for ch in CHARS:
        name = cmap.get(ord(ch))
        if not name:
            continue
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        out[ch] = {'a': hmtx[name][0], 'd': pen.getCommands()}
    os2 = font['OS/2']
    cap = getattr(os2, 'sCapHeight', 0) or int(font['head'].unitsPerEm * 0.7)
    name_table = font['name']
    data = {
        'id': fid, 'label': label, 'unitsPerEm': font['head'].unitsPerEm, 'capHeight': cap,
        'copyright': name_table.getDebugName(0), 'license': name_table.getDebugName(13),
        'glyphs': out,
    }
    with open(os.path.join(OUT, fid + '.json'), 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    return len(out)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    index = []
    for fid, label, path in FONTS:
        if not os.path.exists(path):
            print('missing', path, file=sys.stderr)
            continue
        n = build(fid, label, path)
        index.append({'id': fid, 'label': label})
        print(fid, n, 'glyphs')
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(index, fh)
