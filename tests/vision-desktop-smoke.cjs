const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.tmp/vision-smoke'), { recursive: true });
process.env.RECOIL_TEST_DATA_DIR = fs.mkdtempSync(path.join(root, '.tmp/vision-smoke/run-'));
process.env.RECOIL_TEST_HEADLESS = '1';
// Substitute the physical mouse and pointer adapters. No OS input or permission changes in this test.
const mouseAdapter = require('../build/desktop/mouse-buttons');
let mouseInput, mouseHeld = false, mouseTimer;
mouseAdapter.mouseDevices = async () => [{path:'/dev/input/event0',name:'Synthetic test mouse',readable:true}];
mouseAdapter.MouseButtons = class {
  connected = false;
  constructor(input) { mouseInput = input; }
  async connect() { this.connected=true; mouseInput(false); mouseTimer=setInterval(()=>mouseInput(mouseHeld),80); }
  close() { this.connected=false; clearInterval(mouseTimer); }
};
mouseAdapter.allowMouseRead = async () => { throw new Error('Test must never request mouse permissions'); };
let pointerTarget;
const pointerMoves=[];
require('../build/desktop/portal-pointer').PortalPointer=class {
  profileReady=false;
  async connect(){this.profileReady=true;}
  async moveProfile(x,y,current){
    if(!current())return false;pointerMoves.push([x,y]);
    if(pointerTarget)await pointerTarget.webContents.executeJavaScript(`window.calibrationOffset[0]-=${x}*2;window.calibrationOffset[1]-=${y}*2;`);
    return true;
  }
  async disarm(){}
  close(){this.profileReady=false;}
};
require('../build/desktop/main');
setTimeout(() => { console.error('Vision desktop test timed out.'); app.exit(1); }, 90000).unref();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await delay(50); } throw new Error(message); }
(async () => {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length === 2, 'App windows missing');
  const main = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Recoil Control'), run = s => main.webContents.executeJavaScript(s);
  await until(async () => !main.webContents.isLoading() && await run('!!document.querySelector("[data-action=vision-lab]")'), 'Vision action missing');
  await run(`(async () => { const s=(await window.control.getState()).settings; const w=s.games[0].weapons[0]; w.profile={name:w.name,units:'counts',rpm:600,mode:'end',recoils:[{name:'Default',activate:[],multipliers:[1,1],vectors:Array.from({length:10},()=>[0,2])}]}; w.provenance='manual'; receive(await window.control.save(s)); document.querySelector('[data-action="vision-lab"]').click(); })()`);
  await until(() => BrowserWindow.getAllWindows().some(w => w.getTitle() === 'Vision lab'), 'Lab did not open');
  const lab = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Vision lab'), execute = async s => { try { return await lab.webContents.executeJavaScript(s); } catch (e) { throw new Error(s.slice(0,160) + ': ' + e.message); } }, errors = [];
  lab.webContents.on('console-message', e => { if (e.level === 'error') { errors.push(e.message); console.error('Renderer:',e.message); } });
  await until(async () => !lab.webContents.isLoading() && await execute('typeof context!=="undefined" && !!context'), 'Context missing');
  assert.match(await execute('document.querySelector("#context").textContent'), /Rust.*Assault Rifle.*Base/);
  // Produce an actual WebM clip of a textured scene translating down, with a static central reticle.
  // The UI must decode frames, crop, track, and propose the correct signed correction.
  await execute(`(async () => {
    const scene=document.createElement('canvas'); scene.width=640; scene.height=360;
    const ctx=scene.getContext('2d'), texture=document.createElement('canvas'); texture.width=640; texture.height=560;
    const tc=texture.getContext('2d'), pixels=tc.createImageData(640,560); let seed=32;
    for(let i=0;i<pixels.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0; pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=seed>>>24; pixels.data[i+3]=255;} tc.putImageData(pixels,0,0);
    const feed=scene.captureStream(0), track=feed.getVideoTracks()[0], chunks=[], recorder=new MediaRecorder(feed,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:8000000});
    const done=new Promise(resolve=>{recorder.onstop=()=>resolve(new Blob(chunks,{type:'video/webm'}));}); recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
    for(let i=0;i<46;i++){ctx.drawImage(texture,0,-100+i*2);ctx.strokeStyle='red';ctx.beginPath();ctx.moveTo(312,180);ctx.lineTo(328,180);ctx.moveTo(320,172);ctx.lineTo(320,188);ctx.stroke();track.requestFrame();await new Promise(r=>setTimeout(r,34));}
    recorder.stop();const clip=await done; feed.getTracks().forEach(t=>t.stop()); const transfer=new DataTransfer();transfer.items.add(new File([clip],'synthetic-burst.webm',{type:'video/webm'}));document.querySelector('#clip').files=transfer.files;document.querySelector('#clip').dispatchEvent(new Event('change'));
  })()`);
  await until(() => execute('video.ended && samples.length>20'), 'Synthetic clip did not decode');
  await execute(`document.querySelector('#shots').value='5'; document.querySelector('#phase').value='300'; document.querySelector('#calibrated').checked=true; document.querySelector('#analyze').click();`);
  await until(() => execute('!!proposal'), 'Analysis missing');
  const rows = await execute('proposal');
  assert.ok(rows.filter(r => r.valid).length >= 3, JSON.stringify(rows));
  assert.ok(rows.filter(r => r.valid).every(r => r.after[1] > r.before[1]), 'Downward scene drift must propose positive mouse correction with negative scene gain');
  await execute(`document.querySelector('#calibrated').checked=true;document.querySelector('#accept').click();`);
  await until(() => execute('!document.querySelector("#save").disabled'), 'Candidate not accepted');
  const beforeSave = await execute('candidate'); assert.equal(beforeSave.length, 10); assert.deepEqual(beforeSave.slice(5), Array.from({ length: 5 }, () => [0, 2]));
  await execute(`document.querySelector('#undo').click();`); await until(() => execute('document.querySelector("#save").disabled'), 'Undo failed');
  // Reopen the same fixture clip for a new analysis; accepting clears the old observations.
  await execute(`document.querySelector('#clip').dispatchEvent(new Event('change'));`);
  await until(() => execute('video.ended && samples.length>20'), 'Second clip did not finish');
  await execute(`document.querySelector('#analyze').click();`); await until(() => execute('!!proposal'), 'Second analysis missing');
  await execute(`document.querySelector('#calibrated').checked=true;document.querySelector('#accept').click();`); await until(() => execute('!document.querySelector("#save").disabled'), 'Second accept failed');
  await execute(`document.querySelector('#save').click();`); await until(() => execute('document.querySelector("#lab-status").textContent.includes("saved to this setup")'), 'Save failed');
  const saved = await run('window.control.getState().then(s=>s.settings.games[0].weapons[0].profile)');
  assert.ok(saved.recoils[0].vectors.slice(0,5).some(v=>v[1]>2)); assert.deepEqual(saved.recoils[0].vectors.slice(5), Array.from({length:5},()=>[0,2]));
  // Reproduce a new weapon with only one seed vector: it must allow a full recording target.
  await run(`(async()=>{const s=(await window.control.getState()).settings; s.games[0].weapons[0].profile.recoils[0].vectors=[[0,2]];receive(await window.control.save(s));})()`);
  await execute(`document.querySelector('#reload').click();`);
  await until(()=>execute('candidate.length===1 && document.querySelector("#shots").value==="30"'),'Starter profile did not default to a 30-shot recording');
  assert.equal(await execute('document.querySelector("#shots").max'),'120');
  await execute(`document.querySelector('#shots').value='5'; document.querySelector('#phase').value='300'; document.querySelector('#clip').dispatchEvent(new Event('change'));`);
  await until(()=>execute('video.ended && samples.length>20'),'Starter clip did not decode');
  await execute(`document.querySelector('#analyze').click();`); await until(()=>execute('!!proposal'),'Starter analysis missing');
  assert.ok(await execute('proposal.slice(1).some(row=>row.valid)'), 'must measure shots beyond the seed vector');
  await execute(`document.querySelector('#calibrated').checked=true;document.querySelector('#accept').click();`); await until(()=>execute('candidate.length>1'),'Starter candidate did not grow');
  await execute(`document.querySelector('#save').click();`); await until(()=>execute('document.querySelector("#lab-status").textContent.includes("saved to this setup")'),'Extended candidate did not save');
  assert.ok((await run('window.control.getState().then(s=>s.settings.games[0].weapons[0].profile.recoils[0].vectors.length)'))>1);
  // Run the default path with live synthetic capture, without starting any link/server.
  assert.equal(await execute('document.querySelector("#trigger").value'), 'countdown');
  assert.equal(await execute('document.querySelector("#simulator-options").hidden'), true);
  assert.equal(await execute('document.querySelector("#link-url").value'), '');
  await execute(`(async () => {
    stopCapture(); clearTrace(); clipMode=false;
    const scene=document.createElement('canvas');scene.width=640;scene.height=360;const ctx=scene.getContext('2d');
    ctx.fillRect(0,0,640,360);stream=scene.captureStream(30);video.srcObject=stream;
    window.liveFixture=setInterval(()=>{ctx.fillStyle=Math.random()>.5?'#333':'#555';ctx.fillRect(0,0,640,360);},30);
    await video.play();watchFrames(); document.querySelector('.lab-preview').hidden=true;
    document.querySelector('#countdown').value='3';document.querySelector('#shots').value='1';
  })()`);
  await until(() => execute('samples.length>3'), 'Live fixture frames missing');
  await execute(`document.querySelector('#mouse-list').click();`);
  await until(() => execute('document.querySelector("#mouse-device").options.length===1'), 'Mouse list missing');
  await execute(`document.querySelector('#mouse-connect').click();`);
  await until(() => execute('document.querySelector("#mouse-status").textContent.includes("Listening")'), 'Mouse did not connect');
  await execute(`document.querySelector('#arm').click();`);
  await until(() => execute('document.querySelector("#lab-status").textContent.includes("waiting for left mouse")'), 'Countdown did not arm');
  assert.equal(await execute('!!activeTake'),false);
  mouseHeld=true; mouseInput(true);
  await until(() => execute('!!activeTake'), 'Mouse hold did not start a take');
  await delay(850);
  assert.equal(await execute('!!activeTake'),true, '100 ms of pattern coverage must not end the recording');
  assert.match(await execute('document.querySelector("#lab-status").textContent'),/Still recording/);
  mouseHeld=false; mouseInput(false);
  await until(() => execute('!!take && !activeTake'), 'Direct take did not finish');
  assert.equal(await execute('take.reason'), 'Fire released.');
  assert.equal(await execute('stream.active'),true, 'ending a take must keep screen capture running');
  assert.ok(await execute('take.samples.length>15'),'hidden preview must still supply capture frames');
  await execute(`document.querySelector('#analyze').click();`); await until(()=>execute('!!proposal'),'Live analysis missing');
  assert.match(await execute('document.querySelector("#diagnostics").textContent'),/texture/);
  await until(()=>fs.existsSync(path.join(process.env.RECOIL_TEST_DATA_DIR,'vision-diagnostics.json')),'Diagnostic file missing');
  const report=JSON.parse(fs.readFileSync(path.join(process.env.RECOIL_TEST_DATA_DIR,'vision-diagnostics.json'),'utf8'));
  assert.ok(report.capture.frames>0);
  await execute(`document.querySelector('.lab-preview').hidden=false;`);
  assert.equal(await execute('take.config.trigger'), 'countdown');
  assert.equal(await execute('document.querySelector("#link-url").value'), '');
  await execute(`document.querySelector('#mouse-device').scrollIntoView({block:'start'});`); await delay(60);
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  fs.writeFileSync(path.join(root,'artifacts/vision-lab-input.png'),(await lab.webContents.capturePage()).toPNG());
  // Cancel a second countdown through the user-facing Stop button.
  await execute(`document.querySelector('#arm').click();`);
  await until(() => execute('document.querySelector("#lab-status").textContent.includes("Starting in")'), 'Second countdown missing');
  await execute(`document.querySelector('#stop').click();`); await delay(3200);
  assert.equal(await execute('!!activeTake'),false);
  // Exercise the calibration button through real capture and CV, with only output substituted.
  const candidateBeforeCalibration=await execute('candidate');
  await execute(`(async()=>{
    clearInterval(window.liveFixture);stopCapture();clearTrace();clipMode=false;
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d'),texture=document.createElement('canvas');texture.width=800;texture.height=500;
    const tc=texture.getContext('2d'),pixels=tc.createImageData(800,500);let seed=99;
    for(let i=0;i<pixels.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=seed>>>24;pixels.data[i+3]=255;}tc.putImageData(pixels,0,0);
    window.calibrationOffset=[0,0];
    const draw=()=>ctx.drawImage(texture,-80+window.calibrationOffset[0],-70+window.calibrationOffset[1]);draw();
    stream=canvas.captureStream(60);video.srcObject=stream;window.liveFixture=setInterval(draw,16);await video.play();watchFrames();
    document.querySelector('#pointer').click();
  })()`);
  pointerTarget=lab;
  await until(()=>execute('samples.length>5 && document.querySelector("#pointer-status").textContent.includes("connected")'),'Calibration capture or pointer missing');
  await execute(`document.querySelector('#calibrate').click();`);
  await until(()=>execute('document.querySelector("#lab-status").textContent.includes("Calibration applied")'),'Calibration did not apply').catch(async error=>{throw new Error(error.message+': '+await execute('document.querySelector("#lab-status").textContent'));});
  const scales=await execute('[Number(document.querySelector("#scale-x").value),Number(document.querySelector("#scale-y").value)]');
  for(const scale of scales)assert.ok(Math.abs(scale+2)<.15,JSON.stringify(scales));
  assert.equal(await execute('document.querySelector("#calibrated").checked'),true);
  assert.equal(await execute('document.querySelector("#mode").value'),'pointer');
  assert.deepEqual(await execute('candidate'),candidateBeforeCalibration);
  assert.equal(pointerMoves.length,48);assert.deepEqual(pointerMoves.reduce((a,b)=>a.map((v,i)=>v+b[i]),[0,0]),[0,0]);
  await execute(`document.querySelector('#calibrate').scrollIntoView({block:'center'});`);await delay(80);
  fs.writeFileSync(path.join(root,'artifacts/vision-lab-calibration.png'),(await lab.webContents.capturePage()).toPNG());
  // A cancelled retry preserves previous values and sends no further movement.
  await execute(`document.querySelector('#calibrate').click();`);
  await until(()=>execute('document.querySelector("#lab-status").textContent.includes("Calibration in")'),'Calibration retry countdown missing');
  await execute(`document.querySelector('#stop').click();`);
  await until(()=>execute('!preparing'),'Calibration cancellation did not settle');
  assert.deepEqual(await execute('[Number(document.querySelector("#scale-x").value),Number(document.querySelector("#scale-y").value)]'),scales);
  assert.equal(pointerMoves.length,48);assert.equal(await execute('document.querySelector("#calibrated").checked'),false);
  await execute(`clearInterval(window.liveFixture);stopCapture(); document.querySelector('#trigger').value='simulator';document.querySelector('#trigger').dispatchEvent(new Event('change'));`);
  await until(() => execute('!document.querySelector("#simulator-options").hidden'), 'Optional link controls missing');
  await execute(`document.querySelector('#link').click();`); await until(() => execute('document.querySelector("#link-url").value.startsWith("http")'), 'Link missing');
  const url = new URL(await execute('document.querySelector("#link-url").value'));
  url.pathname='/events'; const abort = new AbortController(); const events = await fetch(url,{signal:abort.signal}); assert.equal(events.status,200); const reader=events.body.getReader(); const first=await reader.read(); assert.match(new TextDecoder().decode(first.value),/ready/);
  url.pathname='/input';assert.equal((await fetch(url,{method:'POST',body:'{"firing":false}'})).status,200);
  // The HUD cannot reach the lab-only bridge.
  const hud=BrowserWindow.getAllWindows().find(w=>w!==main&&w!==lab); assert.equal(await hud.webContents.executeJavaScript('typeof window.vision'), 'undefined');
  await execute(`document.querySelector('#analyze').click();`); await delay(80);
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/vision-lab.png'),(await lab.webContents.capturePage()).toPNG());
  assert.equal(await execute('document.documentElement.scrollWidth>window.innerWidth'),false);
  const port=url.port; abort.abort(); lab.destroy(); await delay(100);
  await assert.rejects(fetch('http://127.0.0.1:'+port+'/'));
  assert.deepEqual(errors,[]); assert.equal((await run('window.control.getState()')).runtime.enabled,false);
  console.log('Vision lab: real WebM decode, masked CV, drift proposals, partial coverage, undo/save, starter-pattern expansion, countdown-to-armed, hold beyond pattern end, release, persistent capture, cancellation, optional simulator link, guided signed-scale calibration, cancellation, and cleanup passed with mocked pointer output only.'); app.exit(0);
})().catch(error=>{console.error(error);app.exit(1);});
