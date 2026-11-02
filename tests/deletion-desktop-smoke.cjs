const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'.tmp/deletion-smoke'),{recursive:true});
process.env.RECOIL_TEST_DATA_DIR=fs.mkdtempSync(path.join(root,'.tmp/deletion-smoke/run-'));process.env.RECOIL_TEST_HEADLESS='1';
require('../build/desktop/main');const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await delay(40);}throw new Error(message);}
setTimeout(()=>{console.error('Deletion smoke timeout');app.exit(1);},60000).unref();
(async()=>{
 await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length===2,'Windows missing');
 const main=BrowserWindow.getAllWindows().find(w=>w.getTitle()==='Recoil Control'),hud=BrowserWindow.getAllWindows().find(w=>w!==main),run=s=>main.webContents.executeJavaScript(s),errors=[];
 for(const w of [main,hud])w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 await until(async()=>!main.webContents.isLoading()&&await run('typeof state!=="undefined" && !!state'),'App not ready');
 const listing=await run(`(async()=>api.libraryPublish(await api.libraryDraft({title:'Saved community fixture',author:'Tester',release:'1.0',description:'Preserve while deleting local games.',gameVersion:'',tags:[]})))()`);
 await run(`document.querySelector('[data-action="delete-weapon"]').click();`);
 assert.match(await run('document.querySelector("#dialog").textContent'),/Assault Rifle/);
 await run(`document.querySelector('#modal-form [data-action="close-dialog"]').click();`);assert.equal(await run('state.settings.games[0].weapons.length'),6);
 // A changed target must be reviewed again, never silently deleted.
 await run(`document.querySelector('[data-action="delete-weapon"]').click();(async()=>{const next=structuredClone(state.settings);next.games[0].weapons[0].name='Updated rifle';receive(await api.save(next));})()`);
 await until(()=>run('current().weapon.name==="Updated rifle"'),'Rename missing');await run(`document.querySelector('#modal-form').requestSubmit();`);
 await until(()=>run('document.querySelector("#dialog-error").textContent.includes("changed")'),'Stale confirmation not rejected');assert.equal(await run('state.settings.games[0].weapons.length'),6);
 await run(`document.querySelector('#modal-form [data-action="close-dialog"]').click();`);
 for(let count=6;count>0;count--){await run(`document.querySelector('[data-action="delete-weapon"]').click();document.querySelector('#modal-form').requestSubmit();`);await until(()=>run(`state.settings.games[0].weapons.length===${count-1} && !document.querySelector('#dialog').open`),'Weapon delete failed');}
 assert.match(await run('document.querySelector("#content").textContent'),/Add your first weapon/);assert.equal(await run('document.querySelector("#enable-toggle").disabled'),true);
 await until(()=>hud.webContents.executeJavaScript('document.querySelector("#hud-weapon").textContent==="No weapon selected"'),'HUD did not clear weapon');
 fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/deletion-empty-weapons.png'),(await main.webContents.capturePage()).toPNG());
 // An empty collection remains usable for controls and adding a weapon.
 await run(`document.querySelector('[data-view="controls"]').click();`);assert.equal(await run('!!document.querySelector("#controls-form")'),true);
 await run(`document.querySelector('[data-view="arsenal"]').click();document.querySelector('[data-action="new-weapon"]').click();document.querySelector('#weapon-name').value='Replacement';document.querySelector('#modal-form').requestSubmit();`);
 await until(()=>run('state.settings.games[0].weapons.length===1 && !!document.querySelector("#pattern-name")'),'Adding to empty collection failed');
 await run(`document.querySelector('[data-action="close-dialog"]').click();`);await until(()=>run('!document.querySelector("#dialog").open'),'Pattern did not close');
 await run(`document.querySelector('[data-action="delete-game"]').click();`);
 assert.equal(await run('document.querySelector("#dialog").open && document.querySelector("#modal-form").dataset.submit === "delete-game"'),true);
 await delay(150);fs.writeFileSync(path.join(root,'artifacts/deletion-confirm.png'),(await main.webContents.capturePage()).toPNG());
 await run(`document.querySelector('#modal-form').requestSubmit();`);await until(()=>run('state.settings.games.length===0 && !document.querySelector("#dialog").open'),'Last game delete failed');
 assert.match(await run('document.querySelector("#content").textContent'),/No games yet/);assert.equal(await run('document.querySelectorAll(".game-item").length'),0);
 assert.equal((await run('api.libraryList()')).packs.length,1,'deletion must preserve published packs');
 main.webContents.reload();await until(async()=>!main.webContents.isLoading()&&await run('typeof state!=="undefined" && !!state && state.settings.games.length===0'),'Empty state did not persist');
 for(const v of ['controls','input','hud','board','arsenal']){await run(`document.querySelector('[data-view="${v}"]').click();`);assert.equal(await run('!!document.querySelector("#content")'),true);}
 await delay(80);fs.writeFileSync(path.join(root,'artifacts/deletion-empty-games.png'),(await main.webContents.capturePage()).toPNG());
 // Community installation works when there are no games, and also restores the HUD.
 await run(`document.querySelector('[data-view="community"]').click();`);await until(()=>run('community.loaded'),'Community missing');
 await run(`document.querySelector('.community-card').click();`);await until(()=>run('!!community.detail'),'Pack detail missing');
 await run(`document.querySelector('[data-action="community-install"]').click();document.querySelector('#modal-form').requestSubmit();`);await until(()=>run('state.settings.games.length===1 && !document.querySelector("#dialog").open'),'Install into empty app failed');
 assert.equal(await run('state.settings.games[0].weapons.length'),6);assert.equal((await run('api.libraryDetail('+JSON.stringify(listing.id)+')')).id,listing.id);
 assert.equal(await run('state.runtime.enabled'),false);assert.deepEqual(errors,[]);
 console.log('Deletion: confirmation/cancel, stale-target protection, all weapons, last game, empty-state reload/HUD, recreation and preserved community packs passed.');app.exit(0);
})().catch(e=>{console.error(e);app.exit(1);});
