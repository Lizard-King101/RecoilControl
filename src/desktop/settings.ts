import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { akProfile, WeaponProfile } from '../profiles';
import type { TuningState } from '../live-tuning';
import { defaultBindings, GameBindings, validateBindingConflicts, validateBindings, validateShortcut } from '../key-bindings';

export interface InputSetup { dpi: number; sensitivity: number; adsMultiplier: number }
export interface WeaponSettings {
  hotkey: string | null;
  id: string;
  name: string;
  category: string;
  profile: WeaponProfile | null;
  tuning: { x: number; y: number };
  provenance: 'legacy' | 'template' | 'manual' | 'calibrated';
  calibration: (InputSetup & { at: string }) | null;
}
export interface GameSettings {
  bindings: GameBindings;
  id: string;
  name: string;
  input: InputSetup;
  selectedWeaponId: string;
  weapons: WeaponSettings[];
}
export interface Settings {
  version: 1;
  output: 'interception' | 'bluetooth';
  selectedGameId: string;
  games: GameSettings[];
  hud: { visible: boolean; locked: boolean; opacity: number; x: number | null; y: number | null };
}

export function defaultSettings(): Settings {
  const catalog = [
    ['ak', 'Assault Rifle', 'Rifle'], ['lr300', 'LR-300', 'Rifle'],
    ['mp5', 'MP5A4', 'SMG'], ['thompson', 'Thompson', 'SMG'],
    ['custom-smg', 'Custom SMG', 'SMG'], ['m249', 'M249', 'LMG'],
  ];
  return {
    version: 1, output: 'interception', selectedGameId: 'rust',
    games: [{ id: 'rust', name: 'Rust', bindings: defaultBindings(), input: { dpi: 800, sensitivity: 1, adsMultiplier: 1 }, selectedWeaponId: 'ak',
      weapons: catalog.map(([id, name, category]) => ({
        id, name, category, hotkey: null, profile: id === 'ak' ? structuredClone(akProfile) : null,
        tuning: { x: 1, y: 1 }, provenance: id === 'ak' ? 'legacy' : 'template', calibration: null,
      })),
    }],
    hud: { visible: false, locked: false, opacity: 0.94, x: null, y: null },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}
function list(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected true or false.');
  return value;
}
function input(value: unknown): InputSetup {
  const setup = object(value);
  return {
    dpi: number(setup.dpi, 'DPI', 50, 64000),
    sensitivity: number(setup.sensitivity, 'Sensitivity', 0.01, 20),
    adsMultiplier: number(setup.adsMultiplier, 'ADS multiplier', 0.05, 10),
  };
}
function vector(value: unknown, max = 10): [number, number] {
  const pair = list(value, 'vector', 2, 2);
  return [number(pair[0], 'Vector X', -max, max), number(pair[1], 'Vector Y', -max, max)];
}

export function validateProfile(value: unknown): WeaponProfile {
  const profile = object(value);
  if (profile.units !== undefined && profile.units !== 'counts') throw new Error('Unknown pattern units.');
  const mode = text(profile.mode, 'repeat mode');
  if (mode !== 'loop' && mode !== 'start' && mode !== 'end') throw new Error('Invalid repeat mode.');
  const recoils = list(profile.recoils, 'stances', 1, 4).map(value => {
    const recoil = object(value);
    const activate = list(recoil.activate, 'conditions', 0, 2).map(condition => {
      if (condition !== 'aiming' && condition !== 'crouching') throw new Error('Unknown stance condition.');
      return condition;
    });
    if (new Set(activate).size !== activate.length) throw new Error('Duplicate stance condition.');
    const multipliers = vector(recoil.multipliers);
    multipliers.forEach(value => number(value, 'Multiplier', 0, 2));
    return { name: text(recoil.name, 'stance name'), activate, multipliers,
      vectors: list(recoil.vectors, 'vectors', 1, 120).map(value => vector(value, profile.units === 'counts' ? 1000 : 10)) };
  });
  if (!recoils.some(recoil => recoil.activate.length === 0)) throw new Error('A default stance is required.');
  const conditions = recoils.map(recoil => [...recoil.activate].sort().join(','));
  if (new Set(conditions).size !== conditions.length) throw new Error('Duplicate stance.');
  return { name: text(profile.name, 'profile name'), rpm: number(profile.rpm, 'RPM', 30, 2000), mode, recoils, ...(profile.units === 'counts' ? { units: 'counts' as const } : {}) };
}

export function validateWeapon(value: unknown): WeaponSettings {
  const weapon = object(value);
  const tuning = object(weapon.tuning);
  const provenance = weapon.provenance;
  if (!['legacy', 'template', 'manual', 'calibrated'].includes(String(provenance))) throw new Error('Invalid profile provenance.');
  let calibration: WeaponSettings['calibration'] = null;
  if (weapon.calibration !== null) {
    const record = object(weapon.calibration);
    const at = text(record.at, 'calibration date');
    if (!Number.isFinite(Date.parse(at))) throw new Error('Invalid calibration date.');
    calibration = { ...input(record), at };
  }
  const profile = weapon.profile === null ? null : validateProfile(weapon.profile);
  if (provenance === 'calibrated' && (!calibration || !profile)) throw new Error('Calibration requires a configured profile.');
  if ((provenance === 'template') !== (profile === null)) throw new Error('Template status does not match the profile.');
  return {
    id: text(weapon.id, 'weapon ID'), name: text(weapon.name, 'weapon name'), category: text(weapon.category, 'category'),
    hotkey: weapon.hotkey == null ? null : validateShortcut(weapon.hotkey),
    profile, calibration, provenance: provenance as WeaponSettings['provenance'],
    tuning: { x: number(tuning.x, 'Horizontal strength', 0.05, 5), y: number(tuning.y, 'Vertical strength', 0.05, 5) },
  };
}

export function validateSettings(value: unknown): Settings {
  const settings = object(value);
  if (settings.version !== 1) throw new Error('Unsupported settings version.');
  const output = settings.output ?? 'interception';
  if (output !== 'interception' && output !== 'bluetooth') throw new Error('Unknown output device.');
  const games = list(settings.games, 'game collections', 1, 20).map(value => {
    const game = object(value);
    const weapons = list(game.weapons, 'weapons', 1, 100).map(validateWeapon);
    const bindings = validateBindings(game.bindings);
    validateBindingConflicts(bindings, weapons);
    if (new Set(weapons.map(weapon => weapon.id)).size !== weapons.length) throw new Error('Duplicate weapon ID.');
    const selectedWeaponId = text(game.selectedWeaponId, 'selected weapon');
    if (!weapons.some(weapon => weapon.id === selectedWeaponId)) throw new Error('Selected weapon is missing.');
    return { id: text(game.id, 'game ID'), name: text(game.name, 'game name'), bindings, input: input(game.input), selectedWeaponId, weapons };
  });
  if (new Set(games.map(game => game.id)).size !== games.length) throw new Error('Duplicate game ID.');
  const selectedGameId = text(settings.selectedGameId, 'selected game');
  if (!games.some(game => game.id === selectedGameId)) throw new Error('Selected game is missing.');
  const hud = object(settings.hud);
  return {
    version: 1, output, selectedGameId, games,
    hud: { visible: bool(hud.visible), locked: bool(hud.locked), opacity: number(hud.opacity, 'HUD opacity', 0.3, 1),
      x: hud.x === null ? null : number(hud.x, 'HUD X', -100000, 100000),
      y: hud.y === null ? null : number(hud.y, 'HUD Y', -100000, 100000) },
  };
}

export function selected(settings: Settings): { game: GameSettings; weapon: WeaponSettings } {
  const game = settings.games.find(game => game.id === settings.selectedGameId)!;
  return { game, weapon: game.weapons.find(weapon => weapon.id === game.selectedWeaponId)! };
}

export function selectWeapon(settings: Settings, request: { id?: string; direction?: number }): Settings {
  const next = structuredClone(settings), { game } = selected(next);
  if (request.direction === 1 || request.direction === -1) {
    const configured = game.weapons.filter(w => w.profile);
    if (!configured.length) throw new Error('Configure a weapon pattern before cycling weapons.');
    const index = configured.findIndex(w => w.id === game.selectedWeaponId);
    game.selectedWeaponId = configured[(index < 0 ? (request.direction === 1 ? 0 : configured.length - 1) : index + request.direction + configured.length) % configured.length].id;
  } else if (typeof request.id === 'string' && game.weapons.some(w => w.id === request.id)) game.selectedWeaponId = request.id;
  else throw new Error('Choose a weapon in this game.');
  return next;
}

export function effectiveProfile(settings: Settings): WeaponProfile | null {
  const { game, weapon } = selected(settings);
  if (!weapon.profile) return null;
  const reference = weapon.calibration;
  const sensitivityScale = reference ? reference.sensitivity / game.input.sensitivity : 1;
  return {
    ...structuredClone(weapon.profile), name: weapon.name,
    recoils: weapon.profile.recoils.map(recoil => {
      const adsScale = reference && recoil.activate.includes('aiming') ? reference.adsMultiplier / game.input.adsMultiplier : 1;
      return { ...recoil, multipliers: [
        recoil.multipliers[0] * weapon.tuning.x * sensitivityScale * adsScale,
        recoil.multipliers[1] * weapon.tuning.y * sensitivityScale * adsScale,
      ] };
    }),
  };
}

export function tuningLimits(settings: Settings): [number, number][] | undefined {
  const profile = selected(settings).weapon.profile;
  if (!profile) return undefined;
  // A saved multiplier is only one way to represent strength. Its remaining
  // headroom must not limit tuning when that strength can be folded into vectors.
  const maxVector = profile.units === 'counts' ? 1000 : 10;
  return profile.recoils.map(stance => [0, 1].map(axis => {
    const peak = Math.max(...stance.vectors.map(pair => Math.abs(pair[axis]))) * stance.multipliers[axis];
    return peak === 0 ? 3 : Math.max(1, Math.min(3, Math.floor(maxVector * 2 / peak * 100) / 100));
  }) as [number, number]);
}

export function applyLiveTuning(settings: Settings, draft: TuningState): Settings {
  const next = structuredClone(settings);
  const weapon = selected(next).weapon;
  if (!weapon.profile || draft.stances.length !== weapon.profile.recoils.length) throw new Error('The tuning draft does not match this weapon.');
  const limits = tuningLimits(settings)!;
  const counts = weapon.profile.units === 'counts';
  const maxVector = counts ? 1000 : 10;
  weapon.profile = { ...weapon.profile, recoils: weapon.profile.recoils.map((stance, index) => {
    const gain = draft.stances[index];
    if (gain.name !== stance.name) throw new Error('The tuning stance changed.');
    const gains = [number(gain.x, 'Horizontal tuning', 0, limits[index][0]), number(gain.y, 'Vertical tuning', 0, limits[index][1])];
    if (gains.every(value => value === 1)) return stance;
    const vectors = stance.vectors.map(pair => [...pair] as [number, number]);
    const multipliers = stance.multipliers.map((value, axis) => {
      const strength = value * gains[axis];
      // Preserve legacy representation when it fits. Counts patterns bake the
      // saved gain into each shot so the next draft starts from the new baseline.
      if (!counts && strength <= 2) return strength;
      const peak = Math.max(...stance.vectors.map(pair => Math.abs(pair[axis]) * strength));
      const scale = peak <= maxVector ? 1 : 2;
      for (const pair of vectors) pair[axis] = pair[axis] * strength / scale;
      return scale;
    }) as [number, number];
    return { ...stance, vectors, multipliers };
  }) };
  // Retain the sensitivity reference, but this edited profile needs testing again.
  weapon.provenance = 'manual';
  return validateSettings(next);
}

export class SettingsStore {
  warning: string | null = null;
  constructor(readonly path: string) {}
  load(): Settings {
    if (!existsSync(this.path)) return defaultSettings();
    try {
      const contents = readFileSync(this.path, 'utf8');
      if (contents.length > 2_000_000) throw new Error('Settings file is too large.');
      return validateSettings(JSON.parse(contents));
    } catch (error) {
      this.warning = `Saved settings could not be loaded. The original file will be backed up when you save. ${String(error)}`;
      return defaultSettings();
    }
  }
  save(value: unknown): Settings {
    const settings = validateSettings(value);
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.backup`);
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    renameSync(`${this.path}.tmp`, this.path);
    this.warning = null;
    return settings;
  }
}
