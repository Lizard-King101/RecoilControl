const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BoardConnection, parseBoardStatus } = require('../build/desktop/board');

const status = () => ({ kind: 'status', board: 'recoil-c3', protocol: 2, firmware: '0.2.0',
  usb: true, ble: true, secure: true, subscribed: true, armed: false,
  brightness: 6, brightnessCap: 12, ledCount: 24, pin: 20, reports: 0, uptime: 1000 });

class Port extends EventEmitter {
  isOpen = false;
  commands = [];
  state = status();
  sent = true;
  drop = null;
  open(callback) { this.isOpen = true; setImmediate(() => callback(null)); }
  close(callback) { this.isOpen = false; this.emit('close'); callback(null); }
  write(line, callback) {
    const [command, id, ...args] = line.trim().split(' ');
    this.commands.push([command, ...args]);
    if (command === 'ARM') this.state.armed = true;
    if (command === 'DISARM' || command === 'HELLO') this.state.armed = false;
    if (command === 'LED') this.state.brightness = Number(args[0]);
    if (command === 'MOVE' || command === 'FRAME') { this.state.armed = false; this.state.reports++; }
    setImmediate(() => {
      callback(null);
      if (command === this.drop) return;
      const supported = command !== 'HELLO' || args[0] === `RC${this.state.protocol}`;
      const data = JSON.stringify({ kind: 'reply', id: Number(id), ok: supported, error: supported ? '' : 'unsupported_protocol', ...(command === 'RFRAME' ? {sent:this.sent} : {}) }) + '\n' + (supported ? JSON.stringify(this.state) + '\n' : '');
      // Exercise framing across multiple serial chunks.
      this.emit('data', Buffer.from(data.slice(0, 13)));
      this.emit('data', Buffer.from(data.slice(13)));
    });
    return true;
  }
}

function fixture(options = {}) {
  let port = new Port();
  let created = false;
  const board = new BoardConnection({ createPort: () => { if (created) port = new Port(); created = true; return port; }, timeoutMs: 35, heartbeatMs: 10000, ...options });
  return { board, get port() { return port; } };
}

test('board handshake validates identity, LED limits, and starts disarmed without motion', async () => {
  const { board, port } = fixture();
  await board.connect('COM3');
  assert.equal(board.state.ready, true);
  assert.equal(board.state.status.armed, false);
  assert.deepEqual(port.commands, [['HELLO','RC4'], ['HELLO','RC3'], ['HELLO','RC2'], ['DISARM']]);
  await board.setBrightness(12);
  await assert.rejects(board.setBrightness(13), /Brightness/);
  assert.equal(board.state.status.brightness, 12);
  assert.equal(port.commands.some(c => c[0] === 'MOVE'), false);
  await board.disconnect();
  assert.equal(board.state.error, null);
});

test('board movement requires pairing and subscription, sends only one bounded move, and disarms', async () => {
  const { board, port } = fixture();
  port.state.subscribed = false;
  await board.connect('COM3');
  await assert.rejects(board.testMovement(), /Pair/);
  port.state.subscribed = true;
  port.emit('data', Buffer.from(JSON.stringify(port.state) + '\n'));
  await board.testMovement();
  assert.deepEqual(port.commands.slice(-3), [['ARM'], ['MOVE', '8', '0'], ['DISARM']]);
  assert.equal(board.state.status.reports, 1);
  assert.equal(board.state.status.armed, false);
  await board.disconnect();
});

test('lost movement acknowledgement is never retried and requires reconnect', async () => {
  const { board, port } = fixture();
  await board.connect('COM3'); port.drop = 'MOVE';
  await assert.rejects(board.testMovement(), /acknowledge MOVE/);
  assert.equal(port.commands.filter(c => c[0] === 'MOVE').length, 1);
  assert.equal(port.commands.at(-1)[0], 'DISARM');
  assert.equal(board.state.ready, false);
  assert.equal(board.state.busy, false);
  await board.disconnect();
});

test('missing heartbeats stop readiness; intentional disconnect clears pending pings cleanly', async () => {
  const f = fixture({ heartbeatMs: 10 }); const { board, port } = f;
  await board.connect('COM3'); port.drop = 'PING';
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(board.state.ready, false);
  assert.match(board.state.error, /PING/);
  await board.disconnect();
  await board.connect('COM3'); f.port.drop = 'PING';
  await new Promise(resolve => setTimeout(resolve, 15));
  await board.disconnect();
  await new Promise(setImmediate);
  assert.equal(board.state.error, null);
});

