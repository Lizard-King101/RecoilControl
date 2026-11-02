const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoilEngine } = require('../build/recoil-engine');
const { LiveTuning } = require('../build/live-tuning');
const { BluetoothController } = require('../build/bluetooth-controller');
const { defaultSettings, effectiveProfile, selected, applyLiveTuning, validateProfile, tuningLimits } = require('../build/desktop/settings');
const tools = require('../ui/pattern-tools');
const { akProfile } = require('../build/profiles');
const input = (aiming = false, crouching = false) => ({ shooting: true, paused: false, aiming, crouching });
const tap = (tuner, key, suspended = false) => { tuner.keyDown(key, suspended); tuner.keyUp(key); };
function total(profile, aiming, crouching, milliseconds) {
  const engine = new RecoilEngine(profile); engine.setInput(input(aiming, crouching));
  const result = [0, 0];
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 10) {
    const delta = engine.advance(Math.min(10, milliseconds - elapsed));
    result[0] += delta[0]; result[1] += delta[1];
  }
  return result;
}

test('live arrows affect only the current stance, ignore autorepeat/focused config, and Escape ends editing', () => {
  const engine = new RecoilEngine(akProfile), tuner = new LiveTuning(engine);
  tap(tuner, 'up'); assert.equal(tuner.state.dirty, false);
  tap(tuner, 'f8'); engine.setInput(input(true, false));
  tuner.keyDown('down', false); tuner.keyDown('down', false); tuner.keyUp('down');
  assert.equal(tuner.state.stances[2].y, 0.99);
  tap(tuner, 'right'); assert.equal(tuner.state.stances[2].x, 1.01);
  engine.setInput(input(true, true)); tap(tuner, 'left');
  assert.deepEqual(tuner.state.stances.map(s => [s.x, s.y]), [[1, 1], [1, 1], [1.01, 0.99], [0.99, 1]]);
  tap(tuner, 'up', true); tap(tuner, 'f8', true); assert.equal(tuner.state.active, true);
  assert.equal(tuner.state.stances[3].y, 1);
  tap(tuner, 'escape'); tap(tuner, 'up'); assert.equal(tuner.state.active, false);
  assert.equal(tuner.state.dirty, true);
  tuner.reset(); assert.equal(tuner.state.dirty, false);
});

test('tuning gains stay bounded and saving preserves the sensitivity reference and other stances', () => {
  const settings = defaultSettings(), weapon = selected(settings).weapon;
  weapon.calibration = { ...selected(settings).game.input, sensitivity: 0.5, at: '2026-11-01T12:00:00Z' };
  const engine = new RecoilEngine(effectiveProfile(settings));
  const tuner = new LiveTuning(engine, tuningLimits(settings)); tuner.setActive(true); tuner.setStep(0.05);
  engine.setInput(input(true, false));
  for (let i = 0; i < 100; i++) tap(tuner, 'up');
  assert.equal(tuner.state.stances[2].y, 3);
  for (let i = 0; i < 100; i++) tap(tuner, 'left');
  assert.equal(tuner.state.stances[2].x, 0);
  const saved = applyLiveTuning(settings, tuner.state), result = selected(saved).weapon;
  assert.deepEqual(result.calibration, weapon.calibration);
  assert.deepEqual(result.profile.recoils[3], weapon.profile.recoils[3]);
  assert.equal(result.profile.recoils[2].multipliers[0], 0);
  assert.equal(result.profile.recoils[2].multipliers[1], 0.1 * 3);
  assert.equal(result.provenance, 'manual');
  assert.equal(weapon.profile.recoils[2].multipliers[1], 0.1);
  assert.throws(() => tuner.setStep(NaN));
  assert.throws(() => applyLiveTuning(settings, { ...tuner.state, stances: [] }));
});

