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

For each pack in apps.json "packs" (OFFICE_PACK=<id>: ONE APK with every app of the pack) it writes
android-app/office/pack-<id>/:
  res/                                 the pack's own icon (ic_launcher*, from icons/pack-<id>/) and per app
                                       ic_app_<slug>* (legacy, round, adaptive + themed), its colour, its splash
                                       (Theme.AeroGyan.App<Slug>), and app_name = the pack's name
  AndroidManifest.xml                  one launcher activity per app (own label, icon, task, /apps/<slug>/ links)
  java/tech/aerogyan/app/PackApps.java one tiny MainActivity subclass per app (an own task needs an own class)

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


# ---------------------------------------------------------------- packs (OFFICE_PACK=<id>)
def class_name(slug):
    """'notesreview' → 'AppNotesreview' (one Java class per app; slugs are [a-z][a-z0-9]*)."""
    return 'App' + slug[:1].upper() + slug[1:]


def launcher_label(a):
    """the label under the icon — the same as the stand-alone app's ("Live Classes", "AI Solver")."""
    name = a['name']
    return name[len('AeroGyan '):] if name.startswith('AeroGyan ') else name


def icon_set(icons, res, prefix, color_name):
    """legacy + round mipmaps and an adaptive (+ themed) icon called <prefix>, from one icons/<x>/ folder."""
    for dpi, size in DPIS:
        d = os.path.join(res, 'mipmap-' + dpi)
        os.makedirs(d, exist_ok=True)
        shutil.copyfile(os.path.join(icons, 'icon-%d.png' % size), os.path.join(d, prefix + '.png'))
        write_png(os.path.join(d, prefix + '_round.png'), size, size,
                  circle_icon(os.path.join(icons, 'maskable-512.png'), size))
    nodpi = os.path.join(res, 'drawable-nodpi')
    os.makedirs(nodpi, exist_ok=True)
    shutil.copyfile(os.path.join(icons, 'maskable-512.png'), os.path.join(nodpi, prefix + '_fg.png'))
    mono = os.path.join(icons, 'monochrome-512.png')
    has_mono = os.path.exists(mono)
    if has_mono:
        shutil.copyfile(mono, os.path.join(nodpi, prefix + '_mono.png'))
    any26 = os.path.join(res, 'mipmap-anydpi-v26')
    os.makedirs(any26, exist_ok=True)
    xml = ('<?xml version="1.0" encoding="utf-8"?>\n'
           '<!-- generated by android-app/office/make-office-res.py -->\n'
           '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
           '    <background android:drawable="@color/%s" />\n'
           '    <foreground android:drawable="@drawable/%s_fg" />\n' % (color_name, prefix)
           + ('    <monochrome android:drawable="@drawable/%s_mono" />\n' % prefix if has_mono else '')
           + '</adaptive-icon>\n')
    for n in (prefix + '.xml', prefix + '_round.xml'):
        open(os.path.join(any26, n), 'w').write(xml)


def xml_attr(v):
    return escape(v, {'"': '&quot;'})


GEN = '<!-- generated by android-app/office/make-office-res.py -->\n'

ACTIVITY = '''        <!-- %(name)s -->
        <activity
            android:name=".PackApps$%(cls)s"
            android:label="%(label)s"
            android:icon="@mipmap/ic_app_%(slug)s"
            android:roundIcon="@mipmap/ic_app_%(slug)s_round"
            android:theme="@style/Theme.AeroGyan.%(cls)s"
            android:taskAffinity="${applicationId}.%(slug)s"
            android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden|navigation|uiMode|density|fontScale"
            android:exported="true"
            android:launchMode="singleTask"
            android:windowSoftInputMode="adjustResize">
            <meta-data android:name="tech.aerogyan.office.slug" android:value="%(slug)s" />
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data
                    android:scheme="https"
                    android:host="${appHost}"
                    android:pathPrefix="/apps/%(slug)s/" />
            </intent-filter>
        </activity>
'''

MANIFEST = '''<?xml version="1.0" encoding="utf-8"?>
<!-- generated by android-app/office/make-office-res.py: %(name)s (OFFICE_PACK=%(id)s, see app/build.gradle).
     Merged over src/main/AndroidManifest.xml: the main app's activity goes, and every app of the pack
     gets its own launcher activity: own label and icon on the home screen, own task (its own card in
     Recents), opening https://<host>/apps/<slug>/. They all run in one process with one WebView storage,
     so one sign-in covers every app of the pack. -->
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <application>
        <activity android:name=".MainActivity" tools:node="remove" />

%(acts)s    </application>
</manifest>
'''


