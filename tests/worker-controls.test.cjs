const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { defaultBindings } = require('../build/key-bindings');
const { defaultSettings, effectiveProfile } = require('../build/desktop/settings');
const { BluetoothController } = require('../build/bluetooth-controller');

function workerFixture() {
  const filename = path.resolve(__dirname, '../build/desktop/worker.js');
  const realRequire = createRequire(filename); const messages = []; const replies = new Map();
  let receiver, input, board, starts = 0, stops = 0, sequence = 0, now = 0;
  const ticks = new Set();
  const clock = { now: () => now, every: fn => { ticks.add(fn); return () => ticks.delete(fn); } };
  class TestBoard {
    profileReady = true; state = {}; moves = [];
    constructor() { board = this; }
    async disarm() {}
    async disconnect() {}
    async moveProfile(x, y, current) { if (current()) { this.moves.push([x, y]); return true; } return false; }
  }
  const port = { on: (_name, fn) => { receiver = fn; }, postMessage: message => {
    messages.push(message);
    if (message.type === 'reply') { const pending = replies.get(message.id); replies.delete(message.id); message.ok ? pending.resolve() : pending.reject(new Error(message.error)); }
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: {}, process: { parentPort: port, exit() {} }, setInterval() { return 1; }, clearInterval() {}, console,
    require(name) {
      if (name === './board') return { BoardConnection: TestBoard };
      if (name === '../button-input') return { loadButtonInput: () => ({ listen(listener) { starts++; input = listener; return () => stops++; } }) };
      if (name === '../bluetooth-controller') return { BluetoothController: class extends BluetoothController {
        constructor(source, output, engine, options) { super(source, output, engine, { ...options, clock }); }
      } };
      return realRequire(name);
    },
  }, { filename });
  return {
    get state() { return messages.findLast(message => message.type === 'state')?.state; },
    get input() { return input; }, get starts() { return starts; }, get stops() { return stops; }, get board() { return board; }, messages,
    command(command, value) { return new Promise((resolve, reject) => { const id = ++sequence; replies.set(id, { resolve, reject }); receiver({ data: { id, command, value } }); }); },
    tap(key) { input.keyDown(key); input.keyUp(key); },
    async tick() { now += 16; ticks.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); },
  };
}
const config = () => ({ profile: effectiveProfile(defaultSettings()), output: 'bluetooth', bindings: defaultBindings(), gameId: 'rust', weapons: [{ id: 'ak', hotkey: 'num1' }] });

test('worker weapon switching keeps the keyboard hook and requires a fresh fire press', async () => {
  const f = workerFixture(); const c = config();
  try {
    await f.command('configure', c); await f.command('enabled', true);
    f.input.mouse('left', true); await f.tick(); assert.ok(f.board.moves.length);
    f.tap('f6'); const request = f.messages.findLast(m => m.type === 'weapon-select');
    assert.equal(request.resume, true); assert.equal(request.request.direction, 1);
    assert.equal(f.state.enabled, false);
    f.tap('f6'); assert.equal(f.messages.filter(m => m.type === 'weapon-select').length, 1);
    await f.command('switch-prepare');
    await f.command('configure', { ...c, resume: request.resume, resumeEpoch: request.epoch });
    assert.equal(f.state.enabled, true); assert.equal(f.state.paused, true); assert.equal(f.starts, 1);
    const count = f.board.moves.length; await f.tick(); assert.equal(f.board.moves.length, count);
    f.input.mouse('left', false); f.input.mouse('left', true); await f.tick(); assert.ok(f.board.moves.length > count);
  } finally { await f.command('shutdown'); }
  assert.equal(f.stops, 1);
});
test('Escape invalidates an in-flight switch resume; empty selection stays disabled', async () => {
  const f = workerFixture(); const c = config();
  try {
    await f.command('configure', c); await f.command('enabled', true); f.tap('f6');
    const request = f.messages.findLast(m => m.type === 'weapon-select');
    f.tap('escape'); await f.command('switch-prepare');
    await f.command('configure', { ...c, resume: true, resumeEpoch: request.epoch });
    assert.equal(f.state.enabled, false);
    await f.command('configure', { ...c, profile: null, resume: true, resumeEpoch: f.state.stopEpoch });
    assert.equal(f.state.enabled, false);
    f.tap('num1'); assert.equal(f.messages.at(-1).type, 'weapon-select');
  } finally { await f.command('shutdown'); }
});
test('worker refuses both shortcut and HUD switches with a dirty tuning draft', async () => {
  const f = workerFixture();
  try {
    await f.command('configure', config()); f.tap('f8'); f.tap('right');
    assert.equal(f.state.tuning.dirty, true);
    f.tap('f6'); assert.equal(f.messages.some(m => m.type === 'weapon-select'), false);
    await assert.rejects(f.command('switch-prepare'), /tuning draft/);
    assert.equal(f.state.tuning.dirty, true);
    await f.command('tuning', { action: 'discard' }); f.tap('f6');
    assert.equal(f.messages.at(-1).type, 'weapon-select');
  } finally { await f.command('shutdown'); }
});