test('a locked tuning target survives releasing ADS/crouch without changing the output stance', () => {
  const engine = new RecoilEngine(akProfile), tuner = new LiveTuning(engine);
  const reference = new RecoilEngine(akProfile);
  engine.setInput(input(true, true));
  tuner.setTarget(3); tuner.setActive(true);
  // Release both stance buttons, then edit with free hands.
  engine.setInput(input()); reference.setInput(input());
  tap(tuner, 'down'); tap(tuner, 'left');
  assert.equal(engine.stanceIndex, 0);
  assert.equal(tuner.state.current, 3);
  assert.equal(tuner.state.target, 3);
  assert.deepEqual(tuner.state.stances.map(s => [s.x, s.y]), [[1, 1], [1, 1], [1, 1], [0.99, 0.99]]);
  assert.deepEqual(engine.advance(100), reference.advance(100));
  tuner.setTarget(null); tap(tuner, 'up');
  assert.equal(tuner.state.current, 0);
  assert.equal(tuner.state.stances[0].y, 1.01);
  engine.setInput(input(true, false)); tap(tuner, 'up');
  assert.equal(tuner.state.stances[2].y, 1.01);
  tuner.setTarget(3); tuner.reset();
  assert.equal(tuner.state.target, null);
  assert.equal(tuner.state.dirty, false);
});

test('F9 cycles available targets only while tuning, ignores held keys, and validates target selection', () => {
  const tuner = new LiveTuning(new RecoilEngine(akProfile));
  tap(tuner, 'f9'); assert.equal(tuner.state.target, null);
  tap(tuner, 'f8');
  tuner.keyDown('f9', false); tuner.keyDown('f9', false); tuner.keyUp('f9');
  assert.equal(tuner.state.target, 0);
  tap(tuner, 'f9', true); assert.equal(tuner.state.target, 0);
  for (const target of [1, 2, 3, null]) { tap(tuner, 'f9'); assert.equal(tuner.state.target, target); }
  for (const invalid of [-1, 4, 0.5, NaN, undefined, '3']) assert.throws(() => tuner.setTarget(invalid));
  tuner.setTarget(3); tap(tuner, 'escape'); tap(tuner, 'f9');
  assert.equal(tuner.state.active, false);
  assert.equal(tuner.state.target, 3);
  const single = new LiveTuning(new RecoilEngine({ ...akProfile, recoils: [akProfile.recoils[0]] }));
  single.setActive(true); tap(single, 'f9'); assert.equal(single.state.target, 0);
  tap(single, 'f9'); assert.equal(single.state.target, null);
});

test('live tuning changes output without restarting shot position; reset restores the saved strength', () => {
  const profile = { name: 'Test', units: 'counts', rpm: 600, mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: [[0, 10], [0, 100]] }] };
  const engine = new RecoilEngine(profile), tuner = new LiveTuning(engine);
  engine.setInput(input()); engine.advance(100);
  tuner.setActive(true); tuner.setStep(0.05); tap(tuner, 'down');
  assert.ok(Math.abs(engine.advance(100)[1] - 95) <= 1);
  tuner.reset(); assert.ok(Math.abs(engine.advance(100)[1] - 100) <= 1);
});

test('legacy conversion preserves the integrated output in every stance', () => {
  const converted = validateProfile(tools.toCounts(akProfile));
  assert.equal(converted.units, 'counts');
  for (const aim of [false, true]) for (const crouch of [false, true]) {
    for (const duration of [133, 800, 1700]) {
      const old = total(akProfile, aim, crouch, duration), next = total(converted, aim, crouch, duration);
      next.forEach((v, i) => assert.ok(Math.abs(v - old[i]) <= 1, `${duration}: ${old} != ${next}`));
    }
  }
  assert.deepEqual(tools.toCounts(converted), converted);
});

