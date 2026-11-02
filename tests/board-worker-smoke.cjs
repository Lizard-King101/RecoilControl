// Explicit hardware test: opens the selected COM port, never arms or moves.
const { app, utilityProcess } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
let worker;
let latest;
let sequence = 0;
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(command, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${command}`)); }, 6000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, command, value });
  });
}
(async () => {
  await app.whenReady();
  worker = utilityProcess.fork(path.resolve(__dirname, '../build/desktop/worker.js'), [], { stdio: 'pipe' });
  worker.stderr.on('data', chunk => process.stderr.write(chunk));
  worker.on('message', message => {
    if (message.type === 'state') latest = message.state;
    if (message.type === 'reply') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.ok ? item.resolve() : item.reject(Error(message.error));
    }
  });
  await command('board-connect', process.argv[2] ?? 'COM3');
  assert.equal(latest.board.ready, true);
  const before = latest.board.status.reports;
  const correctionsBefore = latest.board.status.relay?.corrections;
  const until = Date.now() + 2300;
  while (Date.now() < until) {} // Simulate a modal/resize blocking the main process.
  await delay(1000);
  assert.equal(latest.board.ready, true);
  assert.equal(latest.board.status.usb, true);
  assert.equal(latest.board.status.armed, false);
  if (latest.board.status.protocol === 3) {
    assert.equal(latest.passthrough, true);
    await assert.rejects(command('enabled', true), /Recoil is disabled/);
    await assert.rejects(command('board-test'), /Synthetic movement is disabled/);
  } else if (latest.board.status.protocol === 4) {
    assert.equal(latest.relay,true); assert.equal(latest.passthrough,false);
    assert.equal(latest.enabled,false); assert.equal(latest.board.status.relay.corrections,correctionsBefore);
    await assert.rejects(command('board-test'), /Synthetic movement is disabled/);
    if (latest.board.status.relay.tracing !== undefined) {
      // Firmware 0.5.0+: recording streams movement and keeps compensation off until stopped.
      await command('record-start');
      assert.equal(latest.recording.active, true);
      await assert.rejects(command('enabled', true), /Stop recording/);
      await delay(1200);
      assert.equal(latest.board.status.relay.tracing, true);
      await command('record-stop');
      await delay(1200);
      assert.equal(latest.recording.active, false);
      assert.equal(latest.board.status.relay.tracing, false);
      assert.equal(latest.board.status.relay.corrections, correctionsBefore);
    } else console.log('Firmware older than 0.5.0: pull recording not checked.');
  } else assert.equal(latest.board.status.reports, before);
  assert.equal(latest.board.error, null);
  console.log('PASS: USB heartbeats continued during a 2.3-second main-thread stall; no synthetic movement generated.');
  console.log(JSON.stringify(latest.board.status));
  await command('shutdown'); worker = null; app.quit();
})().catch(error => { console.error(error); worker?.kill(); app.exit(1); });
