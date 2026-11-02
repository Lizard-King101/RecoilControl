const test = require('node:test');
const assert = require('node:assert/strict');
const { RecoilEngine } = require('../build/recoil-engine');
const { akProfile } = require('../build/profiles');
const shooting = { shooting: true, aiming: false, crouching: false, paused: false };

function distance(engine, steps) {
  return steps.reduce((total, ms) => {
    const vector = engine.advance(ms);
    assert.ok(vector.every(Number.isInteger));
    return [total[0] + vector[0], total[1] + vector[1]];
  }, [0, 0]);
}

test('most specific matching profile wins and releases restore the default', () => {
  const engine = new RecoilEngine();
  for (const [aiming, crouching, expected] of [
    [false, false, 'Default'], [true, false, 'ADS'], [false, true, 'Crouch'],
    [true, true, 'Crouch ADS'], [false, false, 'Default'],
  ]) {
    engine.setInput({ ...shooting, aiming, crouching });
    assert.equal(engine.profile.name, expected);
  }
});

test('recoil distance is independent of frame size and retains negative/fractional motion', () => {
  const totals = [5, 10, 20, 25, 40].map(ms => {
    const engine = new RecoilEngine(); engine.setInput(shooting);
    return distance(engine, Array(1000 / ms).fill(ms));
  });
  for (const total of totals) {
    assert.ok(total[0] < 0 && total[1] > 0);
    assert.ok(Math.abs(total[0] - totals[0][0]) <= 1);
    assert.ok(Math.abs(total[1] - totals[0][1]) <= 1);
  }
});

test('zero time, invalid time, and stalls cannot produce nonfinite or catch-up motion', () => {
  const engine = new RecoilEngine(); engine.setInput(shooting);
  for (const delta of [0, NaN, Infinity, -1, 251, 10000]) {
    assert.deepEqual(engine.advance(delta), [0, 0]);
  }
  assert.ok(engine.advance(16).every(Number.isInteger));
});

test('pause, release, and reset stop immediately and restart a fresh burst', () => {
  const engine = new RecoilEngine();
  assert.deepEqual(engine.advance(16), [0, 0]);
  engine.setInput(shooting);
  const first = engine.advance(100);
  engine.advance(100);
  engine.setInput({ ...shooting, paused: true });
  assert.deepEqual(engine.advance(100), [0, 0]);
  engine.setInput(shooting);
  assert.deepEqual(engine.advance(100), first);
  engine.setInput({ ...shooting, shooting: false });
  assert.deepEqual(engine.advance(100), [0, 0]);
  engine.setInput(shooting);
  assert.deepEqual(engine.advance(100), first);
  engine.reset();
  assert.deepEqual(engine.advance(100), [0, 0]);
});

test('negative-only profiles still produce movement and pattern modes select the right vector', () => {
  for (const [mode, expected] of [['loop', -120], ['start', -90], ['end', -210]]) {
    const engine = new RecoilEngine({ name: 'Test', rpm: 600, mode,
      recoils: [{ name: 'Default', activate: [], multipliers: [0.1, 0.1], vectors: [[0, 0], [-1, -1], [-2, -2]] }],
    });
    engine.setInput(shooting);
    const total = distance(engine, Array(5).fill(100));
    assert.ok(Math.abs(total[0] - expected) <= 1, `${mode}: ${total}`);
    assert.equal(total[0], total[1]);
  }
});

test('invalid profiles fail at construction instead of reaching native input', () => {
  assert.throws(() => new RecoilEngine({ ...akProfile, rpm: 0 }), /RPM/);
  assert.throws(() => new RecoilEngine({ ...akProfile, recoils: [] }), /default/);
  assert.throws(() => new RecoilEngine({ ...akProfile, recoils: [{ name: 'Bad', activate: [], multipliers: [1, 1], vectors: [] }] }), /Invalid/);
});
