import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { ProfileOutput } from '../bluetooth-controller';

/** Linux's user-approved pointer portal. Never requests keyboard access or clicks. */
export class PortalPointer implements ProfileOutput {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private cancelConnect?: () => void;
  private sequence = 0;
  private pending?: { id: number; resolve: (sent: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  get profileReady() { return this.ready; }
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.child) throw new Error('A desktop permission request is already open.');
    if (process.platform !== 'linux') throw new Error('This prototype uses the Linux desktop pointer portal.');
    const child = this.child = spawn('python3', ['-u', resolve(__dirname, '../../scripts/portal-pointer.py')], { stdio: 'pipe' });
    return new Promise((resolveReady, rejectReady) => {
      let stderr = '';
      this.cancelConnect = () => { clearTimeout(timer); rejectReady(new Error('Desktop pointer connection cancelled.')); };
      const timer = setTimeout(() => { this.close(); rejectReady(new Error('Desktop permission request timed out.')); }, 95000);
      const fail = (message: string) => {
        if (this.child !== child) return;
        this.cancelConnect = undefined;
        clearTimeout(timer); this.ready = false;
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = undefined; }
        rejectReady(new Error(message));
        if (this.child === child) this.child = undefined;
        child.kill();
      };
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1500); });
      child.stdin.on('error', error => fail(error.message));
      child.on('error', error => fail(`Cannot start pointer helper: ${error.message}. Python 3 and PyGObject are required.`));
      child.on('exit', () => fail(stderr || 'The desktop pointer session ended. Reconnect it to continue.'));
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const value = JSON.parse(line);
          if (value.ready) { this.cancelConnect = undefined; clearTimeout(timer); this.ready = true; resolveReady(); }
          else if (value.closed) fail('The desktop pointer session was revoked.');
          else if (value.id === this.pending?.id && this.pending) {
            const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
            if (value.ok) pending.resolve(true); else { pending.reject(new Error(value.error)); this.close(); }
          } else if (value.error) fail(String(value.error));
        } catch { fail('Invalid response from the pointer helper.'); }
      });
    });
  }
  async moveProfile(x: number, y: number, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    if (!this.ready || !this.child) throw new Error('Connect the desktop pointer first.');
    if (this.pending) throw new Error('Previous pointer movement is still pending.');
    if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 127)) throw new Error('Prototype movement exceeds 127 counts per frame. Reduce the pattern strength.');
    const id = ++this.sequence;
    return new Promise((resolveMove, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error('Desktop pointer stopped responding.')); this.close(); }, 250);
      this.pending = { id, resolve: resolveMove, reject, timer };
      this.child!.stdin.write(JSON.stringify({ id, x, y }) + '\n');
    });
  }
  async disarm() { /* Each call sends a single relative event; no output queue is maintained. */ }
  close() {
    this.cancelConnect?.(); this.cancelConnect = undefined;
    this.ready = false;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(false); this.pending = undefined; }
    const child = this.child; this.child = undefined;
    child?.stdin.end(); child?.kill();
  }
}
