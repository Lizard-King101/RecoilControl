const api = window.control;
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let state;
let view = 'arsenal';
let stance = 0;
let chartRevision = 0;
let chartPoints = [];
let chartDuration = 1000;
let animation;
let toastTimer;
let editDraft;
let editIndex = 0;
let boardPorts = [];
let firmwareConfirm = false;
let deletionContext;
// Loadout and Controls follow the selected game; device and overlay pages live in Settings.
const sections = { arsenal: 'arsenal', calibration: 'arsenal', input: 'settings', board: 'settings', controls: 'controls', hud: 'settings', community: 'community' };
const provenanceNames = { legacy: 'Legacy tuning', template: 'Needs setup', manual: 'Custom tuning', calibrated: 'Locally calibrated' };
const cardStatus = { legacy: 'Legacy', template: 'Empty', manual: 'Custom', calibrated: 'Calibrated' };
const abbreviations = { ak: 'AK', lr300: 'LR', mp5: 'MP5', thompson: 'TH', 'custom-smg': 'SMG', m249: '249' };
const abbreviation = weapon => abbreviations[weapon.id] ?? weapon.name.slice(0, 3).toUpperCase();

function current(settings = state.settings) {
  const game = settings.games.find(game => game.id === settings.selectedGameId) ?? state.emptySelection.game;
  return { game, weapon: game.weapons.find(weapon => weapon.id === game.selectedWeaponId) ?? state.emptySelection.weapon };
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 6500 : 3200);
}
async function attempt(task) {
  try { return await task(); } catch (error) {
    const message = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, '');
    if ($('#dialog').open && $('#dialog-error')) $('#dialog-error').textContent = message;
    else toast(message, true);
    return null;
  }
}
function receive(next, force = false) {
  if (!next) return;
  const changed = !state || JSON.stringify([state.settings.games, state.settings.selectedGameId, state.settings.output, state.runtime.passthrough, state.runtime.relay]) !== JSON.stringify([next.settings.games, next.settings.selectedGameId, next.settings.output, next.runtime.passthrough, next.runtime.relay]);
  state = next;
  if (changed || force) render(); else updateLive();
}
async function save(next, message = 'Saved. Compensation is disabled while settings change.') {
  receive(await api.save(next), true);
  toast(message);
}
function badge(weapon) { return `<span class="badge ${weapon.provenance}">${provenanceNames[weapon.provenance]}</span>`; }
function heading(eyebrow, title, subtitle, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div><div class="heading-actions">${actions}</div></div>`;
}
function settingsTabs() {
  return `<div class="sub-tabs" role="tablist" aria-label="Settings sections">${[['input','Mouse & sensitivity'],['board','Board & Bluetooth'],['hud','HUD']].map(([id,label]) => `<button class="sub-tab ${view === id ? 'active' : ''}" role="tab" aria-selected="${view === id}" data-view="${id}">${escape(label)}</button>`).join('')}</div>`;
}
function closeSettingsMenu() {
  $('#settings-options').hidden = true;
  $('#settings-button').setAttribute('aria-expanded', 'false');
}

function tabs(weapon) {
  if (!weapon.profile) return '';
  stance = Math.min(stance, weapon.profile.recoils.length - 1);
  return `<div class="stance-tabs">${weapon.profile.recoils.map((recoil, index) => `<button class="stance-tab ${index === stance ? 'active' : ''}" data-stance="${index}">${escape(recoil.name)}</button>`).join('')}</div>`;
}
function patternPanel(weapon, extra = '') {
  const recoil = weapon.profile?.recoils[stance];
  const counts = recoil ? patternTools.shotCounts(weapon.profile, stance) : null;
  return `<section class="pattern-panel"><div class="panel-head"><strong>Compensation path</strong><span>${weapon.profile ? `${recoil?.vectors.length ?? 0} POINTS / ${weapon.profile.mode.toUpperCase()} REPEAT` : 'NO PATTERN YET'}</span></div>${tabs(weapon)}<div class="chart-area" id="chart"><span class="chart-caption">MOUSE OUTPUT</span><svg viewBox="0 0 700 230" aria-label="Compensation path preview" role="img"></svg><span class="chart-unit">RELATIVE COUNTS</span></div><div class="pattern-stats"><div><span class="stat-label">FIRE RATE</span><span class="stat-value">${weapon.profile?.rpm ?? '—'}<small>RPM</small></span></div><div><span class="stat-label">PATTERN LENGTH</span><span class="stat-value">${recoil?.vectors.length ?? '—'}<small>points</small></span></div><div><span class="stat-label">${extra || 'ACTIVE STANCE'}</span><span class="stat-value" style="font-size:16px">${escape(recoil?.name ?? 'Not configured')}</span></div></div>${counts ? `<div class="saved-pattern-output"><strong>Saved first shot · X ${counts[0].toFixed(2)} / Y ${counts[1].toFixed(2)} counts</strong><span>Includes saved stance tuning, before global strength and sensitivity scaling.</span></div>` : ''}</section>`;
}

function sparkline(weapon) {
  const recoil = weapon.profile?.recoils[0];
  if (!recoil?.vectors.length) return '<span class="spark-empty">No pattern yet</span>';
  const points = [[0, 0], ...patternTools.positions(recoil.vectors, recoil.multipliers)];
  const [minX, maxX, minY, maxY] = [0, 1].flatMap(axis => [Math.min(...points.map(p => p[axis])), Math.max(...points.map(p => p[axis]))]);
  const scale = Math.min(110 / Math.max(1, maxX - minX), 60 / Math.max(1, maxY - minY));
  const offsetX = 60 - (minX + maxX) * scale / 2;
  const offsetY = 35 - (minY + maxY) * scale / 2;
  return `<svg class="spark" viewBox="0 0 120 70" aria-hidden="true"><polyline points="${points.map(([x, y]) => `${(offsetX + x * scale).toFixed(1)},${(offsetY + y * scale).toFixed(1)}`).join(' ')}"/></svg>`;
}
function weaponCard(item, selected) {
  const label = setupName(item); item = weaponView(item);
  const stances = item.profile ? `${item.profile.recoils.length} ${item.profile.recoils.length === 1 ? 'stance' : 'stances'}` : 'Not configured';
  return `<button class="weapon-row weapon-card ${selected ? 'selected' : ''}" data-weapon="${escape(item.id)}"><span class="card-top"><span class="weapon-abbr">${escape(abbreviation(item))}</span><span class="badge ${item.provenance}">${cardStatus[item.provenance]}</span></span>${sparkline(item)}<span class="card-name"><strong>${escape(item.name)}</strong><small>${escape(label)} · ${stances}</small></span></button>`;
}
function loadout(tab) {
  const { game, weapon: owner } = current();
  if (!game.id) return emptyCollection();
  if (!owner.id) return emptyCollection(game);
  const weapon = weaponView(owner);
  const actions = '<button class="button quiet delete-action" data-action="delete-game">Delete game</button><button class="button subtle" data-action="import">Import</button><button class="button" data-action="new-weapon">Add weapon</button>';
  const shots = weapon.profile?.recoils[stance]?.vectors.length;
  const meta = [weapon.category, weapon.profile && `${weapon.profile.rpm} RPM`, shots && `${shots} shots`].filter(Boolean).map(escape).join(' · ');
  const panelTabs = `<div class="panel-tabs" role="tablist" aria-label="Weapon workspace">${[['arsenal', 'Pattern'], ['calibration', 'Tune']].map(([id, label]) => `<button class="panel-tab ${view === id ? 'active' : ''}" role="tab" aria-selected="${view === id}" data-view="${id}">${label}</button>`).join('')}</div>`;
  return heading(`${escape(game.name)} · ${game.weapons.length} weapons · ${keyLabel(game.bindings.previousWeapon)} / ${keyLabel(game.bindings.nextWeapon)} cycles`, 'Loadout', '', actions)
    + `<div class="loadout ${tab === 'tune' ? 'tuning' : ''}"><section class="weapon-grid" aria-label="Weapons">${game.weapons.map(item => weaponCard(item, item.id === weapon.id)).join('')}</section><aside class="weapon-panel" aria-label="${escape(weapon.name)}"><div class="panel-title"><span class="weapon-abbr">${escape(abbreviation(weapon))}</span><div><h2>${escape(weapon.name)}</h2><span class="subtitle">${meta}</span></div>${badge(weapon)}</div>${attachmentPanel(owner)}${panelTabs}${tab === 'tune' ? tuneTab(weapon) : patternTab(weapon)}</aside></div>`;
}
function arsenal() { return loadout('pattern'); }
function patternTab(weapon) {
  const note = weapon.provenance === 'legacy'
    ? '<strong>This profile is from your 2023 project.</strong> Keep it as a starting point and calibrate it against your current setup. <button class="inline-link" data-action="source">About Rust recoil ↗</button>'
    : weapon.provenance === 'template' ? 'A weapon slot, ready for your own values. Set a fire rate and movement vectors, or import a saved profile.'
      : weapon.provenance === 'calibrated' ? `Calibration saved ${escape(new Date(weapon.calibration.at).toLocaleDateString())} at ${weapon.calibration.dpi} DPI and ${weapon.calibration.sensitivity} sensitivity. This is your local tuning record.`
        : 'Your custom movement values. Use the calibration workspace to preview the output and tune it against your setup.';
  return `${patternPanel(weapon)}<p class="profile-note">${note}</p><div class="panel-actions"><button class="button" data-action="edit-pattern">${weapon.profile ? 'Edit pattern' : 'Set up pattern'}</button><button class="button subtle small" data-action="vision-lab">Vision lab</button><button class="button subtle small" data-action="export">Export</button><button class="button subtle small" data-action="duplicate-weapon">Duplicate</button><button class="button quiet small delete-action" data-action="delete-weapon">Delete weapon</button></div>`;
}
function emptyCollection(game) {
  return heading(game ? `${escape(game.name)} · 0 weapons` : 'Your collection', game ? 'Loadout' : 'No games yet', '', game ? '<button class="button quiet delete-action" data-action="delete-game">Delete game</button>' : '')
    + `<section class="card collection-empty"><div class="card-kicker">${game ? 'An empty loadout' : 'Start fresh'}</div><h2>${game ? 'Add your first weapon.' : 'Make room for your next setup.'}</h2><p>${game ? 'Your game settings and controls are still here. Add a weapon or import a saved weapon profile.' : 'Create a game collection, or install a shared game pack from the community library.'}</p><div class="action-row"><button class="button" data-action="${game ? 'new-weapon' : 'new-game'}">${game ? 'Add weapon' : 'Add game'}</button>${game ? '<button class="button subtle" data-action="import">Import weapon</button>' : ''}<button class="button subtle" data-view="community">Browse community</button></div></section>`;
}
function tuneTab(weapon) {
  const { game } = current();
  if (!weapon.profile) return `<div class="empty-panel"><h2>Give this weapon a starting point.</h2><p>${escape(weapon.name)} doesn’t have a movement profile yet. Enter your measured values or import a saved profile before tuning.</p><button class="button" data-action="edit-pattern">Set up pattern</button></div>`;
  return `${patternPanel(weapon)}<div class="action-row"><button class="button subtle small" data-action="play-preview">▷ Play preview</button><span class="hint">Canvas only · no mouse movement</span></div>`
    + tuningPanel()
    + `<section class="panel-section"><div class="card-kicker">Output strength · all stances</div><p>Scales every stance. Edit the pattern for individual shots or stance multipliers.</p><div class="strength-grid"><div class="field"><div class="range-label"><label for="gain-x">Horizontal</label><output id="gain-x-value">${weapon.tuning.x.toFixed(2)}×</output></div><input id="gain-x" type="range" min="0.05" max="5" step="0.01" value="${weapon.tuning.x}"></div><div class="field"><div class="range-label"><label for="gain-y">Vertical</label><output id="gain-y-value">${weapon.tuning.y.toFixed(2)}×</output></div><input id="gain-y" type="range" min="0.05" max="5" step="0.01" value="${weapon.tuning.y}"></div></div><button class="button subtle full" data-action="save-tuning">Apply strength</button></section>`
    + `<section class="panel-section"><div class="card-kicker">Calibration record</div><div class="step-list"><div class="step">Confirm your DPI and sensitivity under Settings → Mouse &amp; sensitivity.</div><div class="step">Test a burst in your practice session and adjust strength to match what you observe.</div><div class="step">After checking each stance, save a calibration record for this setup.</div></div><div class="setup-line"><span><strong>${game.input.dpi}</strong> DPI</span><span><strong>${game.input.sensitivity}</strong> sensitivity</span><span><strong>${game.input.adsMultiplier}×</strong> ADS</span></div><button class="button full" data-action="calibrate">Save calibration</button><p class="hint" style="margin-top:10px">Records the setup you have tested. It does not certify a game’s current recoil pattern.</p></section>`;
}

function outputControls() {
  if (state.runtime.relay && !state.runtime.passthrough) return `<section class="card" style="margin-bottom:20px"><h2>Cobra relay + weapon profiles</h2><p>The selected weapon uses the same Bluetooth mouse connection as your Cobra. ${keyLabel(current().game.bindings.toggle)} ${current().game.bindings.activationMode === 'hold' ? 'enables recoil while held' : 'toggles recoil'}; Escape disables it. ${keyLabel(current().game.bindings.pause)} and configuration focus pause it. Release fire after pausing.</p><div class="hint">Closing or disconnecting the app stops recoil. Physical movement, clicks, and scrolling continue while the board has power. DPI measurement through the old driver is unavailable; enter DPI manually.</div></section>`;
  if (state.runtime.passthrough) return '<section class="card" style="margin-bottom:20px"><h2>Mouse passthrough</h2><p>The Cobra Pro is relayed through the board. Recoil output and driver capture are disabled during this test. Use Settings › Board &amp; Bluetooth for pairing and diagnostics.</p></section>';
  return `<section class="card" style="margin-bottom:20px"><div class="field"><label for="output-device">Mouse output</label><select id="output-device"><option value="interception" ${state.settings.output === 'interception' ? 'selected' : ''}>Interception driver (legacy)</option><option value="bluetooth" ${state.settings.output === 'bluetooth' ? 'selected' : ''}>ESP32 Bluetooth</option></select></div><p>Bluetooth uses the selected weapon, tuning, and stances. Connect USB under Settings › Board &amp; Bluetooth, then enable with ${keyLabel(current().game.bindings.toggle)}. Left mouse fires, right mouse selects ADS, and your stance keys are set under Controls.</p><div class="hint">Escape disables; ${keyLabel(current().game.bindings.pause)} and configuration focus pause. After pausing, release fire before starting another burst. Bluetooth stops after a connection fault, a timing gap, or 10 seconds of continuous fire; re-enable to continue.</div></section>`;
}

function inputView() {
  const { game } = current();
  return heading(`${escape(game.name)} · Settings`, 'Mouse & sensitivity', `Save the mouse and sensitivity settings you use in ${escape(game.name)}.`)
    + settingsTabs()
    + `<div class="grid-two"><section class="card"><div class="card-kicker">01 / YOUR SETUP</div><h2>Start with your settings.</h2><p>Enter these from your mouse software and in-game settings. They aren’t detected automatically.</p><form id="input-form"><div class="field"><label for="dpi">Mouse DPI</label><div class="input-unit"><input id="dpi" name="dpi" type="number" min="50" max="64000" required value="${game.input.dpi}"><span>DPI</span></div><small>Use your mouse software’s active DPI stage.</small></div><div class="field-row"><div class="field"><label for="sensitivity">In-game sensitivity</label><input id="sensitivity" name="sensitivity" type="number" min="0.01" max="20" step="0.001" required value="${game.input.sensitivity}"></div><div class="field"><label for="ads">ADS multiplier</label><input id="ads" name="ads" type="number" min="0.05" max="10" step="0.01" required value="${game.input.adsMultiplier}"></div></div><button class="button" type="submit">Save input settings</button></form><div class="rule"></div><div class="hint">DPI describes physical mouse movement. It does not multiply the app’s raw output counts. Once calibrated, profiles scale for changes to your saved sensitivity and ADS multiplier.</div></section><section class="card"><div class="card-kicker">02 / PHYSICAL CHECK</div><h2>Measure your DPI.</h2><p>Measure a straight horizontal distance on your mouse pad. Start, move the mouse that distance in one direction, then press <kbd>ESC</kbd> to finish. Compensation stays off.</p><div class="ruler"><span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10 cm</span></div><div class="field"><label for="distance">Distance moved</label><div class="input-unit"><input id="distance" type="number" min="2" max="100" step="0.1" value="10"><span>cm</span></div></div><div class="measurement-value"><span id="measurement-counts">0</span> <small>raw counts</small></div><p id="measurement-status">Ready when you are. The measurement ends after 20 seconds.</p><div class="action-row"><button class="button subtle" data-action="measure-start" id="measure-start">Start measurement</button><button class="button subtle" data-action="measure-stop" id="measure-stop" hidden>Finish</button><button class="button" data-action="measure-apply" id="measure-apply" disabled>Use measured DPI</button></div></section></div>`;
}

function relayView() {
  return heading('Settings · Mouse relay', 'One mouse, two links', state.runtime.passthrough ? 'Cobra Pro → ESP32-C3 → Windows. Recoil is disabled in this firmware.' : 'Cobra Pro → ESP32-C3 → Windows. Weapon profiles share this mouse connection.')
    + settingsTabs() + (state.runtime.passthrough ? '' : outputControls())
    + `<div class="grid-two"><section class="card"><div class="card-kicker">01 / APP CONNECTION</div><h2>USB status and setup.</h2><p>USB powers the board. App disconnects and heartbeat delays do not stop the mouse relay.</p><div class="field"><label for="board-port">ESP32 USB port</label><select id="board-port">${boardPortOptions()}</select></div><div class="action-row"><button class="button subtle" data-action="board-scan">Refresh ports</button><button class="button" id="board-connect" data-action="board-connect">Connect USB</button><button class="button quiet" id="board-disconnect" data-action="board-disconnect">Disconnect app</button></div><p id="board-status"></p><p id="board-error" class="dialog-error" hidden></p></section>
    <section class="card"><div class="card-kicker">02 / BLUETOOTH LINKS</div><h2>Pair the mouse and Windows.</h2><p>On the Cobra Pro, select BT and hold <strong>button 5 + wheel click + right button</strong> for 3 seconds. Then start pairing below. Keep a second mouse available during setup.</p><button class="button" id="relay-pair" data-action="relay-pair">Pair Cobra Pro</button><div class="rule"></div><p>In Windows Bluetooth settings, remove the old <strong>Recoil Control C3</strong> entry and add <strong>Mouse Relay C3</strong>. Pair the Cobra to the board using the button above.</p><button class="button subtle" data-action="board-bluetooth">Open Bluetooth settings ↗</button><p id="board-telemetry"></p><p id="relay-pair-state"></p></section></div>${firmwareCard()}${statusLightsCard()}
    <section class="card" style="margin-top:20px"><div class="card-kicker">LIVE CHECK</div><h2>Movement, buttons, and scrolling.</h2><p id="relay-input-stats">Waiting for the board.</p><p id="relay-timing"></p><p id="relay-health"></p><button class="button subtle" id="relay-reset" data-action="relay-reset">Reset counters</button><div class="rule"></div><div id="relay-test-surface" tabindex="0" style="height:160px;overflow:auto;border:1px solid #3a3f45;padding:20px;border-radius:8px"><strong>Mouse test area</strong><p>Click left, right, middle, and side buttons here. Scroll this area up and down.</p><p id="relay-browser-events">No test events yet.</p><div style="height:220px"></div><p>Bottom of scroll test</p></div><p class="hint">Forwarding time measures the board receiving a mouse report through its BLE transmit callback. It excludes the mouse sensor, first radio hop, Windows processing, and display delay. Compare the feel with your direct connection too.</p></section>`;
}

function boardView() {
  if (state.runtime.relay || state.runtime.passthrough || state.board?.status?.relay) return relayView();
  return heading('Settings · Hardware', 'Board & Bluetooth', 'XIAO ESP32-C3 · 24 status LEDs on D7 · USB commands and a Bluetooth mouse connection.')
    + settingsTabs() + outputControls()
    + `<div class="grid-two"><section class="card"><div class="card-kicker">01 / USB CONNECTION</div><h2>Connect the desktop app.</h2><p>Keep USB connected for power and commands. Choose the board’s port, then connect. Connecting pauses profile output.</p><div class="field"><label for="board-port">ESP32 USB port</label><select id="board-port">${boardPortOptions()}</select></div><div class="action-row"><button class="button subtle" data-action="board-scan">Refresh ports</button><button class="button" id="board-connect" data-action="board-connect">Connect USB</button><button class="button quiet" id="board-disconnect" data-action="board-disconnect">Disconnect</button></div><div class="rule"></div><div class="stat-label">CONNECTION STATUS</div><p id="board-status">USB not connected.</p><p id="board-error" class="dialog-error" hidden></p></section><section class="card"><div class="card-kicker">02 / BLUETOOTH MOUSE</div><h2>Pair, then test.</h2><p>In Windows Bluetooth settings, add a Bluetooth device named <strong>Recoil Control C3</strong>. The board boots disabled and connecting never moves the mouse.</p><button class="button subtle" data-action="board-bluetooth">Open Bluetooth settings ↗</button><div class="rule"></div><div class="stat-label">BOARD TELEMETRY</div><p id="board-telemetry">Waiting for the USB handshake.</p><div class="action-row"><button class="button" id="board-test" data-action="board-test" disabled>Move 8 counts right →</button></div><p class="hint" style="margin-top:14px">One mouse report, no clicks. Keep this window focused. Pixel distance depends on Windows pointer settings. Each test disarms immediately and is never retried automatically.</p><div class="rule"></div><div class="hint">Blue pulse: waiting for Bluetooth<br>Dim white: connected and disabled<br>Green: briefly armed for one report<br>White flash: report submitted<br>Red: USB command connection lost</div><div class="warning-copy">Select ESP32 Bluetooth above to use weapon profiles. Start with a short burst and compare the input and output counters below. Game compatibility and current recoil calibration still need testing.</div></section></div>`
    + firmwareCard() + statusLightsCard();
}

const ledLegend = [
  ['fault', 'Blinking red', 'Self-test failed. Passthrough is stopped.'],
  ['windows', 'Blue breathing', 'Pair with Windows: add “Mouse Relay C3” in Bluetooth settings.'],
  ['pairing', 'Purple twin comets', 'Pairing the Cobra.'],
  ['mouse', 'Amber breathing', 'Windows is ready; waiting for the Cobra.'],
  ['noapp', 'Green sweep, then low teal breathing', 'Both links ready; the app is not connected.'],
  ['standby', 'Soft green', 'App connected, compensation off.'],
  ['armed', 'Ember wipe, flashing as corrections send', 'Armed.'],
  ['paused', 'Marching amber', 'Armed but paused: Shift held, or this window has focus.'],
  ['recording', 'Red breathing, solid red during a burst', 'Recording a pull. A white flash marks each captured take.'],
];
// What the ring shows right now, from the same signals the firmware uses (0.6.0 and later).
function ledState() {
  const status = state.board?.status, relay = status?.relay;
  if (!state.board?.connected || relay?.indicator === undefined) return null;
  if (!relay.selfTest) return 'fault';
  if (relay.pairing) return 'pairing';
  if (!(status.ble && status.secure && status.subscribed)) return 'windows';
  if (!relay.mouseReady) return 'mouse';
  if (relay.tracing) return 'recording';
  return ['standby', 'armed', 'paused'][relay.indicator];
}
function firmwareCard() {
  return `<section class="card" style="margin-top:20px"><div class="card-kicker">FIRMWARE</div><h2>Keep the board up to date.</h2><div class="firmware-row"><div><span class="stat-label">On the board</span><span id="fw-board" class="stat-value">—</span></div><div><span class="stat-label">Included with the app</span><span id="fw-bundled" class="stat-value">—</span></div><button id="firmware-update" class="button" data-action="firmware-update">Update firmware</button><button id="firmware-recover" class="button subtle" data-action="firmware-recover" hidden>Retry board recovery · Alt+R</button></div><div id="fw-progress" class="fw-progress" hidden><div class="fw-bar"><span id="fw-bar"></span></div><p id="fw-stage" class="hint"></p></div><p id="fw-error" class="dialog-error" hidden></p><p class="hint">Mouse passthrough pauses while firmware is written and the board restarts. Keep USB plugged in and the app open; allow about 30 seconds after writing for the mouse and Windows to reconnect. Pairings and LED settings are kept. If recovery stalls, press Alt+R to retry without writing again. RESET (without BOOT) or reconnecting USB can restart the board; an interrupted firmware write needs another update.</p></section>`;
}
const versionOrder = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); };
function statusLightsCard() {
  const status = state.board?.status;
  const cap = status?.brightnessCap ?? 255;
  return `<section class="card" style="margin-top:20px"><div class="card-kicker">STATUS LIGHTS</div><h2>What the board's LEDs mean.</h2><p id="led-now">Connect the board to see its current state highlighted.</p><div class="led-legend">${ledLegend.map(([id, look, meaning]) => `<div class="led-row" data-led="${id}"><span class="led-swatch ${id}" aria-hidden="true"></span><span><strong>${look}</strong><small>${meaning}</small></span></div>`).join('')}</div><div class="rule"></div><div class="grid-two"><div class="field"><div class="range-label"><label for="board-brightness">Brightness</label><output id="board-brightness-value"></output></div><input id="board-brightness" type="range" min="0" max="${cap}" step="1" value="${status?.brightness ?? 96}"><small>${cap === 255 ? `Saved on the board. A full ring dims automatically to stay inside an estimated ${status?.ledBudgetMa ?? 350} mA USB budget.` : 'This firmware caps every channel at 12/255. Update to 0.7.0 or later for full brightness.'}</small><button class="button subtle" id="board-led" data-action="board-led">Apply brightness</button></div><div class="field"><label for="board-led-count">LEDs on the strip</label><input id="board-led-count" type="number" min="1" max="60" step="1" value="${status?.ledCount ?? 24}"><small>Saved on the board. Match it to the ring in your housing (firmware 0.7.0 or later).</small><button class="button subtle" id="board-led-count-apply" data-action="board-led-count">Apply LED count</button></div></div></section>`;
}
function boardPortOptions() {
  return boardPorts.length ? boardPorts.map(port => `<option value="${escape(port.path)}">${escape(port.label)}</option>`).join('') : '<option value="">Refresh to find your board</option>';
}

