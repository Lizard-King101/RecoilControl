import { Clock, InputBackend, InputDevice, inspectBackend, Key, missingDriverMessage, MouseContext, postureFromKeys, systemClock } from './input';
import { RecoilEngine } from './recoil-engine';

interface Session {
  context: MouseContext;
  active: boolean;
  lastTick: number;
  cancelTimer?: () => void;
  done: Promise<void>;
}

interface Options {
  legacyToggle?: boolean;
  clock?: Clock;
  engine?: RecoilEngine;
  onStatus?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export class AntiRecoil {
  private readonly clock: Clock;
  private readonly engine: RecoilEngine;
  private readonly onStatus: (message: string) => void;
  private readonly onError: (error: unknown) => void;
  private readonly keys = new Set<Key>();
  private readonly shootingMice = new Map<number, InputDevice>();
  private readonly aimingMice = new Set<number>();
  private stopKeyboard?: () => void;
  private session?: Session;
  private requestedEnabled = false;
  private disposed = false;
  private suspended = false;
  private readonly legacyToggle: boolean;
  private readonly counters = {
    mouseEvents: 0, firePresses: 0, movementAttempts: 0, movementsAccepted: 0,
    ticks: 0, maxTickMs: 0,
  };

  constructor(private readonly backend: InputBackend, options: Options = {}) {
    this.legacyToggle = options.legacyToggle !== false;
    this.clock = options.clock ?? systemClock;
    this.engine = options.engine ?? new RecoilEngine();
    this.onStatus = options.onStatus ?? console.log;
    this.onError = options.onError ?? console.error;
  }

  get enabled(): boolean { return this.session?.active ?? false; }
  get status() {
    return { enabled: this.enabled, paused: this.engine.paused, profile: this.engine.profile.name };
  }

  get diagnostics() {
    return {
      ...this.status,
      pauseReasons: [
        ...(this.suspended ? ['configuration'] : []),
        ...(this.keys.has('shift') || this.keys.has('shiftRight') ? ['shift'] : []),
      ],
      shooting: this.shootingMice.size > 0,
      aiming: this.aimingMice.size > 0,
      ...this.counters,
    };
  }

  setSuspended(value: boolean): void {
    this.suspended = value;
    this.updateInput();
  }

  start(): void {
    if (this.disposed) throw new Error('This controller has been disposed.');
    if (this.stopKeyboard) return;
    if (inspectBackend(this.backend) === 0) throw new Error(missingDriverMessage);
    this.stopKeyboard = this.backend.listenKeyboard(this.keyDown, this.keyUp);
    this.onStatus('Ready (disabled). Enter + Numpad Plus: toggle. Escape: disable. Hold Shift: pause.');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.requestedEnabled = enabled && !this.disposed;
    if (!this.requestedEnabled) {
      const session = this.session;
      if (session) {
        this.deactivate(session);
        await session.done;
      }
      return;
    }
    if (!this.stopKeyboard) {
      this.requestedEnabled = false;
      throw new Error('Start the controller before enabling it.');
    }
    if (this.session?.active) return;
    // A previous wait must settle before destroying its context or starting another loop.
    if (this.session) await this.session.done;
    if (!this.requestedEnabled || this.disposed || this.session) return;

    let context: MouseContext | undefined;
    try {
      context = this.backend.createContext();
      if (context.mouseCount() === 0) throw new Error(missingDriverMessage);
      const session: Session = {
        context, active: true, lastTick: this.clock.now(), done: Promise.resolve(),
      };
      this.session = session;
      this.updateInput();
      context.capture(true);
      session.cancelTimer = this.clock.every(() => this.tick(session), 1000 / 60);
      this.onStatus('Recoil control enabled.');
      session.done = this.listen(session);
    } catch (error) {
      this.requestedEnabled = false;
      if (this.session) this.deactivate(this.session);
      this.session = undefined;
      context?.destroy();
      throw error;
    }
  }

  private deactivate(session: Session): void {
    if (!session.active) return;
    session.active = false;
    session.cancelTimer?.();
    this.shootingMice.clear();
    this.aimingMice.clear();
    this.engine.reset();
    // Release capture immediately, but leave the context alive until wait() settles.
    try { session.context.capture(false); } catch (error) { this.onError(error); }
    this.onStatus('Recoil control disabled.');
  }

  private async listen(session: Session): Promise<void> {
    try {
      while (session.active) {
        const device = await session.context.wait(25);
        if (!device) {
          if (session.active && session.context.mouseCount() === 0) throw new Error('All mice disconnected.');
          continue;
        }
        const stroke = device.receive();
        if (!stroke) continue;
        if (stroke.type === 'mouse') {
          this.counters.mouseEvents++;
          if (stroke.state & 1) this.counters.firePresses++;
        }
        // Preserve every field and return events to their source, including events already
        // intercepted when disable was requested. Never turn movement into a button press.
        if (!device.send(stroke)) throw new Error(`Unable to forward input from device ${device.id}.`);
        if (!session.active || stroke.type !== 'mouse') continue;
        if (stroke.state & 1) this.shootingMice.set(device.id, device);
        if (stroke.state & 2) this.shootingMice.delete(device.id);
        if (stroke.state & 4) this.aimingMice.add(device.id);
        if (stroke.state & 8) this.aimingMice.delete(device.id);
        this.updateInput();
      }
    } catch (error) {
      this.requestedEnabled = false;
      this.onError(error);
    } finally {
      this.deactivate(session);
      try { session.context.destroy(); } catch (error) { this.onError(error); }
      if (this.session === session) this.session = undefined;
    }
  }

  private tick(session: Session): void {
    if (!session.active) return;
    try {
      const now = this.clock.now();
      const delta = now - session.lastTick;
      session.lastTick = now;
      this.counters.ticks++;
      this.counters.maxTickMs = Math.max(this.counters.maxTickMs, Math.round(delta));
      const [x, y] = this.engine.advance(delta);
      const mouse = this.shootingMice.values().next().value;
      if (mouse && (x !== 0 || y !== 0)) {
        // The binding's enum omits zero, although zero is the native movement-only state.
        this.counters.movementAttempts++;
        if (!mouse.send({ type: 'mouse', flags: 0, state: 0, x, y, rolling: 0, information: 0 })) {
          throw new Error('Unable to send mouse movement.');
        }
        // Acceptance by the driver does not establish consumption by a game.
        this.counters.movementsAccepted++;
      }
    } catch (error) {
      this.requestedEnabled = false;
      this.deactivate(session);
      this.onError(error);
    }
  }

  private updateInput(): void {
    this.engine.setInput({
      shooting: this.shootingMice.size > 0,
      aiming: this.aimingMice.size > 0,
      crouching: this.keys.has('control') || this.keys.has('controlRight'),
      posture: postureFromKeys(this.keys),
      paused: this.suspended || this.keys.has('shift') || this.keys.has('shiftRight'),
    });
  }

  private keyDown = (key: Key): void => {
    if (this.disposed || this.keys.has(key)) return;
    this.keys.add(key);
    if (key === 'escape') {
      void this.setEnabled(false).catch(this.onError);
    } else if (this.legacyToggle && (key === 'enter' || key === 'plus') && !this.keys.has('escape')
      && this.keys.has('enter') && this.keys.has('plus')) {
      void this.setEnabled(!this.requestedEnabled).catch(this.onError);
    }
    this.updateInput();
  };

  private keyUp = (key: Key): void => {
    this.keys.delete(key);
    this.updateInput();
  };

  async dispose(): Promise<void> {
    this.disposed = true;
    const done = this.setEnabled(false);
    try { this.stopKeyboard?.(); } finally {
      this.stopKeyboard = undefined;
      this.keys.clear();
      this.engine.reset();
      await done;
    }
  }
}
