export type Vector = readonly [number, number];
// "aiming" is ADS; other IDs refer to a game's mutually exclusive postures.
export type Condition = string;

export interface RecoilProfile {
  readonly name: string;
  readonly activate: readonly Condition[];
  readonly multipliers: Vector;
  readonly vectors: readonly Vector[];
}

export interface WeaponProfile {
  readonly name: string;
  readonly rpm: number;
  readonly units?: 'counts'; // Missing means the original velocity-vector format.
  readonly mode: 'loop' | 'start' | 'end';
  readonly recoils: readonly RecoilProfile[];
}

// The experimental branch's original tuning. These values are not game-calibrated.
export const akProfile: WeaponProfile = {
  name: 'AK',
  rpm: 450,
  mode: 'end',
  recoils: [
    {
      name: 'Default', activate: [], multipliers: [0.1, 0.09],
      vectors: [[-0.25, 1], [-0.25, 1], [-0.26, 1], [-0.28, 1], [-0.3, 1], [-0.65, 1]],
    },
    {
      name: 'Crouch', activate: ['crouching'], multipliers: [0.08, 0.06],
      vectors: [[-0.24, 0.8], [-0.24, 0.8], [-0.25, 0.8], [-0.26, 0.8], [-0.28, 0.8], [-0.3, 0.79]],
    },
    {
      name: 'ADS', activate: ['aiming'], multipliers: [0.11, 0.1],
      vectors: [[-0.26, 1], [-0.26, 1], [-0.27, 1], [-0.28, 1], [-0.3, 0.98], [-0.6, 0.95]],
    },
    {
      name: 'Crouch ADS', activate: ['crouching', 'aiming'], multipliers: [0.07, 0.05],
      vectors: [[-0.24, 0.99], [-0.25, 0.96], [-0.26, 0.95], [-0.28, 0.94], [-0.295, 0.94], [-0.5, 0.93]],
    },
  ],
};
