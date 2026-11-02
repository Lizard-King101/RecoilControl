import { writeFileSync } from 'node:fs';
import { app, BrowserWindow, desktopCapturer, DesktopCapturerSource, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { MouseButtons, mouseDevices, allowMouseRead } from './mouse-buttons';
import { PortalPointer } from './portal-pointer';
import { VisionSession, VisionMode } from './vision-session';
import { Settings, validateProfile } from './settings';
import { visionContext } from './vision-settings';

export function createVisionLab(root: string, options: {
  getSettings: () => Settings; disable: () => Promise<void>;
  save: (key: string, stance: number, vectors: unknown, rpm: number) => Promise<void>;
  headless?: boolean;
}) {
  let window: BrowserWindow | undefined;
  let armRevision = 0;
  let sources: DesktopCapturerSource[] = [], chosen: DesktopCapturerSource | undefined;
  const pointer = new PortalPointer();
  const bridge = new VisionSession(pointer, event => { if (window && !window.isDestroyed()) window.webContents.send('vision:event', event); }, () => !!window && !window.isDestroyed() && !window.isFocused());
  const mouse = new MouseButtons(pressed => bridge.mouseInput(pressed, !window?.isFocused()), reason => { bridge.disarm(reason); });
  const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
  const partition = session.fromPartition('vision-lab');
  partition.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window?.webContents && ['display-capture', 'media'].includes(permission)));
  partition.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== window?.webContents.mainFrame) { callback({}); return; }
    try {
      // PipeWire selection belongs to this request. Do not cache its source between two UI clicks.
      const source = wayland
        ? (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }))[0]
        : chosen;
      chosen = undefined;
      if (!source || request.frame !== window?.webContents.mainFrame) { callback({}); return; }
      callback({ video: source });
    } catch { callback({}); }
  });
  ipcMain.handle('vision:call', async (event, action: string, value: any) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted lab request.');
    switch (action) {
      case 'diagnostics': {
        const report = JSON.stringify(value, null, 2);
        if (!report || Buffer.byteLength(report) > 512000) throw new Error('Analysis report is too large.');
        writeFileSync(join(app.getPath('userData'), 'vision-diagnostics.json'), report);
        return;
      }
      case 'context': return visionContext(options.getSettings());
      case 'sources':
        if (wayland) return { systemPicker: true };
        sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        return sources.map(s => ({ id: s.id, name: s.name }));
      case 'choose-source': chosen = sources.find(s => s.id === value); if (!chosen) throw new Error('Choose an available screen or window.'); return;
      case 'capture-alive': bridge.captureAlive(); return;
      case 'mouse-list': return mouseDevices();
      case 'mouse-allow': armRevision++; bridge.disarm(); return allowMouseRead(value);
      case 'mouse-connect': armRevision++; bridge.disarm(); await mouse.connect(value); return { connected: mouse.connected };
      case 'mouse-close': armRevision++; bridge.disarm(); mouse.close(); return;
      case 'capture-frame': bridge.captureFrame(); return;
      case 'link': return bridge.listen();
      case 'pointer': await pointer.connect(); return bridge.state;
      case 'pointer-close': armRevision++; bridge.disarm(); pointer.close(); return bridge.state;
      case 'calibrate': {
        if (!value || value.key !== visionContext(options.getSettings()).key) throw new Error('The active setup changed. Reload the lab.');
        const revision = ++armRevision;
        await options.disable();
        if (revision !== armRevision) throw new Error('Calibration cancelled.');
        if (value.key !== visionContext(options.getSettings()).key) throw new Error('The active setup changed. Reload the lab.');
        return bridge.calibrate(value.countdown);
      }
      case 'arm': {
        if (!value || value.key !== visionContext(options.getSettings()).key) throw new Error('The active setup changed. Reload the lab.');
        const profile = validateProfile(value.profile, []), revision = ++armRevision;
        await options.disable();
        if (revision !== armRevision) throw new Error('Arming cancelled.');
        if (value.key !== visionContext(options.getSettings()).key) throw new Error('The active setup changed. Reload the lab.');
        if (value.trigger === 'countdown' && !mouse.connected) throw new Error('Connect the fire-button listener first.');
        bridge.arm(profile, value.mode as VisionMode, value.trigger, value.countdown); return bridge.state;
      }
      case 'stop': armRevision++; bridge.disarm(); return bridge.state;
      case 'save':
        armRevision++; bridge.disarm();
        await options.save(value?.key, value?.stance, value?.vectors, value?.rpm); return visionContext(options.getSettings());
      default: throw new Error('Unknown lab action.');
    }
  });
  return {
    async open() {
      await options.disable();
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ width: 1250, height: 880, minWidth: 960, minHeight: 700, title: 'Vision lab', backgroundColor: '#101113', show: !options.headless,
        webPreferences: { preload: join(root, 'build/desktop/vision-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'vision-lab', backgroundThrottling: false, offscreen: !!options.headless } });
      window.setMenuBarVisibility(false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('render-process-gone', () => { armRevision++; bridge.close(); pointer.close(); mouse.close(); });
      window.on('closed', () => { armRevision++; bridge.close(); pointer.close(); mouse.close(); sources = []; chosen = undefined; window = undefined; });
      await window.loadFile(join(root, 'ui/vision.html'));
    },
    stop() { armRevision++; bridge.disarm('Configuration changed. Re-arm the lab to continue.'); },
    close() { armRevision++; bridge.close(); pointer.close(); mouse.close(); window?.destroy(); },
  };
}
