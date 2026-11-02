const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
fs.mkdirSync(path.join(root,'.tmp/navigation-smoke'),{recursive:true});
process.env.RECOIL_TEST_DATA_DIR = fs.mkdtempSync(path.join(root,'.tmp/navigation-smoke/run-'));
process.env.RECOIL_TEST_HEADLESS = '1';
require('../build/desktop/main');
const delay = ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message) { const deadline=Date.now()+10000; while(Date.now()<deadline){if(await check())return;await delay(40);}throw new Error(message); }
(async()=>{
  await app.whenReady();
  await until(()=>BrowserWindow.getAllWindows().length===2,'Windows missing');
  const main=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Recoil Control');
  const errors=[]; main.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const run=s=>main.webContents.executeJavaScript(s), snap=()=>run('window.control.getState()');
  await until(async()=>!main.webContents.isLoading() && await run('document.querySelectorAll(".weapon-row").length===6'),'Loadout missing');
  assert.deepEqual(await run('[...document.querySelectorAll(".main-nav [data-view]")].map(b=>b.dataset.view)'),['arsenal','controls','community']);
  assert.equal(await run('document.querySelector("#game-list [aria-current]").dataset.game'),'rust');
  assert.equal(await run('!!document.querySelector("#game-select")'),false);
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  await delay(100); fs.writeFileSync(path.join(root,'artifacts/navigation-loadout.png'),(await main.webContents.capturePage()).toPNG());
  for(const [view,element] of [['input','#input-form'],['board','#board-port'],['hud','#hud-visible']]){
    await run(`document.querySelector('#settings-button').click(); document.querySelector('#settings-options [data-view="${view}"]').click();`);
    assert.equal(await run(`!!document.querySelector('${element}')`),true);
    assert.equal(await run('document.querySelector("#settings-options").hidden'),true);
    assert.equal(await run('document.querySelector("#settings-button").classList.contains("active")'),true);
    if(view==='input')assert.equal(await run('!!document.querySelector("#board-port") || !!document.querySelector("#output-device")'),false);
  }
  await run(`document.querySelector('[data-view="controls"]').click();`);
  assert.equal(await run('document.querySelectorAll(".shortcut-picker select").length'),0);
  await run(`document.querySelector('#binding-toggle-key').click(); document.dispatchEvent(new MouseEvent('pointerdown',{button:3,bubbles:true,cancelable:true})); document.dispatchEvent(new MouseEvent('auxclick',{button:3,bubbles:true,cancelable:true}));`);
  assert.equal(await run('document.querySelector("#binding-toggle-key").value'),'mouse4');
  // Let the side-button click guard expire before a separate UI action.
  await delay(750);
  await run(`document.querySelector('#activation-mode').value='hold'; document.querySelector('#weapon-key-0-key').click(); document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyK',key:'k',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); document.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyK',key:'k',bubbles:true,cancelable:true}));`);
  assert.equal(await run('document.querySelector("#weapon-key-0-key").value'),'ctrl+shift+keyk');
  await run(`document.querySelector('#binding-pause').click(); document.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true,cancelable:true})); document.dispatchEvent(new KeyboardEvent('keyup',{code:'Escape',key:'Escape',bubbles:true,cancelable:true}));`);
  assert.equal(await run('document.querySelector("#binding-pause").value'),'shift');
  await run(`document.querySelector('#stance-key-crouching').click(); document.dispatchEvent(new KeyboardEvent('keydown',{code:'ControlRight',key:'Control',ctrlKey:true,bubbles:true,cancelable:true})); document.dispatchEvent(new KeyboardEvent('keyup',{code:'ControlRight',key:'Control',bubbles:true,cancelable:true}));`);
  assert.equal(await run('document.querySelector("#stance-key-crouching").value'),'control');
  await run(`document.querySelector('#controls-form').requestSubmit();`);
  await until(async()=>{const b=(await snap()).settings.games[0].bindings;return b.toggle==='mouse4' && b.activationMode==='hold';},'Bindings not saved');
  assert.equal((await snap()).settings.games[0].weapons[0].hotkey,'ctrl+shift+keyk');
  assert.match(await run('document.querySelector("#footer-keys").textContent'),/Mouse 4.*Hold to enable/);
  await run(`document.querySelector('#toast').hidden=true; document.querySelector('#content').scrollTop=0;`);
  await delay(100); fs.writeFileSync(path.join(root,'artifacts/navigation-controls.png'),(await main.webContents.capturePage()).toPNG());
  // Reserved fire/ADS cannot accidentally become an activation binding.
  await run(`document.querySelector('#binding-toggle-key').click(); document.dispatchEvent(new MouseEvent('pointerdown',{button:2,bubbles:true,cancelable:true})); document.dispatchEvent(new MouseEvent('contextmenu',{button:2,bubbles:true,cancelable:true}));`);
  assert.equal(await run('document.querySelector("#binding-toggle-key").value'),'mouse4');
  assert.match(await run('document.querySelector("#binding-hint").textContent'),/reserved/);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',bubbles:true,cancelable:true}));`); await delay(750);
  await run(`document.querySelector('#new-game').click(); document.querySelector('#game-name').value='Second game'; document.querySelector('#first-weapon').value='Second rifle'; document.querySelector('#modal-form').requestSubmit();`);
  await until(async()=>(await snap()).settings.games.length===2 && await run('!document.querySelector("#dialog").open'),'Game not created');
  assert.equal(await run('document.querySelectorAll("#game-list .game-item").length'),2);
  assert.equal((await snap()).settings.games[1].bindings.activationMode,'toggle');
  await run(`document.querySelector('[data-game="rust"]').click();`);
  await until(async()=>(await snap()).settings.selectedGameId==='rust','Game did not switch');
  await run(`document.querySelector('[data-view="controls"]').click(); document.querySelector('[data-clear-binding="weapon-key-0-key"]').click();`);
  assert.equal(await run('document.querySelector("#weapon-key-0-key").value'),'');
  // Discard the unsaved clear by reloading: the saved binding must be restored.
  main.webContents.reload();
  await until(async()=>!main.webContents.isLoading() && await run('typeof state !== "undefined" && !!state'),'Reload failed');
  await run(`document.querySelector('[data-view="controls"]').click();`);
  assert.equal(await run('document.querySelector("#binding-toggle-key").value'),'mouse4');
  assert.equal(await run('document.querySelector("#activation-mode").value'),'hold');
  assert.equal(await run('document.querySelector("#weapon-key-0-key").value'),'ctrl+shift+keyk');
  main.setSize(1000,760); await delay(100);
  assert.equal(await run('document.documentElement.scrollWidth > window.innerWidth'),false);
  fs.writeFileSync(path.join(root,'artifacts/navigation-compact.png'),(await main.webContents.capturePage()).toPNG());
  assert.equal((await snap()).runtime.enabled,false); assert.equal((await snap()).board.connected,false);
  assert.deepEqual(errors,[]);
  console.log('Sidebar, settings pages, keyboard/mouse recording, cancellation, per-game activation modes, and persistence passed without hardware.');
  app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
