import { Key } from './input';
import { maxStances, stanceId } from './stances';

export interface StanceBinding { id: string; key: Key | null; mode: 'hold' | 'toggle' }

export interface GameBindings {
  toggle: string; previousWeapon: string; nextWeapon: string;
  tuningToggle: string; tuningTarget: string; pause: Key; crouch: Key;
  stances?: StanceBinding[];
  activationMode?: 'toggle' | 'hold';
}
export function stanceBindings(bindings: GameBindings): StanceBinding[] {
  return bindings.stances ?? [{ id: 'crouching', key: bindings.crouch, mode: 'hold' }];
}
export const actionNames = ['toggle', 'previousWeapon', 'nextWeapon', 'tuningToggle', 'tuningTarget'] as const;
export type BindingAction = typeof actionNames[number];
export const defaultBindings = (): GameBindings => ({ toggle: 'f7', activationMode: 'toggle', previousWeapon: 'f5', nextWeapon: 'f6', tuningToggle: 'f8', tuningTarget: 'f9', pause: 'shift', crouch: 'control' });
export const mouseKeys = ['mouse3', 'mouse4', 'mouse5'];
const modifiers = ['control', 'alt', 'shift'];
export const keyChoices: { key: Key; label: string; native: string }[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ key: `f${i + 1}` as Key, label: `F${i + 1}`, native: `F${i + 1}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ key: `num${i}` as Key, label: `Numpad ${i}`, native: `Numpad${i}` })),
  ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', value => ({ key: `key${value.toLowerCase()}` as Key, label: value, native: value })),
  ...[['home', 'Home'], ['end', 'End'], ['insert', 'Insert'], ['delete', 'Delete'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['space', 'Space'], ['plus', 'NumpadAdd'], ['minus', 'NumpadSubtract'], ['enter', 'Enter']].map(([key, native]) => ({ key: key as Key, label: native, native })),
];
export function keyboardMap(native: Record<string, number>): Map<number, Key> {
  return new Map<number, Key>([
    ...keyChoices.map(({ key, native: name }): [number, Key] => [native[name], key]),
    [native.Escape, 'escape'], [native.Ctrl, 'control'], [native.CtrlRight, 'controlRight'],
    [native.Shift, 'shift'], [native.ShiftRight, 'shiftRight'], [native.Alt, 'alt'], [native.AltRight, 'altRight'],
    [native.ArrowLeft, 'left'], [native.ArrowRight, 'right'], [native.ArrowUp, 'up'], [native.ArrowDown, 'down'],
  ]);
}
export function validateShortcut(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Choose a keyboard shortcut.');
  const parts = value.split('+'), key = parts.pop();
  const mods = ['ctrl', 'alt', 'shift'].filter(item => parts.includes(item));
  const supported = keyChoices.some(item => item.key === key) || [...mouseKeys, ...modifiers].includes(key ?? '');
  if (!supported || mods.length !== parts.length || new Set(parts).size !== parts.length) throw new Error('Unsupported shortcut.');
  if (modifiers.includes(key!) && parts.length) throw new Error('Use a modifier by itself or combine modifiers with a key or mouse button.');
  const result = [...mods, key].join('+');
  if (result === 'ctrl+shift+keyh' || result === 'alt+f4') throw new Error('That shortcut is reserved.');
  return result;
}
export function validateBindings(value: unknown): GameBindings {
  if (value === undefined) return defaultBindings();
  if (!value || typeof value !== 'object') throw new Error('Invalid game key bindings.');
  const data = value as Record<string, unknown>;
  const result = defaultBindings();
  if (data.activationMode !== undefined && data.activationMode !== 'toggle' && data.activationMode !== 'hold') throw new Error('Choose hold or toggle for compensation.');
  result.activationMode = data.activationMode ?? 'toggle';
  for (const action of actionNames) result[action] = validateShortcut(data[action]);
  for (const action of ['pause', 'crouch'] as const) {
    if (![...modifiers, ...mouseKeys, ...keyChoices.map(item => item.key)].includes(String(data[action]))) throw new Error(`Choose a ${action} key.`);
    result[action] = data[action] as Key;
  }
  if (data.stances !== undefined) {
    if (!Array.isArray(data.stances) || data.stances.length > maxStances) throw new Error('Invalid stance bindings.');
    result.stances = data.stances.map(item => {
      if (!item || typeof item !== 'object' || !['hold', 'toggle'].includes(item.mode)) throw new Error('Choose hold or toggle for each stance.');
      if (item.key !== null && ![...modifiers, ...mouseKeys, ...keyChoices.map(choice => choice.key)].includes(item.key)) throw new Error('Choose a stance key.');
      return { id: stanceId(item.id), key: item.key, mode: item.mode };
    });
    if (new Set(result.stances.map(s => s.id)).size !== result.stances.length) throw new Error('Duplicate stance binding.');
  }
  const keys = [result.pause, ...stanceBindings(result).flatMap(s => s.key ? [s.key] : [])];
  if (new Set(keys).size !== keys.length) throw new Error('Pause and stances need different keys.');
  validateBindingConflicts(result, []);
  return result;
}
export function validateBindingConflicts(bindings: GameBindings, weapons: { hotkey?: string | null }[]): void {
  const values = [...actionNames.map(action => bindings[action]), ...weapons.flatMap(w => w.hotkey ? [w.hotkey] : [])];
  if (new Set(values).size !== values.length) throw new Error('Each action and weapon needs a different shortcut.');
  if (bindings.activationMode === 'hold' && values.slice(1).some(value => value.split('+').at(-1) === bindings.toggle.split('+').at(-1))) throw new Error('A hold-to-enable binding needs its own key or mouse button.');
  for (const modifier of modifiers) {
    const prefix = modifier === 'control' ? 'ctrl' : modifier;
    if (values.includes(modifier) && values.some(value => value.split('+').slice(0, -1).includes(prefix))) throw new Error('A modifier action cannot also be part of another shortcut.');
  }
  const stanceKeys = stanceBindings(bindings).flatMap(s => s.key ? [s.key] : []);
  if (values.some(value => [bindings.pause, ...stanceKeys].includes(value.split('+').at(-1) as Key))) throw new Error('A hold key or stance key cannot also trigger an action.');
}
export function shortcutLabel(value: string): string {
  return value.split('+').map(part => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', control: 'Ctrl', mouse3: 'Middle mouse', mouse4: 'Mouse 4', mouse5: 'Mouse 5' }[part] ?? keyChoices.find(item => item.key === part)?.label ?? part)).join(' + ');
}
