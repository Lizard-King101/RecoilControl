const test = require('node:test'), assert = require('node:assert/strict');
const tools = require('../ui/vision-tools');
const { VisionSession } = require('../build/desktop/vision-session');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const width=256,height=144;
let seed=123;
const scene=Float32Array.from({length:width*height},()=>{seed=(seed*1664525+1013904223)>>>0;return seed>>>24;});
function shifted(dx,dy) {
  return Float32Array.from({length:scene.length},(_,i)=>scene[Math.max(0,Math.min(height-1,Math.floor(i/width)-dy))*width+Math.max(0,Math.min(width-1,i%width-dx))]);
}
function measurement(options={}) {
  const frames=[],legs=[];
  let offset=[0,0];
  for(let i=0;i<4;i++) {
    const axis=Math.floor(i/2),units=i%2?-12:12,start=i*1200;
    const delta=options.zero?0:units*(options.large?3:1)*(axis===0?-1:1)*(options.inconsistent&&i===1?2:1);
    const before=shifted(...offset);offset[axis]+=delta;
    if(options.cross&&axis===0)offset[1]+=6;
    const after=shifted(...offset);
    legs.push({axis,units,beforeStart:start,moveStart:start+300,moveEnd:start+720,end:start+1070});
    for(let t=0;t<=1060;t+=20) {
      const gray=t<=300?before:after;
      frames.push({t:start+t,gray,width,height,scaleX:2,scaleY:3});
    }
  }
  return {frames,legs};
}
test('calibration measures signed source pixels per output unit in both directions',()=>{
  const {frames,legs}=measurement();
  assert.deepEqual(tools.calibrate(frames,legs).gain,[-2,3]);
  const first=tools.calibrate(frames,legs);
  assert.deepEqual(tools.calibrate(frames,legs),first,'repeated calibration must not retain prior tracking state');
});
test('calibration tracks anchored displacement beyond the recording search range',()=>{
  const {frames,legs}=measurement({large:true});
  assert.deepEqual(tools.calibrate(frames,legs).gain,[-6,9]);
});
test('calibration rejects zero response, inconsistent directions, cross motion and capture changes',()=>{
  for(const [options,reason] of [[{zero:true},/too small/],[{inconsistent:true},/inconsistent/],[{cross:true},/other axis/]]) {
    const {frames,legs}=measurement(options);assert.throws(()=>tools.calibrate(frames,legs),reason);
  }
  let {frames,legs}=measurement();frames[3]={...frames[3],scaleX:4};assert.throws(()=>tools.calibrate(frames,legs),/Capture size/);
  ({frames,legs}=measurement());frames=frames.filter(f=>f.t<400||f.t>550);assert.throws(()=>tools.calibrate(frames,legs),/frame gap/);
  ({frames,legs}=measurement());frames[1]={...frames[1],t:frames[0].t};assert.throws(()=>tools.calibrate(frames,legs),/timing/);
});
test('calibration rejects untrackable scenes and motion during settling',()=>{
  let {frames,legs}=measurement();frames=frames.map(f=>({...f,gray:new Float32Array(width*height)}));assert.throws(()=>tools.calibrate(frames,legs),/tracking failed/);
  ({frames,legs}=measurement());frames[0]={...frames[0],gray:shifted(4,0)};assert.throws(()=>tools.calibrate(frames,legs),/pointer was still/);
});
function sessionFixture(focus=()=>true) {
  const moves=[],events=[];
  const output={profileReady:true,async moveProfile(x,y,current){if(!current())return false;moves.push([x,y]);return true;},async disarm(){}};
  const session=new VisionSession(output,event=>events.push(event),focus);
  session.captureFrame();const timer=setInterval(()=>session.captureFrame(),30);
  return {session,moves,events,output,stopFrames(){clearInterval(timer);},close(){clearInterval(timer);session.close();}};
}
test('calibration performs only bounded out-and-back motion without a fire listener or simulator',async()=>{
  const f=sessionFixture();
  try {
    const {legs}=await f.session.calibrate(3);
    assert.equal(legs.length,4);assert.equal(f.moves.length,48);
    assert.deepEqual(f.moves.reduce((total,v)=>total.map((n,i)=>n+v[i]),[0,0]),[0,0]);
    assert.ok(f.moves.every(([x,y])=>Math.abs(x)+Math.abs(y)===1));
    assert.equal(f.session.state.armed,false);assert.equal(f.session.state.firing,false);
    assert.deepEqual(f.events.filter(e=>e.type==='calibration-countdown').map(e=>e.seconds),[3,2,1]);
  } finally {f.close();}
});
test('calibration cancels on Stop and capture loss before any movement',async()=>{
  for(const reason of ['stop','capture']) {
    const f=sessionFixture();
    try {
      const pending=f.session.calibrate(3);
      const rejected=assert.rejects(pending,reason==='stop'?/cancelled/:/Capture/);
      if(reason==='stop'){await delay(40);f.session.disarm();}else f.stopFrames();
      await rejected;assert.equal(f.moves.length,0);
    }finally{f.close();}
  }
});
test('calibration refuses output with lab focus and stops during movement on cancellation',async()=>{
  const focus=sessionFixture(()=>false);
  try {await assert.rejects(focus.session.calibrate(3),/Switch to the game/);assert.equal(focus.moves.length,0);}finally{focus.close();}
  const f=sessionFixture();
  try {
    const pending=f.session.calibrate(3), rejected=assert.rejects(pending,/cancelled/);
    while(!f.moves.length) await delay(20);
    f.session.disarm();const count=f.moves.length;await rejected;await delay(80);assert.equal(f.moves.length,count);
  }finally{f.close();}
});
