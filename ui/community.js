const community = { packs: [], loaded: false, loading: false, error: '', query: '', game: '', sort: 'recent', detail: null, request: 0, weapon: 0, setup: 'base', stance: 0, draft: null, busy: false };
const packDate = value => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function communityView() {
  return heading('Shared setups · free to share', 'Community library', 'Find a starting point. Make it yours. Share what you learn.', '<button class="button subtle" data-action="community-open">Add pack file</button><button class="button" data-action="community-publish">Publish a pack</button>')
    + '<div class="community-notice"><span class="dot orange"></span><strong>Local library</strong><span>Packs stay on this device. Export a file to share; online publishing comes later.</span><button class="text-button" data-action="community-refresh">Refresh</button></div>'
    + `<div class="community-toolbar"><div class="field"><label for="community-search">Search the library</label><input id="community-search" type="search" placeholder="Game, title, author, or tag…" value="${escape(community.query)}"></div><div class="field"><label for="community-game">Game</label><select id="community-game"><option value="">All games</option>${[...new Set(community.packs.map(p => p.game))].sort().map(g => `<option ${g === community.game ? 'selected' : ''} value="${escape(g)}">${escape(g)}</option>`).join('')}</select></div><div class="field"><label for="community-sort">Sort</label><select id="community-sort"><option value="recent">Newest first</option><option value="title" ${community.sort === 'title' ? 'selected' : ''}>Title A–Z</option></select></div></div>`
    + `<div class="community-layout"><section id="community-results" aria-live="polite">${communityResults()}</section><aside id="community-detail" class="community-detail">${communityDetail()}</aside></div>`;
}
function communityResults() {
  if (community.loading && !community.loaded) return '<div class="community-empty card"><h2>Opening your library…</h2></div>';
  if (community.error) return `<div class="community-empty card"><h2>The library couldn’t load.</h2><p>${escape(community.error)}</p><button class="button subtle" data-action="community-refresh">Try again</button></div>`;
  const query = community.query.trim().toLowerCase();
  const packs = community.packs.filter(p => (!community.game || p.game === community.game) && [p.title, p.game, p.author, ...p.tags].join(' ').toLowerCase().includes(query));
  if (community.sort === 'title') packs.sort((a, b) => a.title.localeCompare(b.title));
  if (!packs.length) return `<div class="community-empty card"><span class="community-empty-mark" aria-hidden="true">↗</span><div class="card-kicker">${community.packs.length ? 'No matches' : 'Your library starts here'}</div><h2>${community.packs.length ? 'Try a different search.' : 'A good setup deserves to be shared.'}</h2><p>${community.packs.length ? 'Search another game, title, author, or tag.' : 'Publish a game pack with its weapons, attachment variants, and stances. Or add a pack someone has shared with you.'}</p><button class="button subtle" data-action="${community.packs.length ? 'community-clear' : 'community-publish'}">${community.packs.length ? 'Clear filters' : 'Create your first pack'}</button></div>`;
  return `<div class="community-count">${packs.length} ${packs.length === 1 ? 'pack' : 'packs'}</div><div class="community-cards">${packs.map(p => `<button class="community-card ${community.detail?.id === p.id ? 'selected' : ''}" data-action="community-detail" data-id="${p.id}"><span class="community-card-top"><span class="community-game-mark">${escape(p.game.slice(0, 2).toUpperCase())}</span><span>${escape(p.game)}<small>Release ${escape(p.release)}</small></span><span class="community-local">LOCAL</span></span><strong class="community-title">${escape(p.title)}</strong><span class="community-author">by ${escape(p.author)}</span><span class="community-description">${escape(p.description)}</span><span class="community-tags">${p.tags.slice(0, 3).map(t => `<span>${escape(t)}</span>`).join('')}</span><span class="community-card-stats"><span>${p.weapons} weapons</span><span>${p.setups} variants</span><span>${p.patterns} patterns</span></span><span class="community-card-footer">${escape(packDate(p.publishedAt))}<span>Preview →</span></span></button>`).join('')}</div>`;
}
function communityDetail() {
  if (!community.detail) return '<div class="community-detail-placeholder"><span class="card-kicker">Before you install</span><h2>See what’s inside.</h2><p>Preview patterns, attachment setups, stances, and reference settings. Every pack installs as a separate game collection.</p><div class="rule"></div><p>Your existing loadouts and controls stay yours.</p></div>';
  const { pack, publishedAt } = community.detail, game = pack.game;
  return `<div class="card-kicker">${escape(game.name)} · release ${escape(pack.release)}</div><h2>${escape(pack.title)}</h2><p class="community-author">by ${escape(pack.author)} · ${escape(packDate(publishedAt))}</p><p class="community-full-description">${escape(pack.description)}</p><div class="community-tags">${pack.tags.map(t => `<span>${escape(t)}</span>`).join('')}</div><div class="community-reference"><span>Game build<strong>${escape(pack.gameVersion || 'Not specified')}</strong></span><span>Reference DPI<strong>${game.input.dpi}</strong></span><span>Sensitivity<strong>${game.input.sensitivity}</strong></span><span>ADS multiplier<strong>${game.input.adsMultiplier}×</strong></span></div><p class="hint">Author-provided settings. Test and tune for your own setup.</p><div id="community-pattern">${communityPattern()}</div><p class="hint">Postures: ${game.stances.length ? game.stances.map(s => escape(s.name)).join(' · ') : 'None'}<br>Default and ADS patterns are shown per weapon.</p><button class="button full" data-action="community-install">Add to my games</button><div class="community-detail-actions"><button class="text-button" data-action="community-export">Export pack</button><button class="text-button" data-action="community-remove">Remove local listing</button></div>`;
}
function communityPattern() {
  const game = community.detail.pack.game;
  community.weapon = Math.min(community.weapon, game.weapons.length - 1);
  const weapon = game.weapons[community.weapon];
  const setup = community.setup === 'base' ? weapon : weapon.setups.find(s => s.id === community.setup) ?? weapon;
  const profile = setup.profile;
  community.stance = Math.min(community.stance, Math.max(0, (profile?.recoils.length ?? 1) - 1));
  const recoil = profile?.recoils[community.stance];
  let path = '';
  if (recoil) {
    const vectors = recoil.vectors.map((_, i) => patternTools.shotCounts(profile, community.stance, i));
    const points = [[0, 0]]; for (const v of vectors) points.push([points.at(-1)[0] + v[0] * setup.tuning.x, points.at(-1)[1] + v[1] * setup.tuning.y]);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min(260 / Math.max(1, maxX - minX), 110 / Math.max(1, maxY - minY));
    path = points.map(p => `${(160 + (p[0] - (minX + maxX) / 2) * scale).toFixed(1)},${(70 + (p[1] - (minY + maxY) / 2) * scale).toFixed(1)}`).join(' ');
  }
  return `<div class="rule"></div><div class="field"><label for="community-weapon">Weapon · ${game.weapons.length} included</label><select id="community-weapon">${game.weapons.map((w, i) => `<option value="${i}" ${i === community.weapon ? 'selected' : ''}>${escape(w.name)}</option>`).join('')}</select></div><div class="field"><label for="community-setup">Attachment setup</label><select id="community-setup"><option value="base">Base</option>${weapon.setups.map(s => `<option value="${escape(s.id)}" ${s === setup ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select></div>${setup !== weapon ? `<p class="hint">${setup.attachments.map(a => `${escape(a.slot)}: ${escape(a.name)}`).join(' · ') || 'No attachment labels'}</p>` : ''}${profile ? `<div class="field"><label for="community-stance">Pattern stance</label><select id="community-stance">${profile.recoils.map((s, i) => `<option value="${i}" ${i === community.stance ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}</select></div><svg class="community-path" viewBox="0 0 320 140" role="img" aria-label="Compensation path preview"><path d="M160 10V130M20 70H300" stroke="#ffffff12" stroke-dasharray="3 5"/><polyline points="${path}"/></svg><div class="community-pattern-meta"><span>${profile.rpm} RPM</span><span>${recoil.vectors.length} shots</span><span>${(recoil.vectors.length * 60 / profile.rpm).toFixed(2)} s</span></div>` : '<p class="hint">Empty weapon slot · ready to author.</p>'}`;
}
async function refreshCommunity(id) {
  community.loading = true; community.error = '';
  try {
    const result = await api.libraryList(); community.packs = result.packs; community.loaded = true;
    if (community.game && !community.packs.some(p => p.game === community.game)) community.game = '';
    if (community.detail && !community.packs.some(p => p.id === community.detail.id)) community.detail = null;
    if (id) { community.detail = await api.libraryDetail(id); community.weapon = 0; community.setup = 'base'; community.stance = 0; }
  } catch (error) { community.error = String(error.message ?? error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { community.loading = false; if (view === 'community') render(); }
}
async function communityAction(button) {
  const action = button.dataset.action;
  if (community.busy) return;
  if (action === 'community-refresh') return refreshCommunity();
  if (action === 'community-clear') { community.query = community.game = ''; render(); return; }
  if (action === 'community-detail') {
    const request = ++community.request, record = await api.libraryDetail(button.dataset.id);
    if (request !== community.request) return;
    community.detail = record; community.weapon = community.stance = 0; community.setup = 'base'; if (view === 'community') render(); return;
  }
  if (action === 'community-open') {
    const record = await api.libraryOpenFile(); if (record) { community.query = community.game = ''; await refreshCommunity(record.id); toast('Shared pack added to the local library. Review it before installing.'); } return;
  }
  if (action === 'community-publish') {
    community.draft = null;
    const game = current().game;
    if (!game.id) throw new Error('Add or install a game before publishing a pack.');
    modal('Publish a game pack', `From ${escape(game.name)} · published to this device’s library`, `<div class="field"><label for="pack-title">Pack title</label><input id="pack-title" name="title" required maxlength="80" value="${escape(game.name)} loadout"></div><div class="field-row"><div class="field"><label for="pack-author">Author name</label><input id="pack-author" name="author" required maxlength="60" placeholder="Your display name"></div><div class="field"><label for="pack-release">Pack release</label><input id="pack-release" name="release" required maxlength="30" value="1.0.0"></div></div><div class="field"><label for="pack-build">Game version / build <small>optional</small></label><input id="pack-build" name="gameVersion" maxlength="60" placeholder="The build you tested"></div><div class="field"><label for="pack-description">Description &amp; setup notes</label><textarea id="pack-description" name="description" rows="4" maxlength="3000" required placeholder="What’s included, what you tested, and any setup advice."></textarea></div><div class="field"><label for="pack-tags">Tags <small>comma-separated, up to 8</small></label><input id="pack-tags" name="tags" maxlength="200" placeholder="rifles, beginner, controller setup"></div><p class="hint">Includes ${game.weapons.length} weapons, attachment setups, stances, and reference sensitivity. Personal bindings and local calibration history are excluded.</p>`, 'community-review', 'Review pack');
    return;
  }
  if (!community.detail) throw new Error('Select a pack first.');
  if (action === 'community-export') { if (await api.libraryExport(community.detail.id)) toast('Game pack exported.'); return; }
  if (action === 'community-install') {
    const p = community.detail.pack;
    modal('Add this pack to your games?', `${escape(p.title)} · by ${escape(p.author)}`, `<p>Add ${p.game.weapons.length} weapons and their attachment setups as a new <strong>${escape(p.game.name)}</strong> collection?</p><p>Reference: ${p.game.input.dpi} DPI · ${p.game.input.sensitivity} sensitivity · ${p.game.input.adsMultiplier}× ADS.</p><p class="hint">Existing games are preserved. The new collection starts with default controls and unassigned posture keys. Compensation stays off.</p><input type="hidden" name="id" value="${community.detail.id}">`, 'community-install', 'Add collection');
  } else if (action === 'community-remove') modal('Remove local listing?', escape(community.detail.pack.title), `<p>This removes the pack from this device’s library. Installed game collections and exported files are kept.</p><input type="hidden" name="id" value="${community.detail.id}">`, 'community-remove', 'Remove listing');
}
async function communitySubmit(form) {
  if (community.busy) return;
  const data = new FormData(form); community.busy = true;
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    if (form.dataset.submit === 'community-review') {
      const metadata = Object.fromEntries(data); metadata.tags = String(metadata.tags).split(',').map(t => t.trim()).filter(Boolean);
      const pack = community.draft = await api.libraryDraft(metadata), game = pack.game;
      modal('Ready to publish locally', `${escape(pack.title)} · release ${escape(pack.release)}`, `<p class="community-full-description">${escape(pack.description)}</p><div class="community-reference"><span>Author<strong>${escape(pack.author)}</strong></span><span>Game<strong>${escape(game.name)}</strong></span><span>Weapons<strong>${game.weapons.length}</strong></span><span>Variants<strong>${game.weapons.reduce((n, w) => n + w.setups.length, 0)}</strong></span></div><p>${game.weapons.map(w => escape(w.name)).join(' · ')}</p><p class="hint">This is a snapshot of your current setup. It stays on this device until you export it. Publishing again with changes creates a separate listing.</p>`, 'community-confirm', 'Publish locally');
    } else if (form.dataset.submit === 'community-confirm') {
      if (!community.draft) throw new Error('Create a pack draft first.');
      const record = await api.libraryPublish(community.draft); community.draft = null; $('#dialog').close(); community.query = community.game = ''; await refreshCommunity(record.id); toast('Published to your local library. Export the pack to share it.');
    } else if (form.dataset.submit === 'community-install') {
      const next = await api.libraryInstall(String(data.get('id'))); $('#dialog').close(); stance = 0; receive(next); toast('Pack added as a separate game collection. Open Loadout to edit it.');
    } else if (form.dataset.submit === 'community-remove') {
      await api.libraryRemove(String(data.get('id'))); $('#dialog').close(); await refreshCommunity(); toast('Local listing removed.');
    }
  } finally { community.busy = false; if (submit.isConnected) submit.disabled = false; }
}
document.addEventListener('input', event => {
  if (event.target.id !== 'community-search') return;
  community.query = event.target.value; $('#community-results').innerHTML = communityResults();
});
document.addEventListener('change', event => {
  const { id, value } = event.target;
  if (id === 'community-game' || id === 'community-sort') { community[id === 'community-game' ? 'game' : 'sort'] = value; $('#community-results').innerHTML = communityResults(); }
  if (['community-weapon', 'community-setup', 'community-stance'].includes(id) && community.detail) {
    if (id === 'community-weapon') { community.weapon = Number(value); community.setup = 'base'; community.stance = 0; }
    if (id === 'community-setup') { community.setup = value; community.stance = 0; }
    if (id === 'community-stance') community.stance = Number(value);
    $('#community-pattern').innerHTML = communityPattern();
  }
});