async function scanBoardPorts() {
  boardPorts = await api.boardPorts();
  if ($('#board-port')) { $('#board-port').innerHTML = boardPortOptions(); updateLive(); }
}

function diagnosticsPanel() {
  return `<section class="card" style="margin-top:20px"><div class="card-kicker">TROUBLESHOOTING</div><h2>Live input diagnostics</h2><p>Compare these totals before and after a burst. They reset when the profile is reloaded or the app restarts. Opening configuration pauses compensation.</p><div class="pattern-stats"><div><span class="stat-label">MOUSE EVENTS / FIRE PRESSES</span><span class="stat-value" id="diagnostic-input">—</span></div><div><span class="stat-label">MOVEMENT ATTEMPTS / ACCEPTED</span><span class="stat-value" id="diagnostic-output">—</span></div><div><span class="stat-label">TIMER TICKS / LONGEST GAP</span><span class="stat-value" id="diagnostic-timing">—</span></div></div><p id="diagnostic-state" style="margin-top:14px">Waiting for input worker.</p><div class="hint">Accepted means the selected output accepted a movement report; it does not confirm the game used it. Bluetooth stops on gaps over 100 ms; the driver skips gaps over 250 ms. Escape disables globally; holding ${keyLabel(current().game.bindings.pause)} pauses.</div></section>`;
}

