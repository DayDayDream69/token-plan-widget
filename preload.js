'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('widget', {
  init: () => ipcRenderer.invoke('widget:init'),
  getUsage: (force) => ipcRenderer.invoke('widget:get-usage', force),
  getModelUsage: (range, force) => ipcRenderer.invoke('widget:get-model-usage', range, force),
  setKey: (key) => ipcRenderer.invoke('widget:set-key', key),
  clearKey: () => ipcRenderer.invoke('widget:clear-key'),
  setMode: (mode) => ipcRenderer.invoke('widget:set-mode', mode),
  setExpanded: (value) => ipcRenderer.invoke('widget:set-expanded', value),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('widget:set-always-on-top', value),
  hide: () => ipcRenderer.invoke('widget:hide'),
  quit: () => ipcRenderer.invoke('widget:quit'),
  openDocs: () => ipcRenderer.invoke('widget:open-docs'),

  dragStart: (point) => ipcRenderer.invoke('widget:drag-start', point),
  dragMove: (point) => ipcRenderer.invoke('widget:drag-move', point),
  dragEnd: () => ipcRenderer.invoke('widget:drag-end'),

  resizePill: (width) => ipcRenderer.invoke('widget:resize-pill', width),

  onModeChanged: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('widget:mode-changed', listener)
    return () => ipcRenderer.removeListener('widget:mode-changed', listener)
  },
  onRefreshRequest: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('widget:refresh-request', listener)
    return () => ipcRenderer.removeListener('widget:refresh-request', listener)
  },
  onOpenSettings: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('widget:open-settings', listener)
    return () => ipcRenderer.removeListener('widget:open-settings', listener)
  }
})
