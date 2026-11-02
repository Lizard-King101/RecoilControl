const test = require('node:test');
const assert = require('node:assert/strict');
const { DpiMeasurement } = require('../build/desktop/measurement');
const { fixture, flush, mouseStroke } = require('./helpers.cjs');

test('DPI measurement forwards original events, counts one relative mouse, and cleans up after Escape', async () => {
  const f = fixture();
  const measure = new DpiMeasurement(f.backend, () => {});
  measure.start();
  await f.input(f.device(12), mouseStroke(0, { x: 300, y: 50 }));
  await f.input(f.device(13), mouseStroke(0, { x: 500 }));
  await f.input(f.device(12), mouseStroke(0, { x: 800, flags: 1 }));
  await f.input(f.device(12), mouseStroke(0, { x: -20 }));
  assert.equal(measure.state.counts, 280);
  assert.equal(measure.state.travel, 320);
  assert.equal(f.sent.length, 4);
  f.backend.down('escape');
  assert.equal(measure.state.running, false);
  assert.equal(f.context.destroyed, false);
  assert.equal(f.context.captures.at(-1), false);
  f.context.deliver(); await flush();
  assert.equal(f.context.destroyed, true);
  assert.equal(f.backend.hookStops, 1);
  assert.equal(measure.state.error, null);
});

test('measurement failure releases capture and the keyboard hook', async () => {
  const f = fixture();
  const measure = new DpiMeasurement(f.backend, () => {});
  measure.start();
  f.context.fail(); await flush();
  assert.equal(measure.state.running, false);
  assert.equal(f.context.destroyed, true);
  assert.equal(f.backend.hookStops, 1);
  assert.match(measure.state.error, /wait failed/);
});
