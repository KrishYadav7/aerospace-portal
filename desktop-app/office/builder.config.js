/* ============================================================
   electron-builder config for one AeroGyan Office app or pack:
     OFFICE_SLUG=sheets     npx electron-builder --config office/builder.config.js --win nsis --x64 --publish never
     OFFICE_PACK=professors npx electron-builder --config office/builder.config.js --win nsis --x64 --publish never
   It is the main app's "build" config from package.json with the
   Office app's own id, name, icon, installer name and update feed.
   The slug's name comes from apps.json (OFFICE_APPS_JSON, or
   ../../office/apps.json from here — office/apps.json at the repo top).

   A PACK (apps.json "packs") is ONE program and ONE one-click installer
   (tech.aerogyan.pack.<id>, "AeroGyan for Professors"): the installer puts
   a Start-menu folder with a shortcut per app of the pack (own icon, own
   AppUserModelID tech.aerogyan.pack.<id>.<slug>, "--office=<slug>"), desktop
   shortcuts for the first 4 apps, and removes them all on uninstall
   (office/pack-<id>/pack.nsh, written by this file). main.js then opens
   each app in its own window; one sign-in for all.

   Without OFFICE_SLUG / OFFICE_PACK this file refuses to run (the main app
   is built from package.json as before).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const slug = String(process.env.OFFICE_SLUG || '').trim().toLowerCase();
const packId = String(process.env.OFFICE_PACK || '').trim().toLowerCase();
if (slug && packId) throw new Error('Set OFFICE_SLUG or OFFICE_PACK, not both');
const ID_RE = /^[a-z][a-z0-9]{0,31}$/;
if (!ID_RE.test(slug || packId)) throw new Error('Set OFFICE_SLUG=<slug> or OFFICE_PACK=<id> (lowercase letters/digits) to build an Office app or pack');

const appsFile = process.env.OFFICE_APPS_JSON || path.join(__dirname, '..', '..', 'office', 'apps.json');
const data = JSON.parse(fs.readFileSync(appsFile, 'utf8'));
const APPS = data.apps || [];

const base = JSON.parse(JSON.stringify(pkg.build));
delete base.protocols;                       // aerogyan:// links stay with the main app
delete base.mac;                             // Windows only for now

/* "AeroGyan Placement Prep" → "PlacementPrep" (file names; the website maps it back to the slug) */
const fileShort = (s, fallback) => String(s || '').replace(/^AeroGyan\s+/, '').replace(/[^A-Za-z0-9]/g, '') || fallback;
/* a Windows program / shortcut name: no & or other odd characters ("AeroGyan Campus QA") */
const winName = (s) => String(s).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function needIcons(dir, label) {
  for (const f of ['icon.ico', 'office-icon.png']) {
    if (!fs.existsSync(path.join(__dirname, dir, f))) throw new Error(`Missing desktop-app/office/${dir}/${f} (${label}) — run node desktop-app/office/make-office-icons.js`);
  }
}

/* ---------------------------------------------------------------- one app */
function appConfig() {
  const app = APPS.find((a) => a.slug === slug);
  if (!app) throw new Error(`No app "${slug}" in ${appsFile}`);
  needIcons(slug, app.name);
  const short = fileShort(app.name, slug);
  const ico = path.join(__dirname, slug, 'icon.ico');
  return {
    ...base,
    appId: `tech.aerogyan.office.${slug}`,
    productName: app.name,
    executableName: winName(app.name),              // "AeroGyan Campus QA.exe" (no & in the program's name)
    /* written into the packaged package.json: main.js reads it (START_URL, name, user-agent),
       and the different name gives the app its own data folder (%APPDATA%\<name>) */
    extraMetadata: {
      name: `aerogyan-office-${slug}`,
      productName: app.name,
      description: `${app.name} — AeroGyan Office desktop app`,
      aerogyanOffice: { slug, name: app.name, short, color: app.color2 || app.color }
    },
    files: [...(base.files || ['src/**/*', 'package.json']),
      { from: `office/${slug}`, to: 'src', filter: ['office-icon.png'] }],     // window + notification icon
    publish: [{ provider: 'generic', url: `https://aerogyan.tech/download/office/${slug}/windows/` }],
    win: {
      ...base.win,
      icon: ico,
      artifactName: `AeroGyan-${short}-Setup-\${version}.\${ext}`
    },
    nsis: {
      ...base.nsis,
      shortcutName: app.name,
      uninstallDisplayName: app.name,
      installerIcon: ico,
      uninstallerIcon: ico,
      artifactName: `AeroGyan-${short}-Setup-\${version}.\${ext}`
    }
  };
}

