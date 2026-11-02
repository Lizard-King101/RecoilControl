import { InputBackend, MouseContext } from '../input';

// Physical DPI measurement: raw horizontal counts over a user-measured distance.
// This never generates movement; intercepted events are forwarded unchanged.
export class DpiMeasurement {
  private context?: MouseContext;
  private active = false;
  private done: Promise<void> = Promise.resolve();
  private stopKeyboard?: () => void;
  private timeout?: ReturnType<typeof setTimeout>;
  private deviceId?: number;
  private counts = 0;
  private travel = 0;
  error: string | null = null;

  constructor(private readonly backend: InputBackend, private readonly onChange: () => void) {}
  get state() { return { running: this.active, counts: Math.abs(this.counts), travel: this.travel, error: this.error }; }

  start(): void {
    const context = this.backend.createContext();
    this.context = context;
    try {
      if (context.mouseCount() === 0) throw new Error('No mouse is available for measurement.');
      this.active = true;
      this.stopKeyboard = this.backend.listenKeyboard(key => { if (key === 'escape') void this.stop(); }, () => {});
      context.capture(true);
      this.timeout = setTimeout(() => void this.stop(), 20000);
      this.done = this.listen(context);
      this.onChange();
    } catch (error) {
      this.active = false;
      this.stopKeyboard?.();
      context.destroy();
      throw error;
    }
  }

  private async listen(context: MouseContext): Promise<void> {
    try {
      while (this.active) {
        const device = await context.wait(25);
        if (!device) {
          if (this.active && !context.mouseCount()) throw new Error('Mouse disconnected during measurement.');
          continue;
        }
        const stroke = device.receive();
        if (!stroke) continue;
        if (!device.send(stroke)) throw new Error('Unable to forward input during measurement.');
        if (!this.active || stroke.type !== 'mouse' || (stroke.flags & 1) || stroke.x === 0) continue;
        this.deviceId ??= device.id;
        if (device.id !== this.deviceId) continue;
        this.counts += stroke.x;
        this.travel += Math.abs(stroke.x);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.active = false;
      clearTimeout(this.timeout);
      try { this.stopKeyboard?.(); } finally {
        this.stopKeyboard = undefined;
        context.destroy();
        this.context = undefined;
        this.onChange();
      }
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    try { this.context?.capture(false); } catch (error) { this.error = String(error); }
    await this.done;
  }
}