test('board status rejects wrong firmware, pin mappings, and brightness limits', () => {
  assert.ok(parseBoardStatus(status()));
  for (const patch of [{ board: 'other' }, { protocol: 1 }, { pin: 7 }, { brightness: 255 },
    { brightnessCap: 100 }, { reports: -1 }, { secure: 'yes' }, { ledCount: 25 }]) {
    assert.equal(parseBoardStatus({ ...status(), ...patch }), null);
  }
});

test('serial disconnect and firmware watchdog expiry invalidate the ready state', async () => {
  const f = fixture(); const { board, port } = f; await board.connect('COM3');
  port.emit('data', Buffer.from(JSON.stringify({ ...port.state, usb: false }) + '\n'));
  assert.equal(board.state.ready, false);
  assert.match(board.state.error, /heartbeat expired/);
  await board.disconnect(); await board.connect('COM3');
  f.port.isOpen = false; f.port.emit('close');
  assert.equal(board.state.ready, false);
  assert.equal(board.state.connected, false);
  await board.disconnect();
});

test('profile frames preserve counts, reject overflows, and cancel before sending after a release', async () => {
  const { board, port } = fixture(); await board.connect('COM3');
  await assert.rejects(board.moveProfile(128, 0, () => true), /127 counts/);
  assert.equal(port.commands.some(c => c[0] === 'ARM'), false);
  assert.equal(await board.moveProfile(-127, 24, () => true), true);
  assert.deepEqual(port.commands.at(-1), ['FRAME', '-127', '24']);
  let checks = 0;
  assert.equal(await board.moveProfile(2, 3, () => ++checks === 1), false);
  assert.equal(port.commands.filter(c => c[0] === 'FRAME').length, 1);
  assert.equal(port.commands.at(-1)[0], 'DISARM');
  await board.disconnect();
});

test('a missing profile acknowledgement is never retried, and blocks subsequent frames', async () => {
  const { board, port } = fixture(); await board.connect('COM3'); port.drop = 'FRAME';
  const sending = board.moveProfile(1, 2, () => true);
  await assert.rejects(board.moveProfile(1, 2, () => true), /pending/);
  await assert.rejects(sending, /acknowledge FRAME/);
  assert.equal(port.commands.filter(c => c[0] === 'FRAME').length, 1);
  assert.equal(board.profileReady, false);
  await assert.rejects(board.moveProfile(1, 2, () => true), /not ready/);
  await board.disconnect();
});

function relayStatus() {
  return { ...status(), protocol: 3, firmware: '0.3.0', relay: {
    mode: 'passthrough', selfTest: true, mouseConnected: true, mouseSecure: true, mouseReady: true,
    pairing: false, savedMouse: true, stage: 3, error: '', received: 0, moves: 0, left: 0, right: 0,
    middle: 0, side: 0, wheelUp: 0, wheelDown: 0, buttons: 0, queueDepth: 0, dropped: 0,
    parseErrors: 0, txErrors: 0, mouseDisconnects: 0, pcDisconnects: 0, usbTimeouts: 0,
    latencySamples: 0, latencyLastUs: 0, latencyMaxUs: 0, latencyMeanUs: 0, pcIntervalUs: 7500, mouseIntervalUs: 7500,
  } };
}

test('relay status rejects malformed metrics and any armed state', () => {
  const value = relayStatus();
  assert.ok(parseBoardStatus(value));
  assert.equal(parseBoardStatus({ ...value, armed: true }), null);
  assert.equal(parseBoardStatus({ ...value, relay: undefined }), null);
  for (const patch of [{ queueDepth: 65 }, { buttons: 256 }, { stage: 6 }, { selfTest: 1 }, { latencyMeanUs: -1 }]) {
    assert.equal(parseBoardStatus({ ...value, relay: { ...value.relay, ...patch } }), null);
  }
});

test('relay never sends synthetic mouse input, even with both Bluetooth links ready', async t => {
  const { board, port } = fixture(); t.after(() => board.disconnect());
  port.state = relayStatus(); await board.connect('COM3');
  assert.equal(board.relayReady, true);
  assert.equal(board.profileReady, false);
  await assert.rejects(board.testMovement(), /Synthetic movement is disabled/);
  await assert.rejects(board.moveProfile(1, 2, () => true), /Recoil output is disabled/);
  await board.pairMouse(); await board.resetRelayStats();
  assert.ok(port.commands.some(c => c[0] === 'PAIR'));
  assert.ok(port.commands.some(c => c[0] === 'RESETSTATS'));
  assert.equal(port.commands.some(c => ['ARM', 'MOVE', 'FRAME'].includes(c[0])), false);
});