/* ---------------------------------------------------------------- a pack */
const DESKTOP_SHORTCUTS = 4;                 // the first 4 apps of the pack also get a desktop icon

/* NSIS strings: $ and " are special */
const nsisStr = (s) => String(s).replace(/\$/g, '$$$$').replace(/"/g, "$\\\"");

function packNsh(pack, apps) {
  const folder = winName(pack.name);
  const reg = `Software\\tech.aerogyan.pack.${pack.id}`;
  const L = [];
  L.push(`; generated by desktop-app/office/builder.config.js for ${pack.name} (OFFICE_PACK=${pack.id}) — do not edit`);
  L.push('; Start menu: a folder with every app of the pack; desktop: the first ' + DESKTOP_SHORTCUTS + ' apps.');
  L.push('; Each shortcut runs the one program with --office=<slug>, has the app\'s own icon and its own');
  L.push('; AppUserModelID (so the taskbar keeps each app apart). Uninstall removes them all.');
  L.push('');
  L.push('!macro customInstall');
  /* the folder is ours alone: start clean (an update may have renamed or dropped an app) */
  L.push(`  RMDir /r "$SMPROGRAMS\\${nsisStr(folder)}"`);
  L.push(`  CreateDirectory "$SMPROGRAMS\\${nsisStr(folder)}"`);
  apps.forEach((a, i) => {
    const lnkName = nsisStr(winName(a.name));
    const ico = `$INSTDIR\\resources\\office-icons\\${a.slug}.ico`;
    const aumid = `tech.aerogyan.pack.${pack.id}.${a.slug}`;
    const desc = nsisStr(a.line || a.name);
    L.push(`  ; ${a.name}`);
    L.push(`  CreateShortCut "$SMPROGRAMS\\${nsisStr(folder)}\\${lnkName}.lnk" "$appExe" "--office=${a.slug}" "${ico}" 0 "" "" "${desc}"`);
    L.push('  ClearErrors');
    L.push(`  WinShell::SetLnkAUMI "$SMPROGRAMS\\${nsisStr(folder)}\\${lnkName}.lnk" "${aumid}"`);
    if (i < DESKTOP_SHORTCUTS) {
      /* not on updates (the user may have removed it), and never over a shortcut of the stand-alone app */
      L.push('  ${ifNot} ${isUpdated}');
      L.push(`    \${ifNot} \${FileExists} "$DESKTOP\\${lnkName}.lnk"`);
      L.push(`      CreateShortCut "$DESKTOP\\${lnkName}.lnk" "$appExe" "--office=${a.slug}" "${ico}" 0 "" "" "${desc}"`);
      L.push('      ClearErrors');
      L.push(`      WinShell::SetLnkAUMI "$DESKTOP\\${lnkName}.lnk" "${aumid}"`);
      L.push(`      WriteRegStr HKCU "${reg}" "desktop_${a.slug}" "1"`);
      L.push('    ${endIf}');
      L.push('  ${endIf}');
    }
  });
  /* "run after install" opens the pack's first app through its shortcut (right icon and taskbar id) */
  L.push(`  StrCpy $launchLink "$SMPROGRAMS\\${nsisStr(folder)}\\${nsisStr(winName(apps[0].name))}.lnk"`);
  L.push('  System::Call \'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)\'');
  L.push('!macroend');
  L.push('');
  L.push('!macro customUnInstall');
  L.push('  ${ifNot} ${isUpdated}');
  apps.forEach((a, i) => {
    const lnkName = nsisStr(winName(a.name));
    L.push(`    WinShell::UninstShortcut "$SMPROGRAMS\\${nsisStr(folder)}\\${lnkName}.lnk"`);
    L.push(`    Delete "$SMPROGRAMS\\${nsisStr(folder)}\\${lnkName}.lnk"`);
    L.push(`    WinShell::UninstAppUserModelId "tech.aerogyan.pack.${pack.id}.${a.slug}"`);
    if (i < DESKTOP_SHORTCUTS) {
      L.push(`    ReadRegStr $R1 HKCU "${reg}" "desktop_${a.slug}"`);
      L.push('    ${if} $R1 == "1"');
      L.push(`      WinShell::UninstShortcut "$DESKTOP\\${lnkName}.lnk"`);
      L.push(`      Delete "$DESKTOP\\${lnkName}.lnk"`);
      L.push('    ${endIf}');
    }
  });
  L.push(`    RMDir "$SMPROGRAMS\\${nsisStr(folder)}"`);
  L.push(`    DeleteRegKey HKCU "${reg}"`);
  L.push('    System::Call \'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)\'');
  L.push('  ${endIf}');
  L.push('!macroend');
  return L.join('\r\n') + '\r\n';
}

