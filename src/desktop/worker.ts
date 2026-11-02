import { AntiRecoil } from '../anti-recoil';
import { RecoilEngine } from '../recoil-engine';
import { loadWindowsBackend } from '../windows-input';
import { InputBackend, inspectBackend, Key } from '../input';
import { DpiMeasurement } from './measurement';
import { Vector, WeaponProfile } from '../profiles';
import { BoardConnection } from './board';
import { BluetoothController } from '../bluetooth-controller';
import { ButtonInput, loadButtonInput } from '../button-input';
import { relayButtonInput } from '../relay-button-input';
import { Settings } from './settings';
import { idleTuning, LiveTuning } from '../live-tuning';
import { defaultBindings, GameBindings, validateBindings } from '../key-bindings';
import { GameAction, GameControls } from '../game-controls';
import { PullRecorder, recordingLimits } from '../pull-recording';

const port = process.parentPort;
if (!port) throw new Error('The input worker must be launched by Electron.');
let controller: AntiRecoil | BluetoothController | undefined;
let measurement: DpiMeasurement | undefined;
let backend: InputBackend | undefined;
let profile: WeaponProfile | null = null;
let ready = false;
let mice = 0;
let error: string | null = null;
let previous = '';
let shuttingDown = false;
let suspended = false;
let output: Settings['output'] = 'interception';
let relayMode = false;
let relayProfiles = false;
let tuning: LiveTuning | undefined;
let tuningLimits: readonly Vector[] | undefined;
let controls: GameControls | undefined;
let bindings = defaultBindings();
let weaponKeys: { id: string; hotkey: string | null }[] = [];
let gameId = '';
let stopEpoch = 0;
let switching = false;
const recorder = new PullRecorder();
let stopMotion: (() => void) | undefined;
let recordTimeout: ReturnType<typeof setTimeout> | undefined;
const board = new BoardConnection({ onChange: () => {
  if (controller instanceof BluetoothController) controller.checkOutput();
  if (recorder.active && !board.relayReady) void stopRecording('The relay disconnected, so recording stopped. Finished takes were kept.');
  publish();
} });

// Recording only listens to the relay. Compensation stays off for the whole session.
async function startRecording() {
  if (!relayMode || !relayProfiles) throw new Error('Recording a pull needs the ESP32 relay. Connect it under Settings › Board & Bluetooth.');
  if (!board.supportsTrace) throw new Error('Update the board firmware to 0.5.0 or later to record a pull.');
  if (!board.relayReady) throw new Error('Wait for the Cobra and Windows Bluetooth links before recording.');
  if (measurement?.state.running) throw new Error('Finish the DPI measurement before recording.');
  stopEpoch++;
  await controller?.setEnabled(false);
  tuning?.setActive(false);
  recorder.start();
  stopMotion?.();
  stopMotion = board.listenMotion(frame => { if (recorder.push(frame, !suspended)) publish(); });
  try { await board.setTrace(true); } catch (value) { await stopRecording(); throw value; }
  if (recordTimeout) clearTimeout(recordTimeout);
  recordTimeout = setTimeout(() => void stopRecording('Recording stopped after 10 minutes. Finished takes were kept.'), recordingLimits.maxSessionMs);
}
async function stopRecording(notice?: string) {
  const wasActive = recorder.active;
  if (recordTimeout) { clearTimeout(recordTimeout); recordTimeout = undefined; }
  stopMotion?.(); stopMotion = undefined;
  recorder.stop();
  if (wasActive) await board.setTrace(false).catch(() => {});
  if (notice) error = notice;
  publish();
}

function publish() {
  const state = {
    ready: relayMode && !relayProfiles ? board.relayReady : ready && (relayMode || output === 'bluetooth' ? board.profileReady : true), mice, error, suspended, output, stopEpoch,
    relay: relayMode, passthrough: relayMode && !relayProfiles,
    enabled: controller?.enabled ?? false,
    paused: controller?.status.paused ?? false,
    stance: relayMode && !relayProfiles ? 'Passthrough' : controller?.status.profile ?? 'Default',
    diagnostics: controller?.diagnostics ?? null,
    tuning: tuning?.state ?? idleTuning(),
    board: board.state,
    measurement: measurement?.state ?? { running: false, counts: 0, travel: 0, error: null },
    recording: { ...recorder.state, supported: board.supportsTrace, available: relayMode && relayProfiles && board.supportsTrace && board.relayReady },
  };
  if (relayMode && relayProfiles) board.syncIndicator(recorder.active || !state.enabled ? 0 : state.paused ? 2 : 1);
  const serialized = JSON.stringify(state);
  if (serialized !== previous) { previous = serialized; port!.postMessage({ type: 'state', state }); }
}
const ticker = setInterval(publish, 100);

