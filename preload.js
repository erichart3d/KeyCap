'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keycapApp', {
  api(method, path, body) {
    return ipcRenderer.invoke('keycap:api', { method, path, body });
  },
  getShellState() {
    return ipcRenderer.invoke('keycap:get-shell-state');
  },
  getStreamingStatus() {
    return ipcRenderer.invoke('keycap:get-streaming-status');
  },
  startStreamingServer() {
    return ipcRenderer.invoke('keycap:start-streaming-server');
  },
  stopStreamingServer() {
    return ipcRenderer.invoke('keycap:stop-streaming-server');
  },
  chooseRecordingOutputPath() {
    return ipcRenderer.invoke('keycap:choose-recording-output-path');
  },
  listCaptureSources() {
    return ipcRenderer.invoke('keycap:list-capture-sources');
  },
  saveRecordingFile(payload) {
    return ipcRenderer.invoke('keycap:save-recording-file', payload);
  },
  revealPath(targetPath) {
    return ipcRenderer.invoke('keycap:reveal-path', targetPath);
  },
  openExternal(url) {
    return ipcRenderer.invoke('keycap:open-external', url);
  },
  onAppEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('keycap:app-event', handler);
    return () => ipcRenderer.removeListener('keycap:app-event', handler);
  },

  // Offscreen overlay capture — used by recording mode to bake a
  // pixel-perfect overlay into the composite canvas. Main spins up a hidden
  // BrowserWindow pointed at the real overlay page, then streams its paint
  // frames here as raw BGRA buffers.
  startOverlayCapture(options) {
    return ipcRenderer.invoke('keycap:start-overlay-capture', options || {});
  },
  stopOverlayCapture() {
    return ipcRenderer.invoke('keycap:stop-overlay-capture');
  },
  onOverlayFrame(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('keycap:overlay-frame', handler);
    return () => ipcRenderer.removeListener('keycap:overlay-frame', handler);
  },
});
