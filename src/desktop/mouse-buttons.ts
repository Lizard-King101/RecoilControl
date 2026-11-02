import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const helper = resolve(__dirname, '../../scripts/mouse-buttons.py');
export interface MouseDevice { path: string; name: string; readable: boolean }
export async function mouseDevices(): Promise<MouseDevice[]> {
  if (process.platform !== 'linux') throw new Error('The fire-button listener currently supports Linux.');
  const { stdout } = await execute('python3', ['-u', helper, '--list'], { timeout: 5000, maxBuffer: 65536 });
  return JSON.parse(stdout);
}
async function selectedMouse(path: unknown) {
  const device = (await mouseDevices()).find(d => d.path === path);
  if (!device || !/^\/dev\/input\/event\d+$/.test(device.path)) throw new Error('Select an available mouse device.');
  return device;
}
/** Only called by the explicit permission button, never by startup or arming. */
export async function allowMouseRead(path: unknown) {
  const device = await selectedMouse(path), uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Run the app as your normal desktop user.');
  await execute('/usr/bin/pkexec', ['/usr/bin/setfacl', '-m', `u:${uid}:r`, device.path], { timeout: 90000, maxBuffer: 4096 });
  return mouseDevices();
}

export class MouseButtons {
  private child?: ChildProcessWithoutNullStreams;
  private cancel?: (reason?: string) => void;
  private ready = false;
  private generation = 0;
  private lastInput = 0;
  get connected() { return this.ready && Date.now() - this.lastInput < 350; }
  constructor(private input: (pressed: boolean) => void, private fault: (reason: string) => void) {}
  async connect(path: unknown) {
    this.close(); const generation = this.generation;
    const device = await selectedMouse(path);
    if (generation !== this.generation) throw new Error('Mouse connection cancelled.');
    if (!device.readable) throw new Error('Mouse read permission is required. Use Allow selected mouse, then connect.');
    const child = this.child = spawn('python3', ['-u', helper, device.path], { stdio: 'pipe' });
    return new Promise<void>((resolveReady, rejectReady) => {
      let stderr = '';
      const timer = setTimeout(() => fail('Mouse listener did not become ready.'), 5000);
      const watchdog = setInterval(() => { if (this.ready && !this.connected) fail('Mouse listener stopped responding.'); }, 100);
      this.cancel = (reason = 'Mouse connection cancelled.') => { clearTimeout(timer); clearInterval(watchdog); rejectReady(new Error(reason)); };
      const fail = (reason: string) => {
        if (this.child !== child) return;
        this.cancel?.(reason); this.cancel = undefined; this.close(); this.fault(reason);
      };
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000); });
      child.on('error', error => fail(error.message));
      child.on('exit', () => fail(stderr || 'Mouse listener disconnected.'));
      child.stdin.on('error', error => fail(error.message));
      createInterface({ input: child.stdout }).on('line', line => {
        if (this.child !== child) return;
        try {
          const value = JSON.parse(line);
          if (value.error) { fail(String(value.error)); return; }
          if (typeof value.pressed !== 'boolean') throw new Error('Invalid mouse input.');
          this.lastInput = Date.now();
          if (value.ready) { this.ready = true; clearTimeout(timer); resolveReady(); }
          if (this.ready) this.input(value.pressed);
        } catch (error) { fail(String(error)); }
      });
    });
  }
  close() {
    this.generation++;
    this.cancel?.(); this.cancel = undefined; this.ready = false;
    const child = this.child; this.child = undefined;
    child?.stdin.end(); child?.kill();
  }
}
