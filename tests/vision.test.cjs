const test = require('node:test'), assert = require('node:assert/strict');
const tools = require('../ui/vision-tools');
const { defaultSettings, activeSetup, selected, effectiveProfile } = require('../build/desktop/settings');
const { visionContext, applyVisionVectors } = require('../build/desktop/vision-settings');
const { VisionSession } = require('../build/desktop/vision-session');
const delay = ms => new Promise(r => setTimeout(r, ms));
function texture(w, h) { let seed = 232; return Float32Array.from({ length: w * h }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24; }); }
function shift(data, w, h, dx, dy) { const out = new Float32Array(data.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = data[Math.max(0, Math.min(h - 1, y - dy)) * w + Math.max(0, Math.min(w - 1, x - dx))]; return out; }
test('CV recovers signed scene translation despite brightness changes and masked weapon pixels', () => {
  const w = 200, h = 120, a = texture(w, h), b = shift(a, w, h, 3, -2).map(v => v * .8 + 20);
  for (let y = 80; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = 255;
  const result = tools.track(a, b, w, h, [{ x: 0, y: 2 / 3, w: 1, h: 1 / 3 }, { x: .4, y: .4, w: .2, h: .2 }]);
  assert.equal(result.valid, true); assert.equal(result.dx, 3); assert.equal(result.dy, -2); assert.ok(result.matches.length >= 6);
});
test('CV rejects blank, fully masked and out-of-range frames instead of inventing motion', () => {
  const w = 200, h = 120, a = texture(w, h);
  assert.equal(tools.track(new Float32Array(w * h), new Float32Array(w * h), w, h).valid, false);
  assert.equal(tools.track(a, a, w, h, [{ x: 0, y: 0, w: 1, h: 1 }]).valid, false);
  assert.equal(tools.track(a, shift(a, w, h, 48, 0), w, h).valid, false);
});
function trace() { return Array.from({ length: 21 }, (_, i) => ({ t: i * 10, x: i, y: i * 2, valid: true, confidence: 1 })); }
test('updates use incremental drift, signed calibration, learning rate and per-axis caps', () => {
  const rows = tools.propose(trace(), 0, 600, [[5, 5], [5, 5]], { gain: [-2, -2], rate: .2, maxChange: 1 });
  assert.deepEqual(rows.map(r => r.residual), [[10, 20], [10, 20]]);
  assert.deepEqual(rows.map(r => r.after), [[6, 6], [6, 6]], 'cumulative drift must not be reapplied to later shots');
  const observed = tools.propose(trace(), 0, 600, [[5, 5], [5, 5]], { gain: [-2, -2], rate: .2, maxChange: 5, mode: 'observe' });
  assert.deepEqual(observed.map(r => r.after), [[5, 6], [5, 6]], 'unassisted observations estimate a total target, not an additive residual');
});
test('bad intervals and short coverage preserve their original vectors', () => {
  const s = trace(); s[15].valid = false;
  const rows = tools.propose(s, 0, 600, [[1, 2], [3, 4], [5, 6]]);
  assert.equal(rows[0].valid, true); assert.equal(rows[1].valid, false); assert.equal(rows[2].valid, false);
  assert.deepEqual(rows[1].after, [3, 4]); assert.deepEqual(rows[2].after, [5, 6]);
  assert.throws(() => tools.propose(s, 0, 600, [[1, 2]], { gain: [0, -1] }), /Invalid/);
  assert.throws(() => tools.propose(s, 0, 600, [[1, 2]], { rate: .9 }), /Invalid/);
  assert.throws(() => tools.propose([...s, s[0]], 0, 600, [[1, 2]]), /timestamps/);
});
test('CV save targets the selected setup, preserves later shots and other stances, and converts effective units', () => {
  const s = defaultSettings(), w = selected(s).weapon;
  w.setups.push({ id: 'test', name: 'Test', attachments: [], profile: { name: 'Test', rpm: 600, mode: 'end', units: 'counts', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: [[2, 4], [3, 5]] }, { name: 'ADS', activate: ['aiming'], multipliers: [1, 1], vectors: [[1, 2]] }] }, tuning: { x: 2, y: 2 }, provenance: 'manual', calibration: null }); w.selectedSetupId = 'test';
  const base = structuredClone(w.profile), key = visionContext(s).key;
  const result = applyVisionVectors(s, key, 0, [[8, 12]], 650), setup = activeSetup(selected(result).weapon);
  assert.deepEqual(setup.profile.recoils[0].vectors, [[4, 6], [3, 5]]);
  assert.deepEqual(effectiveProfile(result).recoils[0].multipliers, [2, 2]);
  assert.deepEqual(selected(result).weapon.profile, base); assert.deepEqual(setup.profile.recoils[1], activeSetup(w).profile.recoils[1]); assert.equal(setup.profile.rpm, 650);
  assert.throws(() => applyVisionVectors(result, key, 0, [[1, 2]], 650), /changed/);
  assert.throws(() => applyVisionVectors(s, key, 9, [[1, 2]], 650), /stance/);
});
const profile = { name: 'Test', units: 'counts', rpm: 600, mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: Array.from({ length: 5 }, () => [0, 10]) }] };
async function fixture(link = true) {
  const events = [], moves = [], output = { profileReady: true, async moveProfile(x, y, current) { if (!current()) return false; moves.push([x, y]); return true; }, async disarm() {} };
  const session = new VisionSession(output, e => events.push(e)); if (link) await session.listen();
  let pressed = false, mouse;
  if (!link) { session.mouseInput(false); mouse = setInterval(() => session.mouseInput(pressed), 80); }
  const close = session.close.bind(session); session.close = () => { clearInterval(mouse); close(); };
  return { session, events, moves, press(value, allow = true) { pressed = value; session.mouseInput(value, allow); }, stopMouse() { clearInterval(mouse); } };
}
test('simulator transport checks token and origin, emits relative vectors, and stops on release', async () => {
  const f = await fixture();
  try {
    const url = new URL(f.session.state.url); url.pathname = '/input';
    assert.equal((await fetch(url, { method: 'POST', body: '{"firing":true}', headers: { Origin: 'https://external.example' } })).status, 403);
    const bad = new URL(url); bad.search = ''; assert.equal((await fetch(bad, { method: 'POST', body: '{}' })).status, 403);
    f.session.arm(profile, 'simulator'); f.session.input(false); f.session.input(true); await delay(90); f.session.input(false);
    assert.ok(f.events.some(e => e.type === 'move' && e.y > 0)); assert.equal(f.moves.length, 0, 'virtual mode must never touch OS pointer');
    const count = f.events.filter(e => e.type === 'move').length; await delay(40); assert.equal(f.events.filter(e => e.type === 'move').length, count);
  } finally { f.session.close(); }
});
test('pointer output stops on heartbeat loss and needs a fresh fire edge after rearming', async () => {
  const f = await fixture();
  try {
    f.session.arm(profile, 'pointer'); f.session.input(true); await delay(360);
    assert.ok(f.moves.length > 0); assert.equal(f.session.state.armed, false);
    const count = f.moves.length; f.session.arm(profile, 'pointer'); f.session.input(true); await delay(30); assert.equal(f.moves.length, count);
    f.session.input(false); f.session.input(true); await delay(80); assert.ok(f.moves.length > count);
    f.session.disarm(); const after = f.moves.length; await delay(40); assert.equal(f.moves.length, after);
  } finally { f.session.close(); }
});
test('observe mode generates no pointer output and burst duration is enforced', async () => {
  const f = await fixture(); let heartbeat;
  try {
    assert.throws(() => f.session.arm({ ...profile, rpm: 30 }, 'pointer'), /five seconds/);
    f.session.arm(profile, 'observe'); f.session.input(true); heartbeat = setInterval(() => f.session.input(true), 80); await delay(550);
    assert.equal(f.moves.length, 0); assert.equal(f.session.state.firing, false);
    assert.ok(f.events.some(e => e.reason === 'Burst complete.'));
  } finally { clearInterval(heartbeat); f.session.close(); }
});

