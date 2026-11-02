import type { MotionFrame } from './desktop/board';

// One burst of fire: [microseconds since fire was pressed, dx, dy] per relayed motion frame.
export interface PullTake { samples: [number, number, number][]; durationMs: number; aiming: boolean }
export interface RecordingState { active: boolean; firing: boolean; takes: PullTake[]; notice: string | null }

export const recordingLimits = { maxTakes: 5, maxTakeMs: 15000, minTakeMs: 250, maxSessionMs: 10 * 60 * 1000 };
// supported: the board firmware can stream movement; available: it is connected and ready to record now.
export type RuntimeRecording = RecordingState & { supported: boolean; available: boolean };
export const idleRecording = (): RuntimeRecording => ({ active: false, firing: false, takes: [], notice: null, supported: false, available: false });

// Turns relayed physical movement into takes. A take runs from a fire press to its release;
// any lost frame or overlong burst discards the take rather than recording a wrong pull.
export class PullRecorder {
  private takes: PullTake[] = [];
  private current?: { start: number; samples: [number, number, number][]; aimingFrames: number };
  private lastSeq?: number;
  private wasFiring = false;
  private notice: string | null = null;
  active = false;

  get state(): RecordingState {
    return { active: this.active, firing: !!this.current, takes: structuredClone(this.takes), notice: this.notice };
  }

  start(): void { this.active = true; this.current = undefined; this.lastSeq = undefined; this.wasFiring = false; this.notice = null; }
  stop(): void { this.active = false; this.current = undefined; }
  clear(): void { this.takes = []; this.notice = null; }
  remove(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.takes.length) throw new Error('That take no longer exists.');
    this.takes.splice(index, 1);
  }

  // Returns true when the published state changed. canStart is false while the app itself has
  // focus: those presses are clicks on its own buttons, never a burst in the game.
  push(frame: MotionFrame, canStart = true): boolean {
    if (!this.active) return false;
    let changed = false;
    if (this.lastSeq !== undefined && frame.seq !== ((this.lastSeq + 1) >>> 0) && this.current) {
      this.current = undefined;
      this.notice = 'Some movement data was lost, so that take was discarded. Fire another full burst.';
      changed = true;
    }
    this.lastSeq = frame.seq;
    const firing = (frame.buttons & 1) !== 0;
    const rising = firing && !this.wasFiring;
    this.wasFiring = firing;
    if (!this.current) {
      // Only a fresh press starts a take; the press frame's movement happened before firing.
      if (rising && canStart) { this.current = { start: frame.stamp, samples: [], aimingFrames: 0 }; changed = true; }
      return changed;
    }
    const elapsed = (frame.stamp - this.current.start) >>> 0;
    this.current.samples.push([elapsed, frame.dx, frame.dy]);
    if (frame.buttons & 2) this.current.aimingFrames++;
    if (elapsed > recordingLimits.maxTakeMs * 1000) {
      this.current = undefined;
      this.notice = `Bursts longer than ${recordingLimits.maxTakeMs / 1000} s are discarded. Release fire after one magazine.`;
      return true;
    }
    if (!firing) this.finish(elapsed);
    return true;
  }

  private finish(elapsedUs: number) {
    const take = this.current!;
    this.current = undefined;
    const durationMs = elapsedUs / 1000;
    if (durationMs < recordingLimits.minTakeMs) { this.notice = 'That burst was too short. Hold fire for the whole magazine.'; return; }
    this.takes.push({ samples: take.samples, durationMs, aiming: take.aimingFrames * 2 > take.samples.length });
    if (this.takes.length > recordingLimits.maxTakes) this.takes.shift();
    this.notice = null;
  }
}
