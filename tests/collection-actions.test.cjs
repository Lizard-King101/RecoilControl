const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {defaultSettings,validateSettings,selected,effectiveProfile,SettingsStore}=require('../build/desktop/settings');
const {deleteCollection}=require('../build/desktop/collection-actions');
const {createGamePack,installGamePack}=require('../build/community/package');
const {importWeapon}=require('../build/desktop/profile-sharing');
const request=(s,kind,gameIndex=0,weaponIndex=0)=>({gameId:s.games[gameIndex].id,...(kind==='weapon'?{weaponId:s.games[gameIndex].weapons[weaponIndex].id}:{}),expected:JSON.stringify(kind==='game'?s.games[gameIndex]:s.games[gameIndex].weapons[weaponIndex])});
test('weapon deletion removes all variants, preserves siblings, and selects the adjacent weapon',()=>{
 const s=defaultSettings(),g=s.games[0],w=g.weapons[0];w.setups=[{id:'optic',name:'Optic',attachments:[],profile:structuredClone(w.profile),provenance:'manual',tuning:{x:1,y:1},calibration:null}];
 const original=structuredClone(s),next=deleteCollection(s,'weapon',request(s,'weapon'));
 assert.deepEqual(s,original);assert.deepEqual(next.games[0].weapons,g.weapons.slice(1));assert.equal(next.games[0].selectedWeaponId,g.weapons[1].id);
 const other=deleteCollection(s,'weapon',request(s,'weapon',0,2));assert.equal(other.games[0].selectedWeaponId,w.id);
 const last=structuredClone(s);last.games[0].selectedWeaponId=g.weapons.at(-1).id;assert.equal(deleteCollection(last,'weapon',request(last,'weapon',0,5)).games[0].selectedWeaponId,g.weapons[4].id);
});
test('game deletion preserves unrelated collections and works for selected or unselected games',()=>{
 const s=defaultSettings();s.games.push({...structuredClone(s.games[0]),id:'second',name:'Second'});
 const next=deleteCollection(s,'game',request(s,'game'));assert.deepEqual(next.games,[s.games[1]]);assert.equal(next.selectedGameId,'second');
 const other=deleteCollection(s,'game',request(s,'game',1));assert.equal(other.selectedGameId,'rust');assert.deepEqual(other.games,[s.games[0]]);
});
test('stale confirmations cannot delete changed, renamed or missing targets',()=>{
 const s=defaultSettings(),r=request(s,'weapon');s.games[0].weapons[0].name='Changed';assert.throws(()=>deleteCollection(s,'weapon',r),/changed/);
 const gameRequest=request(s,'game');s.games[0].input.sensitivity=2;assert.throws(()=>deleteCollection(s,'game',gameRequest),/changed/);
 assert.throws(()=>deleteCollection(s,'game',{...gameRequest,gameId:'missing'}),/already removed/);
 assert.throws(()=>deleteCollection(s,'weapon',{...r,weaponId:'missing'}),/already removed/);
 assert.throws(()=>deleteCollection(s,'weapon',{}),/Choose/);
});
test('last weapon and game can be removed, remain empty on disk, and accept new community collections',()=>{
 let s=defaultSettings();const pack=createGamePack(s,{title:'Backup',author:'Tester',release:'1',gameVersion:'',description:'Backup fixture',tags:[]});
 const originalControls=structuredClone(s.games[0].bindings);
 while(s.games[0].weapons.length)s=deleteCollection(s,'weapon',request(s,'weapon'));
 assert.deepEqual(s.games[0].weapons,[]);assert.equal(s.games[0].selectedWeaponId,'');assert.deepEqual(s.games[0].bindings,originalControls);
 assert.equal(effectiveProfile(s),null);assert.equal(selected(s).weapon.id,'');
 s=deleteCollection(s,'game',request(s,'game'));assert.deepEqual(s.games,[]);assert.equal(s.selectedGameId,'');assert.equal(effectiveProfile(s),null);
 const before=JSON.stringify(s);selected(s).game.name='Not persisted';assert.equal(JSON.stringify(s),before);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recoil-empty-'));
 try{const file=path.join(directory,'settings.json');new SettingsStore(file).save(s);assert.deepEqual(new SettingsStore(file).load().games,[]);}finally{fs.rmSync(directory,{recursive:true,force:true});}
 assert.equal(installGamePack(s,pack).games.length,1);assert.throws(()=>createGamePack(s,pack),/Add or install/);
 assert.throws(()=>importWeapon(s,{format:'recoil-control/weapon-v4',stances:pack.game.stances,weapon:pack.game.weapons[0]},'new'),/Add a game/);
 const invalid=defaultSettings();invalid.selectedGameId='missing';assert.throws(()=>validateSettings(invalid),/Selected game/);
});