test('countdown arms without recording; fresh mouse hold starts and release stops, with no simulator link', async () => {
  const f = await fixture(false); let capture;
  try {
    assert.throws(() => f.session.arm(profile, 'observe', 'countdown'), /capture/);
    f.session.captureFrame();
    assert.throws(() => f.session.arm(profile, 'observe', 'countdown', 0), /countdown/);
    assert.throws(() => f.session.arm(profile, 'simulator', 'countdown', 3), /Virtual/);
    assert.throws(() => f.session.arm(profile, 'simulator'), /link/);
    capture = setInterval(() => f.session.captureFrame(), 80);
    f.session.arm(profile, 'pointer', 'countdown', 3);
    assert.equal(f.session.state.url, ''); assert.equal(f.session.state.firing, false);
    f.session.input(true); f.session.input(false); f.press(true);
    await delay(3200);
    assert.equal(f.session.state.waiting, true); assert.equal(f.moves.length, 0, 'a held button at the tone must not start');
    assert.deepEqual(f.events.filter(e => e.type === 'countdown').map(e => e.seconds), [3, 2, 1]);
    assert.equal(f.events.filter(e => e.type === 'burst-start').length, 0);
    f.press(false); f.press(true, false); await delay(100);
    assert.equal(f.moves.length, 0, 'clicking the lab must not start movement');
    f.press(false); f.press(true); await delay(100);
    assert.ok(f.moves.length > 0); assert.equal(f.session.state.firing, true);
    f.press(false);
    assert.equal(f.session.state.armed, false); assert.equal(f.session.state.firing, false);
    assert.ok(f.events.some(e => e.reason === 'Fire released.'));
    const count = f.moves.length; f.press(true); await delay(100); assert.equal(f.moves.length, count, 'one take per arming');
  } finally { clearInterval(capture); f.session.close(); }
});
test('stop, capture loss, and close cancel a pending countdown without delayed movement', async () => {
  const f = await fixture(false);
  try {
    f.session.captureFrame(); f.session.arm(profile, 'pointer', 'countdown', 3);
    await delay(850); assert.equal(f.session.state.armed, false);
    assert.ok(f.events.some(e => /capture lost/.test(e.reason || '')));
    f.session.captureFrame(); f.session.arm(profile, 'pointer', 'countdown', 3); f.session.disarm();
    assert.equal(f.session.state.countdown, 0);
    f.session.captureFrame(); f.session.arm(profile, 'pointer', 'countdown', 3); f.session.close();
    await delay(3100); assert.equal(f.moves.length, 0);
    assert.equal(f.events.filter(e => e.type === 'burst-start').length, 0);
  } finally { f.session.close(); }
});
test('stationary capture can stay armed; stalled frames during a take halt pointer output', async () => {
  const f = await fixture(false); let health;
  try {
    f.session.captureFrame(); health = setInterval(() => f.session.captureAlive(), 80);
    const long = structuredClone(profile); long.recoils[0].vectors = Array.from({length: 20}, () => [0, 10]);
    f.session.arm(long, 'pointer', 'countdown', 3); await delay(3400);
    assert.equal(f.session.state.waiting, true, 'no new frames are required from a stationary scene while waiting');
    assert.equal(f.moves.length, 0); f.press(true); await delay(120);
    assert.equal(f.session.state.firing, true); await delay(500);
    assert.equal(f.session.state.armed, false);
    const count = f.moves.length; await delay(80); assert.equal(f.moves.length, count);
    assert.ok(f.events.some(e => /frames stalled/.test(e.reason || '')));
  } finally { clearInterval(health); f.session.close(); }
});
test('mouse listener loss cancels recording; holding past the pattern ends movement without disarming', async () => {
  const f = await fixture(false); let capture;
  try {
    f.session.captureFrame(); capture = setInterval(() => f.session.captureFrame(), 80);
    f.session.arm(profile, 'pointer', 'countdown', 3); await delay(3100); f.press(true); await delay(650);
    assert.equal(f.session.state.armed, true); assert.equal(f.session.state.firing, true);
    assert.equal(f.events.filter(e => e.type === 'pattern-end').length, 1);
    assert.equal(f.events.filter(e => e.type === 'burst-end').length, 0);
    const count = f.moves.length; await delay(100); assert.equal(f.moves.length, count);
    f.session.arm(profile, 'pointer', 'countdown', 3); f.stopMouse(); await delay(450);
    assert.equal(f.session.state.armed, false); assert.ok(f.events.some(e => /Mouse listener lost/.test(e.reason || '')));
  } finally { clearInterval(capture); f.session.close(); }
});

