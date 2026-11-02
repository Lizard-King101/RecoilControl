import type { Stroke } from 'node-interception';

export type Key = 'enter' | 'plus' | 'escape' | 'control' | 'controlRight' | 'shift' | 'shiftRight'
  | `f${number}` | `num${number}` | `key${string}` | 'alt' | 'altRight'
  | 'home' | 'end' | 'insert' | 'delete' | 'pageup' | 'pagedown' | 'space' | 'minus'
  | 'left' | 'right' | 'up' | 'down';

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
