import { defaultStances, StanceDefinition, validateStances } from '../stances';
import { allSetups, bindingsForGame, selected, Settings, validateSettings, validateWeapon, WeaponSettings } from './settings';

export function exportWeapon(weapon: WeaponSettings, stances: readonly StanceDefinition[]) {
  const used = new Set(allSetups(weapon).flatMap(setup => setup.profile?.recoils.flatMap(recoil => recoil.activate) ?? []));
  const definitions = stances.filter(stance => used.has(stance.id));
  return { format: 'recoil-control/weapon-v4', stances: definitions,
    weapon: { ...validateWeapon(weapon, definitions), hotkey: null } };
}

export function importWeapon(settings: Settings, value: unknown, id: string): Settings {
  if (!value || typeof value !== 'object') throw new Error('This file is not a Recoil Control weapon export.');
  const data = value as Record<string, unknown>;
  if (!['recoil-control/weapon-v1', 'recoil-control/weapon-v2', 'recoil-control/weapon-v3', 'recoil-control/weapon-v4'].includes(String(data.format))) throw new Error('Unsupported weapon export version.');
  if (['recoil-control/weapon-v3', 'recoil-control/weapon-v4'].includes(String(data.format)) && !Array.isArray(data.stances)) throw new Error('The export is missing its stance definitions.');
  const stances = ['recoil-control/weapon-v3', 'recoil-control/weapon-v4'].includes(String(data.format)) ? validateStances(data.stances) : defaultStances();
  const weapon = validateWeapon(data.weapon, stances);
  weapon.id = id; weapon.hotkey = null;
  for (const setup of allSetups(weapon)) { setup.provenance = setup.profile ? 'manual' : 'template'; setup.calibration = null; }
  const next = structuredClone(settings);
  const { game } = selected(next);
  if (!game.id) throw new Error('Add a game before importing a weapon, or install a game pack from Community.');
  // A shared pattern can add stances, but cannot install someone else's key bindings.
  game.bindings = bindingsForGame(game);
  const used = new Set(allSetups(weapon).flatMap(setup => setup.profile?.recoils.flatMap(recoil => recoil.activate) ?? []));
  for (const stance of stances.filter(s => used.has(s.id))) {
    if (game.stances.some(s => s.id === stance.id)) continue;
    let name = stance.name;
    for (let suffix = 2; game.stances.some(s => s.name.toLowerCase() === name.toLowerCase()); suffix++) name = `${stance.name.slice(0, 50)} (${suffix})`;
    game.stances.push({ ...stance, name });
  }
  game.weapons.push(weapon); game.selectedWeaponId = weapon.id;
  return validateSettings(next);
}