test('a one-entry 600 RPM starter stays recording after 100 ms until physical release', async () => {
  const f = await fixture(false); let capture;
  try {
    f.session.captureFrame(); capture = setInterval(() => f.session.captureFrame(), 80);
    const starter = structuredClone(profile); starter.recoils[0].vectors = [[0, 10]];
    f.session.arm(starter, 'pointer', 'countdown', 3); await delay(3100); f.press(true); await delay(250);
    assert.equal(f.session.state.firing, true); assert.equal(f.session.state.armed, true);
    assert.equal(f.events.filter(e => e.type === 'pattern-end').length, 1);
    const count = f.moves.length; await delay(150); assert.equal(f.moves.length, count, 'never repeat the final vector after the selected pattern');
    f.press(false); assert.equal(f.session.state.firing, false);
    const end = f.events.find(e => e.type === 'burst-end');
    assert.equal(end.reason, 'Fire released.'); assert.ok(end.durationMs >= 400);
  } finally { clearInterval(capture); f.session.close(); }
});
test('extended candidates grow only the selected stance and preserve other stances and setups', () => {
  const s = defaultSettings(), w = selected(s).weapon;
  w.profile = structuredClone(profile); w.profile.recoils[0].vectors = [[0, 1]];
  w.profile.recoils.push({name:'ADS',activate:['aiming'],multipliers:[1,1],vectors:[[1,2]]});
  const result = applyVisionVectors(s, visionContext(s).key, 0, [[2,3],[4,5],[6,7]], 600);
  const saved = selected(result).weapon.profile;
  assert.deepEqual(saved.recoils[0].vectors,[[2,3],[4,5],[6,7]]);
  assert.deepEqual(saved.recoils[1],w.profile.recoils[1]);
  assert.deepEqual(w.profile.recoils[0].vectors,[[0,1]],'saving must not mutate the source settings');
});
test('direct recordings retain a hard 30-second cap even when fire remains held', async () => {
  const f = await fixture(false); let capture;
  try {
    f.session.captureFrame(); capture = setInterval(() => f.session.captureFrame(), 80);
    f.session.arm(profile, 'observe', 'countdown', 3); await delay(3100); f.press(true);
    // Move only the take origin back; input and capture remain fresh.
    f.session.started -= 30001;
    await delay(40);
    assert.equal(f.session.state.armed,false);
    assert.ok(f.events.some(e => /30-second limit/.test(e.reason || '')));
  } finally { clearInterval(capture); f.session.close(); }
});

