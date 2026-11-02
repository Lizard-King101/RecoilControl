const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { defaultSettings, validateSettings, selected, activeSetup, selectWeapon, effectiveProfile, tuningLimits, applyLiveTuning, SettingsStore } = require('../build/desktop/settings');
const { exportWeapon, importWeapon } = require('../build/desktop/profile-sharing');
function configured() {
  const s = defaultSettings(), w = selected(s).weapon;
  w.setups.push({ id: 'scope', name: 'Scoped', attachments: [{ slot: 'Optic', name: 'Test scope' }, { slot: 'Custom mount', name: 'Test mount' }],
    profile: { name: w.name, rpm: 600, units: 'counts', mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: [[2, 10]] }] },
    tuning: { x: 0.8, y: 1.2 }, provenance: 'manual', calibration: null });
  w.selectedSetupId = 'scope'; return s;
}
test('old settings and v1-v3 weapon exports migrate to Base without changing output', () => {
  const s = defaultSettings(), before = effectiveProfile(s);
  for (const w of s.games[0].weapons) { delete w.setups; delete w.selectedSetupId; }
  for (const version of [1, 2]) {
    const next = validateSettings({ ...s, version });
    assert.equal(selected(next).weapon.selectedSetupId, 'base'); assert.deepEqual(selected(next).weapon.setups, []);
    assert.deepEqual(effectiveProfile(next), before);
  }
  for (const v of [1, 2, 3]) {
    const next = importWeapon(defaultSettings(), { format: `recoil-control/weapon-v${v}`, stances: s.games[0].stances, weapon: s.games[0].weapons[0] }, 'imported');
    assert.equal(selected(next).weapon.selectedSetupId, 'base'); assert.deepEqual(effectiveProfile(next), before);
  }
});
test('active setup drives output and sensitivity scaling independently of Base', () => {
  const s = configured(), w = selected(s).weapon, base = structuredClone(w.profile);
  activeSetup(w).calibration = { dpi: 800, sensitivity: 2, adsMultiplier: 1, at: '2026-11-02T00:00:00Z' };
  assert.deepEqual(effectiveProfile(s).recoils[0].multipliers, [1.6, 2.4]);
  const next = selectWeapon(s, { setupId: 'base' });
  assert.deepEqual(effectiveProfile(next).recoils, base.recoils);
  assert.equal(w.selectedSetupId, 'scope', 'selection does not mutate its input');
  assert.throws(() => selectWeapon(s, { setupId: 'missing' }), /attachment setup/);
  assert.throws(() => selectWeapon(s, { setupId: 'base', id: 'ak' }), /attachment setup/);
});
test('saving live tuning changes only the active attachment setup', () => {
  const s = configured(), base = structuredClone(selected(s).weapon.profile);
  const next = applyLiveTuning(s, { stances: [{ name: 'Default', x: 1.5, y: 0.5 }] });
  assert.deepEqual(selected(next).weapon.profile, base);
  assert.deepEqual(activeSetup(selected(next).weapon).profile.recoils[0].vectors, [[3, 5]]);
  assert.deepEqual(activeSetup(selected(s).weapon).profile.recoils[0].vectors, [[2, 10]]);
  assert.deepEqual(tuningLimits(s), [[3, 3]]);
});
test('empty active setups disable output and are skipped when cycling weapons', () => {
  const s = configured(), w = selected(s).weapon;
  activeSetup(w).profile = null; activeSetup(w).provenance = 'template';
  assert.equal(effectiveProfile(s), null); assert.equal(tuningLimits(s), undefined);
  assert.throws(() => selectWeapon(s, { direction: 1 }), /Configure/);
  s.games[0].weapons[1].profile = structuredClone(w.profile); s.games[0].weapons[1].provenance = 'manual';
  assert.equal(selectWeapon(s, { direction: 1 }).games[0].selectedWeaponId, 'lr300');
});
test('setup validation rejects missing selections, duplicates, invalid slots and invalid patterns', () => {
  const edits = [w => w.selectedSetupId = 'unknown', w => w.setups.push(structuredClone(w.setups[0])), w => w.setups[0].id = 'base', w => w.setups[0].name = 'BASE',
    w => w.setups[0].attachments.push({ slot: 'optic', name: 'Another scope' }), w => w.setups[0].attachments[0].slot = '',
    w => w.setups[0].tuning.x = Infinity, w => w.setups[0].profile.recoils[0].activate = ['prone'],
    w => w.setups = Array.from({ length: 25 }, (_, i) => ({ ...w.setups[0], id: `s${i}`, name: `S${i}` })),
    w => w.setups[0].attachments = Array.from({ length: 13 }, (_, i) => ({ slot: `slot${i}`, name: 'item' }))];
  for (const edit of edits) { const s = configured(); edit(selected(s).weapon); assert.throws(() => validateSettings(s)); }
});
test('v4 sharing includes stances used only by variants and resets every local calibration', () => {
  const source = configured(), { game, weapon } = selected(source);
  game.stances.push({ id: 'prone', name: 'Prone' });
  activeSetup(weapon).profile.recoils.push({ name: 'Prone ADS', activate: ['prone', 'aiming'], multipliers: [1, 1], vectors: [[1, 3]] });
  weapon.calibration = activeSetup(weapon).calibration = { ...game.input, at: '2026-11-02T00:00:00Z' };
  weapon.provenance = activeSetup(weapon).provenance = 'calibrated'; weapon.hotkey = 'num1';
  const payload = exportWeapon(weapon, game.stances);
  assert.equal(payload.format, 'recoil-control/weapon-v4'); assert.ok(payload.stances.some(s => s.id === 'prone'));
  const local = defaultSettings(), original = structuredClone(local);
  const next = importWeapon(local, JSON.parse(JSON.stringify(payload)), 'new');
  const imported = selected(next).weapon;
  assert.equal(imported.selectedSetupId, 'scope'); assert.equal(imported.hotkey, null);
  assert.deepEqual(imported.setups[0].attachments, weapon.setups[0].attachments);
  for (const setup of [imported, ...imported.setups]) { assert.equal(setup.calibration, null); assert.equal(setup.provenance, 'manual'); }
  assert.deepEqual(imported.setups[0].profile, weapon.setups[0].profile);
  assert.deepEqual(local, original); assert.deepEqual(next.games[0].bindings.stances, [{ id: 'crouching', key: 'control', mode: 'hold' }]);
  assert.throws(() => importWeapon(local, { ...payload, stances: payload.stances.filter(s => s.id !== 'prone') }, 'invalid'), /condition/);
});
test('attachment metadata, selected setup and separate profiles survive save and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recoil-attachments-'));
  try { const store = new SettingsStore(path.join(dir, 'settings.json')), s = configured(); store.save(s); assert.deepEqual(store.load(), validateSettings(s)); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
