import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('vision', {
  call: (action: string, value?: unknown) => ipcRenderer.invoke('vision:call', action, value),
  onEvent: (callback: (value: unknown) => void) => {
    const listener = (_event: unknown, value: unknown) => callback(value);
    ipcRenderer.on('vision:event', listener);
    return () => ipcRenderer.removeListener('vision:event', listener);
  },
});
