import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SerialPort } from 'serialport';

export interface FirmwareImage { file: string; address: number; size: number; sha256: string }
export interface FirmwareRelease { version: string; chip: 'ESP32-C3'; images: FirmwareImage[] }
export interface FirmwareUpdateState { running: boolean; stage: string; progress: number; error: string | null; installed: string | null; recoveryAvailable: boolean }
export const idleFirmwareUpdate = (): FirmwareUpdateState => ({ running: false, stage: '', progress: 0, error: null, installed: null, recoveryAvailable: false });

// Only the boot selector (otadata) and the application are ever written. The bootloader,
// partition table, and NVS with the Bluetooth pairings and LED settings stay untouched.
const allowedAddresses = new Map([['boot_app0.bin', 0xe000], ['firmware.bin', 0x10000]]);

// Reads firmware/release, checking every image against its manifest before it may be flashed.
export function loadRelease(directory: string): (FirmwareRelease & { data: Uint8Array[] }) | null {
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FirmwareRelease;
  if (!/^\d+\.\d+\.\d+$/.test(manifest?.version) || manifest.chip !== 'ESP32-C3' || !Array.isArray(manifest.images) || manifest.images.length !== allowedAddresses.size) {
    throw new Error('The bundled firmware manifest is invalid.');
  }
  const data = manifest.images.map(image => {
    if (allowedAddresses.get(image.file) !== image.address) throw new Error(`The bundled firmware writes ${image.file} to an unexpected address.`);
    const bytes = readFileSync(join(directory, image.file));
    if (bytes.length !== image.size || createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error(`The bundled ${image.file} does not match its checksum.`);
    return new Uint8Array(bytes);
  });
  return { ...manifest, data };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

type Port = Pick<SerialPort, 'open' | 'close' | 'write' | 'drain' | 'set' | 'update' | 'on' | 'isOpen'>;
// The subset of the Web Serial SerialPort that esptool-js's Transport uses, over the serialport package.
export class NodeSerialPort {
  private port?: Port;
  private readStream: ReadableStream<Uint8Array> | null = null;
  private writeStream: WritableStream<Uint8Array> | null = null;
  private push?: ReadableStreamDefaultController<Uint8Array>;
  // serialport.set() applies defaults to omitted lines, so both are always sent together.
  private dtr = false;
  private rts = false;
  private readError?: Error;

  constructor(private readonly path: string, private readonly info: { usbVendorId?: number; usbProductId?: number },
    private readonly create: (path: string, baudRate: number) => Port = (path, baudRate) => new SerialPort({ path, baudRate, autoOpen: false }),
    private readonly timeoutMs = 3000) {}

  private operation(label: string, start: (done: (error?: Error | null) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`USB ${label} timed out.`)), this.timeoutMs);
      try { start(error => { clearTimeout(timer); error ? reject(error) : resolve(); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }

  getInfo() { return { ...this.info }; }

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.port?.isOpen) return null;
    // Like Web Serial, a cancelled stream is replaced by a fresh one while the port stays open.
    this.readStream ??= new ReadableStream<Uint8Array>({
      start: controller => { this.push = controller; if (this.readError) controller.error(this.readError); },
      cancel: () => { this.push = undefined; this.readStream = null; },
    });
    return this.readStream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (!this.port?.isOpen) return null;
    this.writeStream ??= new WritableStream<Uint8Array>({
      write: chunk => this.operation('write', done => {
        const port = this.port;
        if (!port?.isOpen) { done(new Error('Serial port closed.')); return; }
        port.write(Buffer.from(chunk), error => error ? done(error) : port.drain(done));
      }),
      close: () => { this.writeStream = null; },
    });
    return this.writeStream;
  }

  async open(options: { baudRate: number }): Promise<void> {
    const port = this.create(this.path, options.baudRate);
    this.port = port; this.readError = undefined;
    port.on('data', (chunk: Buffer) => { if (this.port === port) this.push?.enqueue(new Uint8Array(chunk)); });
    port.on('close', () => { if (this.port === port) this.endRead(); });
    port.on('error', error => {
      if (this.port !== port) return;
      this.readError = error;
      try { this.push?.error(error); } catch { /* Stream already ended. */ }
      this.push = undefined;
    });
    try {
      await this.operation('open', done => port.open(error => {
        if (this.port !== port && port.isOpen) port.close(() => {});
        done(error);
      }));
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
    if (signals.dataTerminalReady !== undefined) this.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) this.rts = signals.requestToSend;
    const port = this.port;
    if (!port?.isOpen) throw new Error('Serial port closed.');
    await this.operation('control-line change', done => port.set({ dtr: this.dtr, rts: this.rts, brk: !!signals.break }, done));
  }

  async setBaudRate(baudRate: number): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('Serial port closed.');
    await this.operation('baud-rate change', done => port.update({ baudRate }, done));
  }

  async close(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.endRead(); this.writeStream = null;
    if (port?.isOpen) await this.operation('close', done => port.close(done));
  }

  private endRead() {
    try { this.push?.close(); } catch { /* Already closed or cancelled. */ }
    this.push = undefined; this.readStream = null;
  }
}

