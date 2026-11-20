#!/usr/bin/env node
/* Desktop store icons from legacy-node/store/icons (run again when the icon changes; the outputs are committed):
     build/icon.png  1024 px (macOS .icns and Linux are made from it by electron-builder)
     build/icon.ico  16/24/32/48/64/128 as bitmaps + 256 as PNG (Windows: Explorer, taskbar, NSIS) */
'use strict';
const fs = require('fs');
const path = require('path');
const { readPng, bmpEntry, ico } = require('../../../desktop-app/office/make-office-icons.js');
const src = path.join(__dirname, '..', '..', '..', 'store', 'icons');
const entries = [16, 24, 32, 48, 64, 128].map((s) => ({ size: s, data: bmpEntry(readPng(path.join(src, `icon-${s}.png`))) }));
entries.push({ size: 256, data: fs.readFileSync(path.join(src, 'icon-256.png')) });
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(entries));
fs.copyFileSync(path.join(src, 'icon-1024.png'), path.join(__dirname, 'icon.png'));
console.log('icon.ico', fs.statSync(path.join(__dirname, 'icon.ico')).size, 'bytes; icon.png 1024');
