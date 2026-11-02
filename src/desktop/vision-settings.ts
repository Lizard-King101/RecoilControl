import { activeSetup, effectiveProfile, selected, Settings, validateSettings } from './settings';
import type { Vector } from '../profiles';
export function visionContext(settings: Settings) {
  const { game, weapon } = selected(settings), setup = activeSetup(weapon);
  return { key: JSON.stringify([game.id, weapon.id, weapon.selectedSetupId, game.input, setup]),
    game: game.name, weapon: weapon.name, setup: setup === weapon ? 'Base' : weapon.setups.find(s => s.id === weapon.selectedSetupId)!.name,
    profile: effectiveProfile(settings) };
}
export function applyVisionVectors(settings: Settings, key: string, stanceIndex: number, vectors: unknown, rpm: number): Settings {
  if (!Number.isFinite(rpm) || rpm < 30 || rpm > 2000) throw new Error('RPM must be between 30 and 2000.');
  if (key !== visionContext(settings).key) throw new Error('This setup changed. Reload the lab before saving a candidate.');
  if (!Number.isInteger(stanceIndex) || !Array.isArray(vectors) || vectors.length < 1 || vectors.length > 120 || vectors.some(v => !Array.isArray(v) || v.length !== 2 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000))) throw new Error('Invalid candidate vectors.');
  const next = structuredClone(settings), { game, weapon } = selected(next), setup = activeSetup(weapon);
  if (!setup.profile || !setup.profile.recoils[stanceIndex]) throw new Error('Choose a configured stance.');
  const scale = setup.profile.units === 'counts' ? 1 : 180000 / setup.profile.rpm;
  const reference = setup.calibration;
  const sensitivity = reference ? reference.sensitivity / game.input.sensitivity : 1;
  const ads = reference && setup.profile.recoils[stanceIndex].activate.includes('aiming') ? reference.adsMultiplier / game.input.adsMultiplier : 1;
  const factors = [setup.tuning.x * sensitivity * ads, setup.tuning.y * sensitivity * ads];
  setup.profile = { ...setup.profile, rpm, units: 'counts', recoils: setup.profile.recoils.map((stance, i) => ({ ...stance, multipliers: [1, 1],
    vectors: Array.from({ length: i === stanceIndex ? Math.max(stance.vectors.length, vectors.length) : stance.vectors.length }, (_, shot) => (i === stanceIndex && shot < vectors.length
      ? (vectors[shot] as number[]).map((v, axis) => v / factors[axis])
      : stance.vectors[shot].map((v, axis) => v * stance.multipliers[axis] * scale)) as unknown as Vector) })) };
  setup.provenance = 'manual';
  return validateSettings(next);
}
