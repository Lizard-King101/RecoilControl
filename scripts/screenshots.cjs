// Documentation captures from an isolated app, with no USB auto-connect or live output.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { defaultSettings } = require('../build/desktop/settings');
const runs = path.join(root, '.tmp/screenshots');
fs.mkdirSync(runs, { recursive: true });
process.env.RECOIL_TEST_DATA_DIR = fs.mkdtempSync(path.join(runs, 'run-'));
process.env.RECOIL_TEST_HEADLESS = '1';
const settings = defaultSettings();
settings.output = 'bluetooth';
fs.writeFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR, 'settings.json'), JSON.stringify(settings));
require('../build/desktop/main');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}

(async () => {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().some(w => w.getTitle() === 'Recoil Control'), 'Main window did not open');
  const main = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Recoil Control');
  main.setContentSize(1440, 1000);
  const run = script => main.webContents.executeJavaScript(script);
  await until(async () => !main.webContents.isLoading()
    && await run('document.querySelectorAll(".weapon-row").length === 6 && !!document.querySelector("#chart svg path")'), 'Loadout did not render');
  await run('document.fonts.ready');
  await until(async () => await run('state.runtime.output === "bluetooth" && state.runtime.tuning.stances.length === 4'), 'Bluetooth input setup did not settle');
  if (await run('state.runtime.enabled || state.board.connected || !!state.runtime.error')) throw new Error('Expected disabled, disconnected hardware without an input error');
  const output = path.join(root, 'docs/images');
  fs.mkdirSync(output, { recursive: true });
  async function capture(name) {
    // Allow offscreen paint to catch up to the DOM and fonts.
    await delay(300);
    fs.writeFileSync(path.join(output, name), (await main.webContents.capturePage()).toPNG());
  }
  await capture('loadout.png');
  await run('document.querySelector(\'[data-action="edit-pattern"]\').click()');
  await until(async () => await run('!!document.querySelector("#draft-chart [data-point]")'), 'Pattern workshop did not render');
  await capture('pattern-workshop.png');
  console.log('Saved docs/images/loadout.png and pattern-workshop.png using isolated defaults; hardware stayed disconnected.');
  app.quit();
})().catch(error => { console.error(error); app.exit(1); });
