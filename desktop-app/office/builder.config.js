/* ============================================================
   electron-builder config for one AeroGyan Office app:
     OFFICE_SLUG=sheets npx electron-builder --config office/builder.config.js --win nsis --x64 --publish never
   It is the main app's "build" config from package.json with the
   Office app's own id, name, icon, installer name and update feed.
   The slug's name comes from apps.json (OFFICE_APPS_JSON, or
   ../../office/apps.json from here — office/apps.json at the repo top).
   Without OFFICE_SLUG this file refuses to run (the main app is built
   from package.json as before).
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const slug = String(process.env.OFFICE_SLUG || '').trim().toLowerCase();
if (!/^[a-z][a-z0-9]{0,31}$/.test(slug)) throw new Error('Set OFFICE_SLUG=<slug> (lowercase letters/digits) to build an Office app');

const appsFile = process.env.OFFICE_APPS_JSON || path.join(__dirname, '..', '..', 'office', 'apps.json');
const app = (JSON.parse(fs.readFileSync(appsFile, 'utf8')).apps || []).find((a) => a.slug === slug);
if (!app) throw new Error(`No app "${slug}" in ${appsFile}`);

const iconDir = path.join(__dirname, slug);
for (const f of ['icon.ico', 'office-icon.png']) {
  if (!fs.existsSync(path.join(iconDir, f))) throw new Error(`Missing desktop-app/office/${slug}/${f} — run node desktop-app/office/make-office-icons.js`);
}

/* "AeroGyan Placement Prep" → "PlacementPrep" (file names; the website maps it back to the slug) */
const short = app.name.replace(/^AeroGyan\s+/, '').replace(/[^A-Za-z0-9]/g, '') || slug;
const ico = path.join(iconDir, 'icon.ico');

const base = JSON.parse(JSON.stringify(pkg.build));
delete base.protocols;                       // aerogyan:// links stay with the main app
delete base.mac;                             // Windows only for now

module.exports = {
  ...base,
  appId: `tech.aerogyan.office.${slug}`,
  productName: app.name,
  executableName: app.name.replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(),   // "AeroGyan Campus QA.exe" (no & in the program's name)
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