async function configure(next: WeaponProfile | null, nextOutput = output) {
  await measurement?.stop();
  measurement = undefined;
  await controller?.dispose();
  controller = undefined;
  tuning = undefined;
  profile = next;
  output = nextOutput;
  ready = false;
  error = null;
  try {
    if (!controls) controls = new GameControls(loadButtonInput(), bindings, weaponKeys, gameAction, () => suspended);
    controls.start();
    controls.configure(bindings, weaponKeys);
    if (relayMode && !relayProfiles) { ready = true; mice = 0; publish(); return; }
    if (relayMode || output === 'bluetooth') {
      mice = 0;
      const buttons = relayMode ? relayButtonInput(controls, board) : controls;
      if (profile) {
        const engine = new RecoilEngine(profile);
        tuning = new LiveTuning(engine, tuningLimits);
        const tunedButtons: ButtonInput = { listen(listener) { return buttons.listen({
          keyDown(key) { listener.keyDown(key); tuneDown(key); },
          keyUp(key) { listener.keyUp(key); tuning?.keyUp(key); }, mouse: listener.mouse,
        }); } };
        controller = new BluetoothController(tunedButtons, board, engine, {
          legacyToggle: false, onStatus: publish, onError: value => { stopEpoch++; error = String(value); publish(); },
        });
        controller.start(); controller.setSuspended(suspended);
      }
      ready = true;
      publish(); return;
    }
    backend = loadWindowsBackend();
    mice = inspectBackend(backend);
    if (!mice) throw new Error('Interception cannot see a mouse. Restart Windows after installing the driver, then retry.');
    ready = true;
    if (profile) {
      const engine = new RecoilEngine(profile);
      tuning = new LiveTuning(engine, tuningLimits);
      const source = backend;
      const tunedBackend: InputBackend = { createContext: () => source.createContext(),
        listenKeyboard: (down, up) => controls!.listen({ keyDown: key => { down(key); tuneDown(key); }, keyUp: key => { up(key); tuning?.keyUp(key); }, mouse: () => {} }) };
      controller = new AntiRecoil(tunedBackend, {
        engine, legacyToggle: false, onStatus: () => publish(),
        onError: value => { stopEpoch++; error = String(value); publish(); },
      });
      controller.start();
      controller.setSuspended(suspended);
    }
  } catch (value) { ready = false; error = value instanceof Error ? value.message : String(value); }
  publish();
}

function tuneDown(key: Key) { if (key === 'escape') stopEpoch++; tuning?.keyDown(key, suspended); publish(); }

function gameAction(action: GameAction) {
  if (action === 'disable') { stopEpoch++; tuning?.setActive(false); publish(); return; }
  // Release always wins, including during a weapon switch or pending enable.
  if (typeof action === 'object' && 'compensation' in action && !action.compensation) {
    stopEpoch++; void controller?.setEnabled(false).then(publish).catch(value => { error = String(value); publish(); });
    publish(); return;
  }
  if (measurement?.state.running || switching) return;
  if (action === 'tuningToggle' || action === 'tuningTarget') {
    const key = action === 'tuningToggle' ? 'f8' : 'f9';
    tuning?.keyDown(key, suspended); tuning?.keyUp(key); publish(); return;
  }
  if (action === 'toggle' || typeof action === 'object' && 'compensation' in action) {
    stopEpoch++;
    if (recorder.active) { error = 'Stop recording before enabling compensation.'; publish(); return; }
    if (!controller) { error = 'Configure this weapon before enabling compensation.'; publish(); return; }
    const enabled = typeof action === 'object' ? action.compensation : !controller.enabled;
    void controller.setEnabled(enabled).then(() => { error = null; publish(); }).catch(value => { error = String(value); publish(); }); return;
  }
  const resume = controller?.enabled ?? false;
  if (tuning?.state.dirty) { error = 'Save or discard the live tuning draft in the Loadout Tune tab before changing weapons.'; publish(); return; }
  switching = true;
  void controller?.setEnabled(false);
  port!.postMessage({ type: 'weapon-select', gameId, resume, epoch: stopEpoch,
    request: typeof action === 'object' ? { id: action.weaponId } : { direction: action === 'nextWeapon' ? 1 : -1 } });
}

