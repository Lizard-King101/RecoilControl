const api = window.control;
const abbreviations = { ak: 'AK', lr300: 'LR', mp5: 'MP5', thompson: 'TH', 'custom-smg': 'SMG', m249: '249' };
function activeSetup(w) { return !w.selectedSetupId || w.selectedSetupId === 'base' ? w : w.setups.find(s => s.id === w.selectedSetupId); }
let latest;
let feedback = '';
let busy = false;
function update(state) {
  latest = state;
  const game = state.settings.games.find(game => game.id === state.settings.selectedGameId) ?? state.emptySelection.game;
  const weapon = game.weapons.find(weapon => weapon.id === game.selectedWeaponId) ?? state.emptySelection.weapon;
  const setup = activeSetup(weapon);
  const setupName = setup === weapon ? 'Base' : setup.name;
  const runtime = state.runtime;
  const tuning = runtime.tuning;
  const current = tuning?.stances[tuning.current];
  const tuningRow = document.getElementById('hud-tuning');
  tuningRow.hidden = !tuning?.active && !tuning?.dirty;
  const targetLabel = document.createElement('span');
  targetLabel.className = 'tuning-target-label';
  targetLabel.textContent = current ? `${tuning.active ? 'TUNE' : 'DRAFT'} · ${current.name} · ${tuning.target == null ? 'FOLLOW' : 'LOCKED'}` : '';
  targetLabel.title = targetLabel.textContent;
  const values = document.createElement('span');
  values.className = `tuning-values${current && (current.x >= current.maxX || current.y >= current.maxY) ? ' limit' : ''}`;
  values.textContent = current ? `X ${Math.round(current.x * 100)}%  Y ${Math.round(current.y * 100)}% · ${current.x >= current.maxX || current.y >= current.maxY ? 'LIMIT' : `${Math.round(tuning.step * 100)}% step`}` : '';
  values.title = current ? `Session maximum: X ${Math.round((current.maxX ?? 3) * 100)}%, Y ${Math.round((current.maxY ?? 3) * 100)}%. See Calibration for limit details.` : '';
  tuningRow.replaceChildren(targetLabel, values);
  document.getElementById('hud-game').textContent = `${game.name.toUpperCase()} · ${runtime.output === 'bluetooth' ? 'BLE' : 'DRIVER'}`;
  document.getElementById('hud-weapon').textContent = weapon.name;
  document.getElementById('hud-abbr').textContent = abbreviations[weapon.id] ?? weapon.name.slice(0, 3).toUpperCase();
  document.getElementById('hud-profile').textContent = runtime.stance;
  document.getElementById('hud-weapon').title = `${weapon.name} · ${setupName}`;
  document.getElementById('hud-setup-label').textContent = setupName;
  const stances = (setup.profile?.recoils ?? []).slice(0, 4).map(recoil => recoil.name);
  document.getElementById('hud-stances').replaceChildren(...[0, 1, 2, 3].map(index => {
    const segment = document.createElement('span');
    if (index < stances.length && stances[index] === runtime.stance) segment.className = 'on';
    return segment;
  }));

  document.getElementById('hud-state').textContent = runtime.measurement.running ? 'MEASURING' : !runtime.ready ? 'OFFLINE' : runtime.enabled ? runtime.paused ? 'PAUSED' : 'ARMED' : 'STANDBY';
  if (runtime.relay && !runtime.passthrough) {
    document.getElementById('hud-game').textContent = `${game.name.toUpperCase()} · RELAY`;
    if (!runtime.ready) document.getElementById('hud-state').textContent = 'RECOIL OFF';
  }
  if (runtime.passthrough) document.getElementById('hud-state').textContent = runtime.ready ? 'RELAY' : 'CHECK LINKS';
  if (runtime.passthrough) {
    document.getElementById('hud-game').textContent = 'MOUSE RELAY · BLE';
    document.getElementById('hud-weapon').textContent = 'Cobra Pro';
    document.getElementById('hud-setup-label').textContent = 'Recoil off';
  }
  if (runtime.passthrough) {
    document.getElementById('hud-abbr').textContent = '—';
    document.getElementById('hud-stances').replaceChildren();
  }
  if (runtime.recording?.active) document.getElementById('hud-state').textContent = `REC · ${runtime.recording.takes.length}`;
  const tone = runtime.recording?.active ? 'recording' : !runtime.ready ? 'error' : runtime.enabled ? runtime.paused ? 'paused' : 'active' : '';
  document.getElementById('hud-dot').className = tone;
  document.getElementById('hud-shell').className = `hud-shell ${tone}`;
  document.getElementById('open-settings').hidden = state.settings.hud.locked;
  document.getElementById('hud-controls').hidden = state.settings.hud.locked;
  const select = document.getElementById('hud-select');
  const signature = JSON.stringify(game.weapons.map(w => [w.id, w.name, !!activeSetup(w).profile]));
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...game.weapons.map(w => { const option = document.createElement('option'); option.value = w.id; option.textContent = w.name + (activeSetup(w).profile ? '' : ' · empty'); return option; }));
    select.dataset.signature = signature;
  }
  select.value = weapon.id; select.disabled = busy || !game.weapons.length;
  for (const id of ['previous-weapon', 'next-weapon']) document.getElementById(id).disabled = busy || !game.weapons.some(w => activeSetup(w).profile);
  const setups = document.getElementById('hud-setup-select');
  const choices = [{ id: 'base', name: 'Base' }, ...weapon.setups];
  const setupSignature = JSON.stringify(choices.map(s => [s.id, s.name]));
  document.getElementById('hud-setup-controls').hidden = state.settings.hud.locked || !weapon.setups.length;
  if (setups.dataset.signature !== setupSignature) {
    setups.replaceChildren(...choices.map(s => { const option = document.createElement('option'); option.value = s.id; option.textContent = s.name; return option; }));
    setups.dataset.signature = setupSignature;
  }
  setups.value = weapon.selectedSetupId; setups.disabled = busy;
  const toggle = document.getElementById('hud-toggle');
  toggle.textContent = runtime.enabled ? 'Off' : game.bindings.activationMode === 'hold' ? 'Hold binding' : 'Arm';
  toggle.classList.toggle('on', runtime.enabled);
  toggle.disabled = (game.bindings.activationMode === 'hold' && !runtime.enabled) || busy || !runtime.ready || !setup.profile || runtime.passthrough || runtime.measurement.running;
  const problem = feedback || (runtime.error?.includes('tuning draft') ? runtime.error : '');
  document.getElementById('hud-profile').title = problem;
  if (problem) document.getElementById('hud-profile').textContent = problem.includes('tuning draft') ? 'Save tuning first · ⚙' : 'Action failed · ⚙';
  document.getElementById('hud-controls').title = problem || 'Switching pauses output until you release fire. Escape disables.';
}
api.onState(update);
api.getState().then(update);
document.getElementById('open-settings').addEventListener('click', () => api.showMain());

async function hudAction(task) {
  busy = true; feedback = ''; update(latest);
  try { await task(); } catch (error) { feedback = String(error.message ?? error); }
  finally { busy = false; update(await api.getState()); }
}
document.getElementById('previous-weapon').addEventListener('click', () => hudAction(() => api.selectWeapon({ direction: -1 })));
document.getElementById('next-weapon').addEventListener('click', () => hudAction(() => api.selectWeapon({ direction: 1 })));
document.getElementById('hud-select').addEventListener('change', event => { const id = event.target.value; void hudAction(() => api.selectWeapon({ id })); });
document.getElementById('hud-toggle').addEventListener('click', () => { const enabled = !latest.runtime.enabled; void hudAction(() => api.setEnabled(enabled)); });

document.getElementById('hud-setup-select').addEventListener('change', event => { const setupId = event.target.value; void hudAction(() => api.selectWeapon({ setupId })); });
