const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoilEngine } = require('../build/recoil-engine');
const { GameControls } = require('../build/game-controls');
const { BluetoothController } = require('../build/bluetooth-controller');
const { defaultBindings, validateBindings, stanceBindings } = require('../build/key-bindings');
const { defaultSettings, validateSettings, validateProfile, bindingsForGame, selected, SettingsStore } = require('../build/desktop/settings');
const { exportWeapon, importWeapon } = require('../build/desktop/profile-sharing');
const { validateStances } = require('../build/stances');
const { fixture, mouseStroke } = require('./helpers.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stances = [{ id: 'crouching', name: 'Crouch' }, { id: 'prone', name: 'Prone' }, { id: 'mounted', name: 'Mounted' }];
const row = (name, activate, y) => ({ name, activate, multipliers: [1, 1], vectors: [[0, y]] });
const profile = { name: 'Test', units: 'counts', rpm: 600, mode: 'end', recoils: [
  row('Default', [], 10), row('ADS', ['aiming'], 8), row('Crouch', ['crouching'], 6),
  row('Crouch ADS', ['crouching', 'aiming'], 5), row('Prone', ['prone'], 4),
  row('Prone ADS', ['prone', 'aiming'], 3), row('Mounted', ['mounted'], 2),
] };
const input = { shooting: true, aiming: false, crouching: false, paused: false };
function configured() {
  const s = defaultSettings(); s.games[0].stances = structuredClone(stances);
  s.games[0].weapons[0].profile = structuredClone(profile);
  return s;
}
function controlsFixture() {
  let raw, suspended = false;
  const held = new Set();
  const bindings = { ...defaultBindings(), stances: [
    { id: 'crouching', key: 'control', mode: 'hold' },
    { id: 'prone', key: 'keyz', mode: 'toggle' },
    { id: 'mounted', key: 'keyb', mode: 'hold' },
  ] };
  const controls = new GameControls({ listen(l) { raw = l; return () => {}; } }, bindings, [], () => {}, () => suspended);
  controls.start(); controls.listen({ keyDown: k => held.add(k), keyUp: k => held.delete(k), mouse() {} });
  return { raw, controls, held, bindings, suspend(value) { suspended = value; }, tap(k) { raw.keyDown(k); raw.keyUp(k); } };
}

test('old settings migrate without adding prone to Rust or changing patterns', () => {
  const old = defaultSettings(); old.version = 1; delete old.games[0].stances;
  const next = validateSettings(old);
  assert.equal(next.version, 3);
  assert.deepEqual(next.games[0].stances, [{ id: 'crouching', name: 'Crouch' }]);
  assert.deepEqual(next.games[0].weapons, old.games[0].weapons);
  assert.deepEqual(bindingsForGame(next.games[0]).stances, [{ id: 'crouching', key: 'control', mode: 'hold' }]);
  next.games[0].stances = []; next.games[0].weapons.forEach(w => { w.profile = null; w.provenance = 'template'; });
  assert.deepEqual(bindingsForGame(validateSettings(next).games[0]).stances, []);
});
test('prone and custom postures persist with their independent patterns and game controls', () => {
  const s = configured(); s.games[0].bindings.stances = [{ id: 'prone', key: 'keyz', mode: 'toggle' }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recoil-stances-'));
  try {
    const store = new SettingsStore(path.join(dir, 'settings.json')); store.save(s);
    assert.deepEqual(store.load(), validateSettings(s));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('stance definitions and references reject invalid or ambiguous data', () => {
  for (const value of [[{ id: 'aiming', name: 'ADS' }], [{ id: '__proto__', name: 'Bad' }], [{ id: 'prone', name: '' }], [...stances, stances[0]], Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))]) assert.throws(() => validateStances(value));
  const p = structuredClone(profile);
  assert.throws(() => validateProfile(p), /stances|condition/);
  assert.doesNotThrow(() => validateProfile(p, stances));
  p.recoils[4].activate = ['crouching', 'prone'];
  assert.throws(() => validateProfile(p, stances), /one posture/);
  const s = configured(); s.games[0].stances = [{ id: 'crouching', name: 'Crouch' }];
  assert.throws(() => validateSettings(s));
});
test('engine selects prone, prone ADS, and custom postures regardless of row order', () => {
  for (const rows of [profile.recoils, [...profile.recoils].reverse()]) {
    const engine = new RecoilEngine({ ...profile, recoils: rows });
    for (const [posture, aiming, expected, y] of [[null, false, 'Default', 10], [null, true, 'ADS', 8], ['prone', false, 'Prone', 4], ['prone', true, 'Prone ADS', 3], ['mounted', true, 'Mounted', 2], ['missing', true, 'ADS', 8]]) {
      engine.reset(); engine.setInput({ ...input, posture, aiming, crouching: true });
      assert.equal(engine.profile.name, expected);
      const result = engine.advance(100); assert.ok(Math.abs(result[1] - y) <= 1);
    }
  }
});
test('stance keys select one posture, ignore repeats, and restore held posture on release', () => {
  const f = controlsFixture();
  f.raw.keyDown('control'); assert.deepEqual([...f.held], ['control']);
  f.raw.keyDown('keyz'); f.raw.keyDown('keyz'); f.raw.keyUp('keyz');
  assert.deepEqual([...f.held], ['stance:prone']);
  f.tap('keyz'); assert.deepEqual([...f.held], ['control']);
  f.raw.keyDown('keyb'); assert.deepEqual([...f.held], ['stance:mounted']);
  f.raw.keyUp('keyb'); assert.deepEqual([...f.held], ['control']);
  f.raw.keyUp('control'); assert.equal(f.held.size, 0);
  f.tap('keyz'); f.raw.keyDown('keyb'); f.raw.keyUp('keyb');
  assert.equal(f.held.size, 0, 'choosing another posture clears a toggled posture');
  f.controls.dispose();
});
test('toggle state survives weapon/controller replacement but resets on Escape, controls changes, or game changes', () => {
  const f = controlsFixture(); f.tap('keyz');
  f.controls.configure(structuredClone(f.bindings), [{ id: 'next', hotkey: null }]);
  const seen = []; const stop = f.controls.listen({ keyDown: k => seen.push(k), keyUp() {}, mouse() {} });
  assert.deepEqual(seen, ['stance:prone']); stop();
  f.tap('escape'); assert.equal(f.held.size, 0);
  f.suspend(true); f.tap('keyz'); assert.equal(f.held.size, 0);
  f.suspend(false); f.tap('keyz'); f.suspend(true); f.tap('keyb');
  assert.deepEqual([...f.held], ['stance:prone'], 'typing while configuring must not clear the toggled stance');
  f.suspend(false); f.controls.resetStances(); assert.equal(f.held.size, 0);
  f.tap('keyz'); f.controls.configure(defaultBindings(), []); assert.equal(f.held.size, 0);
  f.controls.dispose();
});
test('stance binding validation rejects duplicate keys, IDs, action conflicts, and invalid modes', () => {
  const base = { ...defaultBindings(), stances: [{ id: 'prone', key: 'keyz', mode: 'toggle' }] };
  assert.equal(validateBindings(base).stances[0].mode, 'toggle');
  assert.throws(() => validateBindings({ ...base, toggle: 'ctrl+keyz' }), /stance key/);
  for (const stances of [[...base.stances, { id: 'mounted', key: 'keyz', mode: 'hold' }], [...base.stances, base.stances[0]], [{ id: 'prone', key: 'f7', mode: 'hold' }], [{ id: 'prone', key: 'shift', mode: 'toggle' }], [{ id: 'prone', key: 'keyz', mode: 'unknown' }]]) assert.throws(() => validateBindings({ ...base, stances }));
});
test('v4 sharing carries custom definitions but preserves local keys and does not overwrite local patterns', () => {
  const source = configured(), { game, weapon } = selected(source);
  weapon.hotkey = 'num1';
  const payload = exportWeapon(weapon, game.stances);
  assert.equal(payload.format, 'recoil-control/weapon-v4'); assert.equal(payload.weapon.hotkey, null);
  const local = defaultSettings(), old = structuredClone(local.games[0].weapons[0]);
  const result = importWeapon(local, JSON.parse(JSON.stringify(payload)), 'new-id');
  assert.deepEqual(result.games[0].weapons[0], old);
  assert.deepEqual(selected(result).weapon.profile, weapon.profile);
  assert.equal(selected(result).weapon.id, 'new-id');
  assert.equal(selected(result).weapon.calibration, null);
  assert.deepEqual(result.games[0].stances, stances);
  assert.deepEqual(stanceBindings(result.games[0].bindings), stanceBindings(local.games[0].bindings));
  assert.equal(local.games[0].weapons.length, 6);
  assert.throws(() => importWeapon(local, { ...payload, stances: [] }, 'bad'));
  assert.throws(() => importWeapon(local, { ...payload, format: 'recoil-control/weapon-v99' }, 'bad'));
});
test('legacy exports still import and same-named custom stances do not acquire local bindings', () => {
  const local = defaultSettings();
  for (const format of ['recoil-control/weapon-v1', 'recoil-control/weapon-v2']) {
    const result = importWeapon(local, { format, weapon: local.games[0].weapons[0] }, format);
    assert.deepEqual(selected(result).weapon.profile, local.games[0].weapons[0].profile);
  }
  const source = configured(); source.games[0].stances[2].name = 'Crouch';
  const payload = { format: 'recoil-control/weapon-v3', stances: [{ id: 'mounted', name: 'Crouch' }], weapon: { ...selected(source).weapon, profile: { ...profile, recoils: [profile.recoils[0], profile.recoils[6]] } } };
  const result = importWeapon(local, payload, 'new');
  assert.equal(result.games[0].stances.find(s => s.id === 'mounted').name, 'Crouch (2)');
  assert.equal(stanceBindings(result.games[0].bindings).some(b => b.id === 'mounted'), false);
});
test('Bluetooth controller receives custom posture and ADS through game controls without hardware', async () => {
  const f = controlsFixture();
  const engine = new RecoilEngine(profile);
  const controller = new BluetoothController(f.controls, { profileReady: true, async moveProfile() { return true; }, async disarm() {} }, engine,
    { legacyToggle: false, clock: { now: () => 0, every: () => () => {} } });
  controller.start(); await controller.setEnabled(true);
  f.tap('keyz'); assert.equal(controller.status.profile, 'Prone');
  f.raw.mouse('right', true); assert.equal(controller.status.profile, 'Prone ADS');
  f.raw.keyDown('control'); assert.equal(controller.status.profile, 'Crouch ADS');
  await controller.dispose(); f.controls.dispose();
});
test('Interception adapter preserves custom posture keys through the controller', async () => {
  const f = fixture({ profile }); await f.start();
  f.backend.down('stance:prone');
  await f.input(f.device(), mouseStroke(1 | 4));
  assert.equal(f.app.status.profile, 'Prone ADS');
  f.backend.up('stance:prone'); assert.equal(f.app.status.profile, 'ADS');
  await f.stop(); assert.deepEqual(f.errors, []);
});
