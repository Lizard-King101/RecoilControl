const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultSettings, validateSettings, validateProfile, validateWeapon, selected, effectiveProfile, SettingsStore } = require('../build/desktop/settings');

test('Rust defaults preserve the legacy AK and leave unknown weapon patterns unconfigured', () => {
  const settings = validateSettings(defaultSettings());
  const { game, weapon } = selected(settings);
  assert.equal(game.name, 'Rust');
  assert.equal(weapon.provenance, 'legacy');
  assert.equal(weapon.calibration, null);
  assert.equal(game.weapons.filter(item => item.profile).length, 1);
  game.selectedWeaponId = 'mp5';
  assert.equal(effectiveProfile(settings), null);
});

test('output selection persists and old settings migrate to the legacy driver', () => {
  const settings = defaultSettings();
  delete settings.output;
  assert.equal(validateSettings(settings).output, 'interception');
  settings.output = 'bluetooth';
  assert.equal(validateSettings(settings).output, 'bluetooth');
  settings.output = 'unknown';
  assert.throws(() => validateSettings(settings), /output/);
});

test('all selected game and weapon references must resolve uniquely', () => {
  const settings = defaultSettings();
  settings.selectedGameId = 'missing';
  assert.throws(() => validateSettings(settings), /Selected game/);
  settings.selectedGameId = 'rust';
  settings.games[0].selectedWeaponId = 'missing';
  assert.throws(() => validateSettings(settings), /Selected weapon/);
  settings.games[0].selectedWeaponId = 'ak';
  settings.games[0].weapons.push(settings.games[0].weapons[0]);
  assert.throws(() => validateSettings(settings), /Duplicate/);
});

test('malformed and unbounded imported vectors, modes, stances, and settings are rejected', () => {
  const settings = defaultSettings();
  for (const mutate of [
    p => p.rpm = Infinity,
    p => p.rpm = 0,
    p => p.mode = 'unknown',
    p => p.recoils[0].vectors = [],
    p => p.recoils[0].vectors = [[NaN, 1]],
    p => p.recoils[0].vectors = [[1, 1, 1]],
    p => p.recoils[0].multipliers = [99999, 1],
    p => p.recoils[0].activate = ['unknown'],
    p => p.recoils[0].activate = ['aiming', 'aiming'],
  ]) {
    const profile = structuredClone(selected(settings).weapon.profile);
    mutate(profile);
    assert.throws(() => validateProfile(profile));
  }
  settings.hud.opacity = 2;
  assert.throws(() => validateSettings(settings), /opacity/);
  const weapon = selected(defaultSettings()).weapon;
  weapon.provenance = 'calibrated';
  assert.throws(() => validateWeapon(weapon), /Calibration/);
});

test('sensitivity and ADS scaling use the calibration baseline, while DPI does not scale raw output', () => {
  const settings = defaultSettings();
  const { game, weapon } = selected(settings);
  weapon.calibration = { dpi: 800, sensitivity: 1, adsMultiplier: 1, at: new Date().toISOString() };
  const before = effectiveProfile(settings);
  game.input.dpi = 1600;
  assert.deepEqual(effectiveProfile(settings), before);
  game.input.sensitivity = 2;
  game.input.adsMultiplier = 2;
  const after = effectiveProfile(settings);
  for (let index = 0; index < before.recoils.length; index++) {
    const factor = before.recoils[index].activate.includes('aiming') ? 0.25 : 0.5;
    assert.equal(after.recoils[index].multipliers[0], before.recoils[index].multipliers[0] * factor);
  }
});

test('rebasing calibration to the current input preserves the actual output', () => {
  const settings = defaultSettings();
  const { game, weapon } = selected(settings);
  weapon.calibration = { dpi: 800, sensitivity: 1, adsMultiplier: 1, at: new Date().toISOString() };
  game.input.sensitivity = 2;
  weapon.tuning = { x: 1.2, y: 0.8 };
  const before = effectiveProfile(settings);
  weapon.profile = before;
  weapon.calibration = { ...game.input, at: new Date().toISOString() };
  weapon.tuning = { x: 1, y: 1 };
  assert.deepEqual(effectiveProfile(settings), before);
});

test('settings persist and a malformed previous file is backed up instead of silently discarded', () => {
  const root = path.resolve(__dirname, '../.tmp/settings-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file);
  const settings = store.load();
  settings.games[0].input.dpi = 1200;
  store.save(settings);
  assert.equal(new SettingsStore(file).load().games[0].input.dpi, 1200);
  fs.writeFileSync(file, '{ invalid config');
  assert.equal(store.load().games[0].input.dpi, 800);
  assert.match(store.warning, /backed up/);
  store.save(settings);
  assert.equal(fs.readFileSync(file + '.backup', 'utf8'), '{ invalid config');
});
