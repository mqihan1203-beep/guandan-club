const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  startLanServer: (options) => ipcRenderer.invoke('lan:start', options),
  startPublicServer: (options) => ipcRenderer.invoke('public:start', options),
  stopRoomServer: () => ipcRenderer.invoke('room:stop'),
  getRoomInfo: () => ipcRenderer.invoke('room:info'),
  startDiscovery: () => ipcRenderer.invoke('lan:discover:start'),
  stopDiscovery: () => ipcRenderer.invoke('lan:discover:stop'),
  onDiscoveredRoom: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('lan:room', handler);
    return () => ipcRenderer.removeListener('lan:room', handler);
  }
});
