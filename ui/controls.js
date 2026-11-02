function keyLabel(value) {
  return String(value).split('+').map(key => ({ ctrl: 'Ctrl', control: 'Ctrl', shift: 'Shift', alt: 'Alt' }[key] || state.keyChoices.find(item => item.key === key)?.label || key)).join(' + ');
}
function shortcutPicker(id, value, optional = false) {
  const parts = value?.split('+') ?? []; const base = parts.pop() ?? '';
  const modifiers = ['', 'ctrl', 'alt', 'shift', 'ctrl+alt', 'ctrl+shift', 'alt+shift', 'ctrl+alt+shift'];
  return `<div class="shortcut-picker"><select id="${id}-mods" aria-label="Shortcut modifiers">${modifiers.map(item => `<option value="${item}" ${parts.join('+') === item ? 'selected' : ''}>${item ? keyLabel(item) : 'No modifier'}</option>`).join('')}</select><select id="${id}-key" aria-label="Shortcut key">${optional ? '<option value="">Not assigned</option>' : ''}${state.keyChoices.map(item => `<option value="${item.key}" ${base === item.key ? 'selected' : ''}>${item.label}</option>`).join('')}</select></div>`;
}
function readShortcut(id) {
  const key = $(`#${id}-key`).value;
  return key ? [$(`#${id}-mods`).value, key].filter(Boolean).join('+') : null;
}
function controlsView() {
  const { game } = current(); const b = game.bindings;
  const actions = { toggle: 'Toggle compensation', previousWeapon: 'Previous configured weapon', nextWeapon: 'Next configured weapon', tuningToggle: 'Toggle live tuning', tuningTarget: 'Cycle tuning target' };
  const holds = [{ key: 'control', label: 'Ctrl' }, { key: 'shift', label: 'Shift' }, { key: 'alt', label: 'Alt' }, ...state.keyChoices];
  return heading(`${escape(game.name.toUpperCase())} / CONTROLS`, 'Your keys, per game.', 'Switch weapons and tune without opening the game’s chat.') + `<form id="controls-form"><div class="grid-two"><section class="card"><div class="card-kicker">ACTIONS</div>${Object.entries(actions).map(([id, label]) => `<div class="field"><label for="binding-${id}-key">${label}</label>${shortcutPicker(`binding-${id}`, b[id])}</div>`).join('')}<div class="field-row">${['pause', 'crouch'].map(id => `<div class="field"><label for="binding-${id}">${id === 'pause' ? 'Hold to pause' : 'Hold for crouch stance'}</label><select id="binding-${id}">${holds.map(item => `<option value="${item.key}" ${b[id] === item.key ? 'selected' : ''}>${item.label}</option>`).join('')}</select></div>`).join('')}</div><p class="hint">Right mouse selects ADS. Escape always disables output. Ctrl + Shift + H always opens configuration. Shortcuts also reach the game; choose keys that are free in its settings. Modifier combinations must match exactly.</p></section><section class="card"><div class="card-kicker">DIRECT WEAPON SELECTION</div><h2>One shortcut for each weapon.</h2><p>Previous / next skips empty slots. Direct selection can choose an empty slot and turns compensation off.</p>${game.weapons.map((weapon, i) => `<div class="field"><label for="weapon-key-${i}-key">${escape(weapon.name)}${weapon.profile ? '' : ' · needs setup'}</label>${shortcutPicker(`weapon-key-${i}`, weapon.hotkey, true)}</div>`).join('')}<p class="hint">Save or discard a live tuning draft before changing weapons. The HUD’s unlocked controls can also switch weapons.</p></section></div><div class="action-row" style="margin-top:20px"><button class="button" type="submit">Save controls</button><button class="button subtle" type="button" id="reset-bindings">Reset action keys</button></div></form>`;
}
document.addEventListener('submit', event => {
  if (event.target.id !== 'controls-form') return;
  event.preventDefault();
  void attempt(async () => {
    const next = structuredClone(state.settings); const { game } = current(next);
    for (const id of ['toggle', 'previousWeapon', 'nextWeapon', 'tuningToggle', 'tuningTarget']) game.bindings[id] = readShortcut(`binding-${id}`);
    for (const id of ['pause', 'crouch']) game.bindings[id] = $(`#binding-${id}`).value;
    game.weapons.forEach((weapon, i) => { weapon.hotkey = readShortcut(`weapon-key-${i}`); });
    await save(next, 'Controls saved for this game. Compensation is in standby.');
  });
});
document.addEventListener('click', event => {
  if (event.target.id !== 'reset-bindings') return;
  for (const [id, value] of Object.entries(state.defaultBindings)) {
    if ($(`#binding-${id}`)) $(`#binding-${id}`).value = value;
    else { $(`#binding-${id}-mods`).value = ''; $(`#binding-${id}-key`).value = value; }
  }
  toast('Default action keys loaded. Save controls to apply them.');
});
