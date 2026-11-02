const test = require('node:test');
const assert = require('node:assert/strict');
const { PullRecorder, recordingLimits } = require('../build/pull-recording');

let seq = 0;
const frame = (stamp, dx, dy, buttons) => ({ seq: seq++, stamp, dx, dy, buttons });

test('a take runs from a fresh fire press to its release, excluding movement before the press', () => {
  seq = 0;
  const recorder = new PullRecorder();
  recorder.push(frame(1000, 5, 5, 1));
  assert.equal(recorder.state.firing, false, 'Inactive recorders ignore input');
  recorder.start();
  recorder.push(frame(1000, 9, 9, 0));
  recorder.push(frame(2000, 7, 7, 1)); // Press frame: movement before firing.
  assert.equal(recorder.state.firing, true);
  recorder.push(frame(102000, 0, 12, 1));
  recorder.push(frame(202000, 1, 11, 3));
  recorder.push(frame(302000, -1, 10, 2)); // Release; ADS still held.
  const { takes, firing, notice } = recorder.state;
  assert.equal(firing, false);
  assert.equal(notice, null);
  assert.deepEqual(takes[0].samples, [[100000, 0, 12], [200000, 1, 11], [300000, -1, 10]]);
  assert.equal(takes[0].durationMs, 300);
  assert.equal(takes[0].aiming, true);
});

test('lost frames, short bursts, and overlong bursts discard the take and explain why', () => {
  seq = 0;
  const recorder = new PullRecorder(); recorder.start();
  recorder.push(frame(0, 0, 0, 1));
  seq++; // A frame never arrived.
  recorder.push(frame(400000, 0, 20, 1));
  assert.equal(recorder.state.firing, false);
  assert.match(recorder.state.notice, /lost/);
  recorder.push(frame(500000, 0, 20, 1));
  assert.equal(recorder.state.firing, false, 'Holding fire after a discard does not start a take');
  recorder.push(frame(600000, 0, 0, 0));
  recorder.push(frame(700000, 0, 0, 1));
  recorder.push(frame(800000, 0, 3, 0));
  assert.match(recorder.state.notice, /too short/);
  recorder.push(frame(900000, 0, 0, 1));
  recorder.push(frame(900000 + recordingLimits.maxTakeMs * 1000 + 1, 0, 3, 1));
  assert.match(recorder.state.notice, /longer than/);
  assert.equal(recorder.state.takes.length, 0);
});

test('clicks while the app has focus never start a take, and single takes can be deleted', () => {
  seq = 0;
  const recorder = new PullRecorder(); recorder.start();
  // Clicking Stop/Clear in the app: a press and release with the app focused.
  recorder.push(frame(0, 0, 0, 1), false);
  assert.equal(recorder.state.firing, false);
  recorder.push(frame(400000, 0, 9, 0), false);
  assert.deepEqual(recorder.state.takes, []);
  assert.equal(recorder.state.notice, null, 'A click is not reported as a short burst');
  for (const start of [1000000, 2000000]) {
    recorder.push(frame(start, 0, 0, 1), true);
    recorder.push(frame(start + 400000, start / 1000000, 20, 0), false); // Focus may return before release.
  }
  assert.equal(recorder.state.takes.length, 2);
  recorder.remove(0);
  assert.equal(recorder.state.takes[0].samples[0][1], 2);
  assert.throws(() => recorder.remove(1), /no longer exists/);
});

test('the recorder keeps the latest takes and survives the board clock wrapping', () => {
  seq = 0;
  const recorder = new PullRecorder(); recorder.start();
  for (let i = 0; i < recordingLimits.maxTakes + 2; i++) {
    const start = 0xffffffff - 100000 + i; // Each take crosses the 32-bit microsecond wrap.
    recorder.push(frame(start, 0, 0, 1));
    recorder.push(frame((start + 400000) >>> 0, i, 20, 0));
  }
  const { takes } = recorder.state;
  assert.equal(takes.length, recordingLimits.maxTakes);
  assert.equal(takes[0].samples[0][1], 2, 'The two oldest takes were dropped');
  assert.equal(takes[0].durationMs, 400);
  recorder.clear(); recorder.stop();
  assert.deepEqual(recorder.state, { active: false, firing: false, takes: [], notice: null });
});
