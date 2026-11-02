import { Key } from './input';
import { Vector } from './profiles';
import { RecoilEngine } from './recoil-engine';

export interface TuningState {
  active: boolean;
  dirty: boolean;
  step: number;
  current: number;
  target: number | null; // null follows input; an index pins only the editing target.
  stances: { name: string; x: number; y: number; maxX: number; maxY: number }[];
}

export const idleTuning = (): TuningState => ({ active: false, dirty: false, step: 0.01, current: 0, target: null, stances: [] });

// One step per physical key press. Edits never restart the engine or fire a mouse report.
export class LiveTuning {
  private active = false;
  private step = 0.01;
  private target: number | null = null;
  private gains: [number, number][];
  private readonly held = new Set<Key>();
  constructor(private readonly engine: RecoilEngine, private readonly limits?: readonly Vector[]) {
    this.gains = engine.weapon.recoils.map(() => [1, 1]);
  }
  get state(): TuningState {
    return { active: this.active, dirty: this.gains.some(pair => pair.some(v => v !== 1)), step: this.step,
      current: this.target ?? this.engine.stanceIndex, target: this.target,
      stances: this.engine.weapon.recoils.map((stance, i) => ({ name: stance.name, x: this.gains[i][0], y: this.gains[i][1],
        maxX: this.limits?.[i]?.[0] ?? 3, maxY: this.limits?.[i]?.[1] ?? 3 })) };
  }
  setActive(value: boolean): void { this.active = value; }
  setTarget(value: number | null): void {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value >= this.gains.length)) {
      throw new Error('Choose an available stance or follow the current stance.');
    }
    this.target = value;
  }
  setStep(value: number): void {
    if (![0.01, 0.02, 0.05].includes(value)) throw new Error('Choose a 1%, 2%, or 5% tuning step.');
    this.step = value;
  }
  reset(): void {
    this.active = false;
    this.target = null;
    this.gains = this.engine.weapon.recoils.map(() => [1, 1]);
    this.engine.setStanceGains(this.gains);
  }
  keyDown(key: Key, suspended: boolean): void {
    if (this.held.has(key)) return;
    this.held.add(key);
    if (key === 'escape') { this.active = false; return; }
    if (suspended) return;
    if (key === 'f8') { this.active = !this.active; return; }
    if (key === 'f9' && this.active) {
      this.target = this.target === null ? 0 : this.target + 1 < this.gains.length ? this.target + 1 : null;
      return;
    }
    if (!this.active || !['left', 'right', 'up', 'down'].includes(key)) return;
    const index = this.target ?? this.engine.stanceIndex;
    const axis = key === 'left' || key === 'right' ? 0 : 1;
    const direction = key === 'right' || key === 'up' ? 1 : -1;
    const max = this.limits?.[index]?.[axis] ?? 3;
    this.gains[index][axis] = Math.max(0, Math.min(max, Math.round((this.gains[index][axis] + direction * this.step) * 100) / 100));
    this.engine.setStanceGains(this.gains);
  }
  keyUp(key: Key): void { this.held.delete(key); }
}
