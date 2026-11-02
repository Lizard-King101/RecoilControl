import { SerialPort } from 'serialport';

export interface RelayStatus {
  mode: 'passthrough' | 'profiles'; selfTest: boolean; mouseConnected: boolean; mouseSecure: boolean; mouseReady: boolean;
  corrections?: number; cancelled?: number; correctionPending?: boolean;
  // Present from firmware 0.5.0, which can stream relayed movement for pull recording.
  tracing?: boolean;
  // Present from firmware 0.6.0: what the status LEDs show (0 standby, 1 armed, 2 paused).
  indicator?: number;
  pairing: boolean; savedMouse: boolean; stage: number; error: string;
  received: number; moves: number; left: number; right: number; middle: number; side: number;
  wheelUp: number; wheelDown: number; buttons: number; queueDepth: number; dropped: number; parseErrors: number; txErrors: number;
  mouseDisconnects: number; pcDisconnects: number; usbTimeouts: number;
  latencySamples: number; latencyLastUs: number; latencyMaxUs: number; latencyMeanUs: number; pcIntervalUs: number; mouseIntervalUs: number;
}
const relayNumbers = ['stage', 'received', 'moves', 'left', 'right', 'middle', 'side', 'wheelUp', 'wheelDown', 'buttons',
  'queueDepth', 'dropped', 'parseErrors', 'txErrors', 'mouseDisconnects', 'pcDisconnects', 'usbTimeouts', 'latencySamples',
  'latencyLastUs', 'latencyMaxUs', 'latencyMeanUs', 'pcIntervalUs', 'mouseIntervalUs'] as const;
export interface BoardStatus {
  board: 'recoil-c3'; protocol: 2 | 3 | 4; firmware: string;
  usb: boolean; ble: boolean; secure: boolean; subscribed: boolean; armed: boolean;
  brightness: number; brightnessCap: number; ledCount: number; pin: number; ledBudgetMa?: number;
  reports: number; uptime: number;
  relay?: RelayStatus;
}

export interface BoardState {
  path: string | null; connected: boolean; ready: boolean; busy: boolean;
  status: BoardStatus | null; error: string | null;
}

export function idleBoardState(): BoardState {
  return { path: null, connected: false, ready: false, busy: false, status: null, error: null };
}

type Transport = Pick<SerialPort, 'on' | 'open' | 'close' | 'write' | 'isOpen'>;
interface Options {
  createPort?: (path: string) => Transport;
  onChange?: () => void;
  timeoutMs?: number;
  heartbeatMs?: number;
}
export interface RelayInput { buttons: number; generation: number; stamp: number; connected: boolean; receivedAt: number }
// Physical movement the board relayed since the previous frame; stamp is the board's microsecond clock.
export interface MotionFrame { seq: number; stamp: number; dx: number; dy: number; buttons: number }
type Reply = { sent?: boolean };

