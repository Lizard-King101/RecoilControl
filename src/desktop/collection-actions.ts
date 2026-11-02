import { Settings, validateSettings } from './settings';

export interface DeleteCollectionRequest { gameId: string; weaponId?: string; expected: string }
export function deleteCollection(settings: Settings, kind: 'game' | 'weapon', value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('Choose a collection to delete.');
  const request = value as DeleteCollectionRequest;
  if (typeof request.gameId !== 'string' || !request.gameId || typeof request.expected !== 'string') throw new Error('Choose a collection to delete.');
  const next = structuredClone(settings), gameIndex = next.games.findIndex(g => g.id === request.gameId), game = next.games[gameIndex];
  if (!game) throw new Error('This game was already removed. Close the dialog and choose another collection.');
  if (kind === 'game') {
    if (JSON.stringify(game) !== request.expected) throw new Error('This game changed while the confirmation was open. Review it and try again.');
    next.games.splice(gameIndex, 1);
    if (next.selectedGameId === game.id) next.selectedGameId = next.games[Math.min(gameIndex, next.games.length - 1)]?.id ?? '';
  } else {
    const index = game.weapons.findIndex(w => w.id === request.weaponId), weapon = game.weapons[index];
    if (!weapon) throw new Error('This weapon was already removed. Close the dialog and choose another weapon.');
    if (JSON.stringify(weapon) !== request.expected) throw new Error('This weapon changed while the confirmation was open. Review it and try again.');
    game.weapons.splice(index, 1);
    if (game.selectedWeaponId === weapon.id) game.selectedWeaponId = game.weapons[Math.min(index, game.weapons.length - 1)]?.id ?? '';
  }
  return validateSettings(next);
}
