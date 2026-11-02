// Hardware protocol check. Relay firmware rejects all synthetic output.
const assert = require('node:assert/strict');
const { SerialPort } = require('serialport');
const path = process.argv[2] ?? 'COM3';
const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
const replies = new Map();
let status;
let input;
let buffer = '';
let sequence = 0;
port.on('error', error => { console.error(error.message); process.exitCode = 1; });
port.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const value = JSON.parse(line);
      if (value.kind === 'status') status = value;
      if (value.kind === 'input') input = value;
      if (value.kind === 'reply') replies.set(value.id, value);
    } catch {}
  }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(name, args = '') {
  const id = ++sequence;
  await new Promise((resolve, reject) => port.write(`${name} ${id}${args ? ` ${args}` : ''}\n`, error => error ? reject(error) : resolve()));
  const deadline = Date.now() + 2500;
  while (!replies.has(id) && Date.now() < deadline) await delay(20);
  assert.ok(replies.has(id), `No reply for ${name}`);
  return replies.get(id);
}
(async () => {
  await new Promise((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
  for (const protocol of ['RC4', 'RC3', 'RC2']) { const hello = await command('HELLO',protocol); if(hello.ok) break; if(protocol==='RC2') assert.fail('Unsupported firmware'); }
  assert.equal(status.board, 'recoil-c3');
  assert.ok([2, 3, 4].includes(status.protocol));
  assert.equal(status.pin, 20); assert.equal(status.ledCount, 24);
  const before = status.reports;
  const relay = status.protocol >= 3;
  if (relay) {
    assert.equal(status.relay.selfTest, true, 'Firmware parser/queue self-test');
    assert.equal((await command('ARM')).error, 'passthrough_only');
    assert.equal((await command('FRAME', '8 0')).error, 'passthrough_only');
    if (status.protocol === 4) {
      const until=Date.now()+1000; while(!input && Date.now()<until) await delay(20);
      assert.ok(input, 'Relay button telemetry'); const stale={...input};
      await delay(150);
      assert.equal((await command('RFRAME', `${stale.generation} ${stale.stamp} 8 0`)).error,'stale_input');
    }
  }
  assert.equal((await command('MOVE', '8 0')).ok, false);
  assert.equal((await command('LED', '255')).ok, false);
  assert.equal((await command('LED', '6')).ok, true);
  assert.equal(status.brightness, 6);
  const links = relay && structuredClone(status);
  await delay(relay ? 6500 : 2100);
  assert.equal(status.usb, false); assert.equal(status.armed, false);
  if (relay) {
    assert.equal(status.ble, links.ble);
    assert.equal(status.relay.mouseReady, links.relay.mouseReady);
    assert.equal(status.relay.pcDisconnects, links.relay.pcDisconnects);
    assert.equal(status.relay.mouseDisconnects, links.relay.mouseDisconnects);
    assert.equal((await command('PING')).ok, true, 'Same session recovers after heartbeat expiry');
    assert.equal(status.usb, true);
  } else {
    assert.equal(status.reports, before);
    assert.equal((await command('HELLO', 'RC2')).ok, true);
  }
  assert.equal((await command('DISARM')).ok, true);
  console.log(relay
    ? 'PASS: firmware self-test, D7/24 LEDs, brightness cap, unsafe output rejected, USB timeout leaves links unchanged and PING recovers.'
    : 'PASS: board identity, D7/24 LEDs, brightness cap, rejected unarmed movement, heartbeat expiry.');
  console.log(JSON.stringify(status));
})().catch(error => { console.error(error); console.error(JSON.stringify(status)); process.exitCode = 1; })
  .finally(() => { if (port.isOpen) port.close(); });
