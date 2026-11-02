const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { loadRelease, compareVersions, NodeSerialPort, restartBoard, flashFirmware, FirmwareFlashError } = require('../build/desktop/firmware-update');

function release(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmware-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { 'boot_app0.bin': Buffer.alloc(16, 1), 'firmware.bin': Buffer.from([0xe9, 2, 3, 4]) };
  const images = Object.entries(files).map(([file, data]) => {
    fs.writeFileSync(path.join(dir, file), data);
    return { file, address: file === 'firmware.bin' ? 0x10000 : 0xe000, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '0.7.0', chip: 'ESP32-C3', images, ...overrides }));
  return { dir, images };
}

test('the bundled release loads only when every image matches its checksum and allowed address', t => {
  const { dir, images } = release(t);
  const loaded = loadRelease(dir);
  assert.equal(loaded.version, '0.7.0');
  assert.deepEqual([...loaded.data[1]], [0xe9, 2, 3, 4]);
  fs.writeFileSync(path.join(dir, 'firmware.bin'), Buffer.from([0xe9, 2, 3, 5]));
  assert.throws(() => loadRelease(dir), /checksum/);
  const nvs = release(t, { images: images.map(image => image.file === 'boot_app0.bin' ? { ...image, address: 0x9000 } : image) });
  assert.throws(() => loadRelease(nvs.dir), /unexpected address/, 'Never overwrite the NVS that holds pairings');
  assert.throws(() => loadRelease(release(t, { chip: 'ESP32' }).dir), /manifest is invalid/);
  assert.equal(loadRelease(path.join(dir, 'missing')), null);
});

test('firmware versions compare numerically', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.7.0', '0.7.0'), 0);
  assert.ok(compareVersions('0.6.0', '0.7.0') < 0);
});

class FakePort extends EventEmitter {
  isOpen = false; written = []; signals = []; baud = 0;
  open(callback) { this.isOpen = true; callback(null); }
  close(callback) { this.isOpen = false; this.emit('close'); callback(null); }
  write(data, callback) { this.written.push([...data]); callback(null); return true; }
  drain(callback) { callback(null); }
  set(options, callback) { this.signals.push(options); callback(null); }
  update(options, callback) { this.baud = options.baudRate; callback(null); }
}

test('the Web Serial adapter streams both ways, always sends both control lines, and ends cleanly', async () => {
  const fake = new FakePort();
  const port = new NodeSerialPort('COM3', { usbVendorId: 0x303a, usbProductId: 0x1001 }, () => fake);
  assert.equal(port.readable, null);
  assert.deepEqual(port.getInfo(), { usbVendorId: 0x303a, usbProductId: 0x1001 });
  await port.open({ baudRate: 115200 });

  const reader = port.readable.getReader();
  fake.emit('data', Buffer.from([1, 2]));
  assert.deepEqual([...(await reader.read()).value], [1, 2]);
  reader.releaseLock();

  const writer = port.writable.getWriter();
  await writer.write(new Uint8Array([0xc0, 9, 0xc0]));
  writer.releaseLock();
  assert.deepEqual(fake.written, [[0xc0, 9, 0xc0]]);

  await port.setSignals({ requestToSend: true });
  await port.setSignals({ dataTerminalReady: true });
  await port.setSignals({ requestToSend: false });
  assert.deepEqual(fake.signals, [{ dtr: false, rts: true, brk: false }, { dtr: true, rts: true, brk: false }, { dtr: true, rts: false, brk: false }]);
  await port.setBaudRate(460800);
  assert.equal(fake.baud, 460800);

  // A cancelled reader gets a fresh stream, as Web Serial does, so esptool can read again.
  const first = port.readable;
  await first.getReader().cancel();
  assert.notEqual(port.readable, first);

  const pending = port.readable.getReader().read();
  await port.close();
  assert.equal((await pending).done, true, 'Closing ends pending reads');
  assert.equal(port.readable, null);
  assert.equal(port.writable, null);
});

