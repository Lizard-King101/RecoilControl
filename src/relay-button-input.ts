import { ButtonInput } from './button-input';
import type { RelayInput } from './desktop/board';

interface Source { listenInput(listener: (input: RelayInput | undefined) => void): () => void }

// Keyboard shortcuts remain local; firing/ADS come only from the relayed Cobra.
export function relayButtonInput(keyboard: ButtonInput, board: Source): ButtonInput {
  return { listen(listener) {
    let previous = 0;
    let generation: number | undefined;
    const stopKeyboard = keyboard.listen({ keyDown: key => listener.keyDown(key), keyUp: key => listener.keyUp(key), mouse: () => {} });
    let stopMouse: (() => void) | undefined;
    try {
      stopMouse = board.listenInput(input => {
        const buttons = input?.connected ? input.buttons : 0;
        if (input && generation !== undefined && ((input.generation - generation) >>> 0) > 1) {
          // A missed release/press must not silently resume an old burst.
          listener.keyDown('escape'); listener.keyUp('escape');
        }
        generation = input?.generation;
        if ((buttons ^ previous) & 2) listener.mouse('right', !!(buttons & 2));
        if ((buttons ^ previous) & 1) listener.mouse('left', !!(buttons & 1));
        previous = buttons;
      });
    } catch (error) { stopKeyboard(); throw error; }
    return () => { stopMouse?.(); stopKeyboard(); };
  } };
}
