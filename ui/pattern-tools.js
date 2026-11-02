/* Shared pure helpers for the editor and its tests. */
(() => {
  const tools = {
    shotCounts(profile, stanceIndex = 0, shotIndex = 0) {
      const stance = profile.recoils[stanceIndex];
      const scale = profile.units === 'counts' ? 1 : 180000 / profile.rpm;
      return stance.vectors[shotIndex].map((value, axis) => value * stance.multipliers[axis] * scale);
    },
    toCounts(profile) {
      const next = structuredClone(profile);
      if (next.units === 'counts') return next;
      next.recoils = next.recoils.map(stance => ({ ...stance, multipliers: [1, 1],
        vectors: stance.vectors.map(pair => pair.map((v, axis) => Number((v * stance.multipliers[axis] * 180000 / next.rpm).toFixed(9)))) }));
      next.units = 'counts';
      return next;
    },
    ramp(count, start, end) {
      if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error('Choose 1–120 shots.');
      if ([...start, ...end].some(v => !Number.isFinite(v) || Math.abs(v) > 1000)) throw new Error('Counts must be between −1000 and 1000.');
      return Array.from({ length: count }, (_, i) => start.map((v, axis) => Number((v + (end[axis] - v) * (count === 1 ? 0 : i / (count - 1))).toFixed(9))));
    },
    positions(vectors, multipliers = [1, 1]) {
      let point = [0, 0];
      return vectors.map(pair => (point = point.map((value, axis) => value + pair[axis] * multipliers[axis])));
    },
    fromPositions(positions, multipliers = [1, 1]) {
      if (multipliers.some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Use nonzero stance multipliers to edit shot positions.');
      let previous = [0, 0];
      const vectors = positions.map(point => {
        const pair = point.map((value, axis) => Number(((value - previous[axis]) / multipliers[axis]).toFixed(6)));
        previous = point;
        return pair;
      });
      tools.checkVectors(vectors);
      return vectors;
    },
    movePoint(vectors, multipliers, index, position) {
      if (!Number.isInteger(index) || index < 0 || index >= vectors.length || position.length !== 2 || position.some(v => !Number.isFinite(v))) throw new Error('Choose a valid shot position.');
      const points = tools.positions(vectors, multipliers);
      points[index] = position;
      return tools.fromPositions(points, multipliers);
    },
    shape(vectors, from, to, gains) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= vectors.length || from > to || gains.some(v => !Number.isFinite(v))) throw new Error('Choose a valid shot range and scale.');
      const next = vectors.map((pair, i) => pair.map((v, axis) => i >= from && i <= to ? Number((v * gains[axis]).toFixed(6)) : v));
      tools.checkVectors(next); return next;
    },
    // After-test fixes. "High" means shots landed above the target, so pull down harder.
    // Horizontal drift nudges X by a share of the range's average shot size, since X is often near zero.
    correct(vectors, from, to, direction, step) {
      if (!Number.isFinite(step) || step <= 0 || step > 1) throw new Error('Choose a fix size between 1% and 100%.');
      if (direction === 'high' || direction === 'low') return tools.shape(vectors, from, to, [1, direction === 'high' ? 1 + step : 1 - step]);
      if (direction !== 'left' && direction !== 'right') throw new Error('Choose high, low, left, or right.');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= vectors.length || from > to) throw new Error('Choose a valid shot range.');
      const range = vectors.slice(from, to + 1);
      const nudge = Math.max(0.5, step * range.reduce((sum, pair) => sum + Math.hypot(...pair), 0) / range.length) * (direction === 'left' ? 1 : -1);
      const next = vectors.map((pair, i) => i >= from && i <= to ? [Number((pair[0] + nudge).toFixed(6)), pair[1]] : pair);
      tools.checkVectors(next); return next;
    },
    // Recorded pulls: bin a take's [µs since fire, dx, dy] samples into shots at the fire rate.
    // maxShots caps the count so holding fire on an empty magazine adds no phantom shots.
    splitTake(samples, durationMs, rpm, maxShots) {
      if (!Number.isFinite(rpm) || rpm < 30 || rpm > 2000) throw new Error('Set a fire rate between 30 and 2000 RPM first.');
      if (!Number.isInteger(maxShots) || maxShots < 1 || maxShots > 120) throw new Error('Choose 1–120 shots per magazine.');
      const interval = 60000000 / rpm;
      const count = Math.min(maxShots, Math.floor(durationMs * 1000 / interval + 0.1));
      if (count < 1) throw new Error('This take is shorter than one shot at this fire rate.');
      const shots = Array.from({ length: count }, () => [0, 0]);
      for (const [time, dx, dy] of samples) {
        const index = Math.floor(time / interval);
        if (index < count) { shots[index][0] += dx; shots[index][1] += dy; }
      }
      return shots;
    },
    // Takes are compared and combined by where their paths go, not shot by shot: hand jitter makes
    // single shots noisy even when the pull lands in the same place. The result follows the median
    // path. With 3+ takes, one far from the rest is ignored. deviations are each take's average
    // distance from the result as a share of the path's length; spread averages the kept ones.
    // smooth blends each shot with its neighbours (first shot kept) to remove hand jitter.
    combineTakes(takes, { smooth = false } = {}) {
      if (!takes.length) throw new Error('Record at least one take.');
      const count = Math.min(...takes.map(take => take.length));
      const median = values => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
      const paths = takes.map(take => tools.positions(take.slice(0, count)));
      const center = kept => Array.from({ length: count }, (_, i) => [0, 1].map(axis => median(kept.map(index => paths[index][i][axis]))));
      const measure = path => {
        const length = path.reduce((sum, point, i) => sum + Math.hypot(point[0] - (i ? path[i - 1][0] : 0), point[1] - (i ? path[i - 1][1] : 0)), 0) || 1;
        return paths.map(take => take.reduce((sum, point, i) => sum + Math.hypot(point[0] - path[i][0], point[1] - path[i][1]), 0) / count / length);
      };
      let kept = takes.map((_, i) => i);
      let path = center(kept);
      if (takes.length >= 3) {
        const first = measure(path), typical = median(first);
        kept = kept.filter(i => first[i] <= Math.max(2 * typical, 0.05));
        path = center(kept);
      }
      let vectors = path.map((point, i) => [0, 1].map(axis => point[axis] - (i ? path[i - 1][axis] : 0)));
      if (smooth && count >= 3) vectors = vectors.map((pair, i) => i === 0 || i === count - 1 ? pair : [0, 1].map(axis => 0.25 * vectors[i - 1][axis] + 0.5 * pair[axis] + 0.25 * vectors[i + 1][axis]));
      const deviations = measure(path);
      return { vectors, spread: kept.reduce((sum, i) => sum + deviations[i], 0) / kept.length, deviations,
        ignored: takes.map((_, i) => i).filter(i => !kept.includes(i)), lengths: takes.map(take => take.length) };
    },
    checkVectors(vectors) {
      if (!vectors.length || vectors.length > 120 || vectors.some(pair => pair.length !== 2 || pair.some(v => !Number.isFinite(v) || Math.abs(v) > 1000))) throw new Error('Use 1–120 shots with X/Y movement between −1000 and 1000 counts.');
    },
    parse(text, limit = 1000) {
      const lines = text.trim().split(/\r?\n/);
      if (!text.trim() || lines.length > 120) throw new Error('Enter 1–120 X, Y pairs.');
      return lines.map((line, i) => {
        const tokens = line.trim().split(/[\s,]+/);
        if (tokens.length !== 2 || tokens.some(v => !v || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > limit)) throw new Error(`Shot ${i + 1} needs two values between −${limit} and ${limit}.`);
        return tokens.map(Number);
      });
    },
  };
  if (typeof module !== 'undefined') module.exports = tools;
  else globalThis.patternTools = tools;
})();
