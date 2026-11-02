const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush, mouseStroke } = require('./helpers.cjs');

test('missing driver fails before starting a keyboard hook or capturing input', () => {
  const f = fixture({ mice: 0 });
  assert.throws(() => f.app.start(), /No mice/);
  assert.equal(f.backend.hookStarts, 0);
  assert.equal(f.context.destroyed, true);
  assert.deepEqual(f.context.captures, []);
});

test('idle startup stays disabled and cleans up the keyboard hook', async () => {
  const f = fixture();
  f.app.start();
  f.app.start();
  assert.equal(f.app.enabled, false);
  assert.equal(f.backend.hookStarts, 1);
  assert.equal(f.timers.size, 0);
  await f.stop();
  await f.stop();
  assert.equal(f.backend.hookStops, 1);
});

test('all mouse fields and buttons pass through unchanged to their source device', async () => {
  const f = fixture();
  await f.start();
  for (const state of [0, 16, 32, 64, 128, 256, 512, 1024, 2048, 5, 10]) {
    const device = f.device(15);
    const stroke = mouseStroke(state, { flags: 1, x: -31, y: 26, rolling: -120, information: 99 });
    await f.input(device, stroke);
    assert.deepEqual(f.sent.at(-1), { id: 15, stroke });
  }
  await f.stop();
  assert.deepEqual(f.errors, []);
});

test('combined button flags select ADS and release stops movement', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device();
  await f.input(mouse, mouseStroke(1 | 4));
  assert.equal(f.app.status.profile, 'ADS');
  f.tick();
  const movement = f.sent.at(-1).stroke;
  assert.equal(movement.state, 0);
  assert.equal(movement.flags, 0);
  assert.ok(Number.isInteger(movement.x) && Number.isInteger(movement.y));
  assert.ok(movement.y > 0);
  await f.input(mouse, mouseStroke(2 | 8));
  const count = f.sent.length;
  f.tick();
  assert.equal(f.sent.length, count);
  assert.equal(f.app.status.profile, 'Default');
  await f.stop();
});

test('disabling immediately stops movement and releases capture before wait settles', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device();
  await f.input(mouse, mouseStroke(1)); f.tick();
  const context = f.context;
  const count = f.sent.length;
  const done = f.app.setEnabled(false);
  assert.equal(f.app.enabled, false);
  assert.equal(f.timers.size, 0);
  assert.equal(context.captures.at(-1), false);
  assert.equal(context.destroyed, false);
  assert.equal(context.timeout, 25);
  f.tick();
  assert.equal(f.sent.length, count);
  // An already-intercepted release still needs forwarding during shutdown.
  mouse.stroke = mouseStroke(2);
  context.deliver(mouse);
  await done;
  assert.deepEqual(f.sent.at(-1), { id: mouse.id, stroke: mouse.stroke });
  assert.equal(context.destroyed, true);
  await f.stop();
  assert.deepEqual(f.errors, []);
});

test('rapid toggles serialize contexts and discard stale shooting state', async () => {
  const f = fixture(); await f.start();
  await f.input(f.device(), mouseStroke(1));
  const old = f.context;
  const off = f.app.setEnabled(false);
  const on = f.app.setEnabled(true);
  const alsoOn = f.app.setEnabled(true);
  assert.equal(f.contexts.length, 2); // Startup probe and first active session.
  old.deliver();
  await Promise.all([off, on, alsoOn]);
  assert.equal(f.contexts.length, 3);
  assert.equal(old.destroyed, true);
  assert.equal(f.app.enabled, true);
  const count = f.sent.length;
  f.tick();
  assert.equal(f.sent.length, count);
  await f.stop();
  assert.deepEqual(f.errors, []);
});

test('a later disable cancels an enable waiting for cleanup', async () => {
  const f = fixture(); await f.start();
  const off = f.app.setEnabled(false);
  const on = f.app.setEnabled(true);
  const offAgain = f.app.setEnabled(false);
  f.context.deliver();
  await Promise.all([off, on, offAgain]);
  assert.equal(f.app.enabled, false);
  assert.equal(f.contexts.length, 2);
  await f.stop();
});

test('both Shift keys pause, both Ctrl keys select crouch, and releases restore input', async () => {
  const f = fixture(); await f.start();
  await f.input(f.device(), mouseStroke(1 | 4));
  f.backend.down('controlRight');
  assert.equal(f.app.status.profile, 'Crouch ADS');
  f.backend.down('control'); f.backend.up('controlRight');
  assert.equal(f.app.status.profile, 'Crouch ADS');
  f.backend.up('control');
  assert.equal(f.app.status.profile, 'ADS');
  f.backend.down('shiftRight'); f.backend.down('shift');
  const count = f.sent.length;
  f.tick();
  f.backend.up('shiftRight'); f.tick();
  assert.equal(f.sent.length, count);
  f.backend.up('shift'); f.tick();
  assert.ok(f.sent.length > count);
  await f.stop();
});

test('toggle hotkey ignores autorepeat, unrelated keys, and Escape held with the chord', async () => {
  const f = fixture(); f.app.start();
  f.backend.down('enter'); f.backend.down('plus');
  await flush();
  assert.equal(f.app.enabled, true);
  f.backend.down('plus'); f.backend.down('control');
  assert.equal(f.app.enabled, true);
  f.backend.down('escape');
  assert.equal(f.app.enabled, false);
  f.backend.up('plus'); f.backend.down('plus');
  f.context.deliver(); await flush();
  assert.equal(f.app.enabled, false);
  await f.stop();
});

test('mouse movement uses the shooting device, not the first enumerated mouse', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device(18);
  await f.input(mouse, mouseStroke(1));
  await f.input(f.device(11), mouseStroke(2));
  f.tick();
  assert.equal(f.sent.at(-1).id, 18);
  assert.equal(f.sent.at(-1).stroke.state, 0);
  await f.stop();
});

