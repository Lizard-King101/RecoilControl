/* Small, dependency-free CV prototype: masked patch tracking and bounded between-take updates. */
(() => {
  const median = values => { const a = [...values].sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const masked = (x, y, masks) => masks.some(m => x >= m.x && y >= m.y && x <= m.x + m.w && y <= m.y + m.h);
  function corner(data, width, height, sx, sy, masks, radius) {
    let point = { x: sx, y: sy, score: 0 };
    for (let y = Math.max(radius + 1, sy - 10); y <= Math.min(height - radius - 2, sy + 10); y += 3) {
      for (let x = Math.max(radius + 1, sx - 10); x <= Math.min(width - radius - 2, sx + 10); x += 3) {
        if (masked(x / width, y / height, masks)) continue;
        let xx = 0, yy = 0, xy = 0;
        for (let oy = -3; oy <= 3; oy += 3) for (let ox = -3; ox <= 3; ox += 3) {
          const i = (y + oy) * width + x + ox, dx = data[i + 1] - data[i - 1], dy = data[i + width] - data[i - width];
          xx += dx * dx; yy += dy * dy; xy += dx * dy;
        }
        const score = (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 2;
        if (score > point.score) point = { x, y, score };
      }
    }
    return point;
  }
  function trackLevel(previous, next, width, height, masks, search = 8, cx0 = 0, cy0 = 0, minMatches = 6) {
      if (previous.length !== width * height || next.length !== previous.length) throw new Error('Frame dimensions changed.');
      const radius = 7, border = radius + 3, matches = [];
      let textured = 0, boundary = 0, available = 0; const selected = new Set();
      for (let seedY = border; seedY < height - border; seedY += Math.max(14, Math.floor(height / 6))) {
        for (let seedX = border; seedX < width - border; seedX += Math.max(14, Math.floor(width / 8))) {
          const { x: gx, y: gy } = corner(previous, width, height, seedX, seedY, masks, radius);
          if (masks.some(m => (gx + radius) / width >= m.x && (gx - radius) / width <= m.x + m.w && (gy + radius) / height >= m.y && (gy - radius) / height <= m.y + m.h)) continue;
          const key = `${gx},${gy}`; if (selected.has(key)) continue; selected.add(key);
          available++;
          const patch = []; let mean = 0;
          for (let y = -radius; y <= radius; y += 2) for (let x = -radius; x <= radius; x += 2) { const v = previous[(gy + y) * width + gx + x]; patch.push(v); mean += v; }
          mean /= patch.length;
          const centered = patch.map(v => v - mean), variance = centered.reduce((sum, v) => sum + v * v, 0);
          if (variance / patch.length < 100) continue;
          textured++;
          const candidates = [];
          for (let dy = cy0 - search; dy <= cy0 + search; dy++) for (let dx = cx0 - search; dx <= cx0 + search; dx++) {
            const cx = gx + dx, cy = gy + dy;
            if (cx - radius < 0 || cy - radius < 0 || cx + radius >= width || cy + radius >= height) continue;
            // Reject patches touching masks in either frame, including the search endpoint.
            if (masks.some(m => (cx + radius) / width >= m.x && (cx - radius) / width <= m.x + m.w && (cy + radius) / height >= m.y && (cy - radius) / height <= m.y + m.h)) continue;
            let sum = 0, sum2 = 0, dot = 0, index = 0;
            for (let y = -radius; y <= radius; y += 2) for (let x = -radius; x <= radius; x += 2) {
              const v = next[(cy + y) * width + cx + x]; sum += v; sum2 += v * v; dot += v * centered[index++];
            }
            const denom = Math.sqrt(variance * Math.max(0, sum2 - sum * sum / patch.length));
            candidates.push({ dx, dy, score: denom > 0 ? dot / denom : -1, x: gx, y: gy });
          }
          const best = candidates.reduce((best, p) => !best || p.score > best.score ? p : best, undefined);
          const alternative = candidates.reduce((alt, p) => best && Math.hypot(p.dx - best.dx, p.dy - best.dy) > 2 && (!alt || p.score > alt.score) ? p : alt, undefined);
          if (best && best.score >= .8 && (Math.abs(best.dx - cx0) === search || Math.abs(best.dy - cy0) === search)) boundary++;
          if (best && best.score >= .8 && Math.abs(best.dx - cx0) < search && Math.abs(best.dy - cy0) < search && (!alternative || best.score - alternative.score >= .04)) matches.push(best);
        }
      }
      if (matches.length < minMatches) return { valid: false, dx: 0, dy: 0, confidence: 0, matches, reason: available < minMatches ? 'Masked region' : textured < minMatches ? 'Not enough scene texture' : boundary >= 3 ? 'Motion exceeds tracking range' : 'Ambiguous scene motion' };
      const mx = median(matches.map(p => p.dx)), my = median(matches.map(p => p.dy));
      const inliers = matches.filter(p => Math.hypot(p.dx - mx, p.dy - my) <= 1.5);
      const confidence = inliers.length / matches.length;
      return { valid: inliers.length >= minMatches && confidence >= .65, dx: median(inliers.map(p => p.dx)), dy: median(inliers.map(p => p.dy)), confidence, matches: inliers, reason: confidence >= .65 ? undefined : 'Scene patches disagree' };
  }
  const tools = {
    gray(rgba) { const out = new Float32Array(rgba.length / 4); for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] * .299 + rgba[i * 4 + 1] * .587 + rgba[i * 4 + 2] * .114; return out; },
    track(previous, next, width, height, masks = [], wide = false) {
      const fine = trackLevel(previous, next, width, height, masks);
      if (fine.valid || ['Masked region', 'Not enough scene texture'].includes(fine.reason)) return fine;
      // A kick may exceed the small frame-to-frame search. Estimate at half resolution,
      // then verify at full resolution without reducing agreement/ambiguity requirements.
      const w = Math.floor(width / 2), h = Math.floor(height / 2);
      const down = data => {
        const result = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * 2 * width + x * 2;
          result[y * w + x] = (data[i] + data[i + 1] + data[i + width] + data[i + width + 1]) / 4;
        }
        return result;
      };
      const coarse = trackLevel(down(previous), down(next), w, h, masks, wide ? 32 : 16, 0, 0, 4);
      if (!coarse.valid) return { ...fine, reason: coarse.reason === 'Motion exceeds tracking range' ? coarse.reason : fine.reason };
      const refined = trackLevel(previous, next, width, height, masks, 3, Math.round(coarse.dx * 2), Math.round(coarse.dy * 2));
      return refined;
    },
    calibrate(frames, legs, masks = []) {
      if (legs.length !== 4 || !frames.length) throw new Error('Calibration needs both directions on both axes.');
      const first = frames[0], gains = [[], []], confidence = [];
      if (frames.some((f, i) => f.width !== first.width || f.height !== first.height || f.scaleX !== first.scaleX || f.scaleY !== first.scaleY || i && f.t <= frames[i - 1].t)) throw new Error('Capture size or timing changed. Repeat calibration.');
      const measure = (a, b) => {
        // Anchored calibration spans a whole movement, unlike adjacent recording frames.
        const r = tools.track(a.gray, b.gray, a.width, a.height, masks, true);
        if (!r.valid) throw new Error(`Calibration tracking failed: ${r.reason || 'uncertain scene'}. Aim at distinctive, stationary detail and retry.`);
        confidence.push(r.confidence); return [r.dx, r.dy];
      };
      for (const [index, leg] of legs.entries()) {
        if (leg.axis !== Math.floor(index / 2) || leg.units !== (index % 2 ? -12 : 12) || ![leg.beforeStart, leg.moveStart, leg.moveEnd, leg.end].every(Number.isFinite) || !(leg.beforeStart < leg.moveStart && leg.moveStart < leg.moveEnd && leg.moveEnd < leg.end)) throw new Error('Invalid calibration movement.');
        const covered = frames.filter(f => f.t >= leg.beforeStart && f.t <= leg.end);
        const before = covered.filter(f => f.t <= leg.moveStart);
        const after = covered.filter(f => f.t >= leg.moveEnd + 100);
        if (before.length < 3 || after.length < 3 || before[0].t - leg.beforeStart > 80 || leg.end - after.at(-1).t > 80 || covered.some((f, i) => i && f.t - covered[i - 1].t > 80)) throw new Error('Too few capture frames or a frame gap during calibration. Retry with live capture.');
        const driftBefore = measure(before[0], before.at(-1)), driftAfter = measure(after[0], after.at(-1));
        if (Math.hypot(...driftBefore) > 1.25 || Math.hypot(...driftAfter) > 1.25) throw new Error('Scene moved while the pointer was still. Keep the mouse and player still; do not fire.');
        const probes = [after[0], after[Math.floor(after.length / 2)], after.at(-1)].map(f => measure(before.at(-1), f));
        const displacement = [0, 1].map(axis => median(probes.map(p => p[axis])));
        const primary = displacement[leg.axis], cross = displacement[1 - leg.axis];
        if (Math.abs(primary) < 2) throw new Error('Pointer response was too small to measure. Confirm the game has mouse capture and responds to Linux desktop pointer output.');
        if (Math.abs(cross) > Math.max(1.5, Math.abs(primary) * .15)) throw new Error('Unexpected movement on the other axis. Keep the mouse and player still and retry.');
        const gain = primary * (leg.axis === 0 ? first.scaleX : first.scaleY) / leg.units;
        if (!Number.isFinite(gain) || Math.abs(gain) < .01 || Math.abs(gain) > 100) throw new Error('Measured scale is outside the supported range.');
        gains[leg.axis].push(gain);
      }
      for (const [a, b] of gains) if (Math.sign(a) !== Math.sign(b) || Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) > .25) throw new Error('Opposite directions gave inconsistent scales. Keep the same zoom and a stationary scene, then retry.');
      return { gain: gains.map(pair => median(pair)), confidence: Math.min(...confidence) };
    },
    diagnostics(samples, rows, start, end) {
      const captured = samples.filter(p => p.t >= start && p.t <= end);
      const gaps = captured.slice(1).map((p, i) => p.t - captured[i].t);
      const reasons = {};
      for (const row of rows) if (!row.valid) reasons[row.reason || 'Tracking uncertain'] = (reasons[row.reason || 'Tracking uncertain'] || 0) + 1;
      return { frames: captured.length, fps: captured.length > 1 ? (captured.length - 1) * 1000 / (captured.at(-1).t - captured[0].t) : 0,
        validFrames: captured.filter(p => p.valid).length, maxGapMs: gaps.length ? Math.max(...gaps) : 0, reasons };
    },
    propose(samples, start, rpm, baseline, { gain = [-1, -1], rate = .2, maxChange = 5, mode = 'simulator', maxGap = 80 } = {}) {
      if (!Number.isFinite(rpm) || rpm < 30 || rpm > 2000 || !baseline.length || baseline.length > 120 || gain.length !== 2 || gain.some(v => !Number.isFinite(v) || Math.abs(v) < .01 || Math.abs(v) > 100) || !Number.isFinite(rate) || rate <= 0 || rate > .25 || !Number.isFinite(maxChange) || maxChange <= 0 || maxChange > 50) throw new Error('Invalid timing, calibration, or update limits.');
      if (samples.some((p, i) => ![p.t, p.x, p.y].every(Number.isFinite) || i > 0 && p.t <= samples[i - 1].t)) throw new Error('Capture timestamps must be finite and increasing.');
      const at = t => {
        const i = samples.findIndex(p => p.t >= t);
        if (i < 0) return { reason: 'Capture ended before interval' };
        const b = samples[i];
        if (b.t === t) return b.valid ? b : { reason: b.reason || 'Tracking lost at boundary' };
        const a = samples[i - 1];
        if (!a) return { reason: 'Capture starts after interval' };
        if (b.t - a.t > maxGap) return { reason: 'Capture frame gap' };
        if (!a.valid || !b.valid) return { reason: a.reason || b.reason || 'Tracking lost at boundary' };
        const f = (t - a.t) / (b.t - a.t); return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
      };
      return baseline.map((vector, i) => {
        const from = start + i * 60000 / rpm, to = start + (i + 1) * 60000 / rpm;
        const a = at(from), b = at(to), frames = samples.filter(p => p.t > from && p.t <= to);
        const badFrame = frames.find(p => !p.valid);
        const reason = !samples.length ? 'No capture frames' : a.reason || b.reason
          || (frames.length < 2 ? 'Too few frames per shot' : undefined)
          || (badFrame ? badFrame.reason || 'Tracking lost within interval' : undefined)
          || (frames.some((p, j) => p.t - (j ? frames[j - 1].t : from) > maxGap) ? 'Capture frame gap' : undefined);
        if (reason) return { shot: i + 1, valid: false, before: [...vector], after: [...vector], reason };
        const residual = [b.x - a.x, b.y - a.y];
        const correction = residual.map((v, axis) => -v / gain[axis] - (mode === 'observe' ? vector[axis] : 0));
        const change = correction.map(v => Math.max(-maxChange, Math.min(maxChange, v * rate)));
        const after = vector.map((v, axis) => Math.max(-1000, Math.min(1000, v + change[axis])));
        return { shot: i + 1, valid: true, residual, before: [...vector], after, confidence: frames.reduce((n, p) => n + p.confidence, 0) / frames.length };
      });
    },
  };
  if (typeof module !== 'undefined') module.exports = tools; else globalThis.visionTools = tools;
})();
