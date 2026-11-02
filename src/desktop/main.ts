import { app, BrowserWindow, dialog, globalShortcut, ipcMain, IpcMainInvokeEvent, screen, shell, utilityProcess, UtilityProcess } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyLiveTuning, effectiveProfile, selected, selectWeapon, SettingsStore, tuningLimits, validateSettings, validateWeapon, validateProfile } from './settings';
import { RecoilEngine } from '../recoil-engine';
import type { AntiRecoil } from '../anti-recoil';
import { idleBoardState, listBoardPorts } from './board';
import { flashFirmware, FirmwareFlashError, idleFirmwareUpdate, loadRelease, restartFirmwarePort } from './firmware-update';
import { FirmwarePort, recoverFirmware } from './firmware-recovery';
import { idleTuning } from '../live-tuning';
import { idleRecording } from '../pull-recording';
import { defaultBindings, keyChoices } from '../key-bindings';

app.setName('Recoil Control');
app.setAppUserModelId('local.recoil.control');
app.setPath('userData', join(app.getPath('appData'), 'Recoil Control'));
const root = resolve(__dirname, '../..');
const testData = process.env.RECOIL_TEST_DATA_DIR;
const headlessTest = process.env.RECOIL_TEST_HEADLESS === '1';
if (headlessTest) app.disableHardwareAcceleration();
if (testData) app.setPath('userData', resolve(testData));
const store = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
let settings = store.load();
let mainWindow: BrowserWindow;
let hud: BrowserWindow;
let worker: UtilityProcess | undefined;
let quitting = false;
let shortcutReady = false;
let requestId = 0;
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let runtime = {
  passthrough: false,
  relay: false,
  output: settings.output,
  ready: false, mice: 0, error: null as string | null, enabled: false, paused: false, suspended: false, stance: 'Default', stopEpoch: 0,
  measurement: { running: false, counts: 0, travel: 0, error: null as string | null },
  diagnostics: null as AntiRecoil['diagnostics'] | null,
  tuning: idleTuning(),
  recording: idleRecording(),
};

let boardState = idleBoardState();
// Firmware bundled with the app (firmware/release, built by npm run firmware:build) and any update in progress.
const firmwareDirectory = join(root, 'firmware/release');
let bundledFirmware: string | null = null;
try { bundledFirmware = loadRelease(firmwareDirectory)?.version ?? null; } catch (error) { console.error('Bundled firmware:', error); }
let firmwareUpdate = idleFirmwareUpdate();
let firmwareOperationPending = false;
let firmwareRecovery: { target: FirmwarePort; expectedVersion: string | null; requireRelay: boolean; failure: string | null } | null = null;
function state() { return { settings, runtime, board: boardState, firmware: { bundled: bundledFirmware, update: firmwareUpdate }, warning: store.warning, shortcutReady, version: app.getVersion(), keyChoices, defaultBindings: defaultBindings() }; }
function broadcast() {
  if (hud && !hud.isDestroyed()) {
    const height = 104 + (settings.hud.locked ? 0 : 38) + (runtime.tuning.active || runtime.tuning.dirty ? 48 : 0);
    if (hud.getSize()[1] !== height) { hud.setSize(316, height); placeHud(); }
  }
  for (const window of [mainWindow, hud]) {
    if (window && !window.isDestroyed()) window.webContents.send('control:state', state());
  }
}
function command(command: string, value?: unknown, timeoutMs = 4000): Promise<void> {
  if (!worker) return Promise.reject(new Error('Input process is unavailable. Restart the application.'));
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The input process did not respond.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, command, value });
  });
}

