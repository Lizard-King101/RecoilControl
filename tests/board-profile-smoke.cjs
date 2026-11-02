// Opt-in hardware test: a 120 ms burst from the selected profile, no mouse clicks.
const assert = require('node:assert/strict');
const path = require('node:path');
const { BoardConnection } = require('../build/desktop/board');
const { SettingsStore, effectiveProfile } = require('../build/desktop/settings');
const { BluetoothController } = require('../build/bluetooth-controller');
const { RecoilEngine } = require('../build/recoil-engine');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.argv.includes('--move')) throw Error('Explicit movement opt-in required: COM3 --move');
const board = new BoardConnection();
let controller, buttons;
(async () => {
  const settings = new SettingsStore(path.join(process.env.APPDATA, 'Recoil Control', 'settings.json')).load();
  const profile = effectiveProfile(settings);
  assert.ok(profile, 'Select a configured weapon first');
  await board.connect(process.argv[2] ?? 'COM3');
  assert.equal(board.state.status.protocol, 2, 'This generated-input test is for legacy firmware 0.2. Relay profiles require physical Cobra input.');
  const deadline = Date.now() + 5000;
  while (!board.profileReady && Date.now() < deadline) await delay(50);
  assert.equal(board.profileReady, true, 'Bluetooth mouse must be connected');
  const before = board.state.status.reports;
  const errors = [];
  controller = new BluetoothController({ listen(value) { buttons = value; return () => {}; } }, board,
    new RecoilEngine(profile), { onError: error => errors.push(String(error)) });
  controller.start(); await controller.setEnabled(true);
  buttons.mouse('left', true); await delay(120); buttons.mouse('left', false);
  await controller.setEnabled(false);
  await delay(550);
  assert.deepEqual(errors, []);
  assert.ok(controller.diagnostics.movementsAccepted >= 2, 'Expected several profile frames');
  assert.equal(board.state.status.reports - before, controller.diagnostics.movementsAccepted);
  assert.equal(board.state.status.armed, false);
  const stopped = board.state.status.reports;
  await delay(550);
  assert.equal(board.state.status.reports, stopped, 'No reports after release');
  console.log(`PASS: ${profile.name}, ${controller.diagnostics.movementsAccepted} Bluetooth profile reports; release stopped output.`);
  console.log(JSON.stringify({ diagnostics: controller.diagnostics, board: board.state.status }));
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await controller?.dispose(); await board.disconnect(); });