export function parseBoardStatus(value: unknown): BoardStatus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.board !== 'recoil-c3' || ![2, 3, 4].includes(v.protocol as number) || typeof v.firmware !== 'string' || v.firmware.length > 32) return null;
  if (!['usb', 'ble', 'secure', 'subscribed', 'armed'].every(key => typeof v[key] === 'boolean')) return null;
  if (!['brightness', 'brightnessCap', 'ledCount', 'pin', 'reports', 'uptime'].every(key => typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && (v[key] as number) >= 0)) return null;
  // Up to 0.6.0: 24 LEDs capped at 12/255. From 0.7.0: 0–255 with an estimated power limit and a saved LED count.
  if (v.pin !== 20 || ![12, 255].includes(v.brightnessCap as number) || (v.brightness as number) > (v.brightnessCap as number)) return null;
  if (v.brightnessCap === 12 ? v.ledCount !== 24 : (v.ledCount as number) < 1 || (v.ledCount as number) > 60) return null;
  if ('ledBudgetMa' in v && (!Number.isSafeInteger(v.ledBudgetMa) || (v.ledBudgetMa as number) < 0 || (v.ledBudgetMa as number) > 2000)) return null;
  let relay: RelayStatus | undefined;
  if (v.protocol === 3 || v.protocol === 4) {
    if (!v.relay || typeof v.relay !== 'object' || v.armed !== false) return null;
    const r = v.relay as Record<string, unknown>;
    if (r.mode !== (v.protocol === 4 ? 'profiles' : 'passthrough') || typeof r.error !== 'string' || r.error.length > 120) return null;
    if (v.protocol === 4 && (typeof r.correctionPending !== 'boolean' || !['corrections', 'cancelled'].every(key => Number.isSafeInteger(r[key]) && (r[key] as number) >= 0))) return null;
    if ('tracing' in r && (v.protocol !== 4 || typeof r.tracing !== 'boolean')) return null;
    if ('indicator' in r && (v.protocol !== 4 || ![0, 1, 2].includes(r.indicator as number))) return null;
    if (!['selfTest', 'mouseConnected', 'mouseSecure', 'mouseReady', 'pairing', 'savedMouse'].every(key => typeof r[key] === 'boolean')) return null;
    if (!relayNumbers.every(key => Number.isSafeInteger(r[key]) && (r[key] as number) >= 0)) return null;
    if ((r.buttons as number) > 255 || (r.queueDepth as number) > 64 || (r.stage as number) > 5) return null;
    relay = { mode: r.mode, error: r.error, selfTest: r.selfTest as boolean, mouseConnected: r.mouseConnected as boolean,
      mouseSecure: r.mouseSecure as boolean, mouseReady: r.mouseReady as boolean, pairing: r.pairing as boolean, savedMouse: r.savedMouse as boolean,
      ...Object.fromEntries(relayNumbers.map(key => [key, r[key]])),
      ...(v.protocol === 4 ? { corrections: r.corrections, cancelled: r.cancelled, correctionPending: r.correctionPending } : {}),
      ...(typeof r.tracing === 'boolean' ? { tracing: r.tracing } : {}),
      ...(typeof r.indicator === 'number' ? { indicator: r.indicator } : {}) } as RelayStatus;
  }
  return {
    board: 'recoil-c3', protocol: v.protocol as 2 | 3 | 4, firmware: v.firmware,
    usb: v.usb as boolean, ble: v.ble as boolean, secure: v.secure as boolean,
    subscribed: v.subscribed as boolean, armed: v.armed as boolean,
    brightness: v.brightness as number, brightnessCap: v.brightnessCap as number, ledCount: v.ledCount as number, pin: 20,
    ...(typeof v.ledBudgetMa === 'number' ? { ledBudgetMa: v.ledBudgetMa } : {}),
    reports: v.reports as number, uptime: v.uptime as number,
    ...(relay ? { relay } : {}),
  };
}

export async function listBoardPorts() {
  return (await SerialPort.list()).filter(port => ['303a', '2886'].includes(port.vendorId?.toLowerCase() ?? ''))
    .map(port => ({ path: port.path, label: `${port.path} · ${port.manufacturer ?? 'ESP32 USB'}`,
      usbVendorId: parseInt(port.vendorId ?? '', 16) || undefined, usbProductId: parseInt(port.productId ?? '', 16) || undefined }));
}

export class BoardConnection {
  private current: BoardState = idleBoardState();
  private port?: Transport;
  private buffer = '';
  private id = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pingPending = false;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private input?: RelayInput;
  private inputListeners = new Set<(input: RelayInput | undefined) => void>();
  private motionListeners = new Set<(frame: MotionFrame) => void>();
  private readonly createPort: (path: string) => Transport;
  private readonly changed: () => void;
  private readonly timeout: number;
  private readonly heartbeatMs: number;