let queue = Promise.resolve();
port.on('message', event => {
  const message = event.data as { id: number; command: string; value?: unknown };
  queue = queue.then(async () => {
    try {
      if (shuttingDown) throw new Error('Input is shutting down.');
      switch (message.command) {
        case 'board-connect':
          stopEpoch++;
          if (typeof message.value !== 'string') throw new Error('Choose a board COM port.');
          await stopRecording();
          await controller?.setEnabled(false);
          await board.connect(message.value);
          relayMode = board.isRelay;
          relayProfiles = board.supportsProfiles;
          await configure(profile);
          break;
        case 'board-disconnect': stopEpoch++; await stopRecording(); await controller?.setEnabled(false); await board.disconnect(); break;
        case 'record-start': await startRecording(); break;
        case 'record-stop': await stopRecording(); break;
        case 'record-clear': recorder.clear(); break;
        case 'record-remove': recorder.remove(message.value as number); break;
        case 'board-brightness': await board.setBrightness(message.value); break;
        case 'board-led-count': await board.setLedCount(message.value); break;
        case 'board-pair-mouse': await board.pairMouse(); break;
        case 'board-reset-stats': await board.resetRelayStats(); break;
        case 'board-test':
          await controller?.setEnabled(false);
          await board.testMovement();
          break;
        case 'switch-prepare':
          if (tuning?.state.dirty) throw new Error('Save or discard the live tuning draft in the Loadout Tune tab before changing weapons.');
          if (measurement?.state.running) throw new Error('Finish DPI measurement before changing weapons.');
          switching = true;
          await controller?.setEnabled(false);
          break;
        case 'switch-cancel': switching = false; break;
        case 'configure': {
          const config = message.value as { profile: WeaponProfile | null; output: Settings['output']; tuningLimits?: Vector[]; bindings?: GameBindings; weapons?: typeof weaponKeys; gameId?: string; resumeEpoch?: number; resume?: boolean };
          if (!config || !['interception', 'bluetooth'].includes(config.output)) throw new Error('Invalid output configuration.');
          if (config.tuningLimits && (config.tuningLimits.length !== config.profile?.recoils.length || config.tuningLimits.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(v => !Number.isFinite(v) || v < 1 || v > 3)))) throw new Error('Invalid tuning limits.');
          tuningLimits = config.tuningLimits;
          if (gameId !== (config.gameId ?? '')) { controls?.cancelActivation(); controls?.resetStances(); }
          if (!config.resume) controls?.cancelActivation();
          bindings = validateBindings(config.bindings); weaponKeys = config.weapons ?? []; gameId = config.gameId ?? '';
          const resumeEpoch = config.resumeEpoch ?? stopEpoch;
          await configure(config.profile, config.output);
          switching = false;
          if (config.resume && resumeEpoch === stopEpoch && controller && ready && !recorder.active && (bindings.activationMode !== 'hold' || controls?.activationHeld)) await controller.setEnabled(true);
          break;
        }
        case 'tuning': {
          if (!tuning) throw new Error('Configure a weapon and connect its output before tuning.');
          const value = message.value as { action: string; step?: number; target?: number | null };
          if (value?.action === 'start') tuning.setActive(true);
          else if (value?.action === 'stop') tuning.setActive(false);
          else if (value?.action === 'step') tuning.setStep(value.step!);
          else if (value?.action === 'target') tuning.setTarget(value.target!);
          else if (value?.action === 'discard') { stopEpoch++; await controller?.setEnabled(false); tuning.reset(); error = null; }
          else throw new Error('Unknown tuning action.');
          break;
        }
        case 'suspend':
          suspended = message.value === true;
          if (suspended) controls?.cancelActivation();
          controller?.setSuspended(suspended);
          break;
        case 'enabled':
          if (message.value === false) { stopEpoch++; controls?.cancelActivation(); }
          if (message.value === true && bindings.activationMode === 'hold') throw new Error('Hold your assigned compensation key or mouse button to enable.');
          if (relayMode && !relayProfiles && message.value === true) throw new Error('Recoil is disabled while testing mouse passthrough.');
          if (relayMode && !relayProfiles && message.value === false) break;
          if (typeof message.value !== 'boolean') throw new Error('Invalid enabled state.');
          if (message.value && recorder.active) throw new Error('Stop recording before enabling compensation.');
          if (measurement?.state.running) throw new Error('Finish the DPI measurement before enabling.');
          if (measurement) await configure(profile);
          if (!controller || !ready) throw new Error(error ?? 'Set up a weapon profile before enabling.');
          await controller.setEnabled(message.value); error = null; break;
        case 'measure-start':
          if (relayMode) throw new Error('Driver DPI capture is unavailable in relay mode. Enter the mouse DPI manually.');
          await measurement?.stop();
          await controller?.dispose(); controller = undefined;
          backend = loadWindowsBackend();
          if (!inspectBackend(backend)) throw new Error('DPI measurement needs the Interception driver. Enter DPI manually instead.');
          const measureSource = backend;
          measurement = new DpiMeasurement({ createContext: () => measureSource.createContext(),
            listenKeyboard: (down, up) => controls!.listen({ keyDown: down, keyUp: up, mouse: () => {} }) }, publish);
          measurement.start(); break;
        case 'measure-stop': await measurement?.stop(); break;
        case 'shutdown':
          shuttingDown = true;
          clearInterval(ticker);
          await stopRecording();
          await measurement?.stop();
          await controller?.dispose();
          controls?.dispose();
          await board.disconnect();
          break;
        default: throw new Error('Unknown input command.');
      }
      publish();
      port!.postMessage({ type: 'reply', id: message.id, ok: true });
      if (shuttingDown) process.exit(0);
    } catch (value) {
      const messageError = value instanceof Error ? value.message : String(value);
      if (!message.command.startsWith('board-')) error = messageError;
      publish();
      port!.postMessage({ type: 'reply', id: message.id, ok: false, error: messageError });
    }
  });
});
