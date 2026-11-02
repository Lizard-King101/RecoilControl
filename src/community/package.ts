import { randomUUID } from 'node:crypto';
import { defaultBindings } from '../key-bindings';
import { allSetups, defaultSettings, GameSettings, selected, Settings, validateSettings } from '../desktop/settings';

export const packageFormat = 'recoil-control/game-pack-v1';
export const maxPackageBytes = 2_000_000;
export interface GamePack {
  format: typeof packageFormat;
  title: string; author: string; release: string; gameVersion: string; description: string; tags: string[];
  game: Omit<GameSettings, 'bindings'>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a game pack.');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, optional = false): string {
  if (typeof value !== 'string' || value.length > max || !optional && !value.trim()) throw new Error(`Check ${name} (maximum ${max} characters).`);
  return value.trim();
}
export function packMetadata(value: unknown) {
  const data = record(value);
  if (!Array.isArray(data.tags) || data.tags.length > 8) throw new Error('Use up to eight tags.');
  return { title: text(data.title, 'title', 80), author: text(data.author, 'author name', 60), release: text(data.release, 'release', 30),
    gameVersion: text(data.gameVersion, 'game version', 60, true), description: text(data.description, 'description', 3000),
    tags: [...new Set(data.tags.map(tag => text(tag, 'tag', 24).toLowerCase()))] };
}
function cleanGame(value: unknown): GameSettings {
  const game = record(value);
  if (!Array.isArray(game.weapons)) throw new Error('A pack needs weapons.');
  const local = defaultSettings();
  // Ignore publisher shortcuts and local calibration claims even in hand-authored files.
  const weapons = game.weapons.map(value => {
    const weapon = record(value);
    const cleanSetup = (value: unknown) => { const setup = record(value); return { ...setup, calibration: null, provenance: setup.profile === null ? 'template' : 'manual' }; };
    if (!Array.isArray(weapon.setups)) throw new Error('Each weapon needs an attachment setup list.');
    return { ...cleanSetup(weapon), hotkey: null, setups: weapon.setups.map(cleanSetup) };
  });
  const result = validateSettings({ ...local, selectedGameId: game.id, games: [{ ...game, weapons, bindings: { ...defaultBindings(), stances: [] } }] }).games[0];
  if (!result.weapons.some(w => allSetups(w).some(s => s.profile))) throw new Error('Configure at least one weapon pattern before publishing.');
  return result;
}
export function validateGamePack(value: unknown): GamePack {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maxPackageBytes) throw new Error('Game packs must be smaller than 2 MB.');
  const data = record(value);
  if (data.format !== packageFormat) throw new Error('Unsupported game pack format.');
  const { bindings: _bindings, ...game } = cleanGame(data.game);
  return { format: packageFormat, ...packMetadata(data), game };
}
export function createGamePack(settings: Settings, metadata: unknown): GamePack {
  const game = structuredClone(selected(settings).game);
  if (!game.id) throw new Error('Add or install a game before publishing a pack.');
  for (const weapon of game.weapons) for (const setup of allSetups(weapon)) {
    const profile = setup.profile;
    if (profile) {
      const sensitivity = setup.calibration ? setup.calibration.sensitivity / game.input.sensitivity : 1;
      const unit = profile.units === 'counts' ? 1 : 180000 / profile.rpm;
      setup.profile = { ...profile, units: 'counts', recoils: profile.recoils.map(recoil => {
        const ads = setup.calibration && recoil.activate.includes('aiming') ? setup.calibration.adsMultiplier / game.input.adsMultiplier : 1;
        return { ...recoil, multipliers: [1, 1], vectors: recoil.vectors.map(v => [v[0] * recoil.multipliers[0] * setup.tuning.x * sensitivity * ads * unit, v[1] * recoil.multipliers[1] * setup.tuning.y * sensitivity * ads * unit]) };
      }) };
    }
    setup.tuning = { x: 1, y: 1 }; setup.calibration = null; setup.provenance = profile ? 'manual' : 'template';
  }
  return validateGamePack({ format: packageFormat, ...packMetadata(metadata), game });
}
export function installGamePack(settings: Settings, value: unknown): Settings {
  const pack = validateGamePack(value), next = structuredClone(settings);
  const game: GameSettings = { ...structuredClone(pack.game), bindings: { ...defaultBindings(), stances: pack.game.stances.map(s => ({ id: s.id, key: null, mode: 'hold' as const })) } };
  game.id = randomUUID();
  const selectedId = game.selectedWeaponId;
  for (const weapon of game.weapons) { const oldId = weapon.id; weapon.id = randomUUID(); if (oldId === selectedId) game.selectedWeaponId = weapon.id; }
  const name = game.name;
  for (let n = 2; next.games.some(g => g.name.toLowerCase() === game.name.toLowerCase()); n++) game.name = `${name.slice(0, 65)} (${n})`;
  next.games.push(game); next.selectedGameId = game.id;
  return validateSettings(next);
}
export function packSummary(pack: GamePack) {
  return { title: pack.title, author: pack.author, release: pack.release, gameVersion: pack.gameVersion, description: pack.description,
    tags: pack.tags, game: pack.game.name, weapons: pack.game.weapons.length, setups: pack.game.weapons.reduce((n, w) => n + w.setups.length, 0),
    patterns: pack.game.weapons.reduce((n, w) => n + allSetups(w).filter(s => s.profile).length, 0), stances: pack.game.stances.map(s => s.name), input: pack.game.input };
}