function startWorker() {
  worker = utilityProcess.fork(join(__dirname, 'worker.js'), [], { serviceName: 'Recoil input', stdio: 'pipe' });
  worker.stdout?.on('data', chunk => console.log(String(chunk).trim()));
  worker.stderr?.on('data', chunk => console.error(String(chunk).trim()));
  worker.on('message', message => {
    if (message.type === 'weapon-select') {
      void serialize(async () => {
        if (message.gameId !== settings.selectedGameId) { await command('switch-cancel'); return; }
        await switchWeapon(message.request, message.resume, message.epoch);
      }).catch(error => { void command('switch-cancel').catch(console.error); runtime.error = String(error); broadcast(); });
    }
    if (message.type === 'state') {
      const { board, ...input } = message.state;
      runtime = input; boardState = board; broadcast();
    }
    if (message.type === 'reply') {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.ok) operation.resolve(); else operation.reject(new Error(message.error));
    }
  });
  worker.on('exit', code => {
    worker = undefined;
    boardState = { ...idleBoardState(), error: quitting ? null : 'Input worker stopped. Reconnect after restarting the app.' };
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error('Input process exited.')); }
    pending.clear();
    runtime = { ...runtime, ready: false, enabled: false, paused: false, diagnostics: null, tuning: idleTuning(), recording: { ...idleRecording(), takes: runtime.recording.takes },
      error: quitting ? null : `Input process stopped (${code}). Restart the application to reconnect.`,
      measurement: { ...runtime.measurement, running: false } };
    broadcast();
  });
  void command('configure', configuration()).then(() => command('suspend', mainWindow.isFocused())).catch(error => { runtime.error = String(error); broadcast(); });
}

function configuration() { const { game } = selected(settings); return { profile: effectiveProfile(settings), output: settings.output, tuningLimits: tuningLimits(settings),
  bindings: game.bindings, weapons: game.weapons.map(({ id, hotkey }) => ({ id, hotkey })), gameId: game.id }; }
function requireSavedTuning() {
  if (runtime.tuning.dirty) throw new Error('Save or discard the live tuning draft in the Loadout Tune tab before changing profiles or reconnecting.');
}

async function switchWeapon(request: unknown, resume = runtime.enabled, resumeEpoch = runtime.stopEpoch) {
  requireSavedTuning();
  if (!request || typeof request !== 'object') throw new Error('Choose a weapon.');
  const next = selectWeapon(settings, request);
  // Always configure: a hotkey has already stopped the old output, even if a
  // collection has only one configured weapon and cycles back to itself.
  await command('switch-prepare');
  try {
    settings = store.save(next);
    await command('configure', { ...configuration(), resume: resume && !!effectiveProfile(settings), resumeEpoch });
  } catch (error) { await command('switch-cancel'); throw error; }
  broadcast(); return state();
}

function protect(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    void command('enabled', false).catch(console.error);
  });
  window.webContents.on('did-finish-load', broadcast);
}

function showMain() {
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function placeHud() {
  const height = hud.getSize()[1];
  const bounds = screen.getPrimaryDisplay().workArea;
  let x = settings.hud.x ?? bounds.x + bounds.width - 342;
  let y = settings.hud.y ?? bounds.y + 44;
  const display = screen.getDisplayMatching({ x, y, width: 316, height }).workArea;
  x = Math.round(Math.max(display.x, Math.min(x, display.x + display.width - 316)));
  y = Math.round(Math.max(display.y, Math.min(y, display.y + display.height - height)));
  hud.setPosition(x, y);
}
function updateHud() {
  hud.setAlwaysOnTop(true, 'floating');
  hud.setOpacity(settings.hud.opacity);
  hud.setIgnoreMouseEvents(settings.hud.locked, { forward: true });
  hud.setFocusable(!settings.hud.locked);
  if (settings.hud.visible && !headlessTest) hud.showInactive(); else hud.hide();
  broadcast();
}

let mutation = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = mutation.then(task);
  mutation = result.then(() => {}, () => {});
  return result;
}

async function save(value: unknown, commitTuning = false) {
  if (!commitTuning) requireSavedTuning();
  const next = validateSettings(value);
  // HUD placement is managed by its own window, not by a potentially stale form.
  next.hud = settings.hud;
  if (runtime.enabled) await command('enabled', false);
  settings = store.save(next);
  if (worker) await command('configure', configuration());
  broadcast();
  return state();
}

