#!/usr/bin/env python3
"""Build the Android resources of every AeroGyan Office app.

    python3 android-app/office/make-office-res.py <office dir>      (default: ../office next to android-app)

For each app in <office dir>/apps.json it writes android-app/office/<slug>/res/:
  mipmap-<dpi>/ic_launcher.png         the app's PWA icon (icons/<slug>/icon-48 … icon-192)
  mipmap-<dpi>/ic_launcher_round.png   the maskable art cut to a circle (Android 7.1 round icons)
  mipmap-anydpi-v26/ic_launcher*.xml   adaptive icon: maskable art as the foreground (+ themed icon)
  drawable-nodpi/ic_office_fg.png      maskable-512 (full-bleed, like Chrome's WebAPKs use it)
  drawable-nodpi/ic_office_mono.png    monochrome-512 (Android 13 themed icons)
  drawable-nodpi/splash_logo.png       icon-512 (splash on Android 11 and older)
  values/strings.xml                   app_name (full name) + launcher_name (name without "AeroGyan ")
  values/colors.xml                    ic_launcher_background (the app's dark colour)

Needs only the Python standard library: PNGs are decoded, resampled (box filter) and encoded
here, no image tools. The generated files are committed; run it again when the icons change.
"""
import json
import os
import shutil
import struct
import sys
import zlib
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
DPIS = [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]


# ---------------------------------------------------------------- tiny PNG codec (8-bit, non-interlaced)
def read_png(path):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(path + ': not a PNG')
    pos, idat, w = 8, b'', None
    while pos < len(data):
        n, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if typ == b'IHDR':
            w, h, depth, ctype, _c, _f, inter = struct.unpack('>IIBBBBB', body)
            if depth != 8 or inter != 0 or ctype not in (2, 6):
                raise ValueError('%s: unsupported PNG (depth %d, type %d, interlace %d)' % (path, depth, ctype, inter))
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    i = 0
    for y in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    px = []                                                   # RGBA tuples
    for k in range(0, len(out), bpp):
        px.append((out[k], out[k + 1], out[k + 2], out[k + 3] if bpp == 4 else 255))
    return w, h, px


def write_png(path, w, h, px):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.extend(px[y * w + x])
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def circle_icon(src, size):
    """maskable art → size×size, cut to a circle with smooth edges (box-filter resample)."""
    w, h, px = read_png(src)
    out = []
    sx, sy = w / size, h / size
    r = size / 2.0
    for y in range(size):
        y0, y1 = int(y * sy), max(int(y * sy) + 1, int((y + 1) * sy))
        for x in range(size):
            x0, x1 = int(x * sx), max(int(x * sx) + 1, int((x + 1) * sx))
            acc = [0, 0, 0, 0]
            n = 0
            for yy in range(y0, min(y1, h)):
                row = yy * w
                for xx in range(x0, min(x1, w)):
                    p = px[row + xx]
                    acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; acc[3] += p[3]
                    n += 1
            # coverage of this pixel by the circle (4×4 samples)
            cov = 0
            for j in range(4):
                for i in range(4):
                    dx = x + (i + 0.5) / 4 - r
                    dy = y + (j + 0.5) / 4 - r
                    if dx * dx + dy * dy <= r * r:
                        cov += 1
            a = int(round(acc[3] / n * cov / 16))
            out.append((acc[0] // n, acc[1] // n, acc[2] // n, a))
    return out


def alpha_bbox(src):
    w, h, px = read_png(src)
    xs = [i % w for i, p in enumerate(px) if p[3] > 16]
    ys = [i // w for i, p in enumerate(px) if p[3] > 16]
    return (min(xs), min(ys), max(xs), max(ys), w, h) if xs else None


# ---------------------------------------------------------------- per app
def build(office_dir):
    apps = json.load(open(os.path.join(office_dir, 'apps.json')))['apps']
    for a in apps:
        slug = a['slug']
        icons = os.path.join(office_dir, 'icons', slug)
        res = os.path.join(HERE, slug, 'res')
        if os.path.isdir(res):
            shutil.rmtree(res)
        for dpi, size in DPIS:
            d = os.path.join(res, 'mipmap-' + dpi)
            os.makedirs(d)
            shutil.copyfile(os.path.join(icons, 'icon-%d.png' % size), os.path.join(d, 'ic_launcher.png'))
            write_png(os.path.join(d, 'ic_launcher_round.png'), size, size,
                      circle_icon(os.path.join(icons, 'maskable-512.png'), size))
        nodpi = os.path.join(res, 'drawable-nodpi')
        os.makedirs(nodpi)
        shutil.copyfile(os.path.join(icons, 'maskable-512.png'), os.path.join(nodpi, 'ic_office_fg.png'))
        shutil.copyfile(os.path.join(icons, 'icon-512.png'), os.path.join(nodpi, 'splash_logo.png'))
        mono = os.path.join(icons, 'monochrome-512.png')
        has_mono = os.path.exists(mono)
        if has_mono:
            shutil.copyfile(mono, os.path.join(nodpi, 'ic_office_mono.png'))
        any26 = os.path.join(res, 'mipmap-anydpi-v26')
        os.makedirs(any26)
        xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
               '<!-- generated by android-app/office/make-office-res.py -->\n'
               '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
               '    <background android:drawable="@color/ic_launcher_background" />\n'
               '    <foreground android:drawable="@drawable/ic_office_fg" />\n'
               + ('    <monochrome android:drawable="@drawable/ic_office_mono" />\n' if has_mono else '')
               + '</adaptive-icon>\n')
        for n in ('ic_launcher.xml', 'ic_launcher_round.xml'):
            open(os.path.join(any26, n), 'w').write(xml)
        vals = os.path.join(res, 'values')
        os.makedirs(vals)
        name = a['name']
        launcher = name[len('AeroGyan '):] if name.startswith('AeroGyan ') else name
        open(os.path.join(vals, 'strings.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n<!-- generated by android-app/office/make-office-res.py -->\n'
            '<resources>\n'
            '    <!-- Settings › Apps, the install screen, dialogs -->\n'
            '    <string name="app_name">%s</string>\n'
            '    <!-- under the icon on the home screen (launchers cut long names) -->\n'
            '    <string name="launcher_name">%s</string>\n'
            '</resources>\n' % (escape(name).replace("'", "\\'"), escape(launcher).replace("'", "\\'")))
        open(os.path.join(vals, 'colors.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n<!-- generated by android-app/office/make-office-res.py -->\n'
            '<resources>\n'
            '    <color name="ic_launcher_background">%s</color>\n'
            '</resources>\n' % a.get('color2', a.get('color', '#0B1226')))
        print('%-10s %-26s launcher "%s"  mono=%s' % (slug, name, launcher,
              alpha_bbox(mono)[:4] if has_mono else '-'))


if __name__ == '__main__':
    default = os.path.normpath(os.path.join(HERE, '..', '..', 'office'))
    build(sys.argv[1] if len(sys.argv) > 1 else default)
