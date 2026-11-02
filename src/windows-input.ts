import { InputBackend, InputDevice, Key, MouseContext } from './input';

// The subset of node-interception 2.0.4 used by this adapter. Its package is
// skipped on other platforms, so compiling must not require its declarations.
interface InterceptionModule {
  Interception: new () => {
    getMice(): InputDevice[];
    setFilter(type: 'mouse', filter: number): void;
    wait(timeout: number): Promise<InputDevice | null>;
    destroy(): void;
  };
  FilterMouseState: { ALL: number; NONE: number };
}

export function loadWindowsBackend(): InputBackend {
  if (process.platform !== 'win32' || !['x64', 'ia32'].includes(process.arch)) {
    throw new Error('Live input requires x64 or x86 Windows. Use --demo to run the engine without input devices.');
  }
  // Load native addons only in live/diagnostic mode; the engine and demo are portable.
  const { Interception, FilterMouseState }: InterceptionModule = require('node-interception');
  const { uIOhook, UiohookKey }: typeof import('uiohook-napi') = require('uiohook-napi');
  const keys = new Map<number, Key>([
    [UiohookKey.Enter, 'enter'], [UiohookKey.NumpadAdd, 'plus'], [UiohookKey.Escape, 'escape'],
    [UiohookKey.Ctrl, 'control'], [UiohookKey.CtrlRight, 'controlRight'],
    [UiohookKey.Shift, 'shift'], [UiohookKey.ShiftRight, 'shiftRight'],
    [UiohookKey.F8, 'f8'], [UiohookKey.F9, 'f9'], [UiohookKey.ArrowLeft, 'left'], [UiohookKey.ArrowRight, 'right'],
    [UiohookKey.ArrowUp, 'up'], [UiohookKey.ArrowDown, 'down'],
  ]);

  return {
    createContext(): MouseContext {
      const context = new Interception();
      let destroyed = false;
      return {
        mouseCount: () => context.getMice().length,
        capture: enabled => context.setFilter('mouse', enabled ? FilterMouseState.ALL : FilterMouseState.NONE),
        wait: timeout => context.wait(timeout),
        destroy() {
          if (destroyed) return;
          destroyed = true;
          context.destroy();
        },
      };
    },
    listenKeyboard(down, up) {
      const keydown = (event: { keycode: number }) => {
        const key = keys.get(event.keycode);
        if (key) down(key);
      };
      const keyup = (event: { keycode: number }) => {
        const key = keys.get(event.keycode);
        if (key) up(key);
      };
      const removeListeners = () => {
        uIOhook.removeListener('keydown', keydown);
        uIOhook.removeListener('keyup', keyup);
      };
      uIOhook.on('keydown', keydown);
      uIOhook.on('keyup', keyup);
      try { uIOhook.start(); } catch (error) { removeListeners(); throw error; }
      return () => {
        try { uIOhook.stop(); } finally { removeListeners(); }
      };
    },
  };
}