test('after flashing, the board is reset into its application rather than left in the flasher', async () => {
  const fake = new FakePort();
  const port = new NodeSerialPort('COM3', {}, () => fake);
  await port.open({ baudRate: 115200 });
  // Leave the lines as esptool-js's USB-JTAG bootloader entry does: both released.
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  fake.signals.length = 0;
  const transport = {
    setDTR: state => port.setSignals({ dataTerminalReady: state }),
    setRTS: state => port.setSignals({ requestToSend: state }),
  };
  await restartBoard(transport, async () => {});
  const asserted = fake.signals.findIndex(lines => lines.rts);
  assert.ok(asserted >= 0, 'EN must actually be pulled low; releasing an already released RTS does nothing');
  assert.ok(fake.signals.every(lines => !lines.dtr), 'IO9 stays released so the chip boots the firmware, not download mode');
  assert.equal(fake.signals.at(-1).rts, false, 'EN is released again so the chip runs');
  await port.close();
});

test('a failed reset still attempts to release both control lines', async () => {
  const signals = [];
  await assert.rejects(restartBoard({
    async setDTR(value) { signals.push(['dtr', value]); },
    async setRTS(value) { signals.push(['rts', value]); if (value) throw new Error('USB re-enumerating'); },
  }, async () => {}), /USB re-enumerating/);
  assert.deepEqual(signals.slice(-2), [['dtr', false], ['rts', false]]);
});

test('USB error events reject pending reads without an uncaught EventEmitter error', async () => {
  const fake = new FakePort(); const port = new NodeSerialPort('COM3', {}, () => fake);
  await port.open({ baudRate: 115200 });
  const read = port.readable.getReader().read();
  const rejected = assert.rejects(read, /USB disconnected/);
  fake.emit('error', new Error('USB disconnected'));
  await rejected; await port.close();
  assert.equal(port.readable, null);
});

test('stalled USB operations time out and a late open is closed instead of stealing the recovered port', async () => {
  const fake = new FakePort(); let finishOpen;
  fake.open = callback => { finishOpen = callback; };
  const port = new NodeSerialPort('COM3', {}, () => fake, 5);
  await assert.rejects(port.open({ baudRate: 115200 }), /open timed out/);
  fake.isOpen = true; finishOpen(null);
  assert.equal(fake.isOpen, false);
  const second = new FakePort(); second.set = () => {};
  const signals = new NodeSerialPort('COM3', {}, () => second, 5);
  await signals.open({ baudRate: 115200 });
  await assert.rejects(signals.setSignals({ requestToSend: true }), /control-line change timed out/);
  await signals.close(); assert.equal(second.isOpen, false);
});

test('flashing requires checksum verification, releases the native handle first, and leaves restart confirmation to recovery', async t => {
  const { dir } = release(t); const firmware = loadRelease(dir);
  for (const failure of ['before-write', 'verify', 'reset', null]) {
    const events = []; let written;
    const session = {
      loader: { chip: { CHIP_NAME: 'ESP32-C3' },
        async main() { if (failure === 'before-write') throw new Error('No loader'); },
        async writeFlash(options) {
          written = options;
          assert.equal(options.eraseAll, false);
          assert.deepEqual(options.fileArray.map(image => image.address), [0xe000, 0x10000]);
          assert.equal(options.calculateMD5Hash(firmware.data[1]), crypto.createHash('md5').update(firmware.data[1]).digest('hex'));
          if (failure === 'verify') throw new Error('MD5 mismatch');
        } },
      transport: { async setDTR() {}, async setRTS(value) { if (failure === 'reset' && value) throw new Error('USB disappeared'); }, async disconnect() { events.push('transport-disconnect'); } },
      device: { async close() { events.push('native-close'); } },
    };
    const update = flashFirmware('COM3', {}, firmware, () => {}, async () => session);
    if (failure === 'before-write' || failure === 'verify') await assert.rejects(update, error => error instanceof FirmwareFlashError && error.writeStarted === (failure === 'verify'));
    else await update;
    assert.equal(!!written, failure !== 'before-write');
    assert.deepEqual(events, ['native-close', 'transport-disconnect']);
  }
});
