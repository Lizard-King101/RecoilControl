let patternUndo = [];
let patternView = 'table';
let draftRevision = 0;
let draftTimer;
let patternConverted = false;
let selectedShot = 0;
let draftTransform;
// The timeline range that after-test fixes and range reshaping apply to.
let patternRange = { from: 0, to: 0 };
let patternDirty = false;
let patternGhost = null;
let fixStep = 0.1;
let lastFix = '';
let cancelGuardAttached = false;
let recordShots = 30;
let recordSmooth = true;
let draftDragging = false;
let drawnOverlay = 'null';
const chart = { width: 600, height: 420, fitX: 520, fitY: 360 };

function editPattern() {
  const saved = current().weapon;
  editDraft = structuredClone(saved);
  patternConverted = !!editDraft.profile && editDraft.profile.units !== 'counts';
  editDraft.profile = editDraft.profile ? patternTools.toCounts(editDraft.profile)
    : { name: editDraft.name, rpm: 600, units: 'counts', mode: 'end', recoils: [{ name: 'Default', activate: [], multipliers: [1, 1], vectors: [[0, 0]] }] };
  patternGhost = saved.profile ? patternTools.toCounts(saved.profile) : null;
  editIndex = Math.min(stance, editDraft.profile.recoils.length - 1);
  patternUndo = []; patternView = 'table'; selectedShot = 0; patternDirty = false; lastFix = '';
  patternRange = { from: 0, to: editDraft.profile.recoils[editIndex].vectors.length - 1 };
  const shotCount = editDraft.profile.recoils[editIndex].vectors.length;
  recordShots = shotCount > 1 ? shotCount : 30;
  if (!cancelGuardAttached) {
    // Leaving the workbench always ends a recording session, so the relay never streams unnoticed.
    document.getElementById('dialog').addEventListener('close', () => {
      if (state.runtime.recording?.active) void attempt(async () => receive(await api.record('stop')));
    });
    // Escape closes a native dialog; ask first when the workbench has unsaved edits.
    document.getElementById('dialog').addEventListener('cancel', event => {
      if (!document.getElementById('dialog').classList.contains('workbench-dialog') || !patternDirty) return;
      event.preventDefault();
      const back = document.querySelector('.wb-back');
      confirmPatternClose(back); back.focus();
    });
    cancelGuardAttached = true;
  }
  patternDialog();
}
function patternCheckpoint() {
  patternUndo.push(structuredClone(editDraft));
  if (patternUndo.length > 25) patternUndo.shift();
  markPatternDirty();
}
function markPatternDirty() {
  patternDirty = true;
  if ($('#wb-dirty')) $('#wb-dirty').hidden = false;
}
// Returns true when the workbench may close; the first press with unsaved edits only asks.
function confirmPatternClose(button) {
  if (!$('#dialog').classList.contains('workbench-dialog') || !patternDirty || button?.dataset.confirm === 'yes') return true;
  button.dataset.confirm = 'yes';
  button.textContent = 'Discard changes?';
  button.classList.add('danger');
  return false;
}
function clampRange() {
  const last = editDraft.profile.recoils[editIndex].vectors.length - 1;
  patternRange = { from: Math.min(patternRange.from, last), to: Math.min(patternRange.to, last) };
}
function rangeLabel() {
  const count = editDraft.profile.recoils[editIndex].vectors.length;
  if (patternRange.from === 0 && patternRange.to === count - 1) return `All ${count} shots`;
  return patternRange.from === patternRange.to ? `Shot ${patternRange.from + 1}` : `Shots ${patternRange.from + 1}–${patternRange.to + 1}`;
}
// Takes recorded through the relay, split at this draft's fire rate. Takes recorded in the
// wrong ADS state for the stance are skipped, since their pull belongs to another stance.
function recordedPull() {
  const recording = state.runtime.recording;
  const recoil = editDraft.profile.recoils[editIndex];
  const aiming = recoil.activate.includes('aiming');
  const rpm = Number($('#pattern-rpm')?.value || editDraft.profile.rpm);
  const usable = recording.takes.map((take, index) => ({ take, index })).filter(item => item.take.aiming === aiming);
  const split = usable.map(({ take }) => patternTools.splitTake(take.samples, take.durationMs, rpm, recordShots));
  return { aiming, usable, split, skipped: recording.takes.length - usable.length, combined: split.length ? patternTools.combineTakes(split, { smooth: recordSmooth }) : null };
}
// Output multiplies saved shots by strength and the calibration's sensitivity/ADS ratios.
// Dividing recorded counts by this makes the saved pattern reproduce the recorded movement.
function recordingDivisor(aiming) {
  const { game } = current();
  const reference = editDraft.calibration;
  const sensitivity = reference ? reference.sensitivity / game.input.sensitivity : 1;
  const ads = reference && aiming ? reference.adsMultiplier / game.input.adsMultiplier : 1;
  return [editDraft.tuning.x, editDraft.tuning.y].map(gain => gain * sensitivity * ads);
}
// Each part is rendered separately so a burst starting cannot replace a button mid-click.
function recordingParts() {
  const recording = state.runtime.recording;
  const recoil = editDraft.profile.recoils[editIndex];
  let pull = null, error = '';
  try { pull = recordedPull(); } catch (value) { error = value.message; }
  const status = `<div class="wb-record-status ${recording.active ? 'live' : ''}"><i></i><strong>${recording.active ? recording.firing ? 'Recording a burst…' : 'Recording · switch to the game and fire a full magazine' : 'Not recording'}</strong></div>`;
  const notice = recording.notice ? `<p class="wb-record-warn">${escape(recording.notice)}</p>` : '';
  const takes = recording.takes.length ? `<ol class="wb-takes">${recording.takes.map((take, i) => {
    const used = pull?.usable.findIndex(item => item.index === i) ?? -1;
    const deviation = used >= 0 && pull.combined && pull.usable.length > 1 ? pull.combined.deviations[used] : null;
    const label = used < 0 ? `skipped · ${take.aiming ? 'ADS' : 'no ADS'}` : pull?.combined?.ignored.includes(used) ? 'ignored · far from the others'
      : deviation === null ? `${(take.durationMs / 1000).toFixed(1)} s` : `${(take.durationMs / 1000).toFixed(1)} s · ${Math.round(deviation * 100)}% off`;
    const tone = used < 0 || pull?.combined?.ignored.includes(used) || deviation > 0.15 ? 'warn' : '';
    return `<li class="${tone}"><span>Take ${i + 1}</span><span>${label}</span><button type="button" class="text-button" data-action="record-remove" data-row="${i}" aria-label="Delete take ${i + 1}">×</button></li>`;
  }).join('')}</ol>` : '';
  const controls = `<div class="action-row">${recording.active ? '<button type="button" class="button" data-action="record-stop">Stop recording</button>' : `<button type="button" class="button ${recording.takes.length ? 'subtle' : ''}" data-action="record-start">${recording.takes.length ? 'Record more takes' : 'Start recording'}</button>`}${recording.takes.length ? '<button type="button" class="button quiet small" data-action="record-clear">Clear all takes</button>' : ''}</div>`;
  let summary = error ? `<p class="wb-record-warn">${escape(error)}</p>` : '';
  if (pull?.skipped) summary += `<p class="wb-record-warn">${pull.skipped} take${pull.skipped === 1 ? ' was' : 's were'} recorded ${pull.aiming ? 'without' : 'with'} ADS, so ${pull.skipped === 1 ? 'it is' : 'they are'} skipped for ${escape(recoil.name)}.</p>`;
  if (pull?.combined) {
    const { spread, ignored, vectors } = pull.combined;
    const kept = pull.usable.length - ignored.length;
    const quality = pull.usable.length < 2 ? 'Record at least one more take to check consistency.'
      : spread < 0.08 ? `Consistent: takes agree within ${Math.round(spread * 100)}% of the path.`
        : spread < 0.15 ? `Takes vary by ${Math.round(spread * 100)}% of the path. One more take helps.`
          : `Takes disagree by ${Math.round(spread * 100)}% of the path. Delete the furthest take or record more.`;
    summary += `<p class="${spread >= 0.15 ? 'wb-record-warn' : 'wb-record-ok'}">${kept} take${kept === 1 ? '' : 's'} · ${vectors.length} shots. ${quality}</p><button type="button" class="button full" data-action="record-apply">Use recording for ${escape(recoil.name)}</button>`;
  }
  return { status, notice, takes, controls, summary };
}
function recordingLive() {
  const recording = state.runtime.recording;
  if (!recording?.supported) return `<p class="wb-record-note">Recording needs the ESP32 relay with firmware 0.5.0 or later. Connect it under <strong>Setup › Board &amp; Bluetooth</strong>, or flash the new firmware first.</p>`;
  if (!recording.available && !recording.active) return `<p class="wb-record-note">Waiting for the relay. Make sure the Cobra and Windows Bluetooth links are both connected.</p>`;
  const parts = recordingParts();
  return ['status', 'notice', 'takes', 'controls'].map(name => `<div data-part="${name}">${parts[name]}</div>`).join('')
    + `<label class="wb-check"><input type="checkbox" id="record-smooth" ${recordSmooth ? 'checked' : ''}> Smooth out hand jitter</label><div data-part="summary">${parts.summary}</div>`;
}
// State arrives many times a second while recording; only replace the parts that changed.
function refreshRecording() {
  const panel = $('#wb-record-live');
  if (!panel) return;
  const recording = state.runtime.recording;
  const mode = !recording?.supported ? 'unsupported' : !recording.available && !recording.active ? 'waiting' : 'ready';
  if (panel.dataset.mode !== mode) { panel.innerHTML = recordingLive(); panel.dataset.mode = mode; }
  if (mode === 'ready') {
    const parts = recordingParts();
    for (const element of panel.querySelectorAll('[data-part]')) {
      const html = parts[element.dataset.part];
      if (element.dataset.rendered !== html) { element.innerHTML = html; element.dataset.rendered = html; }
    }
  }
  const overlay = JSON.stringify(recordingOverlay());
  if ($('#draft-chart') && !draftDragging && overlay !== drawnOverlay) drawDraft();
}
// The takes and their combined path, in the draft's units, for drawing behind the draft.
function recordingOverlay() {
  if (!state.runtime.recording?.takes.length) return null;
  try {
    const { aiming, split, combined } = recordedPull();
    if (!combined) return null;
    const divisor = recordingDivisor(aiming);
    const path = vectors => [[0, 0], ...patternTools.positions(vectors.map(pair => pair.map((value, axis) => value / divisor[axis])))];
    return { takes: split.map((vectors, i) => ({ points: path(vectors), ignored: combined.ignored.includes(i) })), combined: path(combined.vectors) };
  } catch { return null; }
}
function applyRecording() {
  const { aiming, combined } = recordedPull();
  if (!combined) throw new Error('Record at least one take for this stance first.');
  const divisor = recordingDivisor(aiming);
  const vectors = combined.vectors.map(pair => pair.map((value, axis) => Number((value / divisor[axis]).toFixed(3))));
  patternTools.checkVectors(vectors);
  patternCheckpoint();
  const recoil = editDraft.profile.recoils[editIndex];
  recoil.vectors = vectors; recoil.multipliers = [1, 1];
  // Without a reference, record the setup these counts were made at so later sensitivity changes scale them.
  editDraft.calibration ??= { ...current().game.input, at: new Date().toISOString() };
  patternRange = { from: 0, to: vectors.length - 1 };
  const kept = combined.lengths.length - combined.ignored.length;
  lastFix = `${recoil.name} now uses your recorded pull (${kept} take${kept === 1 ? '' : 's'}). Test a burst, then use these fixes. Undo restores the previous shots.`;
}
function patternRows(recoil) {
  return recoil.vectors.map((pair, i) => `<tr data-shot-row="${i}" class="${i === selectedShot ? 'selected-shot' : ''}"><td><button type="button" class="text-button" data-action="select-shot" data-row="${i}" aria-label="Select shot ${i + 1}">${i + 1}</button></td>${pair.map((value, axis) => `<td><input class="shot-count" data-shot="${i}" data-axis="${axis}" aria-label="Shot ${i + 1} ${axis ? 'vertical' : 'horizontal'} counts" type="number" step="any" min="-1000" max="1000" value="${value}" required></td>`).join('')}<td><button type="button" class="text-button" data-action="duplicate-shot" data-row="${i}" aria-label="Duplicate shot ${i + 1}">＋</button><button type="button" class="text-button" data-action="remove-shot" data-row="${i}" aria-label="Remove shot ${i + 1}">×</button></td></tr>`).join('');
}
function patternDialog() {
  const profile = editDraft.profile;
  const recoil = profile.recoils[editIndex];
  selectedShot = Math.min(selectedShot, recoil.vectors.length - 1);
  clampRange();
  const first = recoil.vectors[0]; const last = recoil.vectors.at(-1);
  const fixes = [['high', 'Went high', 'Pull down more'], ['low', 'Went low', 'Pull down less'], ['left', 'Drifted left', 'Push right'], ['right', 'Drifted right', 'Push left']];
  $('#dialog').className = 'workbench-dialog';
  $('#dialog').innerHTML = `<form id="modal-form" class="workbench" data-submit="pattern">
    <header class="wb-head"><button type="button" class="wb-back" data-action="close-dialog">‹ Loadout</button><span class="weapon-abbr">${escape(abbreviation(editDraft))}</span><label class="wb-name"><span class="kicker">Pattern</span><input id="pattern-name" value="${escape(editDraft.name)}" maxlength="80" required aria-label="Weapon name"></label>
      <div class="wb-head-actions"><span id="wb-dirty" class="wb-dirty" ${patternDirty ? '' : 'hidden'}>Unsaved changes</span><button type="button" class="button subtle" data-action="pattern-undo" ${patternUndo.length ? '' : 'disabled'}>Undo</button><button type="submit" class="button">Save pattern</button></div></header>
    <div id="dialog-error" class="dialog-error wb-error" role="alert"></div>
    <div class="wb-body">
      <section class="wb-main" aria-label="Pattern canvas">
        <div class="wb-stances"><span class="kicker">Stance</span>${profile.recoils.map((item, i) => `<button type="button" class="stance-tab ${i === editIndex ? 'active' : ''}" data-action="edit-stance" data-row="${i}" aria-pressed="${i === editIndex}">${escape(item.name)}</button>`).join('')}<button type="button" class="text-button" data-action="add-stances" ${profile.recoils.length === 4 ? 'disabled' : ''}>+ Add missing stances</button><span class="wb-legend"><i class="draft"></i>Draft <i class="ghost"></i>Saved</span></div>
        <div class="wb-canvas"><svg id="draft-chart" viewBox="0 0 ${chart.width} ${chart.height}" role="group" aria-label="Editable shot positions"></svg><span class="wb-axis">origin (0,0) · X → right · Y ↓ down · counts · preview never moves the mouse</span></div>
        <div class="wb-timeline"><div class="wb-timeline-head"><button type="button" class="button subtle small" data-action="play-draft">▷ Preview</button><span class="kicker">Shots · click to select, Shift+click for a range</span><strong id="wb-range-label" class="wb-range">${rangeLabel()}</strong><button type="button" class="text-button" data-action="range-all">Select all</button></div><div id="wb-timeline" class="wb-bars" role="group" aria-label="Shot timeline"></div><p id="draft-summary" class="hint">Updating preview…</p></div>
      </section>
      <aside class="wb-inspector">
        <section class="wb-section wb-record"><div class="card-kicker">Record a pull · ${escape(recoil.name)}</div><p>Start recording, switch to a practice range, and fire full magazines at a wall while pulling the mouse to stay on target. Only bursts fired while the game has focus are recorded, so clicks in this window never count. Use the stance you are editing${recoil.activate.includes('aiming') ? ', with ADS held' : ''}${recoil.activate.includes('crouching') ? ', crouched' : ''}.</p><div class="field"><label for="record-shots">Shots per magazine</label><input id="record-shots" type="number" min="1" max="120" step="1" value="${recordShots}"><small>Fire rate comes from the Pattern section (${profile.rpm} RPM). Shots after the magazine runs dry are ignored.</small></div><div id="wb-record-live">${recordingLive()}</div></section>
        <section class="wb-section"><div class="card-kicker">Fix after a test burst</div><p>Fire a burst, then tell the pattern what happened to <strong id="wb-fix-range">${rangeLabel().toLowerCase()}</strong>.</p><div class="wb-fixes">${fixes.map(([id, label, detail]) => `<button type="button" class="wb-fix" data-action="fix-pattern" data-fix="${id}"><strong>${label}</strong><small>${detail}</small></button>`).join('')}</div><div class="field wb-step"><label for="fix-step">Fix size</label><select id="fix-step">${[[0.05, 'Small · 5%'], [0.1, 'Medium · 10%'], [0.2, 'Large · 20%']].map(([value, label]) => `<option value="${value}" ${value === fixStep ? 'selected' : ''}>${label}</option>`).join('')}</select></div><p id="wb-last-fix" class="hint" ${lastFix ? '' : 'hidden'}>${escape(lastFix)}</p></section>
        <section class="wb-section selected-point"><strong id="selected-shot-label"></strong><div class="field-row"><div class="field"><label for="shot-position-x">Position X</label><input id="shot-position-x" type="number" step="any"></div><div class="field"><label for="shot-position-y">Position Y</label><input id="shot-position-y" type="number" step="any"></div></div><button class="button subtle small" type="button" data-action="apply-shot-position">Set shot position</button><p class="hint">Drag a point on the canvas, or type its position. Other shots stay where they are. Counts from the origin, including stance strength.</p></section>
        <section class="wb-section"><div class="card-kicker">Pattern</div><div class="field-row"><div class="field"><label for="pattern-rpm">Fire rate · RPM</label><input id="pattern-rpm" type="number" min="30" max="2000" value="${profile.rpm}" required></div><div class="field"><label for="repeat-mode">After the last shot</label><select id="repeat-mode"><option value="end" ${profile.mode === 'end' ? 'selected' : ''}>Repeat last</option><option value="start" ${profile.mode === 'start' ? 'selected' : ''}>Use first</option><option value="loop" ${profile.mode === 'loop' ? 'selected' : ''}>Loop pattern</option></select></div></div><div class="field"><label>Stance multiplier · horizontal / vertical</label><div class="field-row"><input id="multiplier-x" aria-label="Horizontal multiplier on shot counts" type="number" min="0" max="2" step="any" value="${recoil.multipliers[0]}" required><input id="multiplier-y" aria-label="Vertical multiplier on shot counts" type="number" min="0" max="2" step="any" value="${recoil.multipliers[1]}" required></div></div><p id="pattern-strength-explanation" class="hint">${patternConverted ? '<strong>Your saved tuning is included.</strong> The existing stance strength has been folded into the shot counts. ' : ''}The multiplier scales those counts: <strong>1 × 1 uses them as entered</strong>.</p></section>
        <details class="pattern-generator"><summary>Shot table · ${recoil.vectors.length} shots</summary><div class="workshop-toolbar"><button type="button" class="text-button" data-action="pattern-view">${patternView === 'table' ? 'Paste / edit pairs' : 'Shot table'}</button></div>
        ${patternView === 'table' ? `<div class="shot-scroll"><table class="shot-table"><thead><tr><th>Shot</th><th>X · counts</th><th>Y · counts</th><th>Edit</th></tr></thead><tbody>${patternRows(recoil)}</tbody></table></div><button type="button" class="text-button" data-action="add-shot">+ Add shot</button>` : `<div class="field"><label for="vectors">One X, Y pair per line</label><textarea id="vectors" spellcheck="false" required>${recoil.vectors.map(pair => pair.join(', ')).join('\n')}</textarea><small>1–120 pairs. Counts from −1000 to 1000.</small></div>`}</details>
        <details class="pattern-generator"><summary>Reshape a range by percentage</summary><p>Scale movement in a range. Use a negative percentage to mirror an axis.</p><div class="field-row"><div class="field"><label for="shape-from">From shot</label><input id="shape-from" type="number" min="1" max="${recoil.vectors.length}" value="${patternRange.from + 1}"></div><div class="field"><label for="shape-to">Through shot</label><input id="shape-to" type="number" min="1" max="${recoil.vectors.length}" value="${patternRange.to + 1}"></div></div><div class="field-row"><div class="field"><label for="shape-x">Horizontal %</label><input id="shape-x" type="number" step="any" min="-500" max="500" value="100"></div><div class="field"><label for="shape-y">Vertical %</label><input id="shape-y" type="number" step="any" min="-500" max="500" value="100"></div></div><button class="button subtle" type="button" data-action="shape-pattern">Apply to range</button></details>
        <details class="pattern-generator"><summary>Build from shot positions / a recoil guide</summary><p>Enter one position per shot relative to a (0, 0) origin, in firing order. X is right and Y is down. Use positions from a guide or repeated unassisted sprays as a starting estimate; scale still needs in-game tuning.</p><div class="field"><label for="position-pairs">Shot positions · X, Y per line</label><textarea id="position-pairs" placeholder="0, -10&#10;2, -22&#10;5, -35"></textarea></div><div class="field-row"><div class="field"><label for="position-kind">These positions show</label><select id="position-kind"><option value="recoil">Game recoil (invert both axes)</option><option value="output">Desired compensation</option></select></div><div class="field"><label for="position-scale">Counts per reference unit</label><input id="position-scale" type="number" step="any" min="0.001" max="1000" value="1"></div></div><button class="button subtle" type="button" data-action="import-positions">Convert to this stance</button><p class="hint">Replaces this stance and sets its multiplier to 1 × 1. Undo restores it. Screen pixels are not mouse counts.</p></details>
        <details class="pattern-generator"><summary>Generate a constant pattern or a ramp</summary><p>Enter the first and last shot. Matching values make a constant pattern. Generation replaces this stance’s shots; Undo restores them.</p><div class="field"><label for="generate-count">Number of shots</label><input id="generate-count" type="number" min="1" max="120" step="1" value="${Math.max(10, recoil.vectors.length)}"></div><div class="field-row"><div class="field"><label>First shot · X / Y</label><input id="generate-start-x" aria-label="First shot X" type="number" step="any" value="${first[0]}"><input id="generate-start-y" aria-label="First shot Y" type="number" step="any" value="${first[1]}"></div><div class="field"><label>Last shot · X / Y</label><input id="generate-end-x" aria-label="Last shot X" type="number" step="any" value="${last[0]}"><input id="generate-end-y" aria-label="Last shot Y" type="number" step="any" value="${last[1]}"></div></div><button type="button" class="button subtle" data-action="generate-pattern">Generate shots</button></details>
        <details class="pattern-generator"><summary>Copy another stance</summary><div class="field"><label for="copy-from">Copy shots and strength from</label><select id="copy-from">${profile.recoils.map((item, i) => `<option value="${i}" ${i === editIndex ? 'disabled' : ''}>${escape(item.name)}</option>`).join('')}</select></div><button type="button" class="button subtle small" data-action="copy-stance" ${profile.recoils.length < 2 ? 'disabled' : ''}>Copy into this stance</button></details>
      </aside>
    </div></form>`;
  if (!$('#dialog').open) $('#dialog').showModal();
  attachPatternDrag();
  drawDraft();
  queueDraftPreview();
}
function capturePattern(validate = true) {
  if (validate && !$('#modal-form').reportValidity()) throw new Error('Complete the required pattern values.');
  const vectors = patternView === 'text' ? patternTools.parse($('#vectors').value)
    : Array.from(document.querySelectorAll('.shot-table tbody tr'), row => Array.from(row.querySelectorAll('input'), field => field.value.trim() === '' ? NaN : Number(field.value)));
  if (vectors.some(pair => pair.length !== 2 || pair.some(value => !Number.isFinite(value) || Math.abs(value) > 1000))) throw new Error('Each shot needs two counts between −1000 and 1000.');
  editDraft.name = $('#pattern-name').value.trim();
  editDraft.profile.name = editDraft.name;
  editDraft.profile.rpm = Number($('#pattern-rpm').value);
  editDraft.profile.mode = $('#repeat-mode').value;
  editDraft.profile.recoils[editIndex].multipliers = [Number($('#multiplier-x').value), Number($('#multiplier-y').value)];
  editDraft.profile.recoils[editIndex].vectors = vectors;
}
function refreshShotSelection() {
  const recoil = editDraft.profile.recoils[editIndex];
  selectedShot = Math.min(selectedShot, recoil.vectors.length - 1);
  const point = patternTools.positions(recoil.vectors, recoil.multipliers)[selectedShot];
  $('#selected-shot-label').textContent = `Shot ${selectedShot + 1} · end position`;
  $('#shot-position-x').value = Number(point[0].toFixed(4));
  $('#shot-position-y').value = Number(point[1].toFixed(4));
  document.querySelectorAll('[data-shot-row]').forEach(row => row.classList.toggle('selected-shot', Number(row.dataset.shotRow) === selectedShot));
}
function refreshRange() {
  $('#wb-range-label').textContent = rangeLabel();
  $('#wb-fix-range').textContent = rangeLabel().toLowerCase();
  $('#shape-from').value = patternRange.from + 1;
  $('#shape-to').value = patternRange.to + 1;
}
function syncShotFields() {
  const vectors = editDraft.profile.recoils[editIndex].vectors;
  if ($('#vectors')) $('#vectors').value = vectors.map(pair => pair.join(', ')).join('\n');
  document.querySelectorAll('.shot-count').forEach(field => { field.value = vectors[Number(field.dataset.shot)][Number(field.dataset.axis)]; });
}
function drawTimeline(recoil) {
  const sizes = recoil.vectors.map(pair => Math.hypot(pair[0] * recoil.multipliers[0], pair[1] * recoil.multipliers[1]));
  const largest = Math.max(1, ...sizes);
  $('#wb-timeline').innerHTML = sizes.map((size, i) => {
    const state = [i >= patternRange.from && i <= patternRange.to ? 'in-range' : '', i === selectedShot ? 'selected' : ''].join(' ');
    return `<button type="button" class="wb-bar ${state}" data-action="timeline-shot" data-row="${i}" aria-label="Shot ${i + 1}, ${Number(size.toFixed(1))} counts" title="Shot ${i + 1}"><span style="height:${Math.max(6, size / largest * 100).toFixed(1)}%"></span></button>`;
  }).join('');
}
function drawDraft(fixedTransform) {
  const recoil = editDraft.profile.recoils[editIndex];
  const positions = [[0, 0], ...patternTools.positions(recoil.vectors, recoil.multipliers)];
  const saved = patternGhost?.recoils.find(item => item.name === recoil.name);
  const ghost = saved ? [[0, 0], ...patternTools.positions(saved.vectors, saved.multipliers)] : [];
  const overlay = recordingOverlay();
  drawnOverlay = JSON.stringify(overlay);
  const bounds = [...positions, ...ghost, ...(overlay ? [...overlay.combined, ...overlay.takes.flatMap(take => take.points)] : [])];
  const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  draftTransform = fixedTransform ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.min(chart.fitX / Math.max(20, maxX - minX), chart.fitY / Math.max(20, maxY - minY)) };
  const t = draftTransform;
  const project = p => [chart.width / 2 + (p[0] - t.x) * t.scale, chart.height / 2 + (p[1] - t.y) * t.scale];
  const points = positions.map(project);
  const origin = points[0];
  const line = list => list.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
  const inRange = i => i >= patternRange.from && i <= patternRange.to;
  $('#draft-chart').innerHTML = `<path d="M 15 ${origin[1]} H ${chart.width - 15} M ${origin[0]} 15 V ${chart.height - 15}" stroke="#2a2e33" stroke-dasharray="3 4"/>`
    + (ghost.length ? `<path d="${line(ghost.map(project))}" fill="none" stroke="#4a4f55" stroke-width="2" stroke-dasharray="5 4"/>` : '')
    // Recorded takes: thin lines (red when ignored as far from the others), combined result in green.
    + (overlay ? overlay.takes.map(take => `<path d="${line(take.points.map(project))}" fill="none" stroke="${take.ignored ? '#ff7b72' : '#6b7178'}" stroke-width="1.2" stroke-opacity=".7" ${take.ignored ? 'stroke-dasharray="2 3"' : ''}/>`).join('')
      + `<path d="${line(overlay.combined.map(project))}" fill="none" stroke="#7fd49b" stroke-width="2" stroke-dasharray="6 4"/><text x="16" y="24" fill="#7fd49b" font-size="11">- - recorded result</text><text x="16" y="40" fill="#9aa0a6" font-size="11">— each take${overlay.takes.some(take => take.ignored) ? ' (red: ignored)' : ''}</text>` : '')
    + `<path d="${line(points)}" fill="none" stroke="#ff9d6e" stroke-width="2"/><circle cx="${origin[0]}" cy="${origin[1]}" r="4" fill="#c9cdd1"/><text x="${origin[0] + 7}" y="${origin[1] - 8}" fill="#c9cdd1" font-size="10">0</text>`
    + points.slice(1).map((point, i) => {
      const fill = i === selectedShot ? '#ff7a3d' : inRange(i) ? '#2a1e16' : '#1f2226';
      const stroke = i === selectedShot || inRange(i) ? '#ff7a3d' : '#4a4f55';
      return `<circle data-point="${i}" cx="${point[0]}" cy="${point[1]}" r="${i === selectedShot ? 8 : 6}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" tabindex="0" role="button" aria-label="Select shot ${i + 1}"/><text x="${point[0] + 10}" y="${point[1] + 4}" fill="#c9cdd1" font-size="10" pointer-events="none">${i + 1}</text>`;
    }).join('');
  const total = positions.at(-1);
  $('#draft-summary').textContent = `${(recoil.vectors.length * 60 / editDraft.profile.rpm).toFixed(2)} s · ${recoil.vectors.length} shots · total X ${Number(total[0].toFixed(2))}, Y ${Number(total[1].toFixed(2))} counts`;
  drawTimeline(recoil);
  refreshShotSelection();
  refreshRange();
}
function queueDraftPreview() {
  clearTimeout(draftTimer);
  const revision = ++draftRevision;
  draftTimer = setTimeout(async () => {
    if (!$('#draft-chart')) return;
    try {
      capturePattern(false);
      await api.previewDraft(editDraft.profile, editIndex);
      if (revision !== draftRevision || !$('#draft-chart')) return;
      drawDraft();
    } catch (error) { if (revision === draftRevision && $('#draft-summary')) $('#draft-summary').textContent = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  }, 120);
}
// Canvas-only playback of the draft; it never sends mouse movement.
function playDraft() {
  const svg = $('#draft-chart'); const circles = svg ? [...svg.querySelectorAll('circle[data-point]')] : [];
  if (!circles.length) return;
  const interval = 60000 / editDraft.profile.rpm;
  circles.forEach(circle => circle.classList.remove('played'));
  circles.forEach((circle, i) => setTimeout(() => circle.isConnected && circle.classList.add('played'), i * interval));
  setTimeout(() => circles.forEach(circle => circle.classList.remove('played')), circles.length * interval + 400);
}
function attachPatternDrag() {
  const svg = $('#draft-chart'); let drag;
  const local = event => new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  svg.addEventListener('keydown', event => {
    if (!event.target.hasAttribute('data-point') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); selectedShot = Number(event.target.dataset.point); drawDraft(); $('#shot-position-x').focus();
  });
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.target.hasAttribute('data-point')) return;
    try {
      capturePattern(); patternCheckpoint(); clearTimeout(draftTimer); ++draftRevision;
      selectedShot = Number(event.target.dataset.point);
      drag = { transform: { ...draftTransform }, vectors: structuredClone(editDraft.profile.recoils[editIndex].vectors) }; draftDragging = true;
      svg.setPointerCapture(event.pointerId); event.preventDefault(); drawDraft(drag.transform);
      $('[data-action="pattern-undo"]').disabled = false;
    } catch (error) { $('#dialog-error').textContent = error.message; }
  });
  svg.addEventListener('pointermove', event => {
    if (!drag) return;
    try {
      const p = local(event), t = drag.transform;
      const target = [(p.x - chart.width / 2) / t.scale + t.x, (p.y - chart.height / 2) / t.scale + t.y].map(v => Number(v.toFixed(2)));
      const recoil = editDraft.profile.recoils[editIndex];
      recoil.vectors = patternTools.movePoint(drag.vectors, recoil.multipliers, selectedShot, target);
      syncShotFields(); drawDraft(t); $('#dialog-error').textContent = '';
    } catch (error) { $('#dialog-error').textContent = error.message; }
  });
  const finish = event => {
    if (!drag) return;
    if (event.type === 'pointercancel') { editDraft.profile.recoils[editIndex].vectors = drag.vectors; syncShotFields(); }
    drag = undefined; draftDragging = false;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    drawDraft();
  };
  svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish);
}

