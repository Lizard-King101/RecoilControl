import { Key } from './input';

export interface GameBindings {
  toggle: string; previousWeapon: string; nextWeapon: string;
  tuningToggle: string; tuningTarget: string; pause: Key; crouch: Key;
}
export const actionNames = ['toggle', 'previousWeapon', 'nextWeapon', 'tuningToggle', 'tuningTarget'] as const;
export type BindingAction = typeof actionNames[number];
export const defaultBindings = (): GameBindings => ({ toggle: 'f7', previousWeapon: 'f5', nextWeapon: 'f6', tuningToggle: 'f8', tuningTarget: 'f9', pause: 'shift', crouch: 'control' });
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
  const modifiers = ['ctrl', 'alt', 'shift'].filter(item => parts.includes(item));
  if (!keyChoices.some(item => item.key === key) || modifiers.length !== parts.length || new Set(parts).size !== parts.length) throw new Error('Unsupported shortcut.');
  const result = [...modifiers, key].join('+');
  if (result === 'ctrl+shift+keyh' || result === 'alt+f4') throw new Error('That shortcut is reserved.');
  return result;
}
export function validateBindings(value: unknown): GameBindings {
  if (value === undefined) return defaultBindings();
  if (!value || typeof value !== 'object') throw new Error('Invalid game key bindings.');
  const data = value as Record<string, unknown>;
  const result = defaultBindings();
  for (const action of actionNames) result[action] = validateShortcut(data[action]);
  for (const action of ['pause', 'crouch'] as const) {
    if (!['control', 'shift', 'alt', ...keyChoices.map(item => item.key)].includes(String(data[action]))) throw new Error(`Choose a ${action} key.`);
    result[action] = data[action] as Key;
  }
  if (result.pause === result.crouch) throw new Error('Pause and crouch need different keys.');
  validateBindingConflicts(result, []);
  return result;
}
export function validateBindingConflicts(bindings: GameBindings, weapons: { hotkey?: string | null }[]): void {
  const values = [...actionNames.map(action => bindings[action]), ...weapons.flatMap(w => w.hotkey ? [w.hotkey] : [])];
  if (new Set(values).size !== values.length) throw new Error('Each action and weapon needs a different shortcut.');
  if (values.includes(bindings.pause) || values.includes(bindings.crouch)) throw new Error('A hold key cannot also trigger an action.');
}
export function shortcutLabel(value: string): string {
  return value.split('+').map(part => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', control: 'Ctrl' }[part] ?? keyChoices.find(item => item.key === part)?.label ?? part)).join(' + ');
}
