import { contextBridge, ipcRenderer } from 'electron';

// Only named operations cross the renderer boundary; never expose ipcRenderer itself.
contextBridge.exposeInMainWorld('control', {
  getState: () => ipcRenderer.invoke('control:get'),
  boardPorts: () => ipcRenderer.invoke('control:board-ports'),
  connectBoard: (path: string) => ipcRenderer.invoke('control:board-connect', path),
  disconnectBoard: () => ipcRenderer.invoke('control:board-disconnect'),
  setBoardBrightness: (brightness: number) => ipcRenderer.invoke('control:board-brightness', brightness),
  setLedCount: (count: number) => ipcRenderer.invoke('control:board-led-count', count),
  updateFirmware: () => ipcRenderer.invoke('control:firmware-update'),
  pairBoardMouse: () => ipcRenderer.invoke('control:board-pair-mouse'),
  resetRelayStats: () => ipcRenderer.invoke('control:board-reset-stats'),
  testBoardMovement: () => ipcRenderer.invoke('control:board-test'),
  openBluetooth: () => ipcRenderer.invoke('control:board-bluetooth'),
  save: (settings: unknown) => ipcRenderer.invoke('control:save', settings),
  selectWeapon: (request: { id?: string; direction?: number }) => ipcRenderer.invoke('control:weapon-select', request),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('control:enabled', enabled),
  retry: () => ipcRenderer.invoke('control:retry'),
  showMain: () => ipcRenderer.invoke('control:show'),
  setHud: (patch: unknown) => ipcRenderer.invoke('control:hud', patch),
  hudMode: () => ipcRenderer.invoke('control:hud-mode'),
  preview: (stance: number) => ipcRenderer.invoke('control:preview', stance),
  previewDraft: (profile: unknown, stance: number) => ipcRenderer.invoke('control:preview', { profile, stance }),
  tune: (action: string, step?: number) => ipcRenderer.invoke('control:tuning', { action, step }),
  setTuningTarget: (target: number | null) => ipcRenderer.invoke('control:tuning', { action: 'target', target }),
  record: (action: 'start' | 'stop' | 'clear') => ipcRenderer.invoke('control:record', action),
  removeTake: (index: number) => ipcRenderer.invoke('control:record-remove', index),
  startMeasurement: () => ipcRenderer.invoke('control:measure-start'),
  stopMeasurement: () => ipcRenderer.invoke('control:measure-stop'),
  applyMeasurement: (distance: number) => ipcRenderer.invoke('control:measure-apply', distance),
  calibrate: (tuning: unknown) => ipcRenderer.invoke('control:calibrate', tuning),
  importProfile: () => ipcRenderer.invoke('control:import'),
  exportProfile: () => ipcRenderer.invoke('control:export'),
  openSource: (index: number) => ipcRenderer.invoke('control:source', index),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('control:state', listener);
    return () => ipcRenderer.removeListener('control:state', listener);
  },
});