function packConfig() {
  const pack = (data.packs || []).find((p) => p.id === packId);
  if (!pack) throw new Error(`No pack "${packId}" in ${appsFile}`);
  const apps = pack.apps.map((s) => {
    const a = APPS.find((x) => x.slug === s);
    if (!a) throw new Error(`Pack "${packId}" lists "${s}", which is not an app in ${appsFile}`);
    needIcons(s, a.name);
    return a;
  });
  needIcons(`pack-${packId}`, pack.name);
  const short = fileShort(pack.short || pack.name, packId);          // "Professor Pack" → "ProfessorPack"
  const ico = path.join(__dirname, `pack-${packId}`, 'icon.ico');
  const nsh = path.join(__dirname, `pack-${packId}`, 'pack.nsh');
  fs.writeFileSync(nsh, '\ufeff' + packNsh(pack, apps));      // BOM: NSIS reads the file as UTF-8
  return {
    ...base,
    appId: `tech.aerogyan.pack.${packId}`,
    productName: pack.name,
    executableName: winName(pack.name),             // "AeroGyan for Professors.exe"
    extraMetadata: {
      name: `aerogyan-office-pack-${packId}`,
      productName: pack.name,
      description: `${pack.name} — AeroGyan Office apps`,
      aerogyanPack: {
        id: packId, name: pack.name, short,
        apps: apps.map((a) => ({ slug: a.slug, name: a.name, short: a.short, color: a.color2 || a.color }))
      }
    },
    files: [...(base.files || ['src/**/*', 'package.json']),                          // window icons (png):
      ...apps.map((a) => ({ from: `office/${a.slug}`, to: `src/office-icons/${a.slug}`, filter: ['office-icon.png'] }))],
    /* .ico files on disk (not in app.asar): shortcuts and the taskbar read them */
    extraResources: apps.map((a) => ({ from: `office/${a.slug}/icon.ico`, to: `office-icons/${a.slug}.ico` })),
    publish: [{ provider: 'generic', url: `https://aerogyan.tech/download/office/pack/${packId}/windows/` }],
    win: {
      ...base.win,
      icon: ico,
      artifactName: `AeroGyan-${short}-Setup-\${version}.\${ext}`
    },
    nsis: {
      ...base.nsis,
      shortcutName: pack.name,
      createDesktopShortcut: false,                 // pack.nsh makes the per-app shortcuts instead
      createStartMenuShortcut: false,
      uninstallDisplayName: pack.name,
      installerIcon: ico,
      uninstallerIcon: ico,
      include: nsh,
      artifactName: `AeroGyan-${short}-Setup-\${version}.\${ext}`
    }
  };
}

module.exports = packId ? packConfig() : appConfig();
