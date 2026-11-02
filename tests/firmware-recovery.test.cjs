const test = require('node:test');
const assert = require('node:assert/strict');
const { findFirmwarePort, recoverFirmware } = require('../build/desktop/firmware-recovery');
const target = { path: 'COM3', usbVendorId: 0x303a, usbProductId: 0x1001, serialNumber: 'relay-a' };
function fixture({ bootAt = 0, linksAt = 0, version = '0.7.0', resetsToBoot = 0, serial = target.serialNumber, frozen = false } = {}) {
  let time = 0, resets = 0, connected = false; const events = [];
  const port = { ...target, path: 'COM7', serialNumber: serial };
  return { events, get resets() { return resets; }, get time() { return time; }, options: {
    target, expectedVersion: '0.7.0', requireRelay: true,
    now: () => time, wait: async ms => { time += ms; },
    ports: async () => time < 1000 ? [] : [port, { ...target, path: 'COM8', serialNumber: 'another-board' }],
    connect: async path => { events.push(['connect', path]); if (time < bootAt || resets < resetsToBoot) throw new Error('No HELLO reply'); connected = true; },
    disconnect: async () => { events.push(['disconnect']); connected = false; },
    restart: async port => { assert.equal(connected, false); events.push(['restart', port.path]); resets++; },
    state: () => ({ path: connected ? port.path : null, connected, ready: connected, error: null,
      status: connected ? { firmware: version, usb: true, uptime: frozen ? 500 : time,
        ble: time >= linksAt, secure: time >= linksAt, subscribed: time >= linksAt,
        relay: { selfTest: true, mouseReady: time >= linksAt, mouseSecure: time >= linksAt } } : null }),
    progress: stage => events.push(['progress', stage]),
  } };
}
test('recovery follows a unique USB serial number across COM changes, never another board', async () => {
  const f = fixture();
  assert.deepEqual(await recoverFirmware(f.options), { version: '0.7.0', relayReady: true });
  assert.equal(f.resets, 0); assert.ok(f.time >= 2500);
  assert.ok(f.events.filter(e => e[0] === 'connect').every(e => e[1] === 'COM7'));
  assert.equal(findFirmwarePort(target, [{ ...target, serialNumber: 'different' }]), undefined);
  assert.equal(findFirmwarePort(target, [{ ...target }, { ...target, path: 'COM9' }]), undefined);
  assert.equal(findFirmwarePort({ ...target, serialNumber: undefined }, [{ ...target, path: 'COM9' }]), undefined);
});
test('a stuck bootloader gets a bounded restart after the worker releases its handle', async () => {
  const f = fixture({ resetsToBoot: 1 });
  const result = await recoverFirmware(f.options);
  assert.equal(result.relayReady, true); assert.equal(f.resets, 1);
  const index = f.events.findIndex(e => e[0] === 'restart');
  assert.deepEqual(f.events[index - 1], ['disconnect']);
});
test('slow Bluetooth reconnects are awaited without resetting working firmware', async () => {
  const f = fixture({ linksAt: 22000 });
  assert.equal((await recoverFirmware(f.options)).relayReady, true);
  assert.equal(f.resets, 0); assert.ok(f.time >= 23500);
});
test('missing Bluetooth, stale telemetry, or the wrong firmware cannot report success', async () => {
  const missing = fixture({ linksAt: Infinity });
  await assert.rejects(recoverFirmware(missing.options), /stable mouse relay was not confirmed/);
  assert.equal(missing.resets, 0);
  const stale = fixture({ frozen: true });
  await assert.rejects(recoverFirmware(stale.options), /stable mouse relay was not confirmed/);
  assert.equal(stale.resets, 0);
  const wrong = fixture({ version: '0.6.0' });
  await assert.rejects(recoverFirmware(wrong.options), /0.6.0.*0.7.0.*not confirmed/);
  assert.equal(wrong.resets, 0);
});
test('absent or permanently stuck hardware times out with keyboard/physical recovery instructions', async () => {
  const stuck = fixture({ resetsToBoot: Infinity });
  await assert.rejects(recoverFirmware(stuck.options), /RESET button without holding BOOT/);
  assert.equal(stuck.resets, 2);
  const absent = fixture({ serial: 'other-board' });
  await assert.rejects(recoverFirmware(absent.options), /did not return/);
  assert.equal(absent.resets, 0);
  assert.equal(absent.events.some(e => e[0] === 'connect'), false);
});
test('fresh unpaired boards and failed-write recovery distinguish firmware from mouse readiness', async () => {
  const unpaired = fixture({ linksAt: Infinity }); unpaired.options.requireRelay = false;
  assert.deepEqual(await recoverFirmware(unpaired.options), { version: '0.7.0', relayReady: false });
  const failedWrite = fixture({ version: '0.6.0' }); failedWrite.options.expectedVersion = null;
  assert.deepEqual(await recoverFirmware(failedWrite.options), { version: '0.6.0', relayReady: true });
});
test('recovery refuses to take the serial handle if the worker cannot release it', async () => {
  const f = fixture({ resetsToBoot: 1 });
  f.options.disconnect = async () => { throw new Error('Worker did not release port'); };
  await assert.rejects(recoverFirmware(f.options), /release port/);
  assert.equal(f.resets, 0);
});
