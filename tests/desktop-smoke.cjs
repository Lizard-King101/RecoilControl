// Run with Electron. This is an isolated renderer/IPC integration test, not a live-input test.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.tmp/desktop-smoke'), { recursive: true });
process.env.RECOIL_TEST_DATA_DIR = fs.mkdtempSync(path.join(root, '.tmp/desktop-smoke/run-'));
process.env.RECOIL_TEST_HEADLESS = '1';
require('../build/desktop/main');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error(message);
}

(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length === 2, 'Windows were not created');
  const windows = BrowserWindow.getAllWindows();
  // Windows can clear the native topmost flag while an offscreen HUD is hidden.
  const main = windows.find(window => window.getTitle() === 'Recoil Control');
  const hud = windows.find(window => window.getTitle() === 'Recoil HUD');
  const errors = [];
  main.webContents.on('console-message', (_event, ...args) => {
    const details = args.length === 1 ? args[0] : { level: args[0], message: args[1] };
    if (details.level === 'error' || details.level === 3) { errors.push(details.message); console.error('Renderer:', details.message); }
  });
  const run = async script => {
    try { return await main.webContents.executeJavaScript(script); }
    catch (error) { console.error('Failed renderer check:', script, errors); throw error; }
  };
  const snapshot = () => run('window.control.getState()');
  try {
    await until(async () => !main.webContents.isLoading() && await run('document.querySelectorAll(".weapon-row").length === 6'), 'Renderer did not load');
  } catch (error) {
    console.error('Windows:', windows.map(w => ({ title: w.getTitle(), url: w.webContents.getURL(), top: w.isAlwaysOnTop() })));
    console.error('Renderer startup:', await run('({toast: document.querySelector("#toast")?.textContent, content: document.querySelector("#content")?.textContent})'));
    throw error;
  }
  assert.equal(await run('typeof require'), 'undefined');
  assert.equal(await run('typeof process'), 'undefined');
  assert.ok(hud && main && hud !== main);
  await until(async () => (await run('document.querySelector("#chart svg")?.querySelectorAll("path").length')) > 1, 'Recoil preview did not draw');
  assert.match(await run('document.querySelector(".saved-pattern-output").textContent'), /X -10.00 \/ Y 36.00 counts/);
  await until(async () => { const state = await snapshot(); return state.runtime.ready || state.runtime.error; }, 'Input startup did not finish');
  await delay(100);
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts/configuration.png'), (await main.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(root, 'artifacts/hud.png'), (await hud.webContents.capturePage()).toPNG());

  await run(`document.querySelector('[data-action="edit-pattern"]').click();`);
  await until(async () => await run('document.querySelector("#draft-summary")?.textContent.includes("total X")'), 'Draft preview did not draw');
  assert.match(await run('document.querySelector("#pattern-strength-explanation").textContent'), /saved tuning is included/);
  assert.equal(await run(`Number(document.querySelector('.shot-count[data-shot="0"][data-axis="0"]').value)`), -10);
  fs.writeFileSync(path.join(root, 'artifacts/pattern-workshop.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-action="close-dialog"]').click();`);
  assert.equal((await snapshot()).settings.games[0].weapons[0].profile.units, undefined);

  await run(`document.querySelector('[data-view="input"]').click(); document.querySelector('#dpi').value = '1200'; document.querySelector('#sensitivity').value = '0.5'; document.querySelector('#input-form').requestSubmit();`);
  await until(async () => (await snapshot()).settings.games[0].input.dpi === 1200, 'Input settings did not save');
  assert.equal((await snapshot()).settings.games[0].input.sensitivity, 0.5);
  await until(async () => (await snapshot()).runtime.ready || (await snapshot()).runtime.error, 'Input reconfiguration did not finish');
  if ((await snapshot()).runtime.ready) {
    await until(async () => await run('document.querySelector("#diagnostic-output")?.textContent === "0 / 0"'), 'Live diagnostics did not reach the renderer');
    assert.equal((await snapshot()).runtime.diagnostics.movementsAccepted, 0);
  }
  await run('document.querySelector("#diagnostic-state").scrollIntoView({ block: "center" }); document.querySelector("#toast").hidden = true;');
  await delay(50);
  fs.writeFileSync(path.join(root, 'artifacts/input-diagnostics.png'), (await main.webContents.capturePage()).toPNG());

  await run(`document.querySelector('[data-view="hud"]').click(); document.querySelector('#hud-visible').checked=true; document.querySelector('#hud-opacity').value='70'; document.querySelector('[data-action="save-hud"]').click();`);
  await until(async () => (await snapshot()).settings.hud.opacity === 0.7, 'HUD settings did not save');
  assert.equal((await snapshot()).settings.hud.visible, true);

  await run(`document.querySelector('[data-action="new-game"]').click(); document.querySelector('#game-name').value = 'Integration collection'; document.querySelector('#first-weapon').value = 'Test weapon'; document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => (await snapshot()).settings.games.length === 2, 'New collection did not save');
  await until(async () => await run('!document.querySelector("#dialog").open'), 'Collection dialog did not close');
  await run(`document.querySelector('[data-action="edit-pattern"]').click(); document.querySelector('#pattern-rpm').value='600'; document.querySelector('#generate-count').value='10'; document.querySelector('#generate-start-x').value='-2'; document.querySelector('#generate-start-y').value='10'; document.querySelector('#generate-end-x').value='-5'; document.querySelector('#generate-end-y').value='20'; document.querySelector('[data-action="generate-pattern"]').click();`);
  assert.equal(await run('document.querySelectorAll(".shot-table tbody tr").length'), 10);
  await run(`document.querySelector('[data-action="duplicate-shot"]').click();`);
  assert.equal(await run('document.querySelectorAll(".shot-table tbody tr").length'), 11);
  await run(`document.querySelector('[data-action="pattern-undo"]').click(); document.querySelector('[data-action="add-stances"]').click();`);
  assert.equal(await run('document.querySelectorAll(\'[data-action="edit-stance"]\').length'), 4);
  await run(`document.querySelector('[data-action="edit-stance"][data-row="2"]').click(); document.querySelector('.shot-count[data-shot="0"][data-axis="1"]').value='8'; document.querySelector('[data-action="pattern-view"]').click();`);
  assert.equal(await run('document.querySelector("#vectors").value.split(String.fromCharCode(10))[0]'), '-2, 8');
  await run(`document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => (await snapshot()).settings.games[1].weapons[0].profile !== null, 'Pattern did not save');
  await until(async () => await run('!document.querySelector("#dialog").open'), 'Pattern dialog did not close');
  assert.equal((await snapshot()).settings.games[1].weapons[0].profile.rpm, 600);
  assert.equal((await snapshot()).settings.games[1].weapons[0].profile.units, 'counts');
  assert.equal((await snapshot()).settings.games[1].weapons[0].profile.recoils[0].vectors[0][1], 10);
  assert.equal((await snapshot()).settings.games[1].weapons[0].profile.recoils[2].vectors[0][1], 8);
  const preview = await run('window.control.preview(0)');
  assert.ok(preview.points.length > 1);
  assert.ok(preview.points.at(-1).x < 0 && preview.points.at(-1).y > 0);

  await run(`document.querySelector('[data-view="arsenal"]').click(); document.querySelector('[data-view="calibration"]').click(); document.querySelector('#gain-y').value='1.2'; document.querySelector('[data-action="calibrate"]').click();`);
  await until(async () => (await snapshot()).settings.games[1].weapons[0].provenance === 'calibrated', 'Calibration did not save');
  assert.equal((await snapshot()).runtime.enabled, false);
  assert.equal((await snapshot()).settings.games[1].weapons[0].tuning.y, 1);
  await run(`document.querySelector('#gain-y').value='3'; document.querySelector('[data-action="save-tuning"]').click();`);
  await until(async () => (await snapshot()).settings.games[1].weapons[0].tuning.y === 3, 'High global strength did not save');
  const beforeRebase = await run('window.control.preview(0)');
  await run(`document.querySelector('[data-action="calibrate"]').click();`);
  await until(async () => (await snapshot()).settings.games[1].weapons[0].provenance === 'calibrated', 'Counts calibration did not rebase');
  const afterRebase = await run('window.control.preview(0)');
  assert.deepEqual(afterRebase.points, beforeRebase.points);
  const persisted = JSON.parse(fs.readFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(persisted.games.length, 2);
  assert.equal(persisted.games[1].weapons[0].calibration.sensitivity, 0.5);
  assert.deepEqual(errors, []);
  await run(`document.querySelector('[data-view="input"]').click(); document.querySelector('[data-view="board"]').click();`);
  await until(async () => await run('!!document.querySelector("#board-test")'), 'Board screen did not load');
  assert.equal(await run('document.querySelector("#board-test").disabled'), true);
  assert.equal((await snapshot()).board.ready, false);
  assert.equal(await run('document.querySelector("#board-brightness").max'), '255');
  assert.equal(await run('document.querySelectorAll(".led-row").length'), 9);
  const bundled = JSON.parse(fs.readFileSync(path.join(root, 'firmware/release/manifest.json'), 'utf8')).version;
  assert.equal(await run('document.querySelector("#fw-bundled").textContent'), bundled);
  assert.equal(await run('document.querySelector("#firmware-update").textContent'), `Update to ${bundled}`);
  // A real board may be plugged into this machine: the app must refuse to flash during tests.
  await assert.rejects(run('window.control.updateFirmware()'), /disabled in automated tests/);
  await assert.rejects(run('window.control.recoverFirmware()'), /disabled in automated tests/);
  await run(`(() => { const preview=structuredClone(state); preview.firmware.update={running:false,stage:'Board recovery needs attention',progress:0.98,error:'Board did not return',installed:null,recoveryAvailable:true}; receive(preview); })()`);
  assert.equal(await run('document.querySelector("#firmware-recover").hidden'), false);
  assert.equal(await run('document.querySelector("#fw-progress").hidden'), false);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',code:'KeyR',altKey:true,bubbles:true}));`);
  await until(async () => await run('document.querySelector("#toast").textContent.includes("recovery is disabled in automated tests")'), 'Keyboard recovery did not reach the guarded IPC');
  await run('window.control.getState().then(receive)');
  await run(`document.querySelector('#output-device').value = 'bluetooth'; document.querySelector('#output-device').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).settings.output === 'bluetooth' && (await snapshot()).runtime.output === 'bluetooth', 'Bluetooth selection did not reach the worker');
  assert.equal((await snapshot()).runtime.enabled, false);
  assert.equal((await snapshot()).runtime.ready, false);
  assert.equal(await run('document.querySelector("#enable-toggle").disabled'), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR, 'settings.json'), 'utf8')).output, 'bluetooth');
  await assert.rejects(run('window.control.setEnabled(true)'), /Connect USB/);
  await run(`document.querySelector('[data-view="arsenal"]').click(); document.querySelector('[data-view="calibration"]').click();`);
  await until(async () => await run('!document.querySelector("#tuning-toggle").disabled'), 'Tuning input did not initialize');
  assert.match(await run('document.querySelector("#tuning-status").textContent'), /100% means no additional change/);
  assert.match(await run('document.querySelector("#tuning-values").textContent'), /Saved first shot/);
  assert.match(await run('document.querySelector("#tuning-values").textContent'), /Session max: X 300% · Y 300%/);
  await run(`document.querySelector('[data-action="tuning-toggle"]').click();`);
  await until(async () => (await snapshot()).runtime.tuning.active, 'Tuning did not start');
  await until(async () => await hud.webContents.executeJavaScript('!document.querySelector("#hud-tuning").hidden'), 'HUD tuning row did not appear');
  assert.equal(hud.getSize()[1], 190);
  await run(`document.querySelector('#tuning-target').value='3'; document.querySelector('#tuning-target').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).runtime.tuning.target === 3, 'Tuning target did not lock');
  assert.equal((await snapshot()).runtime.stance, 'Default');
  assert.equal((await snapshot()).runtime.tuning.current, 3);
  await until(async () => await hud.webContents.executeJavaScript('document.querySelector("#hud-tuning").textContent.includes("Crouch ADS · LOCKED")'), 'HUD did not identify the locked target');
  fs.writeFileSync(path.join(root, 'artifacts/tuning-hud.png'), (await hud.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(root, 'artifacts/live-tuning.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#tuning-step').value='0.02'; document.querySelector('#tuning-step').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).runtime.tuning.step === 0.02, 'Tuning step did not save');
  await run(`document.querySelector('[data-action="tuning-discard"]').click();`);
  await until(async () => !(await snapshot()).runtime.tuning.active, 'Discard did not exit tuning');
  assert.equal((await snapshot()).runtime.tuning.target, null);
  await until(async () => await run('document.querySelector("#tuning-target").value === "auto"'), 'Discard did not restore following');
  await run(`document.querySelector('#tuning-target').value='2'; document.querySelector('#tuning-target').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).runtime.tuning.target === 2, 'Second target did not lock');
  await run(`document.querySelector('#tuning-target').value='auto'; document.querySelector('#tuning-target').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).runtime.tuning.target === null, 'Follow current stance did not restore');
  assert.equal((await snapshot()).runtime.enabled, false);
  await run(`document.querySelector('[data-view="input"]').click(); document.querySelector('[data-view="board"]').click();`);
  await run(`document.querySelector('#output-device').value = 'interception'; document.querySelector('#output-device').dispatchEvent(new Event('change', { bubbles: true }));`);
  await until(async () => (await snapshot()).runtime.output === 'interception', 'Driver selection did not restore');
  fs.writeFileSync(path.join(root, 'artifacts/board.png'), (await main.webContents.capturePage()).toPNG());

  await run(`document.querySelector('[data-view="controls"]').click(); document.querySelector('#binding-toggle-key').value='f5'; document.querySelector('#controls-form').requestSubmit();`);
  await until(async () => await run('document.querySelector("#toast").textContent.includes("different shortcut")'), 'Duplicate bindings were accepted');
  assert.equal((await snapshot()).settings.games[1].bindings.toggle, 'f7');
  await run(`document.querySelector('#binding-toggle-key').value='num0'; document.querySelector('#binding-tuningToggle-key').value='num8'; document.querySelector('#weapon-key-0-mods').value='alt'; document.querySelector('#weapon-key-0-key').value='num1'; document.querySelector('#controls-form').requestSubmit();`);
  await until(async () => (await snapshot()).settings.games[1].bindings.toggle === 'num0', 'Per-game controls did not save');
  assert.equal((await snapshot()).settings.games[0].bindings.toggle, 'f7');
  assert.equal((await snapshot()).settings.games[1].weapons[0].hotkey, 'alt+num1');
  await until(async () => await run('document.querySelector("#footer-keys").textContent.includes("Numpad 0")'), 'Footer did not update');
  await until(async () => await run('document.querySelector("#binding-toggle-key").value === "num0"'), 'Saved controls did not render');
  await run(`document.querySelector('#toast').hidden=true;`);
  assert.ok(await run('document.querySelector(".statusbar").getBoundingClientRect().bottom <= innerHeight'), 'Long controls page pushed footer outside window');
  assert.ok(await run('document.querySelector("#controls-form button[type=submit]").getBoundingClientRect().bottom < document.querySelector(".statusbar").getBoundingClientRect().top'), 'Save controls is not visible');
  await delay(150);
  fs.writeFileSync(path.join(root, 'artifacts/controls.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-view="arsenal"]').click(); document.querySelector('[data-view="calibration"]').click();`);
  assert.match(await run('document.querySelector("#tuning-toggle").textContent'), /Numpad 8/);
  await run(`document.querySelector('[data-view="arsenal"]').click(); document.querySelector('[data-action="new-weapon"]').click(); document.querySelector('#weapon-name').value='Authored rifle'; document.querySelector('#weapon-source').selectedIndex=1; document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => await run('document.querySelector("#draft-summary")?.textContent.includes("total X")'), 'Create and edit did not open workshop');
  assert.equal((await snapshot()).settings.games[1].weapons.length, 2);
  assert.equal((await snapshot()).settings.games[1].weapons[1].hotkey, null);
  const shotValues = () => run(`Array.from(document.querySelectorAll('.shot-table tbody tr'), row => Array.from(row.querySelectorAll('input'), input => Number(input.value)))`);
  assert.match(await run('document.querySelector("#wb-record-live").textContent'), /firmware 0\.5\.0/);
  await assert.rejects(run('window.control.record("start")'), /ESP32 relay/);
  assert.equal((await snapshot()).runtime.recording.active, false);
  // Synthetic takes stand in for relay hardware: 600 RPM, one 100 ms bin per shot.
  const beforeRecording = await shotValues();
  await run(`(() => {
    const take = { samples: [[50000, 0, 10], [150000, 1, 20], [250000, 0, 30], [380000, 0, 4]], durationMs: 390, aiming: false };
    state.runtime.recording = { active: false, firing: false, notice: null, supported: true, available: true, takes: [take, structuredClone(take), structuredClone(take)] };
    document.querySelector('#pattern-rpm').value = '600';
    document.querySelector('#record-shots').value = '3'; document.querySelector('#record-shots').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.match(await run('document.querySelector("#wb-record-live").textContent'), /Take 1\s*0\.4 s · 0% off.*3 takes · 3 shots\. Consistent: takes agree within 0% of the path\./);
  await delay(50);
  fs.writeFileSync(path.join(root, 'artifacts/recorded-takes.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('[data-action="record-apply"]').click();`);
  const recorded = await shotValues();
  assert.equal(recorded.length, 3, 'The empty-magazine hold is not a shot');
  // Shots are divided by the weapon strength and rounded to 0.001 counts, so compare shapes.
  assert.ok(Math.abs(recorded[1][1] / recorded[0][1] - 2) < 1e-3 && Math.abs(recorded[2][1] / recorded[0][1] - 3) < 1e-3);
  assert.equal(await run('[document.querySelector("#multiplier-x").value, document.querySelector("#multiplier-y").value].join()'), '1,1');
  assert.equal(await run('document.querySelector("#wb-range-label").textContent'), 'All 3 shots');
  await run(`document.querySelector('[data-action="pattern-undo"]').click();`);
  assert.deepEqual(await shotValues(), beforeRecording);
  await run('state.runtime.recording = { active: false, firing: false, notice: null, supported: false, available: false, takes: [] }');
  const beforePosition = await shotValues();
  await run(`document.querySelector('[data-action="select-shot"][data-row="1"]').click(); document.querySelector('#shot-position-x').value='3'; document.querySelector('#shot-position-y').value='20'; document.querySelector('[data-action="apply-shot-position"]').click();`);
  await until(async () => await run('document.querySelector("#draft-summary").textContent.includes("total X")'), 'Position edit did not preview');
  const afterPosition = await shotValues();
  assert.deepEqual(afterPosition[0], beforePosition[0]);
  assert.notDeepEqual(afterPosition[1], beforePosition[1]);
  assert.ok(Math.abs(afterPosition[1][1] + afterPosition[2][1] - beforePosition[1][1] - beforePosition[2][1]) < 0.00001);
  assert.equal(await run('Number(document.querySelector("#shot-position-y").value)'), 20);
  await run(`document.querySelector('[data-action="pattern-undo"]').click();`);
  assert.deepEqual(await shotValues(), beforePosition);

  // Exercise real renderer pointer events, not a replacement implementation of drag.
  await until(async () => await run('!!document.querySelector("#draft-chart [data-point=\\"1\\"]")'), 'Shot handles did not appear');
  const point = await run(`(() => { const r=document.querySelector('#draft-chart [data-point="1"]').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  main.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  main.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  main.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 12, y: point.y + 8, button: 'left' });
  main.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 12, y: point.y + 8, button: 'left', clickCount: 1 });
  await until(async () => JSON.stringify(await shotValues()) !== JSON.stringify(beforePosition), 'Dragging a shot did not update its vectors');
  await run(`document.querySelector('[data-action="pattern-undo"]').click();`);
  assert.deepEqual(await shotValues(), beforePosition);

  await run(`document.querySelector('[data-action="timeline-shot"][data-row="1"]').click(); document.querySelector('[data-action="timeline-shot"][data-row="2"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));`);
  assert.equal(await run('document.querySelector("#wb-range-label").textContent'), 'Shots 2–3');
  const beforeFix = await shotValues();
  await run(`document.querySelector('#fix-step').value='0.1'; document.querySelector('#fix-step').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-action="fix-pattern"][data-fix="high"]').click();`);
  const afterFix = await shotValues();
  assert.deepEqual(afterFix[0], beforeFix[0]);
  assert.ok(Math.abs(afterFix[1][1] - beforeFix[1][1] * 1.1) < 0.00001 && Math.abs(afterFix[2][1] - beforeFix[2][1] * 1.1) < 0.00001);
  assert.equal(await run('document.querySelector("#wb-range-label").textContent'), 'Shots 2–3');
  await run(`document.querySelector('[data-action="close-dialog"]').click();`);
  assert.equal(await run('document.querySelector("#dialog").open'), true);
  assert.match(await run('document.querySelector(".wb-back").textContent'), /Discard changes/);
  await run(`document.querySelector('[data-action="pattern-undo"]').click();`);
  assert.deepEqual(await shotValues(), beforeFix);

  await run(`document.querySelector('#position-pairs').value='0, -10\\n2, -22\\n5, -35'; document.querySelector('#position-scale').value='2'; document.querySelector('[data-action="import-positions"]').click();`);
  assert.deepEqual(await shotValues(), [[0, 20], [-4, 24], [-6, 26]]);
  await run(`document.querySelector('#shape-from').value='2'; document.querySelector('#shape-to').value='3'; document.querySelector('#shape-x').value='-100'; document.querySelector('#shape-y').value='50'; document.querySelector('[data-action="shape-pattern"]').click();`);
  assert.deepEqual(await shotValues(), [[0, 20], [4, 12], [6, 13]]);
  await until(async () => await run('document.querySelector("#draft-summary").textContent.includes("total X")'), 'Authored preview did not update');
  fs.writeFileSync(path.join(root, 'artifacts/authored-pattern.png'), (await main.webContents.capturePage()).toPNG());
  await run(`document.querySelector('#modal-form').requestSubmit();`);
  await until(async () => await run('!document.querySelector("#dialog").open'), 'Authored pattern did not save');
  assert.deepEqual((await snapshot()).settings.games[1].weapons[1].profile.recoils[0].vectors, [[0, 20], [4, 12], [6, 13]]);
  const firstWeapon = (await snapshot()).settings.games[1].weapons[0].id;
  await hud.webContents.executeJavaScript(`document.querySelector('#previous-weapon').click();`);
  await until(async () => (await snapshot()).settings.games[1].selectedWeaponId === firstWeapon, 'HUD previous weapon did not select');
  await until(async () => await hud.webContents.executeJavaScript('!document.querySelector("#next-weapon").disabled'), 'HUD remained busy');
  await hud.webContents.executeJavaScript(`document.querySelector('#next-weapon').click();`);
  await until(async () => (await snapshot()).settings.games[1].selectedWeaponId !== firstWeapon, 'HUD next weapon did not select');
  assert.equal((await snapshot()).runtime.enabled, false);
  const finalSettings = JSON.parse(fs.readFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(finalSettings.games[1].bindings.toggle, 'num0');
  assert.deepEqual(finalSettings.games[1].weapons[1].profile.recoils[0].vectors, [[0, 20], [4, 12], [6, 13]]);
  console.log('PASS: isolated UI, persistence, authoring, draggable shots, guide conversion, per-game controls, calibration, and HUD switching.');
  console.log('Input remained disabled throughout.');
  app.quit();
})().catch(error => { console.error(error); app.exit(1); });