test('CV tracks large recoil jumps with full-resolution confirmation', () => {
  const w=256,h=144,a=texture(w,h), masks=[{x:.43,y:.43,w:.14,h:.14},{x:0,y:.72,w:1,h:.28}];
  for(const [dx,dy] of [[0,12],[4,20],[-6,-18]]) {
    const result=tools.track(a,shift(a,w,h,dx,dy),w,h,masks);
    assert.equal(result.valid,true,JSON.stringify(result)); assert.equal(result.dx,dx); assert.equal(result.dy,dy);
  }
});
test('20 shots at 600 RPM remain measurable with a 12-pixel kick every shot', () => {
  const w=256,h=144,scene=texture(w,500),masks=[{x:.43,y:.43,w:.14,h:.14},{x:0,y:.72,w:1,h:.28}];
  let previous, total=0;const samples=[];
  for(let i=0;i<=125;i++) {
    const t=i*1000/60-50, recoil=Math.max(0,Math.min(20,Math.floor((t-20)/100)+1))*12;
    const frame=Float32Array.from({length:w*h},(_,j)=>scene[(Math.floor(j/w)+260-recoil)*w+j%w]);
    const r=previous?tools.track(previous,frame,w,h,masks):{valid:true,dy:0,confidence:1};
    if(r.valid)total+=r.dy;
    samples.push({t,x:0,y:total,valid:r.valid,confidence:r.confidence,reason:r.reason});previous=frame;
  }
  const rows=tools.propose(samples,0,600,Array.from({length:20},()=>[0,0]),{mode:'observe'});
  assert.equal(rows.filter(r=>r.valid).length,20,JSON.stringify(rows.map(r=>r.reason)));
  assert.ok(rows.every(r=>r.after[1]>0));
});
test('analysis reports distinct missing-frame, timing, and tracking reasons without changing rejected shots', () => {
  const baseline=[[1,2]];
  assert.equal(tools.propose([],0,600,baseline)[0].reason,'No capture frames');
  const bad=trace().map(p=>({...p,valid:false,reason:'Ambiguous scene motion'}));
  const row=tools.propose(bad,0,600,baseline)[0];assert.equal(row.reason,'Ambiguous scene motion'); assert.deepEqual(row.after,[1,2]);
  const gap=[{t:0,x:0,y:0,valid:true,confidence:1},{t:150,x:1,y:1,valid:true,confidence:1}];
  assert.equal(tools.propose(gap,0,600,baseline)[0].reason,'Capture frame gap');
  const report=tools.diagnostics(bad,[row],0,100);
  assert.equal(report.frames,11); assert.equal(report.validFrames,0); assert.equal(report.reasons['Ambiguous scene motion'],1);
});
