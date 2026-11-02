const test = require('node:test');
const assert = require('node:assert/strict');
const { GameControls } = require('../build/game-controls');
const { defaultBindings, validateBindings, validateShortcut } = require('../build/key-bindings');
function fixture(patch = {}) {
  let raw, suspended = false;
  const actions = [], bindings = { ...defaultBindings(), ...patch };
  const controls = new GameControls({ listen(l) { raw = l; return () => {}; } }, bindings, [], a => actions.push(a), () => suspended);
  controls.start();
  return { raw, controls, actions, bindings, tap(k) { raw.keyDown(k); raw.keyUp(k); }, suspend(v) { suspended = v; if (v) controls.cancelActivation(); } };
}
test('mouse and keyboard binding formats migrate to toggle and reject fire/ADS or conflicts', () => {
  assert.equal(validateBindings({ ...defaultBindings(), activationMode: undefined }).activationMode, 'toggle');
  for (const key of ['mouse3','mouse4','mouse5','control','ctrl+mouse4','shift+alt+keya']) assert.equal(typeof validateShortcut(key), 'string');
  for (const key of ['mouse1','mouse2','mouse6','ctrl+control','escape','alt+f4']) assert.throws(() => validateShortcut(key));
  assert.throws(() => validateBindings({ ...defaultBindings(), activationMode: 'auto' }));
  assert.throws(() => validateBindings({ ...defaultBindings(), toggle:'mouse4', stances:[{id:'prone',key:'mouse4',mode:'hold'}] }));
  assert.throws(() => validateBindings({ ...defaultBindings(), toggle:'alt', nextWeapon:'alt+num1' }));
  assert.throws(() => validateBindings({ ...defaultBindings(), toggle:'mouse4', activationMode:'hold', nextWeapon:'ctrl+mouse4' }), /own key/);
});
test('hold activation emits one press and one release, including release while suspended', () => {
  const f = fixture({ toggle:'mouse4', activationMode:'hold' });
  f.raw.keyDown('mouse4'); f.raw.keyDown('mouse4');
  assert.equal(f.controls.activationHeld, true); assert.deepEqual(f.actions, [{ compensation:true }]);
  f.suspend(true); f.raw.keyUp('mouse4');
  assert.deepEqual(f.actions, [{compensation:true},{compensation:false}]);
  f.raw.keyDown('mouse4'); f.suspend(false); f.raw.keyDown('mouse4');
  assert.equal(f.controls.activationHeld, false);
  f.raw.keyUp('mouse4'); f.raw.keyDown('mouse4'); assert.equal(f.controls.activationHeld, true);
  f.controls.dispose(); assert.deepEqual(f.actions.at(-1), {compensation:false});
});
test('release of a chord modifier cancels hold without rearming until a fresh base press', () => {
  const f = fixture({ toggle:'alt+mouse5', activationMode:'hold' });
  f.raw.keyDown('alt'); f.raw.keyDown('mouse5'); assert.equal(f.controls.activationHeld, true);
  f.raw.keyUp('alt'); assert.equal(f.controls.activationHeld, false);
  f.raw.keyDown('alt'); assert.equal(f.controls.activationHeld, false);
  f.raw.keyUp('mouse5'); f.raw.keyDown('mouse5'); assert.equal(f.controls.activationHeld, true);
  f.raw.keyDown('shift'); assert.equal(f.controls.activationHeld, true, 'extra modifiers may be pause/stance controls');
  f.raw.keyUp('alt'); assert.equal(f.controls.activationHeld, false);
  f.controls.dispose();
});
test('Escape and rebinding cancel a held activation; toggle remains edge-triggered', () => {
  const f = fixture({ toggle:'mouse4', activationMode:'hold' });
  f.raw.keyDown('mouse4'); f.tap('escape'); assert.equal(f.controls.activationHeld, false);
  f.raw.keyDown('mouse4'); assert.equal(f.controls.activationHeld, false);
  f.raw.keyUp('mouse4'); f.raw.keyDown('mouse4');
  f.controls.configure({ ...f.bindings, toggle:'keyg' }, []); assert.equal(f.controls.activationHeld, false);
  const t = fixture({ toggle:'mouse3' }); t.raw.keyDown('mouse3'); t.raw.keyDown('mouse3'); t.raw.keyUp('mouse3');
  assert.deepEqual(t.actions,['toggle']); t.tap('mouse3'); assert.deepEqual(t.actions,['toggle','toggle']);
  f.controls.dispose(); t.controls.dispose();
});
test('left and right variants of a modifier act as one binding', () => {
  const f = fixture({toggle:'alt'});
  f.raw.keyDown('alt'); f.raw.keyDown('altRight'); assert.deepEqual(f.actions,['toggle']);
  f.raw.keyUp('alt'); f.raw.keyUp('altRight'); f.tap('altRight'); assert.deepEqual(f.actions,['toggle','toggle']);
  f.controls.dispose();
});
test('native mouse hook maps middle and side button down/up separately from fire/ADS', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const { createRequire } = require('node:module');
  const file = path.resolve(__dirname, '../build/button-input.js'), realRequire = createRequire(file);
  const hook = new EventEmitter(); hook.start = () => {}; hook.stop = () => {};
  const exports = {}; let code = 0;
  const nativeKeys = new Proxy({}, { get(target, name) { return target[name] ??= ++code; } });
  vm.runInNewContext(fs.readFileSync(file,'utf8'), { exports, process:{platform:'win32'}, require(name) { return name === 'uiohook-napi' ? {uIOhook:hook,UiohookKey:nativeKeys} : realRequire(name); } });
  const events = [], stop = exports.loadButtonInput().listen({keyDown:k=>events.push(['down',k]),keyUp:k=>events.push(['up',k]),mouse:(b,d)=>events.push([b,d])});
  for (const button of [1,2,3,4,5]) { hook.emit('mousedown',{button}); hook.emit('mouseup',{button}); }
  assert.deepEqual(events,[['left',true],['left',false],['right',true],['right',false],['down','mouse3'],['up','mouse3'],['down','mouse4'],['up','mouse4'],['down','mouse5'],['up','mouse5']]);
  stop(); assert.equal(hook.listenerCount('mousedown'),0); assert.equal(hook.listenerCount('mouseup'),0);
});
