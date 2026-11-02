import { ButtonInput, ButtonListener } from './button-input';
import { Key } from './input';
import { actionNames, BindingAction, GameBindings, stanceBindings } from './key-bindings';

export type GameAction = BindingAction | 'disable' | { weaponId: string } | { compensation: boolean };

// One hook for the desktop lifetime. Swapping controllers preserves held stance
// keys and cannot retrigger a held weapon shortcut through keyboard auto-repeat.
export class GameControls implements ButtonInput {
  private readonly keys = new Set<Key>();
  private readonly listeners = new Set<ButtonListener>();
  private readonly buttons = new Set<'left' | 'right'>();
  private virtual = new Set<Key>();
  private postureOrder: string[] = [];
  private toggled: string | null = null;
  private holdingActivation = false;
  private stop?: () => void;
  constructor(private readonly source: ButtonInput, private bindings: GameBindings,
    private weapons: { id: string; hotkey: string | null }[],
    private readonly action: (value: GameAction) => void, private readonly suspended: () => boolean) {}
  start(): void {
    if (this.stop) return;
    this.stop = this.source.listen({ keyDown: key => this.down(key), keyUp: key => {
      this.keys.delete(key); this.checkActivation(); this.sync();
      if (['escape', 'left', 'right', 'up', 'down'].includes(key)) for (const l of this.listeners) l.keyUp(key);
    }, mouse: (button, down) => {
      if (down) this.buttons.add(button); else this.buttons.delete(button);
      for (const l of this.listeners) l.mouse(button, down);
    } });
  }
  configure(bindings: GameBindings, weapons: { id: string; hotkey: string | null }[]): void {
    if (bindings.toggle !== this.bindings.toggle || bindings.activationMode !== this.bindings.activationMode) this.cancelActivation();
    if (JSON.stringify(stanceBindings(this.bindings)) !== JSON.stringify(stanceBindings(bindings))) this.resetStances();
    this.bindings = bindings; this.weapons = weapons; this.sync();
  }
  resetStances(): void { this.toggled = null; this.postureOrder = []; this.sync(); }
  get activationHeld(): boolean { return this.holdingActivation; }
  cancelActivation(): void {
    if (!this.holdingActivation) return;
    this.holdingActivation = false;
    this.action({ compensation: false });
  }
  private checkActivation(): void {
    if (!this.holdingActivation) return;
    if (!this.activationChordHeld()) this.cancelActivation();
  }
  private activationChordHeld(): boolean {
    const parts = this.bindings.toggle.split('+'), key = parts.pop() as Key;
    return this.held(key) && parts.every(modifier => this.held(modifier === 'ctrl' ? 'control' : modifier as Key));
  }
  private chord(key: Key): string {
    const base = ({ controlRight: 'control', shiftRight: 'shift', altRight: 'alt' } as Partial<Record<Key, Key>>)[key] ?? key;
    return [...(this.held('control') && base !== 'control' ? ['ctrl'] : []), ...(this.held('alt') && base !== 'alt' ? ['alt'] : []), ...(this.held('shift') && base !== 'shift' ? ['shift'] : []), base].join('+');
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
    const active = stanceBindings(this.bindings).filter(s => s.key && (s.mode === 'hold' ? this.held(s.key) : this.toggled === s.id));
    this.postureOrder = this.postureOrder.filter(id => active.some(s => s.id === id));
    for (const stance of active) if (!this.postureOrder.includes(stance.id)) this.postureOrder.unshift(stance.id);
    const posture = this.postureOrder.at(-1);
    if (posture) next.add(posture === 'crouching' ? 'control' : `stance:${posture}`);
    for (const key of this.virtual) if (!next.has(key)) for (const l of this.listeners) l.keyUp(key);
    for (const key of next) if (!this.virtual.has(key)) for (const l of this.listeners) l.keyDown(key);
    this.virtual = next;
  }
  private down(key: Key): void {
    if (this.keys.has(key)) return;
    const modifier = ({ control: 'control', controlRight: 'control', shift: 'shift', shiftRight: 'shift', alt: 'alt', altRight: 'alt' } as Partial<Record<Key, Key>>)[key];
    const modifierAlreadyHeld = modifier && this.held(modifier);
    const wasHeld = stanceBindings(this.bindings).filter(s => s.key && this.held(s.key)).map(s => s.id);
    this.keys.add(key);
    this.checkActivation();
    for (const stance of stanceBindings(this.bindings)) {
      if (!stance.key || !this.held(stance.key) || wasHeld.includes(stance.id)) continue;
      if (this.suspended() || this.keys.has('escape')) continue;
      this.toggled = stance.mode === 'toggle' && this.toggled !== stance.id ? stance.id : null;
      this.postureOrder = [...this.postureOrder.filter(id => id !== stance.id), stance.id];
    }
    if (key === 'escape') { this.cancelActivation(); this.toggled = null; this.postureOrder = []; }
    this.sync();
    if (['escape', 'left', 'right', 'up', 'down'].includes(key)) for (const l of this.listeners) l.keyDown(key);
    if (key === 'escape') this.action('disable');
    if (this.suspended() || this.keys.has('escape')) return;
    if (modifierAlreadyHeld) return;
    // Extra modifiers may be crouch/pause controls. They must not cancel a hold.
    const base = modifier ?? key;
    if (this.bindings.activationMode === 'hold' && base === this.bindings.toggle.split('+').at(-1) && this.activationChordHeld()) {
      if (!this.holdingActivation) { this.holdingActivation = true; this.action({ compensation: true }); }
      return;
    }
    const chord = this.chord(key);
    const match = actionNames.find(action => this.bindings[action] === chord);
    if (match) { this.action(match); return; }
    const weapon = this.weapons.find(w => w.hotkey === chord);
    if (weapon) this.action({ weaponId: weapon.id });
  }
  dispose(): void { this.cancelActivation(); this.stop?.(); this.stop = undefined; this.listeners.clear(); this.keys.clear(); this.buttons.clear(); this.virtual.clear(); this.postureOrder = []; this.toggled = null; }
}
