const $ = selector => document.querySelector(selector);
const api = window.vision;
const video = $('#video'), overlay = $('#overlay'), overlayContext = overlay.getContext('2d');
const work = document.createElement('canvas'), workContext = work.getContext('2d', { willReadFrequently: true });
let context, baseline = [], candidate = [], undo = [], proposal = null;
let stream, clipUrl, clipMode = false, previous, previousTime = 0, x = 0, y = 0, samples = [], activeTake, take, settle;
let masks = [], drag, frameCallback, frozen, preparing = false, armRevision = 0;
let audioContext, lastCapturePulse = 0, captureRevision = 0, capturePending = false, mice = [], captureFeed;
let calibrationFrames, collectingCalibration = false;
function invalidateCalibration() {
  $('#calibrated').checked = false;
  $('#calibration-status').textContent = 'Scale needs checking for this capture, zoom, and output. Calibrate again after changing window size or game sensitivity.';
}
async function prepareAudio() {
  audioContext ??= new AudioContext();
  await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('Enable audio before starting a countdown.');
}
function tone(frequency, duration = .12) {
  if (audioContext?.state !== 'running') return;
  const oscillator = audioContext.createOscillator(), volume = audioContext.createGain(), now = audioContext.currentTime;
  oscillator.frequency.value = frequency; volume.gain.setValueAtTime(.12, now);
  volume.gain.exponentialRampToValueAtTime(.001, now + duration);
  oscillator.connect(volume); volume.connect(audioContext.destination); oscillator.start(); oscillator.stop(now + duration);
  oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
}
function updateTrigger() {
  const linked = $('#trigger').value === 'simulator';
  $('#simulator-options').hidden = !linked; $('#countdown-options').hidden = linked;
  $('#virtual-output').hidden = $('#virtual-output').disabled = !linked;
  if (!linked && $('#mode').value === 'simulator') $('#mode').value = 'observe';
  $('#arm').textContent = linked ? 'Arm next burst' : 'Count down & arm';
}
const defaultMasks = () => [{ x: .43, y: .43, w: .14, h: .14 }, { x: 0, y: .72, w: 1, h: .28 }];
const status = (text, error = false) => { $('#lab-status').textContent = text; $('#lab-status').className = error ? 'error' : ''; };
async function attempt(task) { try { await task(); } catch (error) { status(String(error.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, ''), true); } }
function config() {
  const rpm = Number($('#rpm').value), shots = Number($('#shots').value), roi = Number($('#roi').value) / 100;
  const gain = [Number($('#scale-x').value), Number($('#scale-y').value)], rate = Number($('#rate').value) / 100, maxChange = Number($('#limit').value), phase = Number($('#phase').value);
  const maxSeconds = $('#trigger').value === 'simulator' ? 5 : 15;
  if (!Number.isInteger(shots) || shots < 1 || shots > 120 || shots * 60000 / rpm > maxSeconds * 1000) throw new Error(`Choose available shots covering no more than ${maxSeconds} seconds.`);
  if (!Number.isFinite(roi) || roi < .15 || roi > .30 || !Number.isFinite(phase) || phase < -500 || phase > 5000) throw new Error('Invalid crop or shot offset.');
  visionTools.propose([], 0, rpm, takeVectors(shots), { gain, rate, maxChange });
  return { rpm, shots, roi, gain, rate, maxChange, phase, mode: $('#mode').value, trigger: $('#trigger').value, countdown: Number($('#countdown').value), masks: structuredClone(masks) };
}
const takeVectors = shots => Array.from({ length: shots }, (_, i) => [...(candidate[i] ?? [0, 0])]);
function updateDuration() {
  const shots = Number($('#shots').value), rpm = Number($('#rpm').value);
  const seconds = shots * 60 / rpm;
  $('#burst-duration').textContent = Number.isFinite(seconds) && seconds > 0
    ? `${shots} shots · ${seconds.toFixed(2)} s of pattern. ${$('#trigger').value === 'simulator' ? 'Simulator takes end at this limit.' : 'Recording continues until mouse release (30 s maximum). New shots start with zero assistance. Movement ends with the pattern.'}`
    : 'Set RPM and the number of shots to measure.';
}
function clearTrace() { previous = undefined; previousTime = 0; x = y = 0; samples = []; activeTake = undefined; take = undefined; proposal = null; clearTimeout(settle); $('#accept').disabled = true; $('#diagnostics').textContent = ''; }
function changeStance() {
  const index = Number($('#stance').value), profile = context.profile;
  if (!profile?.recoils[index]) { candidate = baseline = []; $('#arm').disabled = true; status('Set up a weapon pattern before using the lab.'); return; }
  baseline = profile.recoils[index].vectors.map((_, i) => patternTools.shotCounts(profile, index, i));
  candidate = structuredClone(baseline); undo = []; proposal = null; frozen = undefined;
  $('#rpm').value = profile.rpm; $('#shots').max = 120; $('#shots').value = Math.min(candidate.length === 1 ? 30 : candidate.length, Math.max(1, Math.floor(15000 * profile.rpm / 60000)));
  updateDuration();
  $('#rows').replaceChildren(); $('#save').disabled = true; $('#undo').disabled = true; $('#arm').disabled = false; clearTrace();
}
async function reload() {
  armRevision++;
  await api.call('stop'); context = await api.call('context');
  $('#context').textContent = `${context.game} / ${context.weapon} / ${context.setup}`;
  $('#stance').replaceChildren(...(context.profile?.recoils ?? []).map((s, i) => { const option = document.createElement('option'); option.value = i; option.textContent = s.name; return option; }));
  changeStance(); status('Setup loaded. Share a game window or open a clip.');
}
function stopCapture() {
  invalidateCalibration();
  if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
  frameCallback = undefined; captureRevision++; armRevision++;
  const feed = captureFeed; captureFeed = undefined;
  if (feed) { void feed.reader.cancel().catch(() => {}); feed.track.stop(); }
  stream?.getTracks().forEach(track => track.stop()); stream = undefined;
  video.pause(); video.srcObject = null; video.removeAttribute('src');
  if (clipUrl) URL.revokeObjectURL(clipUrl); clipUrl = undefined;
  $('#placeholder').hidden = false; $('#capture-status').textContent = 'Screen not shared';
}
function geometry() {
  const roi = Number($('#roi').value) / 100;
  return { roi, x: (1 - roi) / 2, y: (1 - roi) / 2, w: roi, h: roi };
}
function drawOverlay(matches = [], valid = false) {
  if (!video.videoWidth) return;
  overlay.width = video.videoWidth; overlay.height = video.videoHeight;
  const { x: rx, y: ry, w, h } = geometry();
  const ox = rx * overlay.width, oy = ry * overlay.height, rw = w * overlay.width, rh = h * overlay.height;
  overlayContext.clearRect(0, 0, overlay.width, overlay.height);
  overlayContext.lineWidth = Math.max(2, overlay.width / 600); overlayContext.strokeStyle = '#ff7a3d'; overlayContext.strokeRect(ox, oy, rw, rh);
  overlayContext.fillStyle = '#101113b0';
  for (const m of masks) { overlayContext.fillRect(ox + m.x * rw, oy + m.y * rh, m.w * rw, m.h * rh); }
  overlayContext.fillStyle = valid ? '#7fd49b' : '#f2c14e';
  for (const p of matches) overlayContext.fillRect(ox + p.x / work.width * rw - 2, oy + p.y / work.height * rh - 2, 4, 4);
}
function recordFrame(time, source = video) {
  if (samples.length && time <= previousTime) return;
  const width = source === video ? video.videoWidth : source.displayWidth, height = source === video ? video.videoHeight : source.displayHeight;
  if (!width || !height) return;
  const crop = geometry(), cropW = width * crop.w, cropH = height * crop.h;
  work.width = 256; work.height = Math.max(64, Math.round(256 * cropH / cropW));
  workContext.drawImage(source, crop.x * width, crop.y * height, cropW, cropH, 0, 0, work.width, work.height);
  const next = visionTools.gray(workContext.getImageData(0, 0, work.width, work.height).data);
  if (collectingCalibration && calibrationFrames) {
    calibrationFrames.push({ t: time, gray: next, width: work.width, height: work.height, scaleX: cropW / work.width, scaleY: cropH / work.height });
    if (calibrationFrames.length > 600) calibrationFrames.shift();
  }
  let result = { valid: true, confidence: 1, dx: 0, dy: 0, matches: [] };
  if (previous && previous.length !== next.length) result = { ...result, valid: false, reason: 'Capture dimensions changed' };
  else if (previous) result = visionTools.track(previous, next, work.width, work.height, masks);
  if (previous && (time <= previousTime || time - previousTime > 80)) { result.valid = false; result.reason = 'Capture frame gap'; }
  if (result.valid) { x += result.dx * cropW / work.width; y += result.dy * cropH / work.height; }
  if (time > previousTime || !samples.length) {
    const point = { t: time, x, y, valid: result.valid, confidence: result.confidence, reason: result.reason, matches: result.matches.length };
    samples.push(point); if (samples.length > 1200) samples.shift();
    if (activeTake) activeTake.samples.push(point);
  }
  if (!clipMode && stream?.active && performance.now() - lastCapturePulse > 100) {
    lastCapturePulse = performance.now(); void api.call('capture-frame').catch(error => status(error.message, true));
  }
  previous = next; previousTime = time;
  drawOverlay(result.matches, result.valid);
  $('#tracking').textContent = `${Math.round(cropW)} × ${Math.round(cropH)} source px · ${result.matches.length} tracked patches · ${result.valid ? `${Math.round(result.confidence * 100)}% agreement` : result.reason || 'tracking uncertain'}`;
}
function watchFrames() {
  if (!clipMode) {
    if (captureFeed) return;
    if (typeof MediaStreamTrackProcessor === 'undefined') throw new Error('This runtime cannot read live capture frames directly. Update Electron or use a clip.');
    const track = stream.getVideoTracks()[0].clone();
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    const feed = captureFeed = { track, reader };
    void (async () => {
      let offset;
      try {
        while (captureFeed === feed) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          try {
            if (captureFeed !== feed) break;
            offset ??= performance.timeOrigin + performance.now() - frame.timestamp / 1000;
            recordFrame(offset + frame.timestamp / 1000, frame);
          } finally { frame.close(); }
        }
        if (captureFeed === feed) { void api.call('stop'); status('Capture frame stream ended. Share the source again.', true); }
      } catch (error) {
        if (captureFeed === feed) { void api.call('stop'); status(`Capture processing stopped: ${error.message}`, true); }
      } finally {
        if (captureFeed === feed) captureFeed = undefined;
        track.stop(); reader.releaseLock();
      }
    })();
    return;
  }
  frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
    try { recordFrame(clipMode ? metadata.mediaTime * 1000 : performance.timeOrigin + metadata.expectedDisplayTime); }
    catch (error) { status(error.message, true); void api.call('stop'); return; }
    if (!video.ended) watchFrames();
  });
}
function finishTake(event) {
  if (!activeTake) return;
  activeTake.end = event.t; activeTake.reason = event.reason;
  const captured = activeTake;
  clearTimeout(settle);
  settle = setTimeout(() => {
    if (activeTake !== captured) return;
    take = activeTake; activeTake = undefined;
    const summary = `Take recorded for ${((take.end - take.start) / 1000).toFixed(2)} s · ${take.reason}`;
    $('#result').textContent = `${summary} Review the selected ${take.baseline.length} shot intervals before accepting an update.`;
    status(summary);
  }, 200);
}
api.onEvent(event => {
  if (event.type === 'calibration-countdown') {
    tone(480); status(`Calibration in ${event.seconds}… Switch to the game, aim at stationary detail, and keep your mouse still. Do not fire.`);
  } else if (event.type === 'calibration-start') {
    collectingCalibration = !!calibrationFrames; tone(1100, .25);
  } else if (event.type === 'calibration-axis') {
    status(`Measuring ${event.axis === 0 ? 'X' : 'Y'} ${event.direction > 0 ? 'forward' : 'return'} movement. Keep your mouse and player still; do not fire.`);
  } else if (event.type === 'countdown') {
    tone(480); status(`Starting in ${event.seconds}… Switch to your game. The tone means ready to fire.`);
  } else if (event.type === 'waiting') {
    tone(1100, .25); status('Armed · waiting for left mouse. Hold to record; release to stop.');
  } else if (event.type === 'burst-start') {
    if (!frozen || !stream?.active || !captureFeed || !samples.length) { void api.call('stop'); status('Start screen capture before firing.', true); return; }
    clearTimeout(settle); proposal = null; $('#accept').disabled = true;
    activeTake = { start: event.t, mode: event.mode, samples: samples.filter(p => p.t >= event.t - 300).map(p => ({ ...p })), config: structuredClone(frozen), baseline: structuredClone(takeVectors(frozen.shots)) };
    status('Recording burst · candidate held fixed.');
  } else if (event.type === 'pattern-end') {
    status(`Selected ${event.shots}-shot pattern finished. Still recording—release left mouse to finish. Movement has stopped.`);
  } else if (event.type === 'burst-end') { if (frozen?.trigger === 'countdown') tone(280, .35); finishTake(event); }
  else if (event.type === 'status' && !event.armed) {
    if (event.reason !== 'Candidate prepared.' && frozen?.trigger === 'countdown' && !activeTake) tone(280, .35);
    status(event.reason ?? 'Disarmed.');
  }
});
function renderRows(rows) {
  $('#rows').replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    const values = [row.shot, row.valid ? `${Math.round(row.confidence * 100)}% agreement` : `Skipped · ${row.reason || 'Tracking uncertain'}`, row.residual?.map(v => v.toFixed(2)).join(' / ') ?? '—', row.before.map(v => v.toFixed(2)).join(' / '), row.after.map(v => v.toFixed(2)).join(' / ')];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; if (!row.valid) td.className = 'warn'; tr.append(td); } return tr;
  }));
}
function analyze() {
  if (activeTake) throw new Error('Wait for the take to finish before analyzing.');
  const cfg = config();
  const target = clipMode ? { start: 0, samples, baseline: takeVectors(cfg.shots), config: cfg, mode: cfg.mode } : take;
  if (!target) throw new Error('Record a burst or play a clip first.');
  if (!clipMode && !['Fire released.', 'Burst complete.'].includes(target.reason)) throw new Error('This take was interrupted. Record another burst before proposing a correction.');
  proposal = visionTools.propose(target.samples, target.start + cfg.phase, target.config.rpm, target.baseline, { ...cfg, mode: target.mode });
  if (!clipMode) proposal = proposal.map((row, i) => (i + 1) * 60000 / target.config.rpm <= target.end - target.start
    ? row : { ...row, valid: false, after: row.before, residual: undefined, confidence: 0, reason: 'Fire released before interval ended' });
  renderRows(proposal);
  const kept = proposal.filter(r => r.valid).length;
  const end = clipMode ? target.samples.at(-1)?.t ?? target.start : target.end;
  const diagnostics = visionTools.diagnostics(target.samples, proposal, target.start, end);
  const summary = `${diagnostics.frames} frames · ${diagnostics.fps.toFixed(1)} fps · ${diagnostics.validFrames} tracked · largest gap ${Math.round(diagnostics.maxGapMs)} ms`;
  $('#result').textContent = `${kept} / ${proposal.length} shot intervals usable. ${summary}.`;
  $('#diagnostics').textContent = Object.entries(diagnostics.reasons).map(([reason, count]) => `${count} × ${reason}`).join(' · ') || 'All measured intervals passed tracking checks.';
  const advice = diagnostics.frames < 2 ? 'Capture did not supply enough frames. Check the shared source.'
    : diagnostics.fps < 25 || diagnostics.maxGapMs > 80 ? 'Capture is too slow or has gaps. Try sharing the game window at a lower resolution.'
    : diagnostics.validFrames / diagnostics.frames < .5 ? 'Tracking is losing the scene. Keep distinctive wall labels/corners in the crop and mask the weapon, reticle, and muzzle flash. Repeating tiles alone may be ambiguous.'
    : 'Check the first-shot offset and hold through the full burst. Skipped intervals keep their original values.';
  $('#analysis-help').textContent = kept ? 'Only usable intervals will change. Tracking agreement is not proof of aim accuracy.' : advice;
  void api.call('diagnostics', { version: 1, mode: target.mode, rpm: target.config.rpm, shots: target.baseline.length, roi: target.config.roi,
    phase: cfg.phase, durationMs: end - target.start, capture: diagnostics, rows: proposal,
    samples: target.samples.map(p => ({ ...p, t: p.t - target.start })) }).catch(error => status(`Could not save analysis diagnostics: ${error.message}`, true));
  $('#accept').disabled = !kept;
}
$('#reload').onclick = () => void attempt(reload);
$('#stop').onclick = () => void attempt(async () => { armRevision++; await api.call('stop'); status('Disarmed.'); });
// A healthy, stationary shared scene need not deliver new frames while waiting for fire.
// During a take the main process separately requires fresh frames before continuing output.
setInterval(() => {
  const track = stream?.getVideoTracks()[0];
  if (!clipMode && stream?.active && track?.readyState === 'live' && !track.muted && captureFeed && samples.length)
    void api.call('capture-alive').catch(error => status(error.message, true));
}, 150);
async function startCapture(systemPicker = false) {
  if (capturePending) return;
  capturePending = true; $('#sources').disabled = $('#capture').disabled = true;
  let shared;
  try {
    await api.call('stop'); stopCapture(); clearTrace(); clipMode = false;
    const revision = captureRevision;
    if (!systemPicker) await api.call('choose-source', $('#source').value);
    shared = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false });
    if (revision !== captureRevision) { shared.getTracks().forEach(track => track.stop()); return; }
    stream = shared;
    const track = shared.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (stream !== shared) return;
      void api.call('stop'); stopCapture();
      status('Screen sharing ended by the desktop or source window. Choose screen / window to reconnect.', true);
    });
    video.srcObject = shared; await video.play();
    if (stream !== shared) return;
    $('#placeholder').hidden = true; $('#capture-status').textContent = 'Screen sharing · live'; watchFrames();
    status('Capture ready. Connect your mouse, then count down and arm.');
  } catch (error) { if (stream === shared) stopCapture(); throw error; }
  finally { capturePending = false; $('#sources').disabled = $('#capture').disabled = false; }
}
$('#sources').onclick = () => void attempt(async () => {
  const sources = await api.call('sources');
  if (sources.systemPicker) { await startCapture(true); return; }
  $('#source').replaceChildren(...sources.map(s => { const option = document.createElement('option'); option.value = s.id; option.textContent = s.name; return option; }));
  $('#source').hidden = $('#capture').hidden = !sources.length; status(sources.length ? 'Choose the game screen or window, then start capture.' : 'No capture sources were returned.');
});
$('#capture').onclick = () => void attempt(() => startCapture());
function showMousePermission() {
  const device = mice.find(d => d.path === $('#mouse-device').value);
  $('#mouse-allow').hidden = $('#mouse-permission').hidden = !device || device.readable;
}
async function listMice() {
  const previous = $('#mouse-device').value;
  mice = await api.call('mouse-list');
  $('#mouse-device').replaceChildren(...mice.map(d => { const o = document.createElement('option'); o.value = d.path; o.textContent = `${d.name} (${d.path.split('/').pop()})`; return o; }));
  if (mice.some(d => d.path === previous)) $('#mouse-device').value = previous;
  showMousePermission();
  $('#mouse-status').textContent = mice.length ? 'Select the mouse you use to fire, then connect.' : 'No mouse devices found.';
}
$('#mouse-list').onclick = () => void attempt(listMice);
$('#mouse-device').onchange = () => void attempt(async () => { await api.call('mouse-close'); showMousePermission(); $('#mouse-status').textContent = 'Mouse changed. Connect to continue.'; });
$('#mouse-allow').onclick = () => void attempt(async () => {
  $('#mouse-allow').disabled = true;
  try { await api.call('mouse-allow', $('#mouse-device').value); await listMice(); }
  finally { $('#mouse-allow').disabled = false; }
});
$('#mouse-connect').onclick = () => void attempt(async () => {
  $('#mouse-connect').disabled = true;
  try { await api.call('mouse-connect', $('#mouse-device').value); $('#mouse-status').textContent = 'Listening for left mouse · works while your game has focus.'; }
  finally { $('#mouse-connect').disabled = false; }
});
$('#mouse-close').onclick = () => void attempt(async () => { await api.call('mouse-close'); $('#mouse-status').textContent = 'Mouse listener disconnected.'; });
$('#clip').onchange = () => void attempt(async () => {
  const file = $('#clip').files[0]; if (!file) return;
  await api.call('stop'); stopCapture(); clearTrace(); clipMode = true;
  clipUrl = URL.createObjectURL(file); video.src = clipUrl; await video.play(); $('#placeholder').hidden = true; $('#capture-status').textContent = 'Recorded clip'; watchFrames();
  status('Analyzing clip frames. Set the first-shot offset and the output mode used in the clip.');
});
video.addEventListener('ended', () => { if (clipMode) status('Clip finished. Review calibration, then analyze the shot intervals.'); });
$('#end-capture').onclick = () => void attempt(async () => { await api.call('stop'); stopCapture(); status('Capture stopped.'); });
$('#link').onclick = () => void attempt(async () => { const result = await api.call('link'); $('#link-url').value = result.url; status('Local link ready. Connect your simulator with this private URL.'); });
$('#pointer').onclick = () => void attempt(async () => {
  $('#pointer').disabled = true;
  try { await api.call('pointer'); $('#pointer-status').textContent = 'Desktop pointer connected. Select real movement to use it.'; }
  finally { $('#pointer').disabled = false; }
});
$('#disconnect').onclick = () => void attempt(async () => { await api.call('pointer-close'); $('#pointer-status').textContent = 'Desktop pointer disconnected.'; });
$('#calibrate').onclick = () => void attempt(async () => {
  if (preparing) return;
  if (clipMode || !stream?.active || !captureFeed || !samples.length) throw new Error('Share the game window before calibrating.');
  const revision = ++armRevision;
  preparing = true; $('#calibrate').disabled = $('#arm').disabled = true;
  invalidateCalibration();
  try {
    await prepareAudio();
    if (revision !== armRevision) return;
    await api.call('stop');
    if (revision !== armRevision) return;
    clearTrace(); frozen = undefined; $('#mode').value = 'pointer';
    calibrationFrames = []; collectingCalibration = false;
    $('#calibration-status').textContent = 'Calibration in progress. The pointer moves 12 units out and back on each axis.';
    const result = await api.call('calibrate', { key: context.key, countdown: Number($('#countdown').value) });
    if (revision !== armRevision) return;
    // Let the final captured frames reach the renderer before evaluating their timestamps.
    await new Promise(resolve => setTimeout(resolve, 100));
    if (revision !== armRevision) return;
    collectingCalibration = false;
    const measured = visionTools.calibrate(calibrationFrames, result.legs, masks);
    $('#scale-x').value = measured.gain[0].toFixed(4); $('#scale-y').value = measured.gain[1].toFixed(4);
    $('#calibrated').checked = true;
    $('#calibration-status').textContent = `Measured X ${measured.gain[0].toFixed(4)} / Y ${measured.gain[1].toFixed(4)} px per unit · both directions agreed. Repeat after changing zoom, sensitivity, window size, capture source, or output.`;
    tone(1100, .2); status('Calibration applied. Re-aim, then arm a take to test your candidate.');
  } catch (error) {
    $('#calibration-status').textContent = 'Calibration was not applied. Previous scale values were kept; retry after checking the scene and pointer connection.';
    if (revision === armRevision) throw error;
  } finally {
    calibrationFrames = undefined; collectingCalibration = false; preparing = false;
    $('#calibrate').disabled = false; $('#arm').disabled = !candidate.length;
  }
});
$('#arm').onclick = () => void attempt(async () => {
  if (preparing) return;
  if (!stream?.active || !captureFeed || !samples.length) throw new Error('Share the game window first.');
  if (clipMode) throw new Error('Clips are for review; switch to screen capture for a live take.');
  const cfg = config(), revision = ++armRevision;
  if (cfg.mode !== 'observe' && !$('#calibrated').checked) throw new Error('Check the mouse-to-scene scale before assisted output.');
  preparing = true;
  try {
    if (cfg.trigger === 'countdown') await prepareAudio();
    if (revision !== armRevision) return;
    frozen = cfg;
    await api.call('arm', { key: context.key, mode: cfg.mode, trigger: cfg.trigger, countdown: cfg.countdown, profile: { name: 'Vision candidate', units: 'counts', rpm: cfg.rpm, mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: takeVectors(cfg.shots) }] } });
    if (revision !== armRevision) { await api.call('stop'); return; }
    status(cfg.trigger === 'countdown' ? `Starting in ${cfg.countdown} seconds. Switch to your game. The tone means ready to fire.` : 'Armed. Fire in the simulator; release to finish the take.');
  } finally { preparing = false; }
});
$('#analyze').onclick = () => void attempt(async () => { await api.call('stop'); analyze(); });
$('#accept').onclick = () => void attempt(async () => {
  if (!$('#calibrated').checked) throw new Error('Check the signed mouse-to-scene calibration before accepting an update.');
  if (!proposal?.some(r => r.valid)) throw new Error('Analyze a usable take first.');
  await api.call('stop'); undo.push(structuredClone(candidate)); if (undo.length > 20) undo.shift();
  const lastMeasured = proposal.reduce((last, row, i) => row.valid ? i : last, -1);
  candidate = takeVectors(Math.max(candidate.length, lastMeasured + 1));
  for (let i = 0; i < proposal.length; i++) if (proposal[i].valid) candidate[i] = proposal[i].after;
  proposal = null; take = undefined; if (clipMode) samples = []; $('#accept').disabled = true; $('#undo').disabled = false; $('#save').disabled = false;
  status('Candidate updated. Arm a new validation burst before saving.');
});
$('#undo').onclick = () => void attempt(async () => { armRevision++; await api.call('stop'); if (!undo.length) return; candidate = undo.pop(); proposal = null; take = undefined; $('#accept').disabled = true; $('#undo').disabled = !undo.length; $('#save').disabled = JSON.stringify(candidate) === JSON.stringify(baseline); status('Previous candidate restored.'); });
$('#save').onclick = () => void attempt(async () => {
  armRevision++; const selectedStance = Number($('#stance').value);
  context = await api.call('save', { key: context.key, stance: selectedStance, vectors: candidate, rpm: Number($('#rpm').value) });
  changeStance(); status('Candidate saved to this setup. Sensitivity reference and other setups were preserved.');
});
$('#stance').onchange = () => void attempt(async () => { armRevision++; invalidateCalibration(); await api.call('stop'); changeStance(); });
for (const id of ['rpm', 'shots']) $(`#${id}`).addEventListener('input', updateDuration);
$('#roi').oninput = () => { $('#roi-value').textContent = `${$('#roi').value}%`; };
for (const id of ['roi', 'rpm', 'shots', 'mode', 'trigger', 'countdown']) $(`#${id}`).addEventListener('change', () => void attempt(async () => { armRevision++; await api.call('stop'); frozen = undefined; clearTrace(); drawOverlay(); updateTrigger(); updateDuration(); if (id === 'mode') $('#calibrated').checked = false; status('Measurement changed. Capture a new take.'); }));
for (const id of ['phase', 'scale-x', 'scale-y', 'rate', 'limit']) $(`#${id}`).addEventListener('change', () => {
  proposal = null; $('#accept').disabled = true;
  if (calibrationFrames) { armRevision++; void api.call('stop'); }
  if (id.startsWith('scale-')) invalidateCalibration();
});
$('#clear-masks').onclick = () => void attempt(async () => { armRevision++; await api.call('stop'); masks = defaultMasks(); clearTrace(); drawOverlay(); });
overlay.onpointerdown = event => { const r = overlay.getBoundingClientRect(); drag = [(event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height]; overlay.setPointerCapture(event.pointerId); };
overlay.onpointerup = event => void attempt(async () => {
  if (!drag) return;
  const r = overlay.getBoundingClientRect(), end = [(event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height], g = geometry();
  const a = drag.map((v, i) => Math.max(0, Math.min(1, (v - (i ? g.y : g.x)) / g.roi))), b = end.map((v, i) => Math.max(0, Math.min(1, (v - (i ? g.y : g.x)) / g.roi))); drag = undefined;
  if (Math.abs(a[0] - b[0]) < .02 || Math.abs(a[1] - b[1]) < .02) return;
  if (masks.length >= 12) throw new Error('Use up to 12 masks, or reset the mask list.');
  armRevision++; await api.call('stop'); masks.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) }); clearTrace(); drawOverlay();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') { armRevision++; void api.call('stop'); status('Disarmed.'); } });
window.addEventListener('beforeunload', stopCapture);
masks = defaultMasks(); updateTrigger(); void attempt(reload);