// Reboots the board into its ROM bootloader over USB, writes and verifies the images, then restarts it.
export class FirmwareFlashError extends Error {
  constructor(message: string, readonly writeStarted: boolean) { super(message); }
}
async function createFlasher(path: string, info: { usbVendorId?: number; usbProductId?: number }) {
  const { ESPLoader, Transport } = await import('esptool-js');
  const device = new NodeSerialPort(path, info);
  const transport = new Transport(device as unknown as ConstructorParameters<typeof Transport>[0], false);
  const silent = { clean() {}, writeLine() {}, write() {} };
  // USB serial on the ESP32-C3 runs at full USB speed regardless of baud, so it never changes.
  const loader = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: silent });
  return { loader, transport, device };
}
export async function flashFirmware(path: string, info: { usbVendorId?: number; usbProductId?: number },
  release: FirmwareRelease & { data: Uint8Array[] }, onProgress: (stage: string, fraction: number) => void,
  create = createFlasher): Promise<void> {
  const { loader, transport, device } = await create(path, info);
  let writeStarted = false;
  try {
    onProgress('Restarting the board into its bootloader', 0.02);
    await loader.main();
    if (loader.chip.CHIP_NAME !== 'ESP32-C3') throw new Error(`Expected an ESP32-C3 but found ${loader.chip.CHIP_NAME}. Nothing was written.`);
    const total = release.data.reduce((sum, image) => sum + image.length, 0);
    const before = release.data.map((_, i) => release.data.slice(0, i).reduce((sum, image) => sum + image.length, 0));
    writeStarted = true;
    await loader.writeFlash({
      fileArray: release.images.map((image, i) => ({ data: release.data[i], address: image.address })),
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
      reportProgress: (index, written, size) => onProgress('Writing and verifying firmware', 0.05 + 0.9 * (before[index] + written / size * release.data[index].length) / total),
      calculateMD5Hash: image => createHash('md5').update(image).digest('hex'),
    });
    onProgress('Restarting the board', 0.97);
    // USB can disappear during a successful reset. The application handshake in
    // recoverFirmware decides whether it worked; a modem-line write is not proof.
    await restartBoard(transport).catch(() => {});
  } catch (error) {
    throw new FirmwareFlashError(error instanceof Error ? error.message : String(error), writeStarted);
  } finally {
    // Close the native handle first so esptool cannot hang waiting for a read lock
    // held by a disconnected USB device. This also wakes its pending reader.
    await device.close().catch(() => {});
    await transport.disconnect().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// esptool-js 0.7's hard reset only releases RTS, which its bootloader entry already left
// released, so the board stayed in the flasher until replugged. Pulse EN with IO9 released
// (DTR low) instead, as esptool.py does, so the new firmware starts.
export async function restartBoard(transport: { setDTR(state: boolean): Promise<void>; setRTS(state: boolean): Promise<void> }, wait = sleep): Promise<void> {
  try {
    await transport.setDTR(false);
    await transport.setRTS(true);
    await wait(200);
  } finally {
    // Attempt both releases even if USB disappears or the preceding call fails.
    try { await transport.setDTR(false); } finally { await transport.setRTS(false); }
  }
  await wait(200);
}

export async function restartFirmwarePort(path: string, info: { usbVendorId?: number; usbProductId?: number }): Promise<void> {
  const device = new NodeSerialPort(path, info);
  try {
    await device.open({ baudRate: 115200 });
    await restartBoard({ setDTR: state => device.setSignals({ dataTerminalReady: state }), setRTS: async state => {
      await device.setSignals({ requestToSend: state });
      await device.setSignals({ dataTerminalReady: false }); // Windows usbser control-line workaround.
    } });
  } finally { await device.close(); }
}