  constructor(options: Options = {}) {
    this.createPort = options.createPort ?? (path => new SerialPort({ path, baudRate: 115200, autoOpen: false }));
    this.changed = options.onChange ?? (() => {});
    this.timeout = options.timeoutMs ?? 1800;
    this.heartbeatMs = options.heartbeatMs ?? 400;
  }

  get state(): BoardState { return structuredClone(this.current); }
  get isRelay(): boolean { return !!this.current.status?.relay; }
  get supportsProfiles(): boolean { return this.current.status?.protocol === 4; }
  get relayInput(): RelayInput | undefined { return this.input && { ...this.input }; }
  listenInput(listener: (input: RelayInput | undefined) => void): () => void {
    this.inputListeners.add(listener); listener(this.relayInput);
    return () => { this.inputListeners.delete(listener); };
  }
  private clearInput() { this.input = undefined; for (const listener of this.inputListeners) listener(undefined); }
  get supportsTrace(): boolean { return this.supportsProfiles && this.current.status?.relay?.tracing !== undefined; }
  listenMotion(listener: (frame: MotionFrame) => void): () => void {
    this.motionListeners.add(listener);
    return () => { this.motionListeners.delete(listener); };
  }
  get relayReady(): boolean {
    const status = this.current.status;
    return !!(this.current.connected && status?.relay?.selfTest && status.relay.mouseReady && status.ble && status.secure && status.subscribed);
  }
  get profileReady(): boolean {
    const status = this.current.status;
    if (this.isRelay) return !!(this.supportsProfiles && this.current.ready && this.relayReady && this.input?.connected && performance.now() - this.input.receivedAt < 150);
    return !!(this.current.ready && status?.usb && status.ble && status.secure && status.subscribed);
  }

