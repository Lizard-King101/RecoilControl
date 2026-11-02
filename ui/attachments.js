let attachmentContext;
function checkAttachmentContext() {
  const { game, weapon } = current();
  if (!attachmentContext || attachmentContext.game !== game.id || attachmentContext.weapon !== weapon.id || attachmentContext.setup !== weapon.selectedSetupId) throw new Error('The active setup changed. Close this dialog and reopen it for the setup you want to edit.');
}
// Configuration fields are copied explicitly: an attachment setup never owns weapon identity or shortcuts.
function setupData(setup) {
  return structuredClone({ profile: setup.profile, tuning: setup.tuning, provenance: setup.provenance, calibration: setup.calibration });
}
function activeSetup(weapon) {
  return !weapon.selectedSetupId || weapon.selectedSetupId === 'base' ? weapon : weapon.setups.find(s => s.id === weapon.selectedSetupId);
}
function setupName(weapon) { return weapon.selectedSetupId === 'base' || !weapon.selectedSetupId ? 'Base' : activeSetup(weapon).name; }
function weaponView(weapon) { return { ...weapon, ...setupData(activeSetup(weapon)) }; }
function setupChoices(weapon) { return [{ id: 'base', name: 'Base' }, ...(weapon.setups ?? [])]; }
function attachmentPanel(weapon) {
  const setup = activeSetup(weapon), base = setup === weapon;
  return `<section class="attachment-panel" aria-label="Attachment setup"><div class="attachment-heading"><label for="setup-select">ATTACHMENT SETUP</label><button class="inline-link" data-action="new-setup" ${weapon.setups.length >= 24 ? 'disabled' : ''}>+ Add setup</button></div><div class="attachment-picker"><select id="setup-select" aria-label="Attachment setup">${setupChoices(weapon).map(s => `<option value="${escape(s.id)}" ${s.id === weapon.selectedSetupId ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select>${base ? '' : '<button class="button subtle small" data-action="edit-setup">Edit</button>'}</div><div class="attachment-tags">${base ? '<span class="hint">Original pattern · no attachments</span>' : setup.attachments.length ? setup.attachments.map(a => `<span class="attachment-tag"><small>${escape(a.slot)}</small>${escape(a.name)}</span>`).join('') : '<span class="hint">Custom setup · no attachments listed</span>'}</div></section>`;
}
function attachmentRow(attachment = { slot: '', name: '' }) {
  return `<div class="attachment-row"><input class="attachment-slot" aria-label="Attachment slot" list="attachment-slots" maxlength="40" value="${escape(attachment.slot)}" placeholder="Slot, e.g. Optic" required><input class="attachment-name" aria-label="Attachment name" list="attachment-names" maxlength="80" value="${escape(attachment.name)}" placeholder="Attachment name" required><button class="button subtle small" type="button" data-action="remove-attachment" aria-label="Remove attachment">×</button></div>`;
}
function editSetup(create = false) {
  const { game, weapon } = current();
  const setup = activeSetup(weapon);
  attachmentContext = { game: game.id, weapon: weapon.id, setup: weapon.selectedSetupId };
  const attachments = create ? (setup.attachments ?? []) : setup.attachments;
  const saved = game.weapons.flatMap(w => w.setups.flatMap(s => s.attachments));
  const slots = [...new Set(['Optic', 'Muzzle', 'Underbarrel', ...saved.map(a => a.slot)])];
  const names = [...new Set(saved.map(a => a.name))];
  modal(create ? 'Add an attachment setup' : 'Edit attachment setup', `${escape(weapon.name)} · patterns and tuning stay independent for each setup.`,
    `<div class="field"><label for="setup-name">Setup name</label><input id="setup-name" name="name" maxlength="80" required value="${create ? '' : escape(setup.name)}" placeholder="e.g. Close range" autofocus></div>`
    + (create ? `<div class="field"><label for="setup-source">Starting pattern</label><select id="setup-source" name="source">${setupChoices(weapon).map(s => `<option value="${escape(s.id)}" ${s.id === weapon.selectedSetupId ? 'selected' : ''}>Copy ${escape(s.name)}</option>`).join('')}<option value="blank">Blank pattern</option></select><small>Copies shots, stances, strength, and sensitivity reference. Tune the copy for your attachments.</small></div>` : '')
    + `<div class="attachment-heading"><strong>Attachments</strong><button type="button" class="inline-link" data-action="add-attachment">+ Add attachment</button></div><p class="hint">Choose a suggested slot or type your own. Names describe your setup; adjust its effect under Tune or Edit pattern.</p><div id="attachment-rows">${attachments.map(attachmentRow).join('')}</div><datalist id="attachment-slots">${slots.map(s => `<option value="${escape(s)}"></option>`).join('')}</datalist><datalist id="attachment-names">${names.map(s => `<option value="${escape(s)}"></option>`).join('')}</datalist>`
    + (create ? '' : '<button type="button" class="inline-link danger setup-delete" data-action="delete-setup">Delete this setup</button>'), create ? 'new-setup' : 'edit-setup', create ? 'Create setup' : 'Save setup');
}
function saveSetupForm(next, create) {
  checkAttachmentContext();
  const { weapon } = current(next);
  const attachments = [...document.querySelectorAll('.attachment-row')].map(row => ({ slot: row.querySelector('.attachment-slot').value.trim(), name: row.querySelector('.attachment-name').value.trim() }));
  const name = $('#setup-name').value.trim();
  if (create) {
    const sourceId = $('#setup-source').value;
    const source = sourceId === 'base' ? weapon : weapon.setups.find(s => s.id === sourceId);
    const data = source ? setupData(source) : { profile: null, tuning: { x: 1, y: 1 }, provenance: 'template', calibration: null };
    if (data.profile) data.provenance = 'manual';
    const setup = { ...data, id: crypto.randomUUID(), name, attachments };
    weapon.setups.push(setup); weapon.selectedSetupId = setup.id;
  } else {
    Object.assign(activeSetup(weapon), { name, attachments });
  }
}
