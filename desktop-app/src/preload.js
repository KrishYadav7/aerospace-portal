/* Runs before the website's own scripts in every AeroGyan window (sandboxed). */
'use strict';
const { contextBridge, webFrame, ipcRenderer } = require('electron');

/* Voice typing needs Google's speech service, which only the Chrome
   browser has. Hide it so the AI Doubt Solver doesn't show a mic
   button that can never work (typing, paste, photos and files do). */
function hideVoice() {
  try { delete window.SpeechRecognition; } catch (e) {}
  try { delete window.webkitSpeechRecognition; } catch (e) {}
}
try {
  if (typeof contextBridge.executeInMainWorld === 'function') contextBridge.executeInMainWorld({ func: hideVoice });
  else webFrame.executeJavaScript('(' + hideVoice.toString() + ')()');
} catch (_) {
  try { webFrame.executeJavaScript('(' + hideVoice.toString() + ')()'); } catch (__) {}
}

/* Lets the website know it runs inside the desktop app. */
try {
  contextBridge.exposeInMainWorld('AeroGyanDesktop', Object.freeze({
    platform: process.platform,
    isDesktopApp: true,
    /* a stable key for this PC, the same in every AeroGyan app on it (one device slot):
       base64url(sha256("aerogyan-device:" + Windows MachineGuid)); "" when unavailable */
    deviceKey: () => {
      try { return String(ipcRenderer.sendSync('aerogyan:device-key') || ''); } catch (_) { return ''; }
    }
  }));
} catch (_) {}