test('relay USB heartbeat expiry does not invalidate physical mouse readiness', async t => {
  const { board, port } = fixture(); t.after(() => board.disconnect());
  port.state = relayStatus(); await board.connect('COM3');
  port.state.usb = false;
  port.emit('data', Buffer.from(JSON.stringify(port.state) + '\n'));
  assert.equal(board.relayReady, true);
  assert.equal(board.state.error, null);
  assert.equal(board.profileReady, false);
});

test('relay reconnects its USB session automatically after a lost heartbeat acknowledgement', async t => {
  const { board, port } = fixture({ heartbeatMs: 10 }); t.after(() => board.disconnect());
  port.state = relayStatus(); await board.connect('COM3'); port.drop = 'PING';
  const until = Date.now() + 500;
  while (port.commands.filter(c => c[0] === 'HELLO').length < 3 && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  port.drop = null;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(port.commands.filter(c => c[0] === 'HELLO'), [['HELLO', 'RC4'], ['HELLO', 'RC3'], ['HELLO', 'RC3']]);
  assert.equal(board.state.ready, true);
  assert.equal(board.state.error, null);
  assert.equal(board.relayReady, true);
  assert.equal(port.commands.some(c => ['ARM', 'MOVE', 'FRAME'].includes(c[0])), false);
});

function profileRelayStatus() {
  const value = relayStatus(); value.protocol = 4; value.firmware = '0.4.0';
  Object.assign(value.relay, {mode:'profiles', corrections:0, cancelled:0, correctionPending:false}); return value;
}
function physical(port, buttons, generation = 1) {
  port.emit('data', Buffer.from(JSON.stringify({kind:'input',buttons,generation,stamp:2000,connected:true})+'\n'));
}
test('profile relay requires fresh physical Cobra input and sends one tagged correction', async t => {
  const {board,port} = fixture(); t.after(()=>board.disconnect()); port.state=profileRelayStatus();
  await board.connect('COM3'); assert.equal(board.profileReady,false);
  physical(port,0); assert.equal(board.profileReady,true);
  assert.equal(await board.moveProfile(2,3,()=>true),false);
  physical(port,1,2);
  assert.equal(await board.moveProfile(2,3,()=>true),true);
  assert.deepEqual(port.commands.at(-1),['RFRAME','2','2000','2','3']);
  assert.equal(port.commands.some(c=>['ARM','FRAME','MOVE'].includes(c[0])),false);
  port.sent=false;
  assert.equal(await board.moveProfile(2,3,()=>true),false);
  assert.equal(board.state.ready,true, 'A physically cancelled correction must not fault passthrough');
  await new Promise(resolve=>setTimeout(resolve,170));
  assert.equal(board.profileReady,false, 'Stale button telemetry stops recoil');
  assert.equal(board.relayReady,true, 'Physical relay remains independent');
});
test('profile relay clears button state on disconnect and never retries a missing correction acknowledgement', async t => {
  const {board,port}=fixture(); t.after(()=>board.disconnect()); port.state=profileRelayStatus();
  const received=[]; board.listenInput(value=>received.push(value));
  await board.connect('COM3'); physical(port,1); port.drop='RFRAME';
  await assert.rejects(board.moveProfile(1,2,()=>true),/acknowledge RFRAME/);
  assert.equal(port.commands.filter(c=>c[0]==='RFRAME').length,1);
  assert.equal(board.profileReady,false);
  assert.equal(board.relayReady,true);
  await board.disconnect(); assert.equal(received.at(-1),undefined);
});
test('trace firmware streams validated motion frames only after TRACE, and older firmware cannot record', async t => {
  const {board,port}=fixture(); t.after(()=>board.disconnect()); port.state=profileRelayStatus();
  await board.connect('COM3');
  assert.equal(board.supportsTrace,false);
  await assert.rejects(board.setTrace(true),/firmware to 0\.5\.0/);
  port.state.relay.tracing=false; port.state.firmware='0.5.0';
  port.emit('data',Buffer.from(JSON.stringify(port.state)+'\n'));
  assert.equal(board.supportsTrace,true);
  const frames=[]; const stop=board.listenMotion(frame=>frames.push(frame));
  await board.setTrace(true);
  assert.deepEqual(port.commands.at(-1),['TRACE','1']);
  port.emit('data',Buffer.from(JSON.stringify({kind:'motion',seq:0,stamp:4294967295,dx:-3,dy:12,buttons:1})+'\n'));
  assert.deepEqual(frames,[{seq:0,stamp:4294967295,dx:-3,dy:12,buttons:1}]);
  stop(); await board.setTrace(false);
  assert.deepEqual(port.commands.at(-1),['TRACE','0']);
  assert.equal(port.commands.some(c=>['ARM','FRAME','MOVE'].includes(c[0])),false);
  port.emit('data',Buffer.from(JSON.stringify({kind:'motion',seq:1,stamp:1,dx:0.5,dy:0,buttons:0})+'\n'));
  assert.equal(frames.length,1);
  assert.match(board.state.error,/Invalid relay motion/);
});
test('LED indicator follows compensation only on firmware that reports it, and catches up after a reset', async t => {
  const {board,port}=fixture(); t.after(()=>board.disconnect()); port.state=profileRelayStatus();
  await board.connect('COM3');
  board.syncIndicator(1); await new Promise(setImmediate);
  assert.equal(port.commands.some(c=>c[0]==='IND'),false,'0.5 firmware has no indicator');
  port.state.relay.indicator=0; port.emit('data',Buffer.from(JSON.stringify(port.state)+'\n'));
  const write=port.write.bind(port);
  port.write=(line,callback)=>{ if(line.startsWith('IND ')) port.state.relay.indicator=Number(line.trim().split(' ')[2]); return write(line,callback); };
  board.syncIndicator(1); board.syncIndicator(1);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(port.commands.filter(c=>c[0]==='IND'),[['IND','1']],'One request while one is pending');
  assert.equal(board.state.status.relay.indicator,1);
  board.syncIndicator(1); await new Promise(setImmediate);
  assert.equal(port.commands.filter(c=>c[0]==='IND').length,1,'Nothing to send when the board already shows it');
  port.state.relay.indicator=0; port.emit('data',Buffer.from(JSON.stringify(port.state)+'\n')); // Board session reset.
  board.syncIndicator(1); await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(port.commands.filter(c=>c[0]==='IND').at(-1),['IND','1']);
  for (const bad of [3,-1,'1']) assert.equal(parseBoardStatus({...port.state,relay:{...port.state.relay,indicator:bad}}),null);
});
test('profile relay schema requires bounded counters and correction state',()=>{
  const value=profileRelayStatus(); assert.ok(parseBoardStatus(value));
  assert.equal(parseBoardStatus({...value,relay:{...value.relay,tracing:true}}).relay.tracing,true);
  assert.equal(parseBoardStatus({...relayStatus(),relay:{...relayStatus().relay,tracing:false}}),null,'Passthrough firmware cannot advertise tracing');
  for(const patch of [{corrections:-1},{correctionPending:1},{mode:'passthrough'},{tracing:'yes'}]) {
    assert.equal(parseBoardStatus({...value,relay:{...value.relay,...patch}}),null);
  }
});
test('0.7 firmware reports full brightness, its LED count and power budget; older firmware keeps the 12/255 cap', async t => {
  const {board,port}=fixture(); t.after(()=>board.disconnect()); port.state=profileRelayStatus();
  await board.connect('COM3');
  await assert.rejects(board.setBrightness(13),/between 0 and 12/);
  await assert.rejects(board.setLedCount(30),/firmware to 0\.7\.0/);
  Object.assign(port.state,{firmware:'0.7.0',brightnessCap:255,brightness:200,ledCount:24,ledBudgetMa:350});
  port.emit('data',Buffer.from(JSON.stringify(port.state)+'\n'));
  assert.equal(board.state.status.ledBudgetMa,350);
  await board.setBrightness(255);
  assert.deepEqual(port.commands.at(-1),['LED','255']);
  await board.setLedCount(36);
  assert.deepEqual(port.commands.at(-1),['LEDS','36']);
  await assert.rejects(board.setLedCount(61),/between 1 and 60/);
  await assert.rejects(board.setBrightness(256),/between 0 and 255/);
  for (const patch of [{ledCount:0},{ledCount:61},{brightness:256},{ledBudgetMa:-1}]) assert.equal(parseBoardStatus({...port.state,...patch}),null);
  assert.ok(parseBoardStatus({...port.state,ledCount:36}));
});
