import { akProfile, RecoilProfile, Vector, WeaponProfile } from './profiles';

export interface InputState {
  shooting: boolean;
  aiming: boolean;
  crouching: boolean;
  posture?: string | null;
  paused: boolean;
}

const idleInput = (): InputState => ({ shooting: false, aiming: false, crouching: false, paused: false });

export class RecoilEngine {
  private input = idleInput();
  private shot = 0;
  private phase = 0;
  private remainder: [number, number] = [0, 0];
  private readonly profiles: readonly RecoilProfile[];
  private gains: readonly Vector[];

  constructor(readonly weapon: WeaponProfile = akProfile) {
    if (!Number.isFinite(weapon.rpm) || weapon.rpm <= 0 || weapon.rpm > 6000) {
      throw new Error('RPM must be greater than 0 and at most 6000.');
    }
    if (!weapon.recoils.some(profile => profile.activate.length === 0)) {
      throw new Error('A default recoil profile is required.');
    }
    for (const profile of weapon.recoils) {
      if (!profile.vectors.length || ![...profile.multipliers, ...profile.vectors.flat()].every(Number.isFinite)) {
        throw new Error(`Invalid recoil values in ${profile.name}.`);
      }
    }
    this.profiles = [...weapon.recoils].sort((a, b) => b.activate.length - a.activate.length
      || Number(a.activate.includes('aiming')) - Number(b.activate.includes('aiming')));
    this.gains = weapon.recoils.map(() => [1, 1]);
  }

  get stanceIndex(): number { return this.weapon.recoils.indexOf(this.profile); }

  setStanceGains(gains: readonly Vector[]): void {
    if (gains.length !== this.weapon.recoils.length || gains.some(pair => pair.length !== 2 || pair.some(value => !Number.isFinite(value) || value < 0 || value > 3))) {
      throw new Error('Invalid stance tuning.');
    }
    this.gains = gains.map(pair => [pair[0], pair[1]]);
    // Never carry a fraction at the previous strength into the next report.
    this.remainder = [0, 0];
  }

  get profile(): RecoilProfile {
    const posture = this.input.posture === undefined ? (this.input.crouching ? 'crouching' : null) : this.input.posture;
    return this.profiles.find(profile => profile.activate.every(condition => condition === 'aiming' ? this.input.aiming : condition === posture))!;
  }

  get paused(): boolean { return this.input.paused; }

  setInput(input: InputState): void {
    const previousProfile = this.profile;
    const wasPaused = this.input.paused;
    this.input = { ...input };
    if (!input.shooting || input.paused || wasPaused) this.resetBurst();
    else if (previousProfile !== this.profile) this.remainder = [0, 0];
  }

  reset(): void {
    this.input = idleInput();
    this.resetBurst();
  }

  private resetBurst(): void {
    this.shot = 0;
    this.phase = 0;
    this.remainder = [0, 0];
  }

  advance(deltaMs: number): Vector {
    if (!this.input.shooting || this.input.paused) return [0, 0];
    // Do not replay a backlog after sleep, a debugger pause, or a stalled event loop.
    if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > 250) {
      this.resetBurst();
      return [0, 0];
    }
    const duration = 60000 / this.weapon.rpm;
    const profile = this.profile;
    const gain = this.gains[this.stanceIndex];
    while (deltaMs > 1e-9) {
      const step = Math.min(deltaMs, duration - this.phase);
      const end = this.phase + step;
      const last = profile.vectors.length - 1;
      const index = this.weapon.mode === 'loop' ? this.shot % profile.vectors.length
        : this.shot <= last ? this.shot : this.weapon.mode === 'start' ? 0 : last;
      const vector = profile.vectors[index];
      // Integrate the old easeOutQuint velocity at its nominal 60 Hz scale.
      // This gives the same distance at different tick rates instead of dividing by frame time.
      const integral = (t: number) => t + Math.pow(1 - t, 6) / 6;
      const distance = (integral(end / duration) - integral(this.phase / duration)) * (this.weapon.units === 'counts' ? 6 / 5 : duration * 3.6);
      this.remainder[0] += vector[0] * profile.multipliers[0] * gain[0] * distance;
      this.remainder[1] += vector[1] * profile.multipliers[1] * gain[1] * distance;
      this.phase = end;
      deltaMs -= step;
      if (this.phase >= duration - 1e-9) {
        this.phase = 0;
        this.shot++;
      }
    }
    // The Windows driver takes integers. Keep subpixel motion for subsequent ticks.
    const x = Math.trunc(this.remainder[0]) || 0;
    const y = Math.trunc(this.remainder[1]) || 0;
    this.remainder[0] -= x;
    this.remainder[1] -= y;
    return [x, y];
  }
}
