const test=require('node:test');
const assert=require('node:assert/strict');
const {relayButtonInput}=require('../build/relay-button-input');
test('relay buttons ignore secondary mice, preserve ADS, and disable after a missed edge',()=>{
  let keyboard,feed,closed=0; const events=[];
  const input=relayButtonInput({listen(listener){keyboard=listener;return()=>closed++;}},
    {listenInput(listener){feed=listener;return()=>closed++;}});
  const stop=input.listen({keyDown:k=>events.push(['down',k]),keyUp:k=>events.push(['up',k]),mouse:(...v)=>events.push(v)});
  keyboard.mouse('left',true); assert.deepEqual(events,[]);
  keyboard.keyDown('control');
  feed({buttons:3,generation:1,connected:true});
  feed({buttons:3,generation:1,connected:true});
  assert.deepEqual(events,[['down','control'],['right',true],['left',true]]);
  feed({buttons:3,generation:3,connected:true});
  assert.deepEqual(events.slice(-2),[['down','escape'],['up','escape']]);
  feed(undefined); assert.deepEqual(events.slice(-2),[['right',false],['left',false]]);
  stop(); assert.equal(closed,2);
});
