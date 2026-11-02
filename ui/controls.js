function keyLabel(value) {
  return String(value).split('+').map(key => ({ ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt', mouse3: 'Middle mouse', mouse4: 'Mouse 4', mouse5: 'Mouse 5' }[key] || state.keyChoices.find(item => item.key === key)?.label || key)).join(' + ');
}
function bindingRecorder(id, value, { optional = false, single = false, className = '' } = {}) {
  return `<div class="binding-picker"><button type="button" id="${escape(id)}" class="binding-record ${className}" data-binding data-single="${single}" value="${escape(value ?? '')}" aria-label="Change binding: ${escape(value ? keyLabel(value) : 'Not assigned')}">${value ? escape(keyLabel(value)) : 'Click to assign'}</button>${optional ? `<button type="button" class="binding-clear" data-clear-binding="${escape(id)}" aria-label="Clear binding">×</button>` : ''}</div>`;
}
function shortcutPicker(id, value, optional = false) { return bindingRecorder(`${id}-key`, value, { optional }); }
function readShortcut(id) { return $(`#${id}-key`).value || null; }
let captureBinding = null;
let captureTimer;
let captureModifier = null;
let suppressBindingClick = 0;
let capturedKeyup = null;
function setBinding(button, value) {
  button.value = value ?? '';
  button.textContent = value ? keyLabel(value) : 'Click to assign';
  button.setAttribute('aria-label', `Change binding: ${value ? keyLabel(value) : 'Not assigned'}`);
}
function cancelBindingCapture() {
  clearTimeout(captureTimer);
  if (captureBinding) { captureBinding.classList.remove('listening'); captureBinding.removeAttribute('aria-pressed'); setBinding(captureBinding, captureBinding.value); }
  captureBinding = null; captureModifier = null;
  const hint = document.getElementById('binding-hint');
  if (hint) hint.textContent = 'Click a binding, then press a key, shortcut, middle mouse, or a side button. Escape cancels. Save to apply.';
}
function finishBinding(value) {
  const button = captureBinding;
  cancelBindingCapture();
  if (button) { setBinding(button, value); toast('Binding recorded. Save controls to apply.'); }
}
function captureHint(message) {
  const hint = document.getElementById('binding-hint');
  if (hint) hint.textContent = message;
}
function captureKey(code) {
  if (/^Key[A-Z]$/.test(code)) return `key${code.slice(3).toLowerCase()}`;
  if (/^Digit[0-9]$/.test(code)) return `key${code.slice(5)}`;
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return { ControlLeft:'control', ControlRight:'control', ShiftLeft:'shift', ShiftRight:'shift', AltLeft:'alt', AltRight:'alt', Space:'space', Enter:'enter', NumpadEnter:'enter', NumpadAdd:'plus', NumpadSubtract:'minus', Home:'home', End:'end', Insert:'insert', Delete:'delete', PageUp:'pageup', PageDown:'pagedown' }[code];
}
function recordedChord(key, event) {
  if (event.metaKey) { captureHint('The system/Meta key is not supported. Choose another binding.'); return null; }
  const mods = [event.ctrlKey && key !== 'control' ? 'ctrl' : '', event.altKey && key !== 'alt' ? 'alt' : '', event.shiftKey && key !== 'shift' ? 'shift' : ''].filter(Boolean);
  if ((captureBinding.dataset.single === 'true' || ['control','alt','shift'].includes(key)) && mods.length) { captureHint('Use one key or mouse button for a stance or pause binding.'); return null; }
  const result = [...mods, key].join('+');
  if (['ctrl+shift+keyh', 'alt+f4'].includes(result)) { captureHint('That shortcut is reserved. Choose another binding.'); return null; }
  return result;
}
document.addEventListener('keydown', event => {
  if (!captureBinding) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.code === 'Escape') { capturedKeyup = event.code; cancelBindingCapture(); return; }
  if (event.repeat) return;
  const key = captureKey(event.code);
  if (!key) { captureModifier = null; captureHint('Choose a letter, number, function key, navigation key, middle mouse, or side button.'); return; }
  if (['control','alt','shift'].includes(key)) { captureModifier = { key, code: event.code }; return; }
  captureModifier = null;
  const value = recordedChord(key, event);
  if (value) { capturedKeyup = event.code; finishBinding(value); }
}, true);
document.addEventListener('keyup', event => {
  if (capturedKeyup === event.code) { capturedKeyup = null; event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (!captureBinding) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (captureModifier?.code === event.code) {
    const key = captureModifier.key; captureModifier = null;
    const value = recordedChord(key, event); if (value) finishBinding(value);
  }
}, true);
document.addEventListener('pointerdown', event => {
  if (!captureBinding) return;
  event.preventDefault(); event.stopImmediatePropagation(); suppressBindingClick = Date.now() + 700;
  if (event.button === 0 && event.target.closest('[data-binding]') === captureBinding) { cancelBindingCapture(); return; }
  const key = { 1:'mouse3', 3:'mouse4', 4:'mouse5' }[event.button];
  captureModifier = null;
  if (!key) { captureHint('Left and right mouse are reserved for fire and ADS. Use middle mouse or a side button.'); return; }
  const value = recordedChord(key, event); if (value) finishBinding(value);
}, true);
for (const type of ['click', 'auxclick', 'contextmenu']) document.addEventListener(type, event => {
  if (captureBinding && type !== 'click' || Date.now() < suppressBindingClick) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('click', event => {
  const clear = event.target.closest('[data-clear-binding]');
  if (clear) { cancelBindingCapture(); setBinding(document.getElementById(clear.dataset.clearBinding), null); return; }
  const button = event.target.closest('[data-binding]');
  if (!button) return;
  cancelBindingCapture(); captureBinding = button;
  button.classList.add('listening'); button.setAttribute('aria-pressed', 'true'); button.textContent = 'Listening…';
  captureHint('Press a key or mouse button now. Escape or click the listening button to cancel.');
  captureTimer = setTimeout(cancelBindingCapture, 10000);
});
window.addEventListener('blur', cancelBindingCapture);
function stanceBindingRows(game) {
  return game.bindings.stances ?? [{ id: 'crouching', key: game.bindings.crouch, mode: 'hold' }];
}
function stanceRow(stance, binding = { key: null, mode: 'hold' }) {
  return `<div class="stance-config" data-stance-id="${escape(stance.id)}"><div class="field"><label>Stance name<input class="stance-name" value="${escape(stance.name)}" maxlength="60" required></label></div><div class="field-row"><div class="field"><label for="stance-key-${escape(stance.id)}">Binding</label>${bindingRecorder(`stance-key-${stance.id}`, binding.key, { optional: true, single: true, className: 'stance-key' })}</div><div class="field"><label>Behavior<select class="stance-mode"><option value="hold" ${binding.mode === 'hold' ? 'selected' : ''}>Hold</option><option value="toggle" ${binding.mode === 'toggle' ? 'selected' : ''}>Toggle</option></select></label></div></div><button type="button" class="text-button" data-remove-stance="${escape(stance.id)}">Remove stance</button></div>`;
}
function gameStancesPanel(game) {
  const bindings = stanceBindingRows(game);
  return `<section class="card game-stances"><div class="card-kicker">STANCES FOR ${escape(game.name.toUpperCase())}</div><h2>Only the stances your game uses.</h2><p>Standing is the default. Right mouse adds ADS to any stance. Add Prone or a custom posture, then copy and tune its pattern in the workshop.</p><div id="stance-rows">${game.stances.map(stance => stanceRow(stance, bindings.find(b => b.id === stance.id))).join('')}</div><div class="action-row"><button type="button" class="button subtle small" data-add-stance="crouching">+ Crouch</button><button type="button" class="button subtle small" data-add-stance="prone">+ Prone</button><button type="button" class="button subtle small" data-add-stance="custom">+ Custom stance</button></div><p class="hint">Hold returns when released. Toggle stays until pressed again or another stance is chosen. Escape clears toggled stances. Match the game's own controls; the app does not detect posture automatically. Unassigned stances can still be edited and previewed.</p></section>`;
}
function controlsView() {
  const { game } = current(); const b = game.bindings;
  const actions = { previousWeapon: 'Previous configured weapon', nextWeapon: 'Next configured weapon', tuningToggle: 'Toggle live tuning', tuningTarget: 'Cycle tuning target' };

  return heading(`${escape(game.name.toUpperCase())} / CONTROLS`, 'Controls', 'Keys and mouse buttons for this game. Click a binding to change it.') + `<form id="controls-form"><p id="binding-hint" class="binding-hint" role="status">Click a binding, then press a key, shortcut, middle mouse, or a side button. Escape cancels. Save to apply.</p><div class="activation-card card"><div><div class="card-kicker">COMPENSATION</div><h2>Choose how to activate.</h2><p>Toggle stays on until pressed again. Hold is active only while pressed; releasing stops it. Left mouse still fires and right mouse selects ADS.</p></div><div class="activation-fields"><div class="field"><label for="binding-toggle-key">Compensation binding</label>${shortcutPicker('binding-toggle', b.toggle)}</div><div class="field"><label for="activation-mode">Activation behavior</label><select id="activation-mode"><option value="toggle" ${(b.activationMode ?? 'toggle') === 'toggle' ? 'selected' : ''}>Toggle on / off</option><option value="hold" ${b.activationMode === 'hold' ? 'selected' : ''}>Hold to enable</option></select></div></div></div><div class="grid-two"><section class="card"><div class="card-kicker">ACTIONS</div>${Object.entries(actions).map(([id, label]) => `<div class="field"><label for="binding-${id}-key">${label}</label>${shortcutPicker(`binding-${id}`, b[id])}</div>`).join('')}<div class="field"><label for="binding-pause">Hold to pause</label>${bindingRecorder('binding-pause', b.pause, { single: true })}</div><p class="hint">Right mouse selects ADS. Escape always disables output. Ctrl + Shift + H always opens configuration. Shortcuts also reach the game; choose keys that are free in its settings. Action shortcuts match modifiers exactly. Hold-to-enable stays active while you use stance and pause keys.</p></section><section class="card"><div class="card-kicker">DIRECT WEAPON SELECTION</div><h2>One shortcut for each weapon.</h2><p>Previous / next skips empty slots. Direct selection can choose an empty slot and turns compensation off.</p>${game.weapons.map((weapon, i) => `<div class="field"><label for="weapon-key-${i}-key">${escape(weapon.name)}${activeSetup(weapon).profile ? '' : ' · needs setup'}</label>${shortcutPicker(`weapon-key-${i}`, weapon.hotkey, true)}</div>`).join('')}<p class="hint">Save or discard a live tuning draft before changing weapons. The HUD’s unlocked controls can also switch weapons.</p></section></div>${gameStancesPanel(game)}<div class="action-row" style="margin-top:20px"><button class="button" type="submit">Save controls &amp; stances</button><button class="button subtle" type="button" id="reset-bindings">Reset action keys</button></div></form>`;
}
document.addEventListener('submit', event => {
  if (event.target.id !== 'controls-form') return;
  event.preventDefault();
  void attempt(async () => {
    cancelBindingCapture();
    const next = structuredClone(state.settings); const { game } = current(next);
    game.bindings.activationMode = $('#activation-mode').value;
    for (const id of ['toggle', 'previousWeapon', 'nextWeapon', 'tuningToggle', 'tuningTarget']) game.bindings[id] = readShortcut(`binding-${id}`);
    game.bindings.pause = $('#binding-pause').value;
    const rows = [...document.querySelectorAll('.stance-config')];
    game.stances = rows.map(row => ({ id: row.dataset.stanceId, name: row.querySelector('.stance-name').value.trim() }));
    game.bindings.stances = rows.map(row => ({ id: row.dataset.stanceId, key: row.querySelector('.stance-key').value || null, mode: row.querySelector('.stance-mode').value }));
    game.weapons.forEach((weapon, i) => { weapon.hotkey = readShortcut(`weapon-key-${i}`); });
    await save(next, 'Controls saved for this game. Compensation is in standby.');
  });
});
document.addEventListener('click', event => {
  if (event.target.id !== 'reset-bindings') return;
  cancelBindingCapture();
  $('#activation-mode').value = 'toggle';
  for (const id of ['toggle','previousWeapon','nextWeapon','tuningToggle','tuningTarget']) setBinding($(`#binding-${id}-key`), state.defaultBindings[id]);
  setBinding($('#binding-pause'), state.defaultBindings.pause);
  toast('Default action keys loaded. Save controls to apply them.');
});

document.addEventListener('click', event => {
  const target = event.target.closest('[data-add-stance], [data-remove-stance]');
  if (!target) return;
  void attempt(async () => {
    const { game } = current();
    if (target.dataset.removeStance) {
      const id = target.dataset.removeStance;
      const users = game.weapons.filter(w => [w, ...w.setups].some(s => s.profile?.recoils.some(r => r.activate.includes(id))));
      if (users.length) throw new Error(`Remove this stance's patterns from ${users.map(w => w.name).join(', ')} first. The workshop has Remove stance and Undo.`);
      target.closest('.stance-config').remove();
      return;
    }
    if (document.querySelectorAll('.stance-config').length >= 16) throw new Error('A game can have up to 16 stances.');
    const preset = target.dataset.addStance;
    const id = preset === 'custom' ? `stance-${crypto.randomUUID()}` : preset;
    if ([...document.querySelectorAll('.stance-config')].some(row => row.dataset.stanceId === id)) throw new Error('That stance is already in this game.');
    $('#stance-rows').insertAdjacentHTML('beforeend', stanceRow({ id, name: preset === 'custom' ? '' : preset === 'prone' ? 'Prone' : 'Crouch' }, { key: preset === 'crouching' ? 'control' : null, mode: 'hold' }));
    const added = $('#stance-rows').lastElementChild;
    added.scrollIntoView({ block: 'nearest' }); added.querySelector('.stance-name').focus();
  });
});
