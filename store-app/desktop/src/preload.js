/* AeroGyan Store — the page's only door to the main process: app ids in, plain data out (sandboxed). */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke('store:' + ch, ...a);
const on = (ch, fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on('store:' + ch, h);
  return () => ipcRenderer.removeListener('store:' + ch, h);
};
contextBridge.exposeInMainWorld('store', Object.freeze({
  state: () => call('state'),
  pref: (k, v) => call('pref', k, v),
  catalog: (refresh) => call('catalog', !!refresh),
  install: (id) => call('install', String(id)),
  cancel: (id) => call('cancel', String(id)),
  open: (id) => call('open', String(id)),
  uninstall: (id) => call('uninstall', String(id)),
  web: (id, which) => call('web', String(id), which === 'download' ? 'download' : 'web'),
  check: () => call('check'),
  onProgress: (fn) => on('progress', fn),
  onCatalog: (fn) => on('catalog', fn),
  onTheme: (fn) => on('theme', fn),
  onTab: (fn) => on('tab', fn)
}));
