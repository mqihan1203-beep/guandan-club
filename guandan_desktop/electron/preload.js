const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  startLanServer: (options) => ipcRenderer.invoke('lan:start', options),
  stopLanServer: () => ipcRenderer.invoke('lan:stop'),
  getLanInfo: () => ipcRenderer.invoke('lan:info'),
  startDiscovery: () => ipcRenderer.invoke('lan:discover:start'),
  stopDiscovery: () => ipcRenderer.invoke('lan:discover:stop'),
  onDiscoveredRoom: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lan:room', handler);
    return () => ipcRenderer.removeListener('lan:room', handler);
  }
});
