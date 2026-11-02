// Keep the portable engine independent of the optional Windows native addon.
export type Stroke = {
  type: 'mouse';
  state: number;
  flags: number;
  rolling: number;
  x: number;
  y: number;
  information: number;
} | {
  type: 'keyboard';
  code: number;
  state: number;
  information: number;
};

export type Key = 'enter' | 'plus' | 'escape' | 'control' | 'controlRight' | 'shift' | 'shiftRight'
  | `f${number}` | `num${number}` | `key${string}` | 'alt' | 'altRight'
  | 'home' | 'end' | 'insert' | 'delete' | 'pageup' | 'pagedown' | 'space' | 'minus'
  | 'left' | 'right' | 'up' | 'down' | 'mouse3' | 'mouse4' | 'mouse5' | `stance:${string}`;

export function postureFromKeys(keys: ReadonlySet<Key>): string | null {
  for (const key of keys) if (key.startsWith('stance:')) return key.slice(7);
  return keys.has('control') || keys.has('controlRight') ? 'crouching' : null;
}

export interface InputDevice {
  readonly id: number;
  receive(): Stroke | null;
  send(stroke: Stroke): boolean;
}

export interface MouseContext {
  mouseCount(): number;
  capture(enabled: boolean): void;
  wait(timeoutMs: number): Promise<InputDevice | null>;
  destroy(): void;
}

export interface InputBackend {
  createContext(): MouseContext;
  listenKeyboard(down: (key: Key) => void, up: (key: Key) => void): () => void;
}

export interface Clock {
  now(): number;
  every(callback: () => void, intervalMs: number): () => void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  every(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  },
};

export const missingDriverMessage = 'No mice are available through Interception. Install the Interception driver from an Administrator terminal, restart Windows, then run npm run doctor. See README.md for the command.';

export function inspectBackend(backend: InputBackend): number {
  const context = backend.createContext();
  try { return context.mouseCount(); } finally { context.destroy(); }
}
