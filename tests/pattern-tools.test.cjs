const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../ui/pattern-tools');

test('after-test fixes scale vertical pull only inside the selected range', () => {
  const vectors = [[0, 20], [2, 20], [-2, 20], [0, 20]];
  assert.deepEqual(tools.correct(vectors, 1, 2, 'high', 0.1), [[0, 20], [2, 22], [-2, 22], [0, 20]]);
  assert.deepEqual(tools.correct(vectors, 0, 3, 'low', 0.25), [[0, 15], [2, 15], [-2, 15], [0, 15]]);
});

test('drift fixes push against the drift, sized from the range and never below half a count', () => {
  const vectors = [[0, 20], [0, 20], [0, 0]];
  assert.deepEqual(tools.correct(vectors, 0, 1, 'left', 0.1), [[2, 20], [2, 20], [0, 0]]);
  assert.deepEqual(tools.correct(vectors, 0, 1, 'right', 0.1), [[-2, 20], [-2, 20], [0, 0]]);
  assert.deepEqual(tools.correct(vectors, 2, 2, 'left', 0.1), [[0, 20], [0, 20], [0.5, 0]]);
});

test('a recorded take splits into shots at the fire rate and ignores an empty-magazine hold', () => {
  // 600 RPM = one shot per 100 ms. The last sample lands after the magazine's 3 shots.
  const samples = [[10000, 1, 5], [60000, 0, 5], [110000, -1, 8], [190000, 0, 2], [250000, 2, 9], [320000, 5, 5]];
  assert.deepEqual(tools.splitTake(samples, 340, 600, 3), [[1, 10], [-1, 10], [2, 9]]);
  assert.deepEqual(tools.splitTake(samples, 195, 600, 30), [[1, 10], [-1, 10]]);
  assert.throws(() => tools.splitTake(samples, 50, 600, 30), /shorter than one shot/);
  assert.throws(() => tools.splitTake(samples, 340, 0, 30), /fire rate/);
});

test('takes combine along the median path, so shot-to-shot jitter that lands in the same place agrees', () => {
  const steady = [[0, 10], [0, 10], [0, 10], [0, 10]];
  // Uneven per shot, but the path ends up in the same spots every other shot.
  const jittery = [[0, 6], [0, 14], [0, 7], [0, 13]];
  const combined = tools.combineTakes([steady, jittery, [[0, 10], [0, 10], [0, 10], [0, 10], [5, 5]]]);
  assert.deepEqual(combined.vectors, [[0, 10], [0, 10], [0, 10], [0, 10]]);
  assert.deepEqual(combined.lengths, [4, 4, 5]);
  assert.deepEqual(combined.ignored, []);
  assert.ok(combined.spread < 0.08, `Jitter that returns to the path stays consistent (${combined.spread})`);
  assert.equal(tools.combineTakes([steady, steady]).spread, 0);
  assert.throws(() => tools.combineTakes([]), /at least one take/);
});

test('with three or more takes, one far from the others is ignored and reported', () => {
  const take = [[0, 10], [1, 10], [0, 10]];
  const drifted = [[0, 10], [15, 10], [15, 10]];
  const combined = tools.combineTakes([take, take.map(pair => [pair[0], pair[1] + 0.4]), drifted]);
  assert.deepEqual(combined.ignored, [2]);
  assert.ok(combined.deviations[2] > 0.3);
  assert.ok(Math.abs(combined.vectors[1][0] - 1) < 1e-9, 'The drifted take does not pull the result');
  assert.deepEqual(tools.combineTakes([take, drifted]).ignored, [], 'Two takes cannot outvote each other');
});

test('smoothing blends neighbouring shots but keeps the first-shot kick and the overall path', () => {
  const take = [[0, 20], [2, 8], [-2, 12], [0, 10]];
  const { vectors } = tools.combineTakes([take], { smooth: true });
  assert.deepEqual(vectors[0], [0, 20]);
  assert.deepEqual(vectors[1], [0.5, 12]);
  assert.deepEqual(vectors[2], [-0.5, 10.5]);
  assert.deepEqual(vectors[3], [0, 10]);
});

test('after-test fixes reject bad ranges, sizes, and directions', () => {
  const vectors = [[0, 20], [0, 20]];
  assert.throws(() => tools.correct(vectors, 1, 0, 'high', 0.1), /range/);
  assert.throws(() => tools.correct(vectors, 0, 2, 'left', 0.1), /range/);
  assert.throws(() => tools.correct(vectors, 0, 1, 'high', 0), /fix size/);
  assert.throws(() => tools.correct(vectors, 0, 1, 'up', 0.1), /high, low/);
  assert.throws(() => tools.correct([[999.8, 0]], 0, 0, 'left', 0.1), /between −1000 and 1000/);
});