function tuningPanel() {
  const { bindings } = current().game;
  return `<section class="panel-section live-tuning"><div class="card-kicker">Live stance tuning</div><div id="tuning-draft" class="draft-banner" hidden><p id="tuning-draft-label">Draft applied to output.</p><button id="tuning-discard" class="button subtle small" data-action="tuning-discard">Discard</button><button id="tuning-save" class="button small" data-action="tuning-save">Save tuning</button></div><p>${keyLabel(bindings.tuningToggle)} toggles tuning in game. ← / → lowers / raises horizontal strength; ↓ / ↑ lowers / raises vertical strength. ${keyLabel(bindings.tuningTarget)} cycles the stance you are editing. Arrows also reach the game.</p><div id="tuning-values" class="tuning-values"></div><div class="tuning-controls"><div class="field"><label for="tuning-target">Tuning target</label><select id="tuning-target"><option value="auto">Follow current stance</option></select></div><div class="field"><label for="tuning-step">Change per tap</label><select id="tuning-step"><option value="0.01">1%</option><option value="0.02">2%</option><option value="0.05">5%</option></select></div></div><button id="tuning-toggle" class="button subtle full" data-action="tuning-toggle">Start tuning</button><p id="tuning-status" class="hint" style="margin:0"></p><p class="hint" style="margin:0">Lock a target, release your stance keys and ADS, then use the arrows; compensation still follows your actual stance. Percentages are relative to the saved stance. ${keyLabel(bindings.tuningToggle)} pauses editing and keeps the draft applied. Escape stops editing and compensation. Arrows are ignored while this window has focus. Save or discard before switching weapons or attachment setups; quitting discards the draft.</p></section>`;
}

