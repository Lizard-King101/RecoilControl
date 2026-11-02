import { Key } from './input';
import { keyboardMap } from './key-bindings';

export interface ButtonListener {
  keyDown(key: Key): void;
  keyUp(key: Key): void;
  mouse(button: 'left' | 'right', down: boolean): void;
}
export interface ButtonInput { listen(listener: ButtonListener): () => void }

// Observe buttons without intercepting or re-injecting the physical mouse.
export function loadButtonInput(options: { mouse?: boolean } = {}): ButtonInput {
  if (process.platform !== 'win32') throw new Error('Bluetooth profile input currently requires Windows.');
  const { uIOhook, UiohookKey }: typeof import('uiohook-napi') = require('uiohook-napi');
  const keys = keyboardMap(UiohookKey);
  return { listen(listener) {
    const down = (event: { keycode: number }) => { const key = keys.get(event.keycode); if (key) listener.keyDown(key); };
    const up = (event: { keycode: number }) => { const key = keys.get(event.keycode); if (key) listener.keyUp(key); };
    const mouse = (button: unknown, pressed: boolean) => {
      if (button === 1 || button === 2) listener.mouse(button === 1 ? 'left' : 'right', pressed);
    };
    const mouseDown = (event: { button: unknown }) => mouse(event.button, true);
    const mouseUp = (event: { button: unknown }) => mouse(event.button, false);
    const remove = () => {
      uIOhook.removeListener('keydown', down); uIOhook.removeListener('keyup', up);
      uIOhook.removeListener('mousedown', mouseDown); uIOhook.removeListener('mouseup', mouseUp);
    };
    uIOhook.on('keydown', down); uIOhook.on('keyup', up);
    if (options.mouse !== false) { uIOhook.on('mousedown', mouseDown); uIOhook.on('mouseup', mouseUp); }
    try { uIOhook.start(); } catch (error) { remove(); throw error; }
    return () => { try { uIOhook.stop(); } finally { remove(); } };
  } };
}
