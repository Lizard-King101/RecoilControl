const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {defaultSettings,effectiveProfile}=require('../build/desktop/settings');
const {createGamePack,validateGamePack,installGamePack,maxPackageBytes}=require('../build/community/package');
const {FilePackRepository}=require('../build/community/repository');
const {startLibraryService,libraryRequest}=require('../build/community/service');
const metadata={title:'Range pack',author:'Range tester',release:'1.0.0',gameVersion:'Dev build',description:'Synthetic test fixture.',tags:['Rifles','rifles','practice']};
function settingsFixture(){
 const s=defaultSettings(),g=s.games[0],w=g.weapons[0];g.stances.push({id:'prone',name:'Prone'});g.input={dpi:1200,sensitivity:2,adsMultiplier:2};
 w.profile={name:'Rifle',units:'counts',rpm:600,mode:'end',recoils:[{name:'Default',activate:[],multipliers:[.5,1],vectors:[[2,4],[3,5]]},{name:'Prone ADS',activate:['prone','aiming'],multipliers:[1,1],vectors:[[1,2]]}]};
 w.hotkey='keyk';w.tuning={x:2,y:1.5};w.calibration={dpi:800,sensitivity:1,adsMultiplier:1,at:'2026-01-01T00:00:00Z'};w.provenance='calibrated';
 w.setups=[{id:'optic',name:'Scoped',attachments:[{slot:'optic',name:'4x'}],profile:structuredClone(w.profile),tuning:{x:1,y:2},calibration:null,provenance:'manual'}];
 return s;
}
test('game packs preserve effective vectors, variants and dynamic stances without personal bindings',()=>{
 const s=settingsFixture(),original=structuredClone(s),pack=createGamePack(s,metadata);
 assert.deepEqual(s,original);assert.equal(pack.format,'recoil-control/game-pack-v1');assert.equal(pack.game.bindings,undefined);
 assert.equal(pack.game.weapons[0].hotkey,null);assert.equal(pack.game.weapons[0].calibration,null);assert.equal(pack.game.weapons[0].provenance,'manual');
 assert.deepEqual(pack.game.weapons[0].profile.recoils[0].vectors,[[1,3],[1.5,3.75]]);assert.deepEqual(pack.game.weapons[0].profile.recoils[1].vectors,[[.5,.75]]);
 assert.deepEqual(pack.game.weapons[0].setups[0].profile.recoils[0].vectors,[[1,8],[1.5,10]]);
 assert.deepEqual(pack.tags,['rifles','practice']);assert.ok(pack.game.stances.some(s=>s.id==='prone'));
 const installed=installGamePack(s,pack);assert.equal(installed.games.length,2);assert.deepEqual(installed.games[0],s.games[0]);
 const game=installed.games[1];assert.equal(game.name,'Rust (2)');assert.notEqual(game.id,s.games[0].id);assert.notEqual(game.weapons[0].id,s.games[0].weapons[0].id);
 assert.equal(game.bindings.stances.find(s=>s.id==='prone').key,null);assert.deepEqual(effectiveProfile(installed).recoils[0].vectors,pack.game.weapons[0].profile.recoils[0].vectors);
 assert.equal(installGamePack(installed,pack).games[2].name,'Rust (3)');
});
test('legacy exports become equivalent counts and empty or malformed packs are rejected',()=>{
 const s=defaultSettings(),source=effectiveProfile(s),pack=createGamePack(s,metadata),target=pack.game.weapons[0].profile;
 assert.equal(target.units,'counts');assert.equal(target.recoils[0].vectors[0][1],source.recoils[0].vectors[0][1]*source.recoils[0].multipliers[1]*180000/source.rpm);
 assert.throws(()=>validateGamePack({...pack,format:'future'}),/Unsupported/);
 assert.throws(()=>createGamePack(s,{...metadata,tags:Array(9).fill('a')}),/eight/);
 const bad=structuredClone(pack);bad.game.weapons[0].profile.recoils[0].vectors[0][0]=Infinity;assert.throws(()=>validateGamePack(bad),/Vector/);
 for(const w of s.games[0].weapons){w.profile=null;w.provenance='template';}assert.throws(()=>createGamePack(s,metadata),/at least one/);
 assert.throws(()=>validateGamePack({...pack,description:'x'.repeat(maxPackageBytes)}),/2 MB/);
});
test('hand-authored packs cannot import bindings or claim local calibration',()=>{
 const pack=createGamePack(settingsFixture(),metadata);pack.game.bindings={toggle:'mouse4'};pack.game.weapons[0].hotkey='keya';pack.game.weapons[0].calibration={private:'data'};pack.game.weapons[0].provenance='calibrated';
 const clean=validateGamePack(pack);assert.equal(clean.game.bindings,undefined);assert.equal(clean.game.weapons[0].hotkey,null);assert.equal(clean.game.weapons[0].calibration,null);
});
test('library HTTP round trip persists immutable packs, deduplicates and validates requests',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recoil-community-'));const repo=new FilePackRepository(dir),service=await startLibraryService(repo);
 try{
  const pack=createGamePack(settingsFixture(),metadata);
  assert.deepEqual((await libraryRequest(service,'/v1/packs')).packs,[]);
  assert.equal((await fetch(service.url+'/v1/packs')).status,403);
  assert.equal((await fetch(service.url+'/v1/packs',{headers:{Authorization:'Bearer '+service.token,Origin:'https://example.com'}})).status,403);
  const [a,b]=await Promise.all([libraryRequest(service,'/v1/packs','POST',pack),libraryRequest(service,'/v1/packs','POST',pack)]);assert.equal(a.id,b.id);
  const summary=(await libraryRequest(service,'/v1/packs')).packs;assert.equal(summary.length,1);assert.equal(summary[0].setups,1);assert.equal(summary[0].game,'Rust');
  assert.deepEqual((await libraryRequest(service,'/v1/packs/'+a.id)).pack,pack);
  assert.deepEqual((await new FilePackRepository(dir).get(a.id)).pack,pack);
  await assert.rejects(libraryRequest(service,'/v1/packs','POST',{...pack,format:'broken'}),/Unsupported/);
  await assert.rejects(libraryRequest(service,'/v1/packs/../../settings'),/Invalid/);
  await assert.rejects(libraryRequest(service,'/v1/packs','POST',{...pack,description:'x'.repeat(maxPackageBytes)}),/2 MB/);
  await libraryRequest(service,'/v1/packs/'+a.id,'DELETE');assert.equal((await libraryRequest(service,'/v1/packs')).packs.length,0);
  await assert.rejects(libraryRequest(service,'/v1/packs/'+a.id),/not found/);
 }finally{service.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('repository refuses modified content and never reads path traversal IDs',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recoil-community-')),repo=new FilePackRepository(dir);
 try{const row=await repo.publish(createGamePack(settingsFixture(),metadata));row.pack.title='Modified';fs.writeFileSync(path.join(dir,row.id+'.json'),JSON.stringify(row));await assert.rejects(repo.get(row.id),/failed validation/);await assert.rejects(repo.get('../settings'),/Invalid/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