function calibrationView() { return loadout('tune'); }

function hudView() {
  const { game, weapon: owner } = current();
  const weapon = weaponView(owner);
  return heading('Settings · Overlay', 'HUD', 'Your active weapon and status in a small always-on-top window.') + settingsTabs()
    + `<div class="grid-two"><div><div class="hud-preview-stage"><div class="hud-preview" id="hud-preview"><div class="hud-preview-top"><span class="weapon-abbr">${escape(abbreviation(weapon))}</span><h3>${escape(weapon.name)}</h3><span class="badge template" id="hud-preview-status">STANDBY</span></div><div class="hud-preview-bottom"><span id="hud-preview-stance">Default</span><span>${escape(setupName(owner))}</span><span>ESC OFF</span></div></div></div><div class="key-guide">Return to configuration with <kbd>CTRL</kbd> + <kbd>SHIFT</kbd> + <kbd>H</kbd>.<br>When unlocked, drag the panel to position it, switch weapons or attachment setups, toggle compensation, or open settings. Locking hides these controls.</div><div class="warning-copy">The HUD is a desktop overlay. Use borderless or windowed mode; it may not appear over exclusive fullscreen applications.</div></div><section class="card"><div class="card-kicker">COMPACT HUD</div><h2>Make room for the game.</h2><div class="check-row"><label for="hud-visible"><strong>Show HUD</strong><small>Keep a compact panel above other windows.</small></label><input id="hud-visible" type="checkbox" ${state.settings.hud.visible ? 'checked' : ''}></div><div class="check-row"><label for="hud-locked"><strong>Lock and pass clicks through</strong><small>Mouse input passes to the window underneath.</small></label><input id="hud-locked" type="checkbox" ${state.settings.hud.locked ? 'checked' : ''} ${!state.shortcutReady ? 'disabled' : ''}></div><div class="rule"></div><div class="field"><div class="range-label"><label for="hud-opacity">Opacity</label><output id="hud-opacity-value">${Math.round(state.settings.hud.opacity * 100)}%</output></div><input id="hud-opacity" type="range" min="30" max="100" value="${Math.round(state.settings.hud.opacity * 100)}"></div><div class="action-row"><button class="button subtle" data-action="save-hud">Apply HUD settings</button><button class="button" data-action="hud-mode">Switch to HUD ↗</button></div><div class="hint" style="margin-top:17px">Closing the configuration window quits the app. HUD mode hides it while keeping the controller available.</div></section></div>`;
}

function render() {
  cancelAnimationFrame(animation);
  const { game } = current();
  cancelBindingCapture(); closeSettingsMenu();
  $('#game-count').textContent = state.settings.games.length;
  $('#game-list').innerHTML = state.settings.games.map(item => `<button class="game-item ${item.id === game.id ? 'selected' : ''}" data-game="${escape(item.id)}" ${item.id === game.id ? 'aria-current="true"' : ''}><span class="game-mark" aria-hidden="true">${escape(item.name.slice(0,1).toUpperCase())}</span><span><strong>${escape(item.name)}</strong><small>${item.weapons.length} ${item.weapons.length === 1 ? 'weapon' : 'weapons'}</small></span></button>`).join('');
  $('#settings-button').classList.toggle('active', sections[view] === 'settings');
  $('#weapon-count').textContent = game.weapons.length;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.id === 'settings-button' ? sections[view] === 'settings' : button.dataset.view === sections[view]));
  $('#content').innerHTML = !game.id && ['arsenal', 'controls', 'input', 'calibration'].includes(view) ? emptyCollection()
    : ({ arsenal, controls: controlsView, input: inputView, calibration: calibrationView, hud: hudView, board: boardView, community: communityView })[view]();
  $('#content').scrollTop = 0;
  if (!state.runtime.passthrough && view === 'board') $('#content').insertAdjacentHTML('beforeend', diagnosticsPanel());
  updateLive();
  if ($('#chart')) void drawChart();
}