test('returning to configuration and saving keeps all stance edits across a reload and editor conversion', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const { SettingsStore } = require('../build/desktop/settings');
  const settings = defaultSettings(), engine = new RecoilEngine(effectiveProfile(settings));
  const tuner = new LiveTuning(engine);
  const controller = new BluetoothController({ listen() { return () => {}; } }, {
    profileReady: true, async disarm() {}, async moveProfile() { throw new Error('This test must not send mouse movement'); },
  }, engine, { clock: { now: () => 0, every: () => () => {} } });
  const root = path.resolve(__dirname, '../.tmp/tuning-save-tests');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(fs.mkdtempSync(path.join(root, 'run-')), 'settings.json');
  const store = new SettingsStore(file);
  try {
    controller.start(); await controller.setEnabled(true); tuner.setActive(true);
    for (const [i, x, y] of [[0, -5, -5], [1, -20, -21], [2, 6, 8], [3, -17, -10]]) {
      tuner.setTarget(i);
      for (let n = 0; n < Math.abs(x); n++) tap(tuner, x < 0 ? 'left' : 'right');
      for (let n = 0; n < Math.abs(y); n++) tap(tuner, y < 0 ? 'down' : 'up');
    }
    const draft = tuner.state;
    const before = settings.games[0].weapons[0].profile.recoils.map(s => {
      engine.reset(); engine.setInput(input(s.activate.includes('aiming'), s.activate.includes('crouching')));
      return engine.advance(100);
    });
    // Focus pauses the engine. Save tuning then stops editing and disables output.
    controller.setSuspended(true);
    tuner.setActive(false); await controller.setEnabled(false);
    assert.deepEqual(tuner.state.stances, draft.stances);
    assert.equal(tuner.state.dirty, true);
    store.save(applyLiveTuning(settings, tuner.state));
    const reloaded = new SettingsStore(file).load();
    const newEngine = new RecoilEngine(effectiveProfile(reloaded));
    const newTuner = new LiveTuning(newEngine);
    assert.equal(newTuner.state.dirty, false);
    assert.ok(newTuner.state.stances.every(s => s.x === 1 && s.y === 1));
    const edited = tools.toCounts(selected(reloaded).weapon.profile);
    assert.ok(edited.recoils.every(s => s.multipliers[0] === 1 && s.multipliers[1] === 1));
    edited.recoils.forEach((s, i) => {
      newEngine.reset(); newEngine.setInput(input(s.activate.includes('aiming'), s.activate.includes('crouching')));
      assert.deepEqual(newEngine.advance(100), before[i]);
      const oldCounts = tools.shotCounts(selected(reloaded).weapon.profile, i);
      const editorCounts = tools.shotCounts(edited, i);
      oldCounts.forEach((v, axis) => assert.ok(Math.abs(v - editorCounts[axis]) < 1e-8));
    });
  } finally { await controller.dispose(); }
});

test('counts-per-shot patterns preserve distance when RPM changes; generation and pasted pairs validate', () => {
  const profile = { name: 'Measured', units: 'counts', rpm: 600, mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: [[-12, 40]] }] };
  assert.deepEqual(total(profile, false, false, 100), total({ ...profile, rpm: 300 }, false, false, 200));
  assert.deepEqual(tools.ramp(3, [0, 10], [-10, 30]), [[0, 10], [-5, 20], [-10, 30]]);
  assert.deepEqual(tools.ramp(1, [1, 2], [3, 4]), [[1, 2]]);
  assert.deepEqual(tools.parse('1, 2\n-3 4'), [[1, 2], [-3, 4]]);
  for (const bad of ['', '1,', '1, 2, 3', 'NaN 2', '1001 0']) assert.throws(() => tools.parse(bad));
  assert.throws(() => tools.ramp(121, [0, 0], [0, 0]));
  assert.throws(() => validateProfile({ ...profile, units: 'unknown' }));
});