function patternAction(action, row, options = {}) {
  if (action === 'pattern-undo') {
    const previous = patternUndo.pop(); if (previous) { editDraft = previous; lastFix = ''; editIndex = Math.min(editIndex, editDraft.profile.recoils.length - 1); patternDialog(); } return;
  }
  if (action === 'play-draft') { playDraft(); return; }
  capturePattern();
  if (action === 'record-apply') {
    applyRecording();
    const keepOpen = [...document.querySelectorAll('#dialog details')].map(item => item.open);
    patternDialog();
    document.querySelectorAll('#dialog details').forEach((item, i) => { item.open = !!keepOpen[i]; });
    return;
  }
  if (action === 'select-shot') { selectedShot = row; drawDraft(); return; }
  if (action === 'timeline-shot') {
    patternRange = options.shift ? { from: Math.min(selectedShot, row), to: Math.max(selectedShot, row) } : { from: row, to: row };
    selectedShot = row; drawDraft(); return;
  }
  if (action === 'range-all') { patternRange = { from: 0, to: editDraft.profile.recoils[editIndex].vectors.length - 1 }; drawDraft(); return; }
  if (action === 'edit-stance') {
    editIndex = row; selectedShot = 0;
    patternRange = { from: 0, to: editDraft.profile.recoils[editIndex].vectors.length - 1 };
    patternDialog(); return;
  }
  if (action === 'pattern-view') { patternView = patternView === 'table' ? 'text' : 'table'; patternDialog(); $('#dialog details').open = true; return; }
  patternCheckpoint();
  const recoil = editDraft.profile.recoils[editIndex];
  const before = recoil.vectors.length;
  if (action === 'fix-pattern') {
    fixStep = Number($('#fix-step').value);
    recoil.vectors = patternTools.correct(recoil.vectors, patternRange.from, patternRange.to, options.fix, fixStep);
    lastFix = `${rangeLabel()}: ${{ high: 'pulled down', low: 'eased off', left: 'pushed right', right: 'pushed left' }[options.fix]} by ${Math.round(fixStep * 100)}%. Test again, or Undo.`;
  }
  if (action === 'shape-pattern') recoil.vectors = patternTools.shape(recoil.vectors, Number($('#shape-from').value) - 1, Number($('#shape-to').value) - 1, [Number($('#shape-x').value) / 100, Number($('#shape-y').value) / 100]);
  if (action === 'apply-shot-position') recoil.vectors = patternTools.movePoint(recoil.vectors, recoil.multipliers, selectedShot, [Number($('#shot-position-x').value), Number($('#shot-position-y').value)]);
  if (action === 'import-positions') {
    const scale = Number($('#position-scale').value) * ($('#position-kind').value === 'recoil' ? -1 : 1);
    recoil.vectors = patternTools.fromPositions(patternTools.parse($('#position-pairs').value, 120000).map(pair => pair.map(v => v * scale)));
    recoil.multipliers = [1, 1];
  }
  if (action === 'generate-pattern') recoil.vectors = patternTools.ramp(Number($('#generate-count').value), [Number($('#generate-start-x').value), Number($('#generate-start-y').value)], [Number($('#generate-end-x').value), Number($('#generate-end-y').value)]);
  if (action === 'add-shot' || action === 'duplicate-shot') {
    if (recoil.vectors.length >= 120) throw new Error('A pattern can have at most 120 shots.');
    const index = action === 'add-shot' ? recoil.vectors.length - 1 : row;
    recoil.vectors.splice(index + 1, 0, [...recoil.vectors[index]]);
  }
  if (action === 'remove-shot') { if (recoil.vectors.length === 1) throw new Error('Keep at least one shot.'); recoil.vectors.splice(row, 1); }
  if (action === 'copy-stance') {
    const source = editDraft.profile.recoils[Number($('#copy-from').value)];
    recoil.vectors = structuredClone(source.vectors); recoil.multipliers = [...source.multipliers];
  }
  if (action === 'add-stances') {
    const base = editDraft.profile.recoils.find(item => !item.activate.length);
    for (const [name, activate] of [['Crouch', ['crouching']], ['ADS', ['aiming']], ['Crouch ADS', ['crouching', 'aiming']]]) {
      if (!editDraft.profile.recoils.some(item => [...item.activate].sort().join(',') === [...activate].sort().join(','))) editDraft.profile.recoils.push({ ...structuredClone(base), name, activate });
    }
  }
  // Replacing the whole stance resets the range; other edits keep it.
  if (['import-positions', 'generate-pattern', 'copy-stance'].includes(action) || recoil.vectors.length !== before && patternRange.to === before - 1 && patternRange.from === 0) patternRange = { from: 0, to: recoil.vectors.length - 1 };
  const keepOpen = [...document.querySelectorAll('#dialog details')].map(item => item.open);
  patternDialog();
  document.querySelectorAll('#dialog details').forEach((item, i) => { item.open = !!keepOpen[i]; });
}