function updateLive() {
  const tuning = state.runtime.tuning;
  if ($('#tuning-toggle')) {
    const available = !!tuning?.stances.length;
    const targetSelect = $('#tuning-target');
    const targets = JSON.stringify(tuning?.stances.map(s => s.name) ?? []);
    if (targetSelect.dataset.targets !== targets) {
      targetSelect.innerHTML = '<option value="auto">Follow current stance</option>' + (tuning?.stances ?? []).map((s, i) => `<option value="${i}">Lock: ${escape(s.name)}</option>`).join('');
      targetSelect.dataset.targets = targets;
    }
    targetSelect.disabled = !available;
    if (document.activeElement !== targetSelect || !document.hasFocus()) targetSelect.value = tuning?.target == null ? 'auto' : String(tuning.target);
    $('#tuning-toggle').disabled = !available;
    $('#tuning-toggle').textContent = `${tuning?.active ? 'Pause' : 'Start'} tuning · ${keyLabel(current().game.bindings.tuningToggle)}`;
    $('#tuning-step').value = String(tuning?.step ?? 0.01);
    $('#tuning-step').disabled = !available;
    $('#tuning-save').disabled = !tuning?.dirty;
    $('#tuning-discard').disabled = !tuning?.dirty && !tuning?.active;
    $('#tuning-draft').hidden = !tuning?.dirty && !tuning?.active;
    $('#tuning-draft-label').textContent = tuning?.dirty ? 'Unsaved draft applied to output.' : 'Tuning is on. Arrow keys adjust the saved strengths.';
    $('#tuning-status').textContent = !available ? 'Tuning becomes available when a configured weapon’s input is ready.' : tuning.dirty ? 'Unsaved draft — applied to output until saved, discarded, or the app closes.' : tuning.active ? 'Tuning is on. The percentages adjust the saved pattern. The HUD shows which stance you are editing.' : 'Using your saved pattern. 100% means no additional change. Saving makes your adjustments the new 100% baseline.';
    const savedProfile = activeSetup(current().weapon).profile;
    $('#tuning-values').innerHTML = (tuning?.stances ?? []).map((s, i) => {
      const counts = savedProfile?.recoils[i] ? patternTools.shotCounts(savedProfile, i) : null;
      return `<div class="${i === tuning.current ? 'current' : ''}"><strong>${escape(s.name)}</strong><span>X ${Math.round(s.x * 100)}%${s.x >= s.maxX ? ' (limit)' : ''} · Y ${Math.round(s.y * 100)}%${s.y >= s.maxY ? ' (limit)' : ''} of saved</span>${counts ? `<small>Saved first shot: X ${counts[0].toFixed(2)} · Y ${counts[1].toFixed(2)} counts</small>` : ''}<small>Session max: X ${Math.round((s.maxX ?? 3) * 100)}% · Y ${Math.round((s.maxY ?? 3) * 100)}%</small></div>`;
    }).join('');
    const target = tuning?.stances[tuning.current];
    if (target && (tuning.active || tuning.dirty)) {
      if (target.x >= target.maxX && target.maxX < 3 || target.y >= target.maxY && target.maxY < 3) $('#tuning-status').textContent += ' A shot has reached the pattern’s movement limit; saving cannot raise that limit.';
      else if (target.x >= target.maxX || target.y >= target.maxY) $('#tuning-status').textContent += ' Session limit reached. Save tuning to use this strength as the next baseline.';
    }
  }
  const { game, weapon: owner } = current();
  const weapon = weaponView(owner);
  const runtime = state.runtime;
  if ($('#board-status')) {
    const connection = state.board;
    const status = connection?.status;
    const ready = !!connection?.ready;
    $('#board-status').textContent = ready ? `${connection.path} connected · firmware ${status.firmware}` : connection?.error && connection.connected ? 'USB connection needs reconnecting.' : connection?.connected ? 'Checking board firmware…' : 'USB not connected.';
    $('#board-error').textContent = connection?.error ?? '';
    $('#board-error').hidden = !connection?.error;
    $('#board-telemetry').textContent = status ? `Bluetooth: ${status.ble ? status.secure ? 'paired and encrypted' : 'connected, pairing' : 'waiting for pairing'} · mouse reports: ${status.subscribed ? 'subscribed' : 'not subscribed'}\n${status.reports} reports submitted · board ${status.armed ? 'armed' : 'disabled'} · ${status.ledCount} LEDs on GPIO${status.pin}` : 'Waiting for the USB handshake.';
    $('#board-connect').disabled = !!connection?.connected || !$('#board-port').value;
    $('#board-disconnect').disabled = !connection?.path;
    if ($('#board-test')) $('#board-test').disabled = runtime.enabled || !ready || !status?.usb || !status.ble || !status.secure || !status.subscribed || connection.busy;
    $('#board-led').disabled = !ready;
    $('#board-led-count-apply').disabled = !ready || status?.brightnessCap !== 255;
    $('#board-brightness').max = String(status?.brightnessCap ?? 255);
    $('#board-brightness-value').textContent = `${Math.round(Number($('#board-brightness').value) / Number($('#board-brightness').max) * 100)}%`;
    if ($('#relay-pair')) {
      const relay = status?.relay;
      $('#relay-pair').disabled = !ready || !relay?.selfTest || relay.pairing || relay.mouseReady;
      $('#relay-reset').disabled = !ready;
      $('#board-telemetry').textContent = `Windows: ${status?.ble && status.secure && status.subscribed ? 'connected' : 'waiting for pairing'} · Cobra: ${relay?.mouseReady ? 'connected and decoding' : relay?.mouseConnected ? 'connecting' : 'not connected'}`;
      $('#relay-pair-state').textContent = relay ? ['Ready to pair Cobra Pro.', 'Scanning for Cobra Pro (up to 60 seconds)…', 'Connecting and reading mouse reports…', runtime.passthrough ? 'Passthrough active. Recoil remains disabled.' : 'Mouse relay active. Enable the selected weapon profile when ready.', 'Reconnecting saved Cobra Pro…', 'Pairing did not complete. Try again.'][relay.stage] : 'USB telemetry disconnected. Mouse passthrough continues independently.';
      const errors = { cobra_not_found: 'Cobra Pro was not found. Switch to BT and enter pairing mode, then retry.', unsupported_mouse_descriptor: 'The mouse report format needs an update before it can be relayed.', mouse_security_failed: 'Mouse pairing failed. Put the Cobra back into pairing mode and retry.', self_test_failed: 'Onboard relay checks failed. Passthrough is stopped.' };
      $('#board-error').textContent = connection?.error || (relay?.error ? errors[relay.error] || relay.error.replaceAll('_', ' ') : '');
      $('#board-error').hidden = !$('#board-error').textContent;
      if (relay) {
        $('#relay-input-stats').textContent = `Received ${relay.received} · Forwarded ${status.reports} · Movement ${relay.moves} · Left ${relay.left} / Right ${relay.right} / Middle ${relay.middle} / Side ${relay.side} · Wheel up ${relay.wheelUp} / down ${relay.wheelDown} · Held buttons ${relay.buttons}`;
        const ms = us => (us / 1000).toFixed(2);
        $('#relay-timing').textContent = `Board forwarding: mean ${ms(relay.latencyMeanUs)} ms · last ${ms(relay.latencyLastUs)} ms · max ${ms(relay.latencyMaxUs)} ms (${relay.latencySamples} reports). Link intervals: mouse ${ms(relay.mouseIntervalUs)} ms / Windows ${ms(relay.pcIntervalUs)} ms.`;
        $('#relay-health').textContent = `Queue ${relay.queueDepth}/64 · Dropped ${relay.dropped} · Decode errors ${relay.parseErrors} · Send errors ${relay.txErrors} · Disconnects: mouse ${relay.mouseDisconnects}, Windows ${relay.pcDisconnects} · App heartbeat gaps ${relay.usbTimeouts} · Onboard checks ${relay.selfTest ? 'passed' : 'failed'}`;
        if (relay.mode === 'profiles') $('#relay-health').textContent += ` · Recoil reports ${relay.corrections} · Cancelled ${relay.cancelled} · Correction ${relay.correctionPending ? 'pending' : 'clear'}`;
      }
    }
  }
  if ($('#firmware-update')) {
    const firmware = state.firmware ?? { bundled: null, update: {} }, update = firmware.update;
    const onBoard = state.board?.status?.firmware ?? null, bundled = firmware.bundled;
    $('#fw-board').textContent = onBoard ?? (state.board?.connected ? 'Unknown' : 'Not connected');
    $('#fw-bundled').textContent = bundled ?? 'None';
    const order = onBoard && bundled ? versionOrder(onBoard, bundled) : -1;
    $('#firmware-update').textContent = !bundled ? 'No bundled firmware' : update.running ? 'Updating…' : firmwareConfirm ? 'Confirm: keep USB plugged in'
      : order === 0 ? `Reinstall ${bundled}` : order > 0 ? `Install ${bundled} (older)` : `Update to ${bundled}`;
    $('#firmware-update').classList.toggle('subtle', order >= 0 && !firmwareConfirm);
    $('#firmware-update').disabled = !bundled || update.running;
    $('#firmware-recover').hidden = !update.recoveryAvailable;
    $('#firmware-recover').disabled = update.running;
    $('#fw-progress').hidden = !update.stage;
    $('#fw-bar').style.width = `${Math.round((update.progress ?? 0) * 100)}%`;
    $('#fw-stage').textContent = update.stage ?? '';
    $('#fw-error').textContent = update.error ?? '';
    $('#fw-error').hidden = !update.error;
  }
  if ($('.led-legend')) {
    const current = ledState();
    document.querySelectorAll('.led-row').forEach(row => row.classList.toggle('current', row.dataset.led === current));
    $('#led-now').textContent = current ? `The board is showing: ${ledLegend.find(([id]) => id === current)[1].toLowerCase()}.`
      : state.board?.connected ? 'This firmware uses the older solid colors. Update to 0.6.0 or later for these effects.' : 'Connect the board to see its current state highlighted.';
  }
  if ($('#diagnostic-input')) {
    const data = runtime.diagnostics;
    const pair = (left, right) => `${left.toLocaleString()} / ${right.toLocaleString()}`;
    $('#diagnostic-input').textContent = data ? pair(data.mouseEvents, data.firePresses) : '—';
    $('#diagnostic-output').textContent = data ? pair(data.movementAttempts, data.movementsAccepted) : '—';
    $('#diagnostic-timing').textContent = data ? `${pair(data.ticks, data.maxTickMs)} ms` : '—';
    $('#diagnostic-state').textContent = !data ? 'Diagnostics unavailable. Configure a profile and connect the selected output.'
      : `Now: ${data.enabled ? 'enabled' : 'disabled'} · left button ${data.shooting ? 'held' : 'released'} · aiming ${data.aiming ? 'held' : 'released'} · pause reason: ${data.pauseReasons.join(' + ') || 'none'}`;
  }
  $('#connection-dot').className = `dot ${runtime.ready ? 'ready' : 'error'}`;
  $('#connection-label').textContent = runtime.ready ? runtime.output === 'bluetooth' ? 'Bluetooth ready' : 'Input connected' : 'Output unavailable';
  $('.link-status').title = runtime.ready ? 'Reconnect input' : 'Output unavailable. Select to reconnect input.';
  $('#connection-detail').textContent = runtime.output === 'bluetooth' ? 'ESP32 Bluetooth · button listener' : runtime.ready ? `${runtime.mice} ${runtime.mice === 1 ? 'mouse' : 'mice'} detected · Windows` : 'Configuration is still available';
  $('#engine-label').textContent = runtime.measurement.running ? 'Measuring' : runtime.enabled ? runtime.paused ? runtime.suspended ? 'Config paused' : 'Paused' : 'Active' : 'Standby';
  $('#engine-label').title = 'Compensation pauses while the configuration window has focus.';
  $('#enable-toggle').classList.toggle('on', runtime.enabled && !runtime.paused);
  $('#enable-toggle').classList.toggle('paused', runtime.enabled && runtime.paused);
  $('#toggle-key').textContent = `${game.bindings.activationMode === 'hold' ? 'Hold ' : ''}${keyLabel(game.bindings.toggle)}`;
  $('#enable-toggle').setAttribute('aria-checked', String(runtime.enabled));
  $('#enable-toggle').disabled = !runtime.ready || !weapon.profile || runtime.measurement.running || !!runtime.recording?.active;
  refreshRecording();
  if (runtime.passthrough) {
    $('#enable-toggle').disabled = true;
    $('#engine-label').textContent = 'Passthrough';
    $('#engine-label').title = 'Physical mouse passthrough continues independently of the app.';
    $('#connection-label').textContent = runtime.ready ? 'Mouse relay ready' : 'Check relay links';
    $('#connection-detail').textContent = 'Passthrough · recoil disabled';
  } else if (runtime.relay) {
    $('#connection-label').textContent = runtime.ready ? 'Relay profiles ready' : 'Recoil offline';
    $('#connection-detail').textContent = 'Physical passthrough independent of app';
  }
  $('#footer-weapon').textContent = weapon.id ? `${weapon.name} · ${setupName(owner)}` : game.id ? `${game.name} · No weapons` : 'No game selected';
  $('#footer-keys').innerHTML = `<span><kbd>${keyLabel(game.bindings.toggle)}</kbd> ${game.bindings.activationMode === 'hold' ? 'Hold to enable' : 'Toggle'}</span><span><kbd>${keyLabel(game.bindings.pause)}</kbd> Pause</span><span><kbd>ESC</kbd> Disable</span>`;
  $('#footer-setup').textContent = game.id ? `${game.input.dpi} DPI · ${game.input.sensitivity} sens` : 'Add a game to get started';
  const notice = state.warning || runtime.error;
  $('#notice').textContent = notice ?? '';
  $('#notice').hidden = !notice;
  if ($('#measurement-counts')) {
    $('#measurement-counts').textContent = runtime.measurement.counts.toLocaleString();
    $('#measurement-status').textContent = runtime.measurement.error || (runtime.measurement.running ? 'Measuring… move in one direction, then press Escape.' : runtime.measurement.counts >= 100 ? 'Measurement finished. Confirm the distance, then apply it.' : 'Ready when you are. The measurement ends after 20 seconds.');
    $('#measure-start').disabled = runtime.relay || runtime.passthrough || !runtime.ready || runtime.measurement.running;
    $('#measure-stop').hidden = !runtime.measurement.running;
    $('#measure-apply').disabled = runtime.measurement.running || runtime.measurement.counts < 100 || !!runtime.measurement.error;
  }
  if ($('#hud-preview-status')) {
    $('#hud-preview-status').textContent = runtime.enabled ? runtime.paused ? 'PAUSED' : 'ARMED' : 'STANDBY';
    $('#hud-preview').classList.toggle('armed', runtime.enabled && !runtime.paused);
    $('#hud-preview-stance').textContent = runtime.stance;
  }
}

