import { ButtonInput, ButtonListener } from './button-input';
import { Key } from './input';
import { actionNames, BindingAction, GameBindings } from './key-bindings';

export type GameAction = BindingAction | 'disable' | { weaponId: string };

// One hook for the desktop lifetime. Swapping controllers preserves held stance
// keys and cannot retrigger a held weapon shortcut through keyboard auto-repeat.
export class GameControls implements ButtonInput {
  private readonly keys = new Set<Key>();
  private readonly listeners = new Set<ButtonListener>();
  private readonly buttons = new Set<'left' | 'right'>();
  private virtual = new Set<Key>();
  private stop?: () => void;
  constructor(private readonly source: ButtonInput, private bindings: GameBindings,
    private weapons: { id: string; hotkey: string | null }[],
    private readonly action: (value: GameAction) => void, private readonly suspended: () => boolean) {}
  start(): void {
    if (this.stop) return;
    this.stop = this.source.listen({ keyDown: key => this.down(key), keyUp: key => {
      this.keys.delete(key); this.sync();
      if (['escape', 'left', 'right', 'up', 'down'].includes(key)) for (const l of this.listeners) l.keyUp(key);
    }, mouse: (button, down) => {
      if (down) this.buttons.add(button); else this.buttons.delete(button);
      for (const l of this.listeners) l.mouse(button, down);
    } });
  }
  configure(bindings: GameBindings, weapons: { id: string; hotkey: string | null }[]): void {
    this.bindings = bindings; this.weapons = weapons; this.sync();
  }
  listen(listener: ButtonListener): () => void {
    this.listeners.add(listener);
    for (const key of this.virtual) listener.keyDown(key);
    if (this.keys.has('escape')) listener.keyDown('escape');
    for (const button of this.buttons) listener.mouse(button, true);
    return () => { this.listeners.delete(listener); };
  }
  private held(key: Key): boolean {
    return this.keys.has(key) || key === 'control' && this.keys.has('controlRight') || key === 'shift' && this.keys.has('shiftRight') || key === 'alt' && this.keys.has('altRight');
  }
  private sync(): void {
    const next = new Set<Key>();
    if (this.held(this.bindings.pause)) next.add('shift');
    if (this.held(this.bindings.crouch)) next.add('control');
    for (const key of this.virtual) if (!next.has(key)) for (const l of this.listeners) l.keyUp(key);
    for (const key of next) if (!this.virtual.has(key)) for (const l of this.listeners) l.keyDown(key);
    this.virtual = next;
  }
  private down(key: Key): void {
    if (this.keys.has(key)) return;
    this.keys.add(key); this.sync();
    if (['escape', 'left', 'right', 'up', 'down'].includes(key)) for (const l of this.listeners) l.keyDown(key);
    if (key === 'escape') this.action('disable');
    if (this.suspended() || this.keys.has('escape')) return;
    const chord = [...(this.held('control') ? ['ctrl'] : []), ...(this.held('alt') ? ['alt'] : []), ...(this.held('shift') ? ['shift'] : []), key].join('+');
    const match = actionNames.find(action => this.bindings[action] === chord);
    if (match) { this.action(match); return; }
    const weapon = this.weapons.find(w => w.hotkey === chord);
    if (weapon) this.action({ weaponId: weapon.id });
  }
  dispose(): void { this.stop?.(); this.stop = undefined; this.listeners.clear(); this.keys.clear(); this.buttons.clear(); this.virtual.clear(); }
}
