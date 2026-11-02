// Packages the PlatformIO build into firmware/release so the app can install it over USB.
// Only the application and its boot selector are shipped: the bootloader, partition table,
// and NVS (Bluetooth pairings, LED settings) are never rewritten by an in-app update.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const build = path.join(root, 'firmware/.pio/build/xiao_esp32c3');
const out = path.join(root, 'firmware/release');
const bootApp0 = path.join(process.env.PLATFORMIO_CORE_DIR ?? path.join(os.homedir(), '.platformio'),
  'packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin');

function partitions(file) {
  const table = fs.readFileSync(file), found = {};
  for (let offset = 0; offset + 32 <= table.length && table.readUInt16LE(offset) === 0x50aa; offset += 32) {
    const name = table.subarray(offset + 12, offset + 28).toString('latin1').replace(/\0.*$/s, '');
    found[name] = { type: table[offset + 2], subtype: table[offset + 3], address: table.readUInt32LE(offset + 4), size: table.readUInt32LE(offset + 8) };
  }
  return found;
}

const version = /\\"firmware\\":\\"(\d+\.\d+\.\d+)\\"/.exec(fs.readFileSync(path.join(root, 'firmware/src/main.cpp'), 'utf8'))?.[1];
if (!version) throw new Error('Could not find the firmware version in main.cpp.');
const table = partitions(path.join(build, 'partitions.bin'));
if (table.app0?.type !== 0 || table.otadata?.type !== 1) throw new Error('Expected app0 and otadata partitions.');
const firmware = fs.readFileSync(path.join(build, 'firmware.bin'));
if (firmware[0] !== 0xe9) throw new Error('firmware.bin is not an ESP application image.');
if (firmware.length > table.app0.size) throw new Error('firmware.bin does not fit in app0.');
if (!fs.existsSync(bootApp0)) throw new Error(`boot_app0.bin not found at ${bootApp0}`);

fs.mkdirSync(out, { recursive: true });
const images = [['boot_app0.bin', fs.readFileSync(bootApp0), table.otadata.address], ['firmware.bin', firmware, table.app0.address]]
  .map(([file, data, address]) => {
    fs.writeFileSync(path.join(out, file), data);
    return { file, address, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ version, chip: 'ESP32-C3', images }, null, 2) + '\n');
console.log(`Firmware ${version} packaged: ${images.map(image => `${image.file} @ 0x${image.address.toString(16)}`).join(', ')}`);