async function drawChart() {
  const revision = ++chartRevision;
  const data = await api.preview(stance);
  if (revision !== chartRevision || !$('#chart')) return;
  if (!data) {
    $('#chart').innerHTML = '<div class="chart-empty"><span style="font-size:30px;color:#7b8188">⌖</span><strong>Your pattern starts here.</strong><p>Add measured vectors to see a compensation preview.</p></div>';
    return;
  }
  const points = data.points;
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min(470 / Math.max(1, maxX - minX), 165 / Math.max(1, maxY - minY));
  const offsetX = 350 - (minX + maxX) * scale / 2;
  const offsetY = 115 - (minY + maxY) * scale / 2;
  chartPoints = points.map(point => ({ x: offsetX + point.x * scale, y: offsetY + point.y * scale }));
  chartDuration = data.duration;
  const first = chartPoints[0];
  const last = chartPoints.at(-1);
  const d = chartPoints.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const nodes = Array.from({ length: 6 }, (_, index) => chartPoints[Math.round(index * (chartPoints.length - 1) / 5)]);
  $('#chart svg').innerHTML = `<defs><linearGradient id="path-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffb38a"/><stop offset="100%" stop-color="#ff7a3d"/></linearGradient></defs><path d="M350 10V220 M75 115H625" stroke="#ffffff14" stroke-dasharray="4 5"/><path d="${d}" fill="none" stroke="#ff7a3d1f" stroke-width="16"/><path d="${d}" fill="none" stroke="url(#path-gradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${nodes.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="3.5" fill="#0c0d0f" stroke="#ff9d6e" stroke-width="1.6"/><text x="${point.x + 13}" y="${point.y + 3}" fill="#9aa0a6" font-size="8" font-family="Consolas">${index + 1}</text>`).join('')}<text x="${first.x - 12}" y="${first.y - 14}" fill="#9aa0a6" font-size="8" text-anchor="end" letter-spacing="1">START</text><circle id="playhead" cx="${first.x}" cy="${first.y}" r="5" fill="#edebe6" opacity="0"/><text x="${last.x - 13}" y="${last.y + 17}" fill="#9aa0a6" font-size="8" text-anchor="end">${points.at(-1).x}, ${points.at(-1).y}</text>`;
}

function playPreview() {
  const dot = $('#playhead');
  if (!dot || !chartPoints.length) return;
  cancelAnimationFrame(animation);
  const started = performance.now();
  const frame = now => {
    if (!document.contains(dot)) return;
    const fraction = Math.min(1, (now - started) / Math.max(600, chartDuration));
    const point = chartPoints[Math.round(fraction * (chartPoints.length - 1))];
    dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y); dot.setAttribute('opacity', '1');
    if (fraction < 1) animation = requestAnimationFrame(frame);
  };
  animation = requestAnimationFrame(frame);
}

function modal(title, subtitle, content, action, label) {
  $('#dialog').className = '';
  $('#dialog').innerHTML = `<div class="dialog-head"><div><h2>${title}</h2><p>${subtitle}</p></div><button type="button" data-action="close-dialog" aria-label="Close dialog">×</button></div><form id="modal-form" data-submit="${action}">${content}<div id="dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions"><button type="button" class="button subtle" data-action="close-dialog">Cancel</button><button type="submit" class="button">${label}</button></div></form>`;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function newWeapon() {
  if (!current().game.id) throw new Error('Add a game first.');
  const sources = current().game.weapons.map(weaponView).filter(weapon => weapon.profile);
  modal('Add a weapon', 'Create a slot, then open its pattern workshop.', `<div class="field"><label for="weapon-name">Weapon name</label><input id="weapon-name" name="name" maxlength="80" required placeholder="e.g. LR-300" autofocus></div><div class="field"><label for="weapon-category">Category</label><select id="weapon-category" name="category"><option>Rifle</option><option>SMG</option><option>LMG</option><option>Pistol</option><option>Other</option></select></div><div class="field"><label for="weapon-source">Starting point</label><select id="weapon-source" name="source"><option value="">Blank pattern</option>${sources.map(weapon => `<option value="${escape(weapon.id)}">Copy ${escape(weapon.name)}</option>`).join('')}</select><small>A blank pattern starts at zero movement and 600 RPM. Set the actual fire rate and author its shots in the workshop.</small></div>`, 'new-weapon', 'Create & edit pattern');
}
function newGame() {
  modal('Add a game collection', 'Keep a separate loadout and input setup for each game.', '<div class="field"><label for="game-name">Game name</label><input id="game-name" name="name" maxlength="80" required placeholder="Your game" autofocus></div><div class="field"><label for="first-weapon">First weapon</label><input id="first-weapon" name="weapon" maxlength="80" required placeholder="Weapon name"></div><div class="field"><label><input name="crouch" type="checkbox" checked> Crouch</label><label><input name="prone" type="checkbox"> Prone</label><small>Standing and ADS are always available. Add custom stances later under Controls.</small></div>', 'new-game', 'Create collection');
}
function emptyWeapon(name, category = 'Rifle') {
  return { id: crypto.randomUUID(), name, category, hotkey: null, selectedSetupId: 'base', setups: [], profile: null, tuning: { x: 1, y: 1 }, provenance: 'template', calibration: null };
}
function confirmCollectionDeletion(kind) {
  const { game, weapon } = current(), target = kind === 'game' ? game : weapon;
  if (!target.id) throw new Error(`Choose a ${kind} first.`);
  deletionContext = { gameId: game.id, ...(kind === 'weapon' ? { weaponId: weapon.id } : {}), expected: JSON.stringify(target) };
  const variants = kind === 'game' ? game.weapons.reduce((sum, w) => sum + w.setups.length, 0) : weapon.setups.length;
  const setupsLabel = `${variants} attachment setup${variants === 1 ? '' : 's'}`;
  modal(kind === 'game' ? 'Delete game collection?' : 'Delete weapon?', escape(target.name),
    `<p>${kind === 'game' ? `Delete this game, its ${game.weapons.length} weapon${game.weapons.length === 1 ? '' : 's'}, and ${setupsLabel}, including its controls and input settings?` : `Delete this weapon, its Base pattern, and ${setupsLabel}?`}</p><p class="hint">Published library packs and exported files are kept. This removes the local ${kind === 'game' ? 'collection' : 'weapon'} permanently.</p>`,
    `delete-${kind}`, kind === 'game' ? 'Delete game' : 'Delete weapon');
  $('#modal-form [type="submit"]').classList.add('danger-button');
  $('#modal-form [data-action="close-dialog"]').focus();
}
document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  void attempt(async () => {
    if (target.dataset.action?.startsWith('community-')) { await communityAction(target); return; }
    if (target.dataset.game) {
      if (target.dataset.game === current().game.id) return;
      const next = structuredClone(state.settings); next.selectedGameId = target.dataset.game; stance = 0;
      await save(next, 'Game selected. Compensation is in standby.'); return;
    }
    if (target.dataset.view) { view = target.dataset.view; render(); if (view === 'board') await scanBoardPorts(); if (view === 'community') await refreshCommunity(); return; }
    if (target.dataset.weapon) {
      const next = structuredClone(state.settings); current(next).game.selectedWeaponId = target.dataset.weapon; stance = 0;
      await save(next, 'Weapon selected. Recoil control is in standby.'); return;
    }
    if (target.dataset.stance !== undefined) { stance = Number(target.dataset.stance); render(); return; }
    switch (target.dataset.action) {
      case 'settings-menu': {
        const open = $('#settings-options').hidden;
        $('#settings-options').hidden = !open; target.setAttribute('aria-expanded', String(open));
        if (open) $('#settings-options button').focus();
        break;
      }
      case 'shape-pattern': case 'import-positions': case 'select-shot': case 'apply-shot-position': case 'pattern-view': case 'pattern-undo': case 'generate-pattern': case 'add-shot': case 'duplicate-shot': case 'remove-shot': case 'copy-stance': case 'add-stances': case 'add-stance': case 'remove-stance': case 'manage-stances':
      case 'timeline-shot': case 'range-all': case 'edit-stance': case 'fix-pattern': case 'play-draft': case 'record-apply':
        patternAction(target.dataset.action, Number(target.dataset.row), { shift: event.shiftKey, fix: target.dataset.fix }); break;
      case 'record-remove': receive(await api.removeTake(Number(target.dataset.row))); break;
      case 'record-start': case 'record-stop': case 'record-clear':
        receive(await api.record(target.dataset.action.slice(7)));
        if (target.dataset.action === 'record-start') toast('Recording. Switch to your practice range and fire full magazines.');
        break;
      case 'tuning-toggle': receive(await api.tune(state.runtime.tuning?.active ? 'stop' : 'start')); break;
      case 'tuning-save': receive(await api.tune('save'), true); toast('Saved into the weapon pattern. 100% now uses your updated strengths. Re-enable when ready.'); break;
      case 'tuning-discard': receive(await api.tune('discard')); toast('Tuning discarded. Saved strengths restored.'); break;
      case 'duplicate-weapon': {
        const next = structuredClone(state.settings); const { game, weapon } = current(next);
        const copy = structuredClone(weapon); copy.hotkey = null; copy.id = crypto.randomUUID(); copy.name = `${copy.name.slice(0, 70)} copy`;
        game.weapons.push(copy); game.selectedWeaponId = copy.id; await save(next, 'Weapon duplicated. The original is still in your collection.'); break;
      }
      case 'board-scan': await scanBoardPorts(); break;
      case 'board-connect': receive(await api.connectBoard($('#board-port').value), true); toast(state.runtime.passthrough ? 'Relay connected. Recoil is disabled.' : 'USB handshake complete.'); break;
      case 'relay-pair': receive(await api.pairBoardMouse()); toast('Scanning for Cobra Pro in pairing mode.'); break;
      case 'relay-reset': receive(await api.resetRelayStats()); toast('Relay counters reset.'); break;
      case 'board-disconnect': receive(await api.disconnectBoard(), true); break;
      case 'board-bluetooth': await api.openBluetooth(); break;
      case 'board-led': receive(await api.setBoardBrightness(Number($('#board-brightness').value))); toast('Brightness saved on the board.'); break;
      case 'firmware-update':
        // Two presses: the first only asks, since the update briefly takes the board offline.
        if (!firmwareConfirm) { firmwareConfirm = true; setTimeout(() => { firmwareConfirm = false; updateLive(); }, 6000); updateLive(); break; }
        firmwareConfirm = false; toast('Updating the board. Keep USB plugged in.');
        receive(await api.updateFirmware(), true); toast(state.firmware.update.error || state.firmware.update.stage, !!state.firmware.update.error); break;
      case 'firmware-recover': receive(await api.recoverFirmware(), true); toast(state.firmware.update.error || state.firmware.update.stage, !!state.firmware.update.error); break;
      case 'board-led-count': receive(await api.setLedCount(Number($('#board-led-count').value))); toast('LED count saved on the board.'); break;
      case 'board-test': receive(await api.testBoardMovement()); toast('One movement report submitted. Board is disabled again.'); break;
      case 'toggle': if (current().game.bindings.activationMode === 'hold' && !state.runtime.enabled) { toast(`Hold ${keyLabel(current().game.bindings.toggle)} outside configuration to enable compensation.`); break; } receive(await api.setEnabled(!state.runtime.enabled)); break;
      case 'retry': receive(await api.retry()); toast('Input check complete.'); break;
      case 'hud-mode': receive(await api.hudMode()); break;
      case 'vision-lab': await api.openVisionLab(); break;
      case 'new-game': newGame(); break;
      case 'new-weapon': newWeapon(); break;
      case 'delete-game': confirmCollectionDeletion('game'); break;
      case 'delete-weapon': confirmCollectionDeletion('weapon'); break;
      case 'new-setup': editSetup(true); break;
      case 'edit-setup': editSetup(); break;
      case 'add-attachment':
        if (document.querySelectorAll('.attachment-row').length >= 12) throw new Error('A setup can have up to 12 attachments.');
        $('#attachment-rows').insertAdjacentHTML('beforeend', attachmentRow());
        $('#attachment-rows').lastElementChild.querySelector('input').focus(); break;
      case 'remove-attachment': target.closest('.attachment-row').remove(); break;
      case 'delete-setup':
        checkAttachmentContext();
        modal('Delete attachment setup?', `Delete ${escape(setupName(current().weapon))} and its pattern? The Base setup will be selected.`, '<p class="hint">Other setups and their tuning are kept.</p>', 'delete-setup', 'Delete setup'); break;
      case 'close-dialog': if (confirmPatternClose(target)) $('#dialog').close(); break;
      case 'edit-pattern': editPattern(); break;
      case 'import': receive(await api.importProfile(), true); break;
      case 'export': if (await api.exportProfile()) toast('Weapon profile exported.'); break;
      case 'source': await api.openSource(0); break;
      case 'play-preview': playPreview(); break;
      case 'measure-start': receive(await api.startMeasurement()); break;
      case 'measure-stop': receive(await api.stopMeasurement()); break;
      case 'measure-apply': receive(await api.applyMeasurement(Number($('#distance').value)), true); toast('Measured DPI saved.'); break;
      case 'save-tuning': {
        const next = structuredClone(state.settings); const weapon = activeSetup(current(next).weapon);
        weapon.tuning = { x: Number($('#gain-x').value), y: Number($('#gain-y').value) };
        weapon.provenance = 'manual'; await save(next, 'Strength applied. Preview reflects the saved output.'); break;
      }
      case 'calibrate': receive(await api.calibrate({ x: Number($('#gain-x').value), y: Number($('#gain-y').value) }), true); toast('Local calibration recorded for this setup.'); break;
      case 'save-hud': receive(await api.setHud({ visible: $('#hud-visible').checked, locked: $('#hud-locked').checked, opacity: Number($('#hud-opacity').value) / 100 }), true); toast('HUD settings saved.'); break;

    }
  });
});

document.addEventListener('submit', event => {
  event.preventDefault();
  void attempt(async () => {
    const form = event.target;
    if (form.dataset.submit?.startsWith('community-')) { await communitySubmit(form); return; }
    if (form.id === 'input-form') {
      const next = structuredClone(state.settings);
      current(next).game.input = { dpi: Number($('#dpi').value), sensitivity: Number($('#sensitivity').value), adsMultiplier: Number($('#ads').value) };
      await save(next, 'Input settings saved for this game.'); return;
    }
    if (form.id !== 'modal-form') return;
    if (form.dataset.submit === 'delete-game' || form.dataset.submit === 'delete-weapon') {
      const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
      if (!deletionContext) throw new Error('Open the deletion confirmation again.');
      button.disabled = true;
      try {
        const next = await (form.dataset.submit === 'delete-game' ? api.deleteGame(deletionContext) : api.deleteWeapon(deletionContext));
        view = 'arsenal'; stance = 0; receive(next, true); deletionContext = undefined; $('#dialog').close();
        toast(form.dataset.submit === 'delete-game' ? 'Game collection deleted. Library packs were kept.' : 'Weapon deleted. Library packs were kept.');
      } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    const data = new FormData(form);
    const next = structuredClone(state.settings);
    switch (form.dataset.submit) {
      case 'new-game': {
        const weapon = emptyWeapon(String(data.get('weapon')).trim());
        const game = { stances: [...(data.has('crouch') ? [{ id: 'crouching', name: 'Crouch' }] : []), ...(data.has('prone') ? [{ id: 'prone', name: 'Prone' }] : [])], id: crypto.randomUUID(), name: String(data.get('name')).trim(), input: { ...current().game.input }, selectedWeaponId: weapon.id, weapons: [weapon] };
        next.games.push(game); next.selectedGameId = game.id; view = 'arsenal'; stance = 0; break;
      }
      case 'new-weapon': {
        const weapon = emptyWeapon(String(data.get('name')).trim(), String(data.get('category')));
        const source = current(next).game.weapons.map(weaponView).find(item => item.id === data.get('source'));
        if (source?.profile) { weapon.profile = structuredClone(source.profile); weapon.profile.name = weapon.name; weapon.tuning = { ...source.tuning }; weapon.calibration = structuredClone(source.calibration); weapon.provenance = 'manual'; }
        current(next).game.weapons.push(weapon); current(next).game.selectedWeaponId = weapon.id; stance = 0; break;
      }
      case 'new-setup': case 'edit-setup': saveSetupForm(next, form.dataset.submit === 'new-setup'); stance = 0; break;
      case 'delete-setup': {
        checkAttachmentContext();
        const weapon = current(next).weapon;
        weapon.setups = weapon.setups.filter(s => s.id !== weapon.selectedSetupId);
        weapon.selectedSetupId = 'base'; stance = 0; break;
      }
      case 'pattern': {
        capturePattern(); editDraft.provenance = 'manual';
        const game = current(next).game;
        const weapon = game.weapons.find(weapon => weapon.id === editDraft.id);
        if (!weapon || weapon.selectedSetupId !== editDraft.selectedSetupId) throw new Error('The active setup changed. Reopen the pattern editor.');
        Object.assign(activeSetup(weapon), setupData(editDraft));
        weapon.name = editDraft.name;
        stance = 0; patternDirty = false; break;
      }
    }
    await save(next);
    $('#dialog').close();
    if (form.dataset.submit === 'new-weapon') editPattern();
  });
});

document.addEventListener('change', event => {
  void attempt(async () => {
    if (event.target.id === 'setup-select') {
      const next = structuredClone(state.settings); current(next).weapon.selectedSetupId = event.target.value;
      stance = 0;
      try { await save(next, 'Attachment setup selected. Compensation is in standby.'); } catch (error) { render(); throw error; }
    }
    if (event.target.id === 'tuning-step') receive(await api.tune('step', Number(event.target.value)));
    if (event.target.id === 'tuning-target') receive(await api.setTuningTarget(event.target.value === 'auto' ? null : Number(event.target.value)));
    if (event.target.id === 'output-device') {
      const next = structuredClone(state.settings); next.output = event.target.value;
      await save(next, 'Output selected. Recoil control is in standby.');
    }
    if (event.target.id === 'fix-step') fixStep = Number(event.target.value);
    if (event.target.id === 'record-shots') { recordShots = Number(event.target.value); refreshRecording(); }
    if (event.target.id === 'record-smooth') { recordSmooth = event.target.checked; refreshRecording(); }
  });
});
document.addEventListener('input', event => {
  if (event.target.closest('#modal-form') && $('#draft-chart') && !event.target.id.startsWith('shot-position-') && !['fix-step', 'record-shots', 'record-smooth'].includes(event.target.id)) { markPatternDirty(); queueDraftPreview(); }
  if (event.target.id === 'pattern-rpm') refreshRecording();
  if (event.target.id === 'board-brightness') $('#board-brightness-value').textContent = `${Math.round(Number(event.target.value) / Number(event.target.max) * 100)}%`;
  if (event.target.id === 'gain-x' || event.target.id === 'gain-y') $(`#${event.target.id}-value`).textContent = `${Number(event.target.value).toFixed(2)}×`;
  if (event.target.id === 'hud-opacity') $('#hud-opacity-value').textContent = `${event.target.value}%`;
});
api.onState(receive);
const relayBrowserCounts = { buttons: [0, 0, 0, 0, 0], wheel: 0 };
document.addEventListener('mousedown', event => {
  if (!event.target.closest('#relay-test-surface')) return;
  if (event.button >= 0 && event.button < 5) relayBrowserCounts.buttons[event.button]++;
  $('#relay-browser-events').textContent = `Windows events: left ${relayBrowserCounts.buttons[0]}, middle ${relayBrowserCounts.buttons[1]}, right ${relayBrowserCounts.buttons[2]}, side ${relayBrowserCounts.buttons[3] + relayBrowserCounts.buttons[4]}, wheel ${relayBrowserCounts.wheel}`;
});
document.addEventListener('contextmenu', event => { if (event.target.closest('#relay-test-surface')) event.preventDefault(); });
document.addEventListener('wheel', event => {
  if (!event.target.closest('#relay-test-surface')) return;
  relayBrowserCounts.wheel++;
  $('#relay-browser-events').textContent = `Windows events: left ${relayBrowserCounts.buttons[0]}, middle ${relayBrowserCounts.buttons[1]}, right ${relayBrowserCounts.buttons[2]}, side ${relayBrowserCounts.buttons[3] + relayBrowserCounts.buttons[4]}, wheel ${relayBrowserCounts.wheel}`;
}, { passive: true });
void attempt(async () => receive(await api.getState()));

// A keyboard-only way back when the only mouse is routed through the board.
document.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.shiftKey || event.code !== 'KeyR' || event.repeat || !state?.firmware.update.recoveryAvailable || state.firmware.update.running) return;
  event.preventDefault();
  void attempt(async () => { receive(await api.recoverFirmware(), true); toast(state.firmware.update.error || state.firmware.update.stage, !!state.firmware.update.error); });
});

document.addEventListener('click', event => { if (!event.target.closest('.settings-menu')) closeSettingsMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#settings-options').hidden) { closeSettingsMenu(); $('#settings-button').focus(); event.preventDefault(); }
});
