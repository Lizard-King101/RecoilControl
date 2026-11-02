const test = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
test('Linux mouse helper filters events, reports initial holds, and stops on lost/stale input', () => {
  execFileSync('python3', [path.join(__dirname, 'mouse-helper.test.py')], { stdio: 'pipe' });
});

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const originalSpawn = cp.spawn, originalExec = cp.execFile;
const calls = [];
let fake;
cp.execFile = (file, args, options, callback) => {
  calls.push({file, args});
  queueMicrotask(() => callback(null, args.includes('--list') ? JSON.stringify([{path:'/dev/input/event42',name:'Fixture mouse',readable:true}]) : '', ''));
};
cp.execFile[require('node:util').promisify.custom] = (file,args,options) => new Promise((resolve,reject) => cp.execFile(file,args,options,(error,stdout,stderr) => error ? reject(error) : resolve({stdout,stderr})));
cp.spawn = (file, args) => {
  calls.push({file,args}); fake = new EventEmitter();
  fake.stdout = new PassThrough(); fake.stderr = new PassThrough(); fake.stdin = new PassThrough();
  fake.killed = false; fake.kill = () => { fake.killed = true; };
  return fake;
};
const { MouseButtons, allowMouseRead } = require('../build/desktop/mouse-buttons');
test.after(() => { cp.spawn = originalSpawn; cp.execFile = originalExec; });
const turn = () => new Promise(resolve => setImmediate(resolve));
test('mouse adapter delivers holds, reports helper failure, and ignores late events after close', async () => {
  const inputs=[], errors=[], mouse=new MouseButtons(v=>inputs.push(v), e=>errors.push(e));
  try {
    const connected=mouse.connect('/dev/input/event42'); await turn();
    fake.stdout.write('{"ready":true,"pressed":true}\n'); await connected;
    assert.equal(mouse.connected,true); assert.deepEqual(inputs,[true]);
    fake.stdout.write('{"pressed":false}\n'); assert.deepEqual(inputs,[true,false]);
    fake.stdout.write('{"error":"Mouse input lost events"}\n');
    assert.equal(mouse.connected,false); assert.equal(fake.killed,true); assert.deepEqual(errors,['Mouse input lost events']);
    fake.stdout.write('{"ready":true,"pressed":true}\n'); assert.deepEqual(inputs,[true,false]);
  } finally { mouse.close(); }
});
test('disconnect during device lookup cancels connection before a helper is spawned', async () => {
  const mouse=new MouseButtons(()=>{},()=>{}), before=calls.length;
  const pending=mouse.connect('/dev/input/event42'); mouse.close();
  await assert.rejects(pending,/cancelled/);
  assert.equal(calls.slice(before).filter(c=>!c.args.includes('--list')).length,0);
});
test('permission action rejects arbitrary paths and grants only read access on the selected mouse', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return;
  const before=calls.length;
  await assert.rejects(allowMouseRead('/tmp/not-a-mouse'),/available mouse/);
  assert.equal(calls.slice(before).some(c=>c.file.includes('pkexec')),false);
  await allowMouseRead('/dev/input/event42');
  const grant=calls.find(c=>c.file==='/usr/bin/pkexec');
  assert.deepEqual(grant.args,['/usr/bin/setfacl','-m',`u:${process.getuid()}:r`,'/dev/input/event42']);
});
