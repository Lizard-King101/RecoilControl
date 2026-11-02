const test = require('node:test');
const assert = require('node:assert/strict');
const { BluetoothController } = require('../build/bluetooth-controller');
const { RecoilEngine } = require('../build/recoil-engine');
const { akProfile } = require('../build/profiles');
const flush = () => new Promise(setImmediate);

function fixture() {
  let now = 0, listener, timer, release;
  const sent = [], errors = [];
  const output = {
    profileReady: true, held: false, calls: 0, disarms: 0,
    async moveProfile(x, y, current) {
      this.calls++;
      if (this.held) await new Promise(resolve => { release = resolve; });
      if (!current()) return false;
      sent.push([x, y]); return true;
    },
    async disarm() { this.disarms++; },
  };
  const controller = new BluetoothController({ listen(value) { listener = value; return () => { listener = null; }; } },
    output, new RecoilEngine(akProfile), { clock: { now: () => now, every(fn) { timer = fn; return () => { timer = null; }; } },
      onError: error => errors.push(String(error)) });
  controller.start();
  return { controller, output, sent, errors, get listener() { return listener; },
    release: () => release?.(), tick: async (ms = 1000 / 60) => { now += ms; timer?.(); await flush(); } };
}

test('Bluetooth uses the profile engine for each stance and stops on mouse release', async () => {
  const f = fixture(); await f.controller.setEnabled(true);
  const reference = new RecoilEngine(akProfile);
  for (const [aiming, crouching] of [[false, false], [true, false], [false, true], [true, true]]) {
    f.listener.mouse('right', aiming);
    f.listener[crouching ? 'keyDown' : 'keyUp']('control');
    f.listener.mouse('left', true);
    reference.reset(); reference.setInput({ shooting: true, aiming, crouching, paused: false });
    const expected = [];
    const start = f.sent.length;
    for (let i = 0; i < 8; i++) {
      const vector = reference.advance(20);
      if (vector[0] || vector[1]) expected.push(vector);
      await f.tick(20);
    }
    assert.deepEqual(f.sent.slice(start), expected);
    assert.equal(f.controller.status.profile, reference.profile.name);
    f.listener.mouse('left', false); await f.tick();
    assert.equal(f.sent.length, start + expected.length);
  }
  assert.equal(f.controller.diagnostics.firePresses, 4);
  await f.controller.dispose();
});

test('release or pause cancels a frame waiting for its arm acknowledgement', async () => {
  for (const stop of ['release', 'shift', 'configuration', 'disable']) {
    const f = fixture(); await f.controller.setEnabled(true); f.output.held = true;
    f.listener.mouse('left', true); await f.tick();
    assert.equal(f.output.calls, 1);
    let disabling;
    if (stop === 'release') f.listener.mouse('left', false);
    if (stop === 'shift') f.listener.keyDown('shift');
    if (stop === 'configuration') f.controller.setSuspended(true);
    if (stop === 'disable') disabling = f.controller.setEnabled(false);
    f.release(); await flush(); await disabling;
    assert.equal(f.sent.length, 0, stop);
    await f.controller.dispose();
  }
});

test('pause and enabling while fire is held require a fresh press', async () => {
  const f = fixture();
  f.listener.mouse('left', true); await f.controller.setEnabled(true); await f.tick();
  assert.equal(f.sent.length, 0);
  f.listener.mouse('left', false); f.listener.mouse('left', true); await f.tick();
  assert.ok(f.sent.length > 0);
  f.listener.keyDown('shift'); f.listener.keyUp('shift');
  const before = f.sent.length; await f.tick();
  assert.equal(f.sent.length, before);
  assert.ok(f.controller.diagnostics.pauseReasons.includes('release fire'));
  f.listener.mouse('left', false); f.listener.mouse('left', true); await f.tick();
  assert.ok(f.sent.length > before);
  await f.controller.dispose();
});

test('only one report can be in flight; a stalled link disables without replay', async () => {
  const f = fixture(); await f.controller.setEnabled(true); f.output.held = true;
  f.listener.mouse('left', true);
  for (let i = 0; i < 10; i++) await f.tick();
  assert.equal(f.output.calls, 1);
  assert.equal(f.controller.enabled, false);
  f.release(); await flush();
  assert.equal(f.sent.length, 0);
  assert.match(f.errors[0], /timing gap/);
  await f.controller.dispose();
});

test('disconnect, Escape, and the burst limit stop output', async () => {
  for (const reason of ['disconnect', 'escape', 'burst']) {
    const f = fixture(); await f.controller.setEnabled(true); f.listener.mouse('left', true); await f.tick();
    if (reason === 'disconnect') { f.output.profileReady = false; f.controller.checkOutput(); }
    if (reason === 'escape') f.listener.keyDown('escape');
    if (reason === 'burst') for (let i = 0; i < 601; i++) await f.tick();
    assert.equal(f.controller.enabled, false);
    const before = f.sent.length; await f.tick(); assert.equal(f.sent.length, before);
    await f.controller.dispose();
  }
});

test('Enter + numpad plus toggles only once per press and cannot enable an offline output', async () => {
  const f = fixture();
  f.listener.keyDown('enter'); f.listener.keyDown('plus'); f.listener.keyDown('plus');
  assert.equal(f.controller.enabled, true);
  f.listener.keyUp('plus'); f.listener.keyDown('plus'); await flush();
  assert.equal(f.controller.enabled, false);
  f.output.profileReady = false;
  await assert.rejects(f.controller.setEnabled(true), /Connect USB/);
  await f.controller.dispose(); assert.equal(f.listener, null);
});