  private rejectPending(message: string) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    this.pending.clear();
  }

  private fault(error: unknown) {
    this.current.error = error instanceof Error ? error.message : String(error);
    this.current.ready = false;
    if (!this.isRelay) clearInterval(this.heartbeat);
    this.rejectPending(this.current.error);
    this.changed();
  }

  private request(command: string, args = '', timeout = this.timeout): Promise<Reply> {
    const port = this.port;
    if (!port?.isOpen) return Promise.reject(new Error('Board USB port is closed.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Board did not acknowledge ${command}. Movement is never retried automatically.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      port.write(`${command} ${id}${args ? ` ${args}` : ''}\n`, error => {
        if (error) {
          clearTimeout(timer); this.pending.delete(id); reject(error);
        }
      });
    });
  }

  private receive(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 8192) { this.buffer = ''; this.fault(new Error('Board serial response exceeded the size limit.')); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue; // ROM/boot messages are not protocol frames.
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.kind === 'reply' && Number.isSafeInteger(value.id) && typeof value.ok === 'boolean') {
        const item = this.pending.get(value.id);
        if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(value.id);
        if (value.ok) item.resolve({ sent: value.sent }); else item.reject(new Error(`Board: ${String(value.error).slice(0, 100)}`));
      } else if (value?.kind === 'input') {
        if (![value.generation, value.stamp, value.buttons].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) || value.buttons > 255 || typeof value.connected !== 'boolean') {
          this.clearInput(); this.fault(new Error('Invalid relay button report.')); continue;
        }
        this.input = { buttons: value.buttons, generation: value.generation, stamp: value.stamp, connected: value.connected, receivedAt: performance.now() };
        for (const listener of this.inputListeners) listener(this.relayInput);
      } else if (value?.kind === 'motion') {
        if (![value.seq, value.stamp].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff)
          || ![value.dx, value.dy].every(n => Number.isSafeInteger(n) && Math.abs(n) <= 1_000_000)
          || !Number.isSafeInteger(value.buttons) || value.buttons < 0 || value.buttons > 255) {
          this.fault(new Error('Invalid relay motion report.')); continue;
        }
        const frame: MotionFrame = { seq: value.seq, stamp: value.stamp, dx: value.dx, dy: value.dy, buttons: value.buttons };
        for (const listener of this.motionListeners) listener(frame);
      } else if (value?.kind === 'status') {
        const status = parseBoardStatus(value);
        if (!status) { this.fault(new Error('Unsupported board firmware or LED configuration.')); continue; }
        this.current.status = status;
        if (this.current.ready && !status.usb && !this.isRelay) this.fault(new Error('Board heartbeat expired. Reconnect USB from this screen.'));
        if (this.isRelay && status.usb && this.current.error?.startsWith('USB status delayed')) this.current.error = null;
        this.changed();
      }
    }
  }

  async connect(path: string): Promise<void> {
    if (!/^COM\d+$/i.test(path)) throw new Error('Choose a Windows COM port.');
    await this.disconnect();
    const port = this.createPort(path);
    this.port = port; this.buffer = ''; this.id = 0; this.clearInput();
    this.current = { path, connected: false, ready: false, busy: false, status: null, error: null };
    port.on('data', (chunk: Buffer) => { if (this.port === port) this.receive(chunk); });
    port.on('error', error => { if (this.port === port) this.fault(error); });
    port.on('close', () => {
      if (this.port !== port) return;
      this.current.connected = false;
      this.clearInput();
      this.fault(new Error('Board USB disconnected.'));
    });
    this.changed();
    try {
      await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
      this.current.connected = true; this.changed();
      for (const protocol of ['RC4', 'RC3', 'RC2']) {
        try { await this.request('HELLO', protocol); break; }
        catch (error) { if (protocol === 'RC2' || !(error instanceof Error) || !error.message.startsWith('Board:')) throw error; }
      }
      const until = Date.now() + this.timeout;
      while (!this.current.status?.usb && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      if (!this.current.status?.usb) throw new Error('Board did not provide a valid protocol handshake.');
      await this.request('DISARM');
      this.current.ready = true;
      this.heartbeat = setInterval(() => {
        if (this.pingPending) return;
        this.pingPending = true;
        void this.request(this.isRelay && !this.current.ready ? 'HELLO' : 'PING', this.isRelay && !this.current.ready ? `RC${this.current.status!.protocol}` : '')
          .then(() => { if (this.port === port && this.isRelay) { this.current.ready = true; this.current.error = null; this.changed(); } })
          .catch(error => {
            if (this.port !== port) return;
            if (this.isRelay && port.isOpen) {
              this.current.ready = false; this.current.error = 'USB status delayed; reconnecting app session. Mouse passthrough continues independently.'; this.changed();
            } else this.fault(error);
          })
          .finally(() => { if (this.port === port) this.pingPending = false; });
      }, this.heartbeatMs);
      this.changed();
    } catch (error) {
      await this.disconnect(); this.fault(error); throw error;
    }
  }

  async setBrightness(value: unknown): Promise<void> {
    const cap = this.current.status?.brightnessCap ?? 12;
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > cap) throw new Error(`Brightness must be between 0 and ${cap}.`);
    if (!this.current.ready) throw new Error('Connect the board first.');
    await this.request('LED', String(value));
  }
  async setLedCount(value: unknown): Promise<void> {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 60) throw new Error('The LED count must be between 1 and 60.');
    if (!this.current.ready) throw new Error('Connect the board first.');
    if (this.current.status?.brightnessCap !== 255) throw new Error('Update the board firmware to 0.7.0 or later to change the LED count.');
    await this.request('LEDS', String(value));
  }

  async testMovement(): Promise<void> {
    if (this.isRelay) throw new Error('Relay firmware only forwards the physical mouse. Synthetic movement is disabled.');
    const status = this.current.status;
    if (!this.current.ready || !status?.usb || !status.ble || !status.secure || !status.subscribed) throw new Error('Pair the board over Bluetooth and wait for the mouse connection.');
    if (this.current.busy) throw new Error('A board test is already running.');
    this.current.busy = true; this.current.error = null; this.changed();
    try {
      await this.request('ARM');
      await this.request('MOVE', '8 0'); // Exactly one small relative movement, no clicks.
    } catch (error) { this.fault(error); throw error; }
    finally {
      try { await this.request('DISARM'); } catch (error) { this.fault(error); }
      this.current.busy = false; this.changed();
    }
  }

  async moveProfile(x: number, y: number, current: () => boolean): Promise<boolean> {
    if (this.isRelay && !this.supportsProfiles) throw new Error('Recoil output is disabled in passthrough firmware.');
    if (![x, y].every(value => Number.isInteger(value) && Math.abs(value) <= 127)) {
      throw new Error('Profile exceeds 127 counts per report. Lower output strength before enabling again.');
    }
    if (!this.profileReady) throw new Error('Bluetooth output is not ready.');
    if (this.current.busy) throw new Error('A board movement is still pending.');
    if (!current() || (!x && !y)) return false;
    this.current.busy = true;
    const started = performance.now();
    let sent = false;
    try {
      if (this.supportsProfiles) {
        const input = this.input;
        if (!input || !(input.buttons & 1) || !current()) return false;
        const result = await this.request('RFRAME', `${input.generation} ${input.stamp} ${x} ${y}`, Math.min(this.timeout, 100));
        sent = result.sent === true;
        return sent;
      }
      await this.request('ARM', '', Math.min(this.timeout, 100));
      // A release, pause, profile switch, or delayed acknowledgement invalidates this frame.
      if (!current()) return false;
      const remaining = 100 - (performance.now() - started);
      if (remaining <= 0) throw new Error('Bluetooth movement expired before transmission.');
      await this.request('FRAME', `${x} ${y}`, Math.min(this.timeout, remaining));
      sent = true;
      return true;
    } catch (error) { this.fault(error); throw error; }
    finally {
      if (!sent && !this.supportsProfiles) await this.disarm().catch(() => {});
      this.current.busy = false;
    }
  }

  async disarm(): Promise<void> {
    if (!this.port?.isOpen) return;
    try { await this.request('DISARM', '', Math.min(this.timeout, 100)); }
    catch (error) { this.fault(error); throw error; }
  }

  async pairMouse(): Promise<void> {
    if (!this.current.ready || !this.isRelay) throw new Error('Connect the relay firmware first.');
    await this.request('PAIR');
  }
  async setTrace(enabled: boolean): Promise<void> {
    if (!enabled && !this.port?.isOpen) return;
    if (!this.current.ready || !this.supportsTrace) throw new Error('Update the board firmware to 0.5.0 or later to record a pull.');
    await this.request('TRACE', enabled ? '1' : '0');
  }
  // Keeps the LEDs matching compensation. Display only: corrections are still gated per RFRAME.
  // Resends whenever the board's reported state differs, so reconnects and reboots catch up.
  private indicatorPending = false;
  syncIndicator(mode: 0 | 1 | 2): void {
    const shown = this.current.status?.relay?.indicator;
    if (shown === undefined || shown === mode || this.indicatorPending || !this.current.ready) return;
    this.indicatorPending = true;
    void this.request('IND', String(mode)).catch(() => {}).finally(() => { this.indicatorPending = false; });
  }
  async resetRelayStats(): Promise<void> {
    if (!this.current.ready || !this.isRelay) throw new Error('Connect the relay firmware first.');
    await this.request('RESETSTATS');
  }

  async disconnect(): Promise<void> {
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    const port = this.port;
    if (port?.isOpen && this.current.ready) await this.request('DISARM').catch(() => {});
    this.port = undefined;
    this.rejectPending('Board disconnected.');
    if (port?.isOpen) await new Promise<void>(resolve => port.close(() => resolve()));
    this.buffer = ''; this.pingPending = false; this.clearInput();
    this.current = { path: null, connected: false, ready: false, busy: false, status: null, error: null };
    this.changed();
  }
}