test('counts tuning can increase again after repeated saves and reloads, including an existing 2x multiplier', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { SettingsStore } = require('../build/desktop/settings');
  const root = path.resolve(__dirname, '../.tmp/tuning-save-tests');
  fs.mkdirSync(root, { recursive: true });
  for (const initialMultiplier of [1, 1.99, 2]) {
    let settings = defaultSettings();
    const game = selected(settings).game; game.selectedWeaponId = 'lr300';
    const weapon = selected(settings).weapon;
    weapon.profile = { name: 'LR-300', units: 'counts', rpm: 600, mode: 'end', recoils: [
      { name: 'Default', activate: [], multipliers: [1, initialMultiplier], vectors: [[-0.2, 4.125628], [0.1, 3.25]] },
      { name: 'ADS', activate: ['aiming'], multipliers: [0.8, 1.2], vectors: [[1, 5], [-1, 8]] },
    ] };
    weapon.provenance = 'manual';
    weapon.tuning = { x: 1.2, y: 0.8 };
    weapon.calibration = { ...game.input, sensitivity: 0.5, at: '2026-11-01T12:00:00Z' };
    const original = structuredClone(settings);
    const file = path.join(fs.mkdtempSync(path.join(root, 'counts-')), 'settings.json');
    const store = new SettingsStore(file);
    let combined = initialMultiplier;
    for (const target of [2, 1.5, 2]) {
      const engine = new RecoilEngine(effectiveProfile(settings));
      const tuner = new LiveTuning(engine, tuningLimits(settings));
      tuner.setActive(true); tuner.setStep(0.05);
      assert.equal(tuner.state.stances[0].maxY, 3);
      for (let i = 0; i < Math.round((target - 1) / 0.05); i++) tap(tuner, 'up');
      assert.equal(tuner.state.stances[0].y, target);
      engine.setInput(input());
      const before = [0, 0];
      for (let i = 0; i < 50; i++) engine.advance(10).forEach((v, axis) => { before[axis] += v; });
      const saved = store.save(applyLiveTuning(settings, tuner.state));
      settings = new SettingsStore(file).load();
      const result = selected(settings).weapon;
      combined *= target;
      assert.deepEqual(result.profile.recoils[0].multipliers, [1, 1]);
      assert.ok(Math.abs(result.profile.recoils[0].vectors[0][1] - 4.125628 * combined) < 1e-10);
      assert.equal(result.profile.recoils[0].vectors[0][0], -0.2);
      assert.deepEqual(result.profile.recoils[1], selected(original).weapon.profile.recoils[1]);
      assert.deepEqual(result.tuning, weapon.tuning);
      assert.deepEqual(result.calibration, weapon.calibration);
      const after = total(effectiveProfile(saved), false, false, 500);
      after.forEach((v, axis) => assert.ok(Math.abs(v - before[axis]) <= 1));
      const nextTuner = new LiveTuning(new RecoilEngine(effectiveProfile(settings)), tuningLimits(settings));
      nextTuner.setActive(true); tap(nextTuner, 'up');
      assert.equal(nextTuner.state.stances[0].y, 1.01);
    }
    assert.equal(weapon.profile.recoils[0].multipliers[1], initialMultiplier);
    assert.deepEqual(settings.games[0].weapons[0], original.games[0].weapons[0]);
  }
});

test('rebasing respects per-shot bounds for counts and legacy patterns without stranding multiplier headroom', () => {
  for (const units of ['counts', undefined]) {
    const settings = defaultSettings(), weapon = selected(settings).weapon;
    const bound = units === 'counts' ? 1000 : 10;
    weapon.profile = { name: 'Bounded', units, rpm: 600, mode: 'end', recoils: [
      { name: 'Default', activate: [], multipliers: [2, 2], vectors: [[-bound / 2, bound / 4], [bound / 4, -bound / 2]] },
    ] };
    assert.deepEqual(tuningLimits(settings), [[2, 2]]);
    const tuner = new LiveTuning(new RecoilEngine(effectiveProfile(settings)), tuningLimits(settings));
    tuner.setActive(true); tuner.setStep(0.05);
    for (let i = 0; i < 50; i++) { tap(tuner, 'right'); tap(tuner, 'up'); }
    assert.equal(tuner.state.stances[0].x, 2); assert.equal(tuner.state.stances[0].y, 2);
    const saved = applyLiveTuning(settings, tuner.state);
    assert.deepEqual(selected(saved).weapon.profile.recoils[0].vectors, [[-bound, bound / 2], [bound / 2, -bound]]);
    assert.deepEqual(selected(saved).weapon.profile.recoils[0].multipliers, [2, 2]);
    assert.deepEqual(tuningLimits(saved), [[1, 1]]);
    const invalid = { ...tuner.state, stances: [{ ...tuner.state.stances[0], x: 2.01 }] };
    assert.throws(() => applyLiveTuning(settings, invalid), /Horizontal tuning/);
    const limitTuner = new LiveTuning(new RecoilEngine(effectiveProfile(saved)), tuningLimits(saved));
    limitTuner.setActive(true); tap(limitTuner, 'up'); assert.equal(limitTuner.state.stances[0].y, 1);
    tap(limitTuner, 'down'); const reduced = applyLiveTuning(saved, limitTuner.state);
    assert.ok(tools.shotCounts(selected(reduced).weapon.profile)[1] < tools.shotCounts(selected(saved).weapon.profile)[1]);
  }
});