def build_packs(office_dir):
    data = json.load(open(os.path.join(office_dir, 'apps.json')))
    apps = {a['slug']: a for a in data['apps']}
    for p in data.get('packs', []):
        pid = p['id']
        out = os.path.join(HERE, 'pack-' + pid)
        if os.path.isdir(out):
            shutil.rmtree(out)
        res = os.path.join(out, 'res')
        picons = os.path.join(office_dir, 'icons', 'pack-' + pid)
        # the pack's own icon: Settings › Apps, the install screen, the update dialog
        icon_set(picons, res, 'ic_launcher', 'ic_launcher_background')
        shutil.copyfile(os.path.join(picons, 'icon-512.png'), os.path.join(res, 'drawable-nodpi', 'splash_logo.png'))
        colors = ['    <color name="ic_launcher_background">%s</color>' % p.get('color2', p.get('color', '#0B1226'))]
        styles, styles31, acts, classes = [], [], [], []
        os.makedirs(os.path.join(res, 'drawable'))
        for slug in p['apps']:
            a = apps[slug]
            cls = class_name(slug)
            icon_set(os.path.join(office_dir, 'icons', slug), res, 'ic_app_' + slug, 'ic_app_%s_bg' % slug)
            colors.append('    <color name="ic_app_%s_bg">%s</color>' % (slug, a.get('color2', a.get('color', '#0B1226'))))
            # its own splash: the app's icon (Android 12+: the system splash; older: the window background)
            open(os.path.join(res, 'drawable', 'splash_app_%s.xml' % slug), 'w').write(
                '<?xml version="1.0" encoding="utf-8"?>\n' + GEN +
                '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n'
                '    <item android:drawable="@color/splash_bg" />\n'
                '    <item android:width="144dp" android:height="144dp" android:gravity="center"\n'
                '        android:drawable="@mipmap/ic_app_%s" />\n'
                '</layer-list>\n' % slug)
            styles.append('    <style name="Theme.AeroGyan.%s">\n'
                          '        <item name="android:windowBackground">@drawable/splash_app_%s</item>\n'
                          '    </style>' % (cls, slug))
            styles31.append('    <style name="Theme.AeroGyan.%s">\n'
                            '        <item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_app_%s</item>\n'
                            '    </style>' % (cls, slug))
            classes.append('    /** %s: opens https://&lt;host&gt;/apps/%s/ in its own task */\n'
                           '    public static final class %s extends MainActivity { }\n' % (a['name'], slug, cls))
            acts.append(ACTIVITY % {'name': escape(a['name']), 'cls': cls, 'label': xml_attr(launcher_label(a)), 'slug': slug})
        vals = os.path.join(res, 'values')
        os.makedirs(vals, exist_ok=True)
        open(os.path.join(vals, 'strings.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n' + GEN + '<resources>\n'
            '    <!-- Settings › Apps, the install screen, dialogs -->\n'
            '    <string name="app_name">%s</string>\n'
            '</resources>\n' % escape(p['name']).replace("'", "\\'"))
        open(os.path.join(vals, 'colors.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n' + GEN + '<resources>\n' + '\n'.join(colors) + '\n</resources>\n')
        open(os.path.join(vals, 'themes.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n' + GEN + '<resources>\n' + '\n'.join(styles) + '\n</resources>\n')
        v31 = os.path.join(res, 'values-v31')
        os.makedirs(v31)
        open(os.path.join(v31, 'themes.xml'), 'w').write(
            '<?xml version="1.0" encoding="utf-8"?>\n' + GEN + '<resources>\n' + '\n'.join(styles31) + '\n</resources>\n')
        open(os.path.join(out, 'AndroidManifest.xml'), 'w').write(
            MANIFEST % {'name': escape(p['name']), 'id': pid, 'acts': '\n'.join(acts)})
        jdir = os.path.join(out, 'java', 'tech', 'aerogyan', 'app')
        os.makedirs(jdir)
        open(os.path.join(jdir, 'PackApps.java'), 'w').write(
            '/* generated by android-app/office/make-office-res.py: %s (OFFICE_PACK=%s) */\n'
            'package tech.aerogyan.app;\n\n'
            '/** One launcher activity per app of the pack. Each needs its own class so that Android gives it\n'
            '    its own task (taskAffinity); MainActivity reads the slug from the activity\'s meta-data\n'
            '    "tech.aerogyan.office.slug" (AndroidManifest.xml next to this folder). */\n'
            'public final class PackApps {\n'
            '    private PackApps() { }\n\n%s}\n' % (p['name'], pid, '\n'.join(classes)))
        print('pack %-11s %-24s %d apps: %s' % (pid, p['name'], len(p['apps']),
              ', '.join('%s "%s"' % (s, launcher_label(apps[s])) for s in p['apps'])))


if __name__ == '__main__':
    default = os.path.normpath(os.path.join(HERE, '..', '..', 'office'))
    office = sys.argv[1] if len(sys.argv) > 1 else default
    build(office)
    build_packs(office)