function authorize(event: IpcMainInvokeEvent, mainOnly = true) {
  const validWindow = event.sender === mainWindow.webContents || (!mainOnly && event.sender === hud.webContents);
  if (!validWindow || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted request.');
}
function handle(channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => unknown, mainOnly = true) {
  ipcMain.handle(`control:${channel}`, async (event, value) => {
    authorize(event, mainOnly);
    return handler(event, value);
  });
}

// Connects the board when exactly one is plugged in. A port the user disconnected is left
// alone until it is unplugged; a failed attempt waits before trying again.
let autoConnectDeclined: string | null = null;
let autoConnectRetryAt = 0;
async function autoConnect() {
  if (!worker || quitting || firmwareUpdate.running || firmwareUpdate.recoveryAvailable || boardState.connected || runtime.tuning.dirty || Date.now() < autoConnectRetryAt) return;
  const ports = await listBoardPorts();
  if (autoConnectDeclined && !ports.some(port => port.path === autoConnectDeclined)) autoConnectDeclined = null;
  const candidates = ports.filter(port => port.path !== autoConnectDeclined);
  if (candidates.length !== 1) return; // None, or several boards: leave the choice to the user.
  await serialize(async () => {
    if (quitting || firmwareUpdate.running || firmwareUpdate.recoveryAvailable || boardState.connected || runtime.tuning.dirty || Date.now() < autoConnectRetryAt) return;
    await command('board-connect', candidates[0].path);
  }).catch(error => { autoConnectRetryAt = Date.now() + 15000; console.error('Board auto-connect:', error); });
}

async function finishFirmwareRecovery() {
  if (!firmwareRecovery) throw new Error('There is no pending board recovery.');
  const pendingRecovery = firmwareRecovery;
  firmwareUpdate = { ...firmwareUpdate, running: true, error: null, recoveryAvailable: false, stage: 'Checking the board after restart' };
  broadcast();
  try {
    const result = await recoverFirmware({ ...pendingRecovery, ports: listBoardPorts,
      state: () => boardState,
      connect: path => command('board-connect', path, 8000),
      disconnect: () => command('board-disconnect', undefined, 8000),
      restart: port => restartFirmwarePort(port.path, port),
      progress: stage => { firmwareUpdate = { ...firmwareUpdate, stage, progress: 0.98 }; broadcast(); },
    });
    firmwareRecovery = null;
    firmwareUpdate = { ...idleFirmwareUpdate(), progress: 1,
      installed: pendingRecovery.failure ? null : result.version,
      stage: result.relayReady ? `Firmware ${result.version} is running. Both mouse links are connected.` : `Firmware ${result.version} is running. Pair the mouse and Windows to use the relay.`,
      error: pendingRecovery.failure ? `${pendingRecovery.failure} The board is running ${result.version} again; retry the update when ready.` : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    firmwareUpdate = { ...firmwareUpdate, running: false, installed: null, recoveryAvailable: true,
      stage: 'Board recovery needs attention', error: [pendingRecovery.failure, message].filter(Boolean).join(' ') };
  } finally { autoConnectDeclined = null; autoConnectRetryAt = Date.now() + 2500; broadcast(); }
}

// Flash, release the port, and verify the running application plus mouse links.
// General auto-connect stays out of the way until this transaction finishes.
async function updateFirmware() {
  // Test runs share this machine with real hardware and must never flash it.
  if (headlessTest) throw new Error('Firmware updates are disabled in automated tests.');
  requireSavedTuning();
  const release = loadRelease(firmwareDirectory);
  if (!release) throw new Error('This copy of the app has no bundled firmware. Run npm run firmware:build first.');
  const ports = await listBoardPorts();
  const target = ports.find(port => port.path === boardState.path) ?? (ports.length === 1 ? ports[0] : undefined);
  if (!target) throw new Error(ports.length ? 'Several boards are plugged in. Connect the one to update first.' : 'Plug in the board over USB first.');
  const boardBeforeUpdate = boardState.status;
  firmwareRecovery = null;
  let lastBroadcast = 0;
  firmwareUpdate = { ...idleFirmwareUpdate(), running: true, stage: 'Disconnecting the app from the board' };
  broadcast();
  try {
    await command('board-disconnect');
    firmwareRecovery = { target, expectedVersion: release.version,
      requireRelay: !boardBeforeUpdate || !!boardBeforeUpdate.relay?.savedMouse || !!boardBeforeUpdate.ble, failure: null };
    await flashFirmware(target.path, target, release, (stage, progress) => {
      firmwareUpdate = { ...firmwareUpdate, stage, progress };
      if (Date.now() - lastBroadcast > 150) { lastBroadcast = Date.now(); broadcast(); }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = `Firmware update failed: ${message}${error instanceof FirmwareFlashError && error.writeStarted ? ' Writing had started; an incomplete image needs another firmware update, not just a reset.' : ''}`;
    if (firmwareRecovery) { firmwareRecovery.failure = failure; firmwareRecovery.expectedVersion = null; }
    else { firmwareUpdate = { ...idleFirmwareUpdate(), error: failure }; broadcast(); return; }
  }
  await finishFirmwareRecovery();
}

function registerIpc() {
  handle('get', () => state(), false);
  handle('firmware-update', () => {
    if (firmwareOperationPending) throw new Error('A firmware operation is already running.');
    firmwareOperationPending = true;
    return serialize(async () => { await updateFirmware(); return state(); }).finally(() => { firmwareOperationPending = false; });
  });
  handle('firmware-recover', () => {
    if (firmwareOperationPending) throw new Error('A firmware operation is already running.');
    firmwareOperationPending = true;
    return serialize(async () => {
      if (headlessTest) throw new Error('Board recovery is disabled in automated tests.');
      requireSavedTuning();
      if (!firmwareRecovery) throw new Error('There is no pending board recovery.');
      await command('board-disconnect', undefined, 8000);
      await finishFirmwareRecovery(); return state();
    }).finally(() => { firmwareOperationPending = false; });
  });
  handle('board-ports', () => listBoardPorts());
  handle('board-connect', (_event, value) => serialize(async () => {
    requireSavedTuning();
    if (typeof value !== 'string' || !(await listBoardPorts()).some(port => port.path === value)) throw new Error('Select a connected ESP32 USB port.');
    autoConnectDeclined = null;
    await command('board-connect', value); return state();
  }));
  handle('board-disconnect', () => serialize(async () => { autoConnectDeclined = boardState.path; await command('board-disconnect'); return state(); }));
  handle('board-brightness', (_event, value) => serialize(async () => { await command('board-brightness', value); return state(); }));
  handle('board-led-count', (_event, value) => serialize(async () => { await command('board-led-count', value); return state(); }));
  handle('board-pair-mouse', () => serialize(async () => { await command('board-pair-mouse'); return state(); }));
  handle('board-reset-stats', () => serialize(async () => { await command('board-reset-stats'); return state(); }));
  handle('board-test', () => serialize(async () => {
    if (!mainWindow.isFocused()) throw new Error('Keep this configuration window focused for the desktop movement test.');
    await command('board-test'); return state();
  }));
  handle('board-bluetooth', () => shell.openExternal('ms-settings:bluetooth'));
  handle('save', (_event, value) => serialize(() => save(value)));
  handle('weapon-select', (_event, value) => serialize(() => switchWeapon(value)), false);
  handle('enabled', (_event, value) => serialize(async () => {
    if (typeof value !== 'boolean') throw new Error('Invalid control state.');
    if (value && !effectiveProfile(settings)) throw new Error('Configure this weapon before enabling it.');
    await command('enabled', value); return state();
  }), false);
  handle('retry', () => serialize(async () => {
    requireSavedTuning();
    if (!worker) startWorker(); else await command('configure', configuration());
    return state();
  }));
  handle('show', () => { showMain(); }, false);
  handle('hud', (_event, value) => serialize(async () => {
    if (!value || typeof value !== 'object') throw new Error('Invalid HUD settings.');
    const patch = value as Record<string, unknown>;
    if (patch.locked === true && !shortcutReady) throw new Error('The restore shortcut is unavailable. Keep the HUD unlocked.');
    settings = store.save({ ...settings, hud: { ...settings.hud, ...patch } });
    updateHud(); return state();
  }));
  handle('hud-mode', () => serialize(async () => {
    if (settings.hud.locked && !shortcutReady) throw new Error('Unlock the HUD first.');
    settings = store.save({ ...settings, hud: { ...settings.hud, visible: true } });
    updateHud(); mainWindow.hide(); return state();
  }));
  handle('preview', (_event, value) => {
    const { game, weapon } = selected(settings);
    const request = typeof value === 'object' && value ? value as { stance: number; profile: unknown } : null;
    const profile = request ? validateProfile(request.profile) : effectiveProfile(settings);
    value = request ? request.stance : value;
    if (!profile || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= profile.recoils.length) return null;
    const stance = profile.recoils[value];
    const engine = new RecoilEngine(profile);
    engine.setInput({ shooting: true, paused: false, aiming: stance.activate.includes('aiming'), crouching: stance.activate.includes('crouching') });
    const frames = Math.min(600, Math.ceil((60000 / profile.rpm) * stance.vectors.length / (1000 / 60)));
    let x = 0; let y = 0;
    const points = [{ x, y }];
    const duration = Math.min(10000, (60000 / profile.rpm) * stance.vectors.length);
    for (let frame = 0; frame < frames; frame++) { const delta = engine.advance(Math.min(1000 / 60, duration - frame * 1000 / 60)); x += delta[0]; y += delta[1]; points.push({ x, y }); }
    return { points, duration, name: weapon.name, game: game.name };
  });
  handle('tuning', (_event, value) => serialize(async () => {
    if (value && typeof value === 'object' && (value as { action: string }).action === 'save') {
      await command('tuning', { action: 'stop' });
      await command('enabled', false);
      return save(applyLiveTuning(settings, runtime.tuning), true);
    }
    await command('tuning', value); return state();
  }));
  handle('record', (_event, value) => serialize(async () => {
    const action = typeof value === 'string' ? value : '';
    if (!['start', 'stop', 'clear'].includes(action)) throw new Error('Unknown recording action.');
    if (action === 'start') requireSavedTuning();
    await command(`record-${action}`); return state();
  }));
  handle('record-remove', (_event, value) => serialize(async () => {
    if (!Number.isInteger(value) || (value as number) < 0) throw new Error('Choose a recorded take.');
    await command('record-remove', value); return state();
  }));
  handle('measure-start', () => serialize(async () => { requireSavedTuning(); await command('measure-start'); return state(); }));
  handle('measure-stop', () => serialize(async () => { await command('measure-stop'); return state(); }));
  handle('measure-apply', (_event, value) => serialize(async () => {
    if (typeof value !== 'number' || value < 2 || value > 100) throw new Error('Enter a physical distance between 2 and 100 cm.');
    const measurement = runtime.measurement;
    if (measurement.running || measurement.error || measurement.counts < 100) throw new Error('Finish a valid movement measurement first.');
    if (measurement.travel > measurement.counts * 1.2) throw new Error('Too much back-and-forth movement. Measure again in one direction.');
    const next = structuredClone(settings);
    selected(next).game.input.dpi = Math.round(measurement.counts * 2.54 / value);
    return save(next);
  }));
  handle('calibrate', (_event, value) => serialize(async () => {
    const next = structuredClone(settings);
    const { game, weapon } = selected(next);
    weapon.tuning = value as typeof weapon.tuning;
    const checked = validateSettings(next);
    const profile = effectiveProfile(checked);
    if (!profile) throw new Error('Configure a pattern before calibrating.');
    // Rebase the raw profile so recording a new sensitivity baseline preserves output.
    // Keep residual global strength when baking it all into stance multipliers
    // would exceed their saved range (common for counts-per-shot profiles).
    const residual = [0, 1].map(axis => Math.max(1, ...profile.recoils.map(stance => stance.multipliers[axis] / 2)));
    weapon.profile = { ...profile, recoils: profile.recoils.map(stance => ({ ...stance,
      multipliers: [stance.multipliers[0] / residual[0], stance.multipliers[1] / residual[1]],
    })) };
    weapon.tuning = { x: residual[0], y: residual[1] };
    weapon.calibration = { ...game.input, at: new Date().toISOString() };
    weapon.provenance = 'calibrated';
    return save(next);
  }));
  handle('import', () => serialize(async () => {
    requireSavedTuning();
    if (runtime.enabled) await command('enabled', false);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import weapon profile', filters: [{ name: 'Recoil profile', extensions: ['json'] }], properties: ['openFile'] });
    if (result.canceled) return state();
    const data = readFileSync(result.filePaths[0], 'utf8');
    if (data.length > 500000) throw new Error('Profile file is too large.');
    const imported = JSON.parse(data);
    if (!['recoil-control/weapon-v1', 'recoil-control/weapon-v2'].includes(imported.format)) throw new Error('This file is not a Recoil Control weapon export.');
    const weapon = validateWeapon(imported.weapon);
    weapon.id = randomUUID();
    weapon.hotkey = null;
    // Imported calibration is not a verified measurement of this setup.
    weapon.provenance = weapon.profile ? 'manual' : 'template'; weapon.calibration = null;
    const next = structuredClone(settings);
    const { game } = selected(next);
    game.weapons.push(weapon); game.selectedWeaponId = weapon.id;
    return save(next);
  }));
  handle('export', async () => {
    requireSavedTuning();
    if (runtime.enabled) await command('enabled', false);
    const { weapon } = selected(settings);
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export weapon profile', defaultPath: `${weapon.name.replace(/[^a-z0-9_-]/gi, '-')}.json`, filters: [{ name: 'Recoil profile', extensions: ['json'] }] });
    if (!result.canceled && result.filePath) writeFileSync(result.filePath, JSON.stringify({ format: weapon.profile?.units === 'counts' ? 'recoil-control/weapon-v2' : 'recoil-control/weapon-v1', weapon }, null, 2), 'utf8');
    return !result.canceled;
  });
  handle('source', async (_event, value) => {
    const sources = ['https://rust.facepunch.com/news/the-combat-update', 'https://rust.facepunch.com/news/built-different'];
    if (typeof value !== 'number' || !sources[value]) throw new Error('Unknown source.');
    await shell.openExternal(sources[value]);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) showMain(); });
  void app.whenReady().then(async () => {
    const preload = join(__dirname, 'preload.js');
    const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: headlessTest };
    mainWindow = new BrowserWindow({ width: 1280, height: 850, minWidth: 1060, minHeight: 720,
      title: 'Recoil Control', backgroundColor: '#101113', show: false,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#9aa0a6', height: 36 }, webPreferences });
    mainWindow.setMenuBarVisibility(false);
    hud = new BrowserWindow({ width: 316, height: 104, resizable: false, frame: false, transparent: true,
      alwaysOnTop: true, skipTaskbar: true, show: false, title: 'Recoil HUD', webPreferences });
    protect(mainWindow); protect(hud);
    const suspendForUi = () => { if (worker) void command('suspend', mainWindow.isFocused() || hud.isFocused()).catch(console.error); };
    mainWindow.on('focus', suspendForUi); mainWindow.on('blur', suspendForUi);
    hud.on('focus', suspendForUi); hud.on('blur', suspendForUi);
    mainWindow.on('close', event => { if (firmwareOperationPending) event.preventDefault(); });
    mainWindow.on('closed', () => app.quit());
    hud.on('close', event => { if (!quitting) { event.preventDefault(); hud.hide(); settings.hud.visible = false; broadcast(); } });
    let moveTimer: ReturnType<typeof setTimeout>;
    hud.on('moved', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (quitting || hud.isDestroyed()) return;
        const [x, y] = hud.getPosition();
        try { settings = store.save({ ...settings, hud: { ...settings.hud, x, y } }); broadcast(); } catch (error) { console.error(error); }
      }, 250);
    });
    shortcutReady = globalShortcut.register('CommandOrControl+Shift+H', showMain);
    if (!shortcutReady) settings.hud.locked = false;
    registerIpc();
    await Promise.all([mainWindow.loadFile(join(root, 'ui/index.html')), hud.loadFile(join(root, 'ui/hud.html'))]);
    placeHud(); updateHud(); if (!headlessTest) mainWindow.show(); startWorker();
    // Tests never touch real hardware, so they must not grab a board plugged into this machine.
    if (!headlessTest) setInterval(() => void autoConnect().catch(console.error), 2000);
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('before-quit', event => {
    if (firmwareOperationPending) { event.preventDefault(); return; }
    if (quitting) return;
    event.preventDefault(); quitting = true;
    globalShortcut.unregisterAll();
    const timer = setTimeout(() => { worker?.kill(); app.exit(0); }, 2000);
    void command('shutdown').catch(console.error).finally(() => { clearTimeout(timer); app.quit(); });
  });
}
