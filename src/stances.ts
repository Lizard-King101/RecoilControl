export interface StanceDefinition { id: string; name: string }
export const maxStances = 16;
export const defaultStances = (): StanceDefinition[] => [{ id: 'crouching', name: 'Crouch' }];

export function stanceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)
    || ['aiming', 'shooting', 'paused', 'default', 'standing', 'constructor', 'prototype'].includes(value)) {
    throw new Error('Invalid stance ID.');
  }
  return value;
}

export function validateStances(value: unknown): StanceDefinition[] {
  if (value === undefined) return defaultStances();
  if (!Array.isArray(value) || value.length > maxStances) throw new Error(`Choose up to ${maxStances} stances.`);
  const stances = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 60) throw new Error('Give each stance a name of up to 60 characters.');
    return { id: stanceId(item.id), name: item.name.trim() };
  });
  if (new Set(stances.map(s => s.id)).size !== stances.length || new Set(stances.map(s => s.name.toLowerCase())).size !== stances.length) throw new Error('Each stance needs a different ID and name.');
  return stances;
}
