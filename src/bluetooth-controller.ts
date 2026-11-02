import { ButtonInput } from './button-input';
import { Clock, Key, systemClock } from './input';
import { RecoilEngine } from './recoil-engine';

export interface ProfileOutput {
  readonly profileReady: boolean;
  moveProfile(x: number, y: number, current: () => boolean): Promise<boolean>;
  disarm(): Promise<void>;
}

// No queued motion: one report in flight, fresh button press after every pause.
export class BluetoothController {
  private readonly clock: Clock;
  private readonly keys = new Set<Key>();
  private stopInput?: () => void;
  private stopTimer?: () => void;
  private flight?: Promise<void>;
  private active = false;
  private disposed = false;
  private suspended = false;
  private left = false;
  private right = false;
  private releaseRequired = false;
  private epoch = 0;
  private lastTick = 0;
  private burstStarted = 0;
  private readonly counters = { mouseEvents: 0, firePresses: 0, movementAttempts: 0, movementsAccepted: 0, ticks: 0, maxTickMs: 0 };

  constructor(private readonly input: ButtonInput, private readonly output: ProfileOutput,
    private readonly engine: RecoilEngine,
    private readonly options: { clock?: Clock; onStatus?: () => void; onError?: (error: unknown) => void; legacyToggle?: boolean } = {}) {
    this.clock = options.clock ?? systemClock;
  }
  get enabled() { return this.active; }
  get status() { return { enabled: this.active, paused: this.paused, profile: this.engine.profile.name }; }
  private get paused() { return this.suspended || this.keys.has('shift') || this.keys.has('shiftRight') || this.releaseRequired; }
  get diagnostics() {
    return { ...this.status, ...this.counters, shooting: this.left, aiming: this.right,
      pauseReasons: [...(this.suspended ? ['configuration'] : []),
        ...(this.keys.has('shift') || this.keys.has('shiftRight') ? ['shift'] : []),
        ...(this.releaseRequired ? ['release fire'] : [])] };
  }
  start() {
    if (this.disposed) throw new Error('This controller has been disposed.');
    if (this.stopInput) return;
    this.stopInput = this.input.listen({ keyDown: this.keyDown, keyUp: this.keyUp, mouse: this.mouse });
    this.stopTimer = this.clock.every(() => this.tick(), 1000 / 60);
  }
  async setEnabled(value: boolean) {
    if (value) {
      if (this.disposed || !this.stopInput) throw new Error('Start the button listener first.');
      if (!this.output.profileReady) throw new Error('Connect USB and the Bluetooth mouse before enabling.');
      if (this.active) return;
      if (this.flight) throw new Error('Previous movement is still stopping. Try enabling again.');
      this.active = true;
      this.releaseRequired = this.left;
      this.lastTick = this.clock.now();
      this.engine.reset(); this.updateInput(); this.options.onStatus?.();
    } else {
      this.active = false; this.cancelBurst(); this.options.onStatus?.();
      await this.output.disarm().catch(() => {});
      await this.flight;
    }
  }
  setSuspended(value: boolean) {
    this.suspended = value;
    if (value) { this.releaseRequired = this.left; this.cancelBurst(); void this.output.disarm().catch(() => {}); }
    this.updateInput();
  }
  checkOutput() { if (this.active && !this.output.profileReady) this.fail(new Error('Bluetooth output disconnected. Reconnect and enable again.')); }
  private cancelBurst() { this.epoch++; this.engine.reset(); this.lastTick = this.clock.now(); }
  private updateInput() {
    this.engine.setInput({ shooting: this.active && this.left && !this.releaseRequired, aiming: this.right,
      crouching: this.keys.has('control') || this.keys.has('controlRight'), paused: this.paused });
  }
  private fail(error: unknown) {
    this.active = false; this.cancelBurst();
    this.options.onError?.(error); this.options.onStatus?.();
    void this.output.disarm().catch(() => {});
  }
  private tick() {
    if (!this.active) return;
    this.checkOutput();
    if (!this.active) return;
    const now = this.clock.now();
    const elapsed = now - this.lastTick;
    this.counters.ticks++;
    this.counters.maxTickMs = Math.max(this.counters.maxTickMs, Math.round(elapsed));
    if (elapsed > 100 || elapsed < 0) { this.fail(new Error('Bluetooth output stopped after a timing gap. Enable again to resume.')); return; }
    if (!this.left || this.paused) { this.lastTick = now; return; }
    if (now - this.burstStarted >= 10000) { this.fail(new Error('10-second burst limit reached. Release fire, then enable again.')); return; }
    if (this.flight) return; // Integrate elapsed time next tick; never accumulate a report queue.
    this.lastTick = now;
    const [x, y] = this.engine.advance(elapsed);
    if (!x && !y) return;
    const epoch = this.epoch;
    this.counters.movementAttempts++;
    this.flight = this.output.moveProfile(x, y, () => this.active && this.left && !this.paused && this.epoch === epoch)
      .then(sent => { if (sent) this.counters.movementsAccepted++; })
      .catch(error => this.fail(error))
      .finally(() => { this.flight = undefined; });
  }
  private mouse = (button: 'left' | 'right', down: boolean) => {
    this.counters.mouseEvents++;
    if (button === 'right') this.right = down;
    else {
      if (down && !this.left) {
        this.counters.firePresses++; this.burstStarted = this.clock.now(); this.lastTick = this.burstStarted;
        if (!this.active || this.paused) this.releaseRequired = true;
      }
      this.left = down;
      if (!down) { this.releaseRequired = false; this.cancelBurst(); }
    }
    this.updateInput();
  };
  private keyDown = (key: Key) => {
    if (this.keys.has(key) || this.disposed) return;
    this.keys.add(key);
    if (key === 'escape') void this.setEnabled(false).catch(error => this.fail(error));
    else if (this.options.legacyToggle !== false && (key === 'enter' || key === 'plus') && this.keys.has('enter') && this.keys.has('plus') && !this.keys.has('escape')) {
      void this.setEnabled(!this.active).catch(error => this.fail(error));
    }
    if (key === 'shift' || key === 'shiftRight') { this.releaseRequired = this.left; this.cancelBurst(); void this.output.disarm().catch(() => {}); }
    this.updateInput();
  };
  private keyUp = (key: Key) => { this.keys.delete(key); this.updateInput(); };
  async dispose() {
    this.disposed = true;
    this.stopTimer?.(); this.stopTimer = undefined;
    try { this.stopInput?.(); } finally { this.stopInput = undefined; this.keys.clear(); await this.setEnabled(false); }
  }
}