test('native wait failure releases timer and context, then permits a clean retry', async () => {
  const f = fixture(); await f.start();
  const context = f.context;
  context.fail(); await flush();
  assert.equal(f.app.enabled, false);
  assert.equal(f.timers.size, 0);
  assert.equal(context.destroyed, true);
  assert.equal(f.errors.length, 1);
  await f.app.setEnabled(true);
  assert.equal(f.app.enabled, true);
  await f.stop();
});

test('failed synthetic movement disables immediately without destroying a pending wait', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device();
  await f.input(mouse, mouseStroke(1));
  mouse.failSend = true;
  f.tick();
  assert.equal(f.app.enabled, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.context.destroyed, false);
  f.context.deliver(); await flush();
  assert.equal(f.context.destroyed, true);
  assert.equal(f.errors.length, 1);
  await f.stop();
});

test('forwarding errors and disconnected mice release all resources', async () => {
  for (const failure of ['send', 'disconnect']) {
    const f = fixture(); await f.start();
    if (failure === 'send') {
      const mouse = f.device(); mouse.failSend = true;
      await f.input(mouse, mouseStroke(1));
    } else {
      f.backend.mice = 0; f.context.deliver(); await flush();
    }
    assert.equal(f.app.enabled, false);
    assert.equal(f.context.destroyed, true);
    assert.equal(f.timers.size, 0);
    assert.equal(f.errors.length, 1);
    await f.stop();
  }
});

test('dispose cancels an enable waiting for shutdown and prevents later activation', async () => {
  const f = fixture(); await f.start();
  const off = f.app.setEnabled(false);
  const on = f.app.setEnabled(true);
  await f.stop();
  await Promise.all([off, on]);
  await f.app.setEnabled(true);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.app.enabled, false);
  assert.equal(f.backend.hookStops, 1);
});

test('capture setup failure destroys its context and allows another activation', async () => {
  const f = fixture(); f.app.start();
  const createContext = f.backend.createContext;
  f.backend.createContext = () => {
    const context = createContext();
    const capture = context.capture;
    context.capture = enabled => {
      if (enabled) throw Error('Capture unavailable');
      capture.call(context, enabled);
    };
    return context;
  };
  await assert.rejects(f.app.setEnabled(true), /Capture unavailable/);
  assert.equal(f.context.destroyed, true);
  assert.equal(f.app.enabled, false);
  assert.equal(f.timers.size, 0);
  f.backend.createContext = createContext;
  await f.app.setEnabled(true);
  assert.equal(f.app.enabled, true);
  await f.stop();
});

test('a synchronous native wait failure ends with disabled status', async () => {
  const f = fixture(); f.app.start();
  const createContext = f.backend.createContext;
  f.backend.createContext = () => {
    const context = createContext();
    context.wait = () => { throw Error('Context failed'); };
    return context;
  };
  await f.app.setEnabled(true);
  assert.equal(f.context.destroyed, true);
  assert.equal(f.app.enabled, false);
  assert.equal(f.messages.at(-1), 'Recoil control disabled.');
  assert.equal(f.errors.length, 1);
  await f.stop();
});

test('configuration-window suspension pauses output without losing Shift pause state', async () => {
  const f = fixture(); await f.start();
  await f.input(f.device(), mouseStroke(1));
  f.app.setSuspended(true);
  const count = f.sent.length;
  f.tick();
  assert.equal(f.sent.length, count);
  f.backend.down('shift');
  f.app.setSuspended(false);
  f.tick();
  assert.equal(f.sent.length, count);
  f.backend.up('shift'); f.tick();
  assert.ok(f.sent.length > count);
  await f.stop();
});

test('diagnostics distinguish received input, paused output, and accepted movement', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device();
  await f.input(mouse, mouseStroke(1 | 4));
  f.app.setSuspended(true);
  f.backend.down('shift');
  f.tick();
  assert.deepEqual(f.app.diagnostics.pauseReasons, ['configuration', 'shift']);
  assert.equal(f.app.diagnostics.firePresses, 1);
  assert.equal(f.app.diagnostics.mouseEvents, 1);
  assert.equal(f.app.diagnostics.shooting, true);
  assert.equal(f.app.diagnostics.aiming, true);
  assert.equal(f.app.diagnostics.movementAttempts, 0);
  f.app.setSuspended(false); f.backend.up('shift'); f.tick();
  assert.equal(f.app.diagnostics.movementAttempts, 1);
  assert.equal(f.app.diagnostics.movementsAccepted, 1);
  const snapshot = f.app.diagnostics;
  snapshot.movementsAccepted = 999;
  assert.equal(f.app.diagnostics.movementsAccepted, 1);
  await f.input(mouse, mouseStroke(2 | 8)); f.tick();
  assert.equal(f.app.diagnostics.shooting, false);
  assert.equal(f.app.diagnostics.mouseEvents, 2);
  assert.equal(f.app.diagnostics.movementsAccepted, 1);
  await f.stop();
});

test('diagnostics do not count failed sends or long-stall skips as accepted movement', async () => {
  const f = fixture(); await f.start();
  const mouse = f.device();
  await f.input(mouse, mouseStroke(1));
  f.tick(300);
  assert.equal(f.app.diagnostics.maxTickMs, 300);
  assert.equal(f.app.diagnostics.ticks, 1);
  assert.equal(f.app.diagnostics.movementAttempts, 0);
  mouse.failSend = true; f.tick();
  assert.equal(f.app.diagnostics.movementAttempts, 1);
  assert.equal(f.app.diagnostics.movementsAccepted, 0);
  assert.equal(f.app.diagnostics.enabled, false);
  await f.stop();
});
