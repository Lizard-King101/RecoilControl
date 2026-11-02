// Hardware-free renderer/IPC coverage for dynamic stances and portable sharing.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.tmp/stance-desktop'), { recursive: true });
process.env.RECOIL_TEST_DATA_DIR = fs.mkdtempSync(path.join(root, '.tmp/stance-desktop/run-'));
process.env.RECOIL_TEST_HEADLESS = '1';
require('../build/desktop/main');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error(message);
}
(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length === 2, 'Windows were not created');
  const main = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Recoil Control');
  const errors = [];
  main.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = script => main.webContents.executeJavaScript(script);
  const snap = () => run('window.control.getState()');
  const savedGame = async () => { const s = await snap(); return s.settings.games.find(g => g.id === s.settings.selectedGameId); };
  await until(async () => !main.webContents.isLoading() && await run('document.querySelectorAll(".weapon-row").length === 6'), 'Loadout did not load');
  assert.deepEqual((await savedGame()).stances, [{ id: 'crouching', name: 'Crouch' }]);
  await run(`document.querySelector('[data-action="new-game"]').click(); document.querySelector('#game-name').value='Stance test'; document.querySelector('#first-weapon').value='Test rifle'; document.querySelector('[name="prone"]').checked=true; document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => (await savedGame()).name === 'Stance test' && await run('!document.querySelector("#dialog").open'), 'Game was not saved');
  const gameId = (await savedGame()).id;
  await run(`document.querySelector('[data-view="controls"]').click(); document.querySelector('[data-stance-id="prone"] .stance-key').value='keyz'; document.querySelector('[data-stance-id="prone"] .stance-mode').value='toggle'; document.querySelector('[data-add-stance="custom"]').click();`);
  await run(`document.querySelector('#stance-rows').lastElementChild.querySelector('.stance-name').value='Mounted'; document.querySelector('#stance-rows').lastElementChild.querySelector('.stance-key').value='keyb'; document.querySelector('#controls-form').requestSubmit();`);
  await until(async () => (await savedGame()).stances.length === 3, 'Custom stance did not save');
  assert.equal((await savedGame()).bindings.stances.find(s => s.id === 'prone').mode, 'toggle');
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  await run(`document.querySelector('.game-stances').scrollIntoView({block:'start'}); document.querySelector('#toast').hidden=true;`);
  await delay(100);
  fs.writeFileSync(path.join(root, 'artifacts/stance-controls.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-view="arsenal"]').click(); document.querySelector('[data-action="edit-pattern"]').click(); document.querySelector('.shot-count[data-axis="1"]').value='10'; document.querySelector('[data-action="manage-stances"]').click();`);
  const add = async name => {
    await run(`document.querySelector('#stance-tools').open=true; document.querySelector('#new-pattern-stance').value=[...document.querySelector('#new-pattern-stance').options].find(o=>o.textContent===${JSON.stringify(name)}).value; document.querySelector('[data-action="add-stance"]').click();`);
  };
  await add('Prone');
  await run(`document.querySelector('.shot-count[data-axis="1"]').value='4'; document.querySelector('#stance-name').value='Prone steady';`);
  await add('Prone ADS');
  await run(`document.querySelector('.shot-count[data-axis="1"]').value='2';`);
  await add('Mounted');
  await run(`document.querySelector('.shot-count[data-axis="1"]').value='1'; document.querySelector('[data-action="remove-stance"]').click(); document.querySelector('[data-action="pattern-undo"]').click();`);
  assert.equal(await run('editDraft.profile.recoils.length'), 4);
  await run(`document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => !!(await savedGame()).weapons[0].profile && await run('!document.querySelector("#dialog").open'), 'Pattern did not save');
  const saved = (await savedGame()).weapons[0].profile;
  assert.deepEqual(saved.recoils.map(r => r.name), ['Default', 'Prone steady', 'Prone ADS', 'Mounted']);
  for (const [index, expected] of [[0,10],[1,4],[2,2],[3,1]]) {
    const preview = await run(`window.control.preview(${index})`);
    assert.ok(Math.abs(preview.points.at(-1).y - expected) <= 1, `Wrong preview for stance ${index}: ${preview.points.at(-1).y}`);
  }
  await run(`document.querySelector('[data-action="edit-pattern"]').click(); document.querySelector('[data-action="edit-stance"][data-row="2"]').click(); document.querySelector('#stance-tools').open=true;`);
  await delay(150);
  fs.writeFileSync(path.join(root, 'artifacts/stance-workshop.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-action="close-dialog"]').click();`);
  const exportFile = path.join(process.env.RECOIL_TEST_DATA_DIR, 'shared.json');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportFile });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportFile] });
  await run('window.control.exportProfile()');
  const payload = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  assert.equal(payload.format, 'recoil-control/weapon-v4');
  assert.deepEqual(payload.stances.map(s => s.name), ['Prone', 'Mounted']);
  await run(`document.querySelector('[data-game="rust"]').click();`);
  await until(async () => (await savedGame()).id === 'rust', 'Did not switch back to Rust');
  await run('window.control.importProfile().then(receive)');
  assert.equal((await savedGame()).weapons.length, 7);
  assert.deepEqual((await savedGame()).stances.map(s => s.name), ['Crouch', 'Prone', 'Mounted']);
  assert.equal((await savedGame()).bindings.stances.some(b => b.id === 'prone'), false);
  await main.webContents.reload();
  await until(async () => !main.webContents.isLoading() && await run('typeof state !== "undefined" && state.settings.games.length === 2'), 'Reload did not restore state');
  const final = await snap();
  assert.equal(final.runtime.enabled, false); assert.equal(final.board.connected, false);
  assert.deepEqual(final.settings.games.find(g => g.id === gameId).weapons[0].profile, saved);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR, 'settings.json'), 'utf8')).version, 3);
  assert.deepEqual(errors, []);
  console.log('Dynamic stance authoring, previews, hold/toggle settings, undo, persistence, and v4 sharing passed without hardware.');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
