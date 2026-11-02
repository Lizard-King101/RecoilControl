const test = require('node:test');
const assert = require('node:assert/strict');
const { GameControls } = require('../build/game-controls');
const { defaultBindings, validateBindings, validateShortcut, keyboardMap } = require('../build/key-bindings');
const { defaultSettings, validateSettings, selectWeapon } = require('../build/desktop/settings');
const patterns = require('../ui/pattern-tools');

function fixture(bindings = defaultBindings()) {
  let raw; let stops = 0; let suspended = false; const actions = []; const events = [];
  const controls = new GameControls({ listen(listener) { raw = listener; return () => stops++; } }, bindings,
    [{ id: 'ak', hotkey: 'ctrl+num1' }], action => actions.push(action), () => suspended);
  const listener = { keyDown: k => events.push(['down', k]), keyUp: k => events.push(['up', k]), mouse: (b, d) => events.push([b, d]) };
  controls.start(); let unsubscribe = controls.listen(listener);
  return { controls, actions, events, listener, get raw() { return raw; }, get stops() { return stops; },
    tap(key) { raw.keyDown(key); raw.keyUp(key); }, suspend(value) { suspended = value; }, unsubscribe: () => unsubscribe() };
}
test('game bindings migrate old files without changing any saved weapon pattern', () => {
  const old = defaultSettings(); const weapon = structuredClone(old.games[0].weapons[0]);
  delete old.games[0].bindings;
  old.games[0].weapons.forEach(w => delete w.hotkey);
  const next = validateSettings(old);
  assert.deepEqual(next.games[0].bindings, defaultBindings());
  assert.deepEqual(next.games[0].weapons[0].profile, weapon.profile);
  assert.equal(next.games[0].weapons[0].hotkey, null);
  const other = structuredClone(next.games[0]); other.id = 'other'; other.bindings.toggle = 'num0';
  next.games.push(other);
  assert.equal(validateSettings(next).games[1].bindings.toggle, 'num0');
  assert.equal(next.games[0].bindings.toggle, 'f7');
});
test('bindings canonicalize chords and reject reserved keys, duplicates, and hold conflicts', () => {
  assert.equal(validateShortcut('shift+ctrl+keya'), 'ctrl+shift+keya');
  for (const value of ['escape', 'left', 'ctrl+ctrl+f1', 'ctrl+shift+keyh', 'alt+f4', 'meta+f7']) assert.throws(() => validateShortcut(value));
  assert.throws(() => validateBindings({ ...defaultBindings(), toggle: 'f5' }), /different shortcut/);
  assert.throws(() => validateBindings({ ...defaultBindings(), pause: 'f7' }), /hold key/);
  assert.throws(() => validateBindings({ ...defaultBindings(), pause: 'control' }), /different keys/);
  const settings = defaultSettings(); settings.games[0].weapons[0].hotkey = 'f7';
  assert.throws(() => validateSettings(settings), /different shortcut/);
  const { UiohookKey } = require('uiohook-napi');
  const map = keyboardMap(UiohookKey);
  assert.equal(map.has(undefined), false);
  assert.equal(map.get(UiohookKey.Numpad1), 'num1');
  assert.equal(map.get(UiohookKey.AltRight), 'altRight');
});
test('shortcuts are edge-triggered, require exact modifiers, and remain suspended in configuration', () => {
  const f = fixture(); f.raw.keyDown('f7'); f.raw.keyDown('f7'); f.raw.keyUp('f7');
  assert.deepEqual(f.actions, ['toggle']);
  f.raw.keyDown('controlRight'); f.tap('num1'); f.tap('f7'); f.raw.keyUp('controlRight');
  assert.deepEqual(f.actions, ['toggle', { weaponId: 'ak' }]);
  f.suspend(true); f.tap('f6'); f.tap('escape');
  assert.deepEqual(f.actions.at(-1), 'disable'); assert.equal(f.actions.length, 3);
  f.suspend(false); f.raw.keyDown('escape'); f.tap('f7'); f.raw.keyUp('escape');
  assert.equal(f.actions.at(-1), 'disable');
  f.tap('enter'); f.tap('plus'); assert.equal(f.actions.at(-1), 'disable');
  assert.equal(f.events.some(e => e[1] === 'f7' || e[1] === 'enter'), false);
  f.controls.dispose(); assert.equal(f.stops, 1);
});
test('custom stance keys and held input survive controller replacement without restarting the hook', () => {
  const f = fixture({ ...defaultBindings(), crouch: 'keyc', pause: 'alt' });
  f.raw.keyDown('keyc'); f.raw.keyDown('altRight'); f.raw.mouse('right', true);
  assert.deepEqual(f.events, [['down', 'control'], ['down', 'shift'], ['right', true]]);
  f.unsubscribe(); f.events.length = 0;
  const off = f.controls.listen(f.listener);
  assert.deepEqual(f.events, [['down', 'shift'], ['down', 'control'], ['right', true]]);
  assert.equal(f.stops, 0);
  f.controls.configure(defaultBindings(), []);
  assert.deepEqual(f.events.slice(-2), [['up', 'shift'], ['up', 'control']]);
  off(); f.controls.dispose();
});
test('cycling skips empty weapons and wraps; direct empty selection remains possible', () => {
  const settings = defaultSettings(); const game = settings.games[0];
  game.weapons[1].profile = structuredClone(game.weapons[0].profile);
  let next = selectWeapon(settings, { direction: 1 });
  assert.equal(next.games[0].selectedWeaponId, game.weapons[1].id);
  next = selectWeapon(next, { direction: 1 }); assert.equal(next.games[0].selectedWeaponId, 'ak');
  next = selectWeapon(settings, { direction: -1 }); assert.equal(next.games[0].selectedWeaponId, game.weapons[1].id);
  next = selectWeapon(settings, { id: 'custom-smg' }); assert.equal(next.games[0].selectedWeaponId, 'custom-smg');
  next = selectWeapon(next, { direction: 1 }); assert.equal(next.games[0].selectedWeaponId, 'ak');
  assert.equal(settings.games[0].selectedWeaponId, 'ak');
  assert.throws(() => selectWeapon(settings, { id: 'absent' }));
  assert.throws(() => selectWeapon(settings, { direction: 0 }));
});
test('editing a shot endpoint preserves its neighbors and incorporates stance strength', () => {
  const vectors = [[2, 10], [-3, 12], [4, 8]]; const gains = [0.5, 1.5];
  const points = patterns.positions(vectors, gains);
  assert.deepEqual(patterns.fromPositions(points, gains), vectors);
  const updated = patterns.movePoint(vectors, gains, 1, [3, 20]);
  const next = patterns.positions(updated, gains);
  assert.deepEqual(next[0], points[0]); assert.deepEqual(next[2], points[2]);
  assert.ok(Math.abs(next[1][1] - 20) < 0.00001); assert.equal(next[1][0], 3);
  assert.deepEqual(vectors[1], [-3, 12]);
  assert.throws(() => patterns.movePoint(vectors, [0, 1], 0, [1, 2]), /nonzero/);
  assert.throws(() => patterns.movePoint(vectors, gains, 0, [10000, 1]), /1000/);
});
test('guide positions convert to opposite correction vectors; range tools are bounded and isolated', () => {
  const guide = patterns.parse('0, -10\n2, -22\n5, -35', 120000);
  const vectors = patterns.fromPositions(guide.map(pair => pair.map(v => -v * 2)));
  assert.deepEqual(vectors, [[0, 20], [-4, 24], [-6, 26]]);
  assert.deepEqual(patterns.shape(vectors, 1, 2, [-1, 0.5]), [[0, 20], [4, 12], [6, 13]]);
  assert.throws(() => patterns.shape(vectors, 2, 1, [1, 1]));
  assert.throws(() => patterns.shape(vectors, 0, 2, [1, 100]), /1000/);
  const long = Array.from({ length: 120 }, () => [0, 25]);
  assert.equal(patterns.positions(long).at(-1)[1], 3000);
});
