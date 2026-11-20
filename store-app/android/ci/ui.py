#!/usr/bin/env python3
"""Tiny uiautomator helper for the emulator test.
   ui.py dump <name>             → test-out/<name>.xml + .txt (all texts / descriptions)
   ui.py tap <text> [pkg]        → taps the smallest node whose text/description equals <text> (else contains it)
   ui.py has <text>              → exit 0 when the last dump contains <text>"""
import os, re, subprocess, sys, time
import xml.etree.ElementTree as ET

OUT = 'test-out'
os.makedirs(OUT, exist_ok=True)


def dump(name='last'):
    for _ in range(3):
        subprocess.run(['adb', 'shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], capture_output=True)
        r = subprocess.run(['adb', 'pull', '/sdcard/ui.xml', f'{OUT}/{name}.xml'], capture_output=True)
        if r.returncode == 0:
            break
        time.sleep(2)
    try:
        root = ET.parse(f'{OUT}/{name}.xml').getroot()
    except Exception:
        return []
    nodes = []
    for n in root.iter('node'):
        t = (n.get('text') or '').strip()
        d = (n.get('content-desc') or '').strip()
        b = re.findall(r'\d+', n.get('bounds') or '')
        if len(b) == 4:
            nodes.append((t, d, n.get('package') or '', [int(x) for x in b]))
    with open(f'{OUT}/{name}.txt', 'w') as f:
        for t, d, p, _ in nodes:
            if t or d:
                f.write(f'{t} | {d} | {p}\n')
    return nodes


def find(nodes, text, pkg=None):
    low = text.lower()
    exact = [n for n in nodes if (n[0].lower() == low or n[1].lower() == low) and (not pkg or pkg in n[2])]
    cand = exact or [n for n in nodes if (low in n[0].lower() or low in n[1].lower()) and (not pkg or pkg in n[2])]
    cand = [n for n in cand if n[3][2] > n[3][0] and n[3][3] > n[3][1]]
    if not cand:
        return None
    return min(cand, key=lambda n: (n[3][2] - n[3][0]) * (n[3][3] - n[3][1]))


def main():
    cmd = sys.argv[1]
    if cmd == 'dump':
        dump(sys.argv[2])
        return 0
    if cmd == 'tap':
        text, pkg = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else None)
        for _ in range(10):
            n = find(dump('tap'), text, pkg)
            if n:
                x1, y1, x2, y2 = n[3]
                subprocess.run(['adb', 'shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2)])
                print(f'tapped "{text}" at {n[3]}')
                return 0
            time.sleep(2)
        print(f'not found: "{text}"')
        return 1
    if cmd == 'wait':  # wait <text> <seconds>
        text, secs = sys.argv[2], int(sys.argv[3])
        end = time.time() + secs
        while time.time() < end:
            if find(dump('wait'), text):
                return 0
            time.sleep(3)
        return 1
    return 2


sys.exit(main())
