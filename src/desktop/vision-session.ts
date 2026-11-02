import { createServer, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RecoilEngine } from '../recoil-engine';
import type { WeaponProfile } from '../profiles';
import type { ProfileOutput } from '../bluetooth-controller';

export type VisionTrigger = 'countdown' | 'simulator';
export type VisionMode = 'observe' | 'simulator' | 'pointer';
const timestamp = () => performance.timeOrigin + performance.now();
/** A deliberately bounded lab transport; does not install a global input hook. */
export class VisionSession {
  private server?: Server;
  private client?: ServerResponse;
  private token = randomBytes(24).toString('hex');
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat = 0;
  private captureTime = 0;
  private captureHealth = 0;
  private mouseHeartbeat = 0;
  private mouseHeld = false;
  private mouseReleased = false;
  private waiting = false;
  private trigger: VisionTrigger = 'simulator';
  private deadline = 0;
  private remaining = 0;
  private firing = false;
  private armed = false;
  private engine?: RecoilEngine;
  private profile?: WeaponProfile;
  private started = 0;
  private patternFinished = false;
  private lastTick = 0;
  private epoch = 0;
  private flight = false;
  private mode: VisionMode = 'observe';
  private url = '';
  private calibration?: object;
  constructor(private output: ProfileOutput, private publish: (event: Record<string, unknown>) => void, private calibrationFocusAllowed = () => true) {}
  get state() { return { url: this.url, armed: this.armed, firing: !!this.engine, mode: this.mode, trigger: this.trigger, countdown: this.remaining, waiting: this.waiting, pointerReady: this.output.profileReady }; }
  private emit(event: Record<string, unknown>) {
    this.publish(event);
    if (this.client && !this.client.write(`data: ${JSON.stringify(event)}\n\n`)) {
      const client = this.client; this.client = undefined; client.destroy(); if (this.trigger === 'simulator') this.disarm('Simulator stopped reading movement.');
    }
  }
  async listen() {
    if (this.server) return this.state;
    const server = this.server = createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403).end(); return; }
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.headers.host !== new URL(this.url || 'http://127.0.0.1').host || url.searchParams.get('token') !== this.token) { res.writeHead(403).end(); return; }
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
      if (req.method === 'GET' && url.pathname === '/events') {
        if (this.client) { res.writeHead(409).end('A simulator is already connected.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        this.client = res; this.emit({ type: 'ready', ...this.state });
        res.on('close', () => { if (this.client === res) { this.client = undefined; if (this.trigger === 'simulator') this.disarm('Simulator disconnected.'); } }); return;
      }
      if (req.method !== 'POST' || url.pathname !== '/input') { res.writeHead(404).end(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 1024) { res.writeHead(413).end(); req.destroy(); } });
      req.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (typeof value.firing !== 'boolean') throw new Error('firing must be a boolean');
          this.input(value.firing);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.state));
        } catch (error) { res.writeHead(400).end(String(error)); }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Simulator bridge did not start.');
    this.url = `http://127.0.0.1:${address.port}/?token=${this.token}`;
    return this.state;
  }
  captureFrame() { this.captureTime = this.captureHealth = timestamp(); }
  captureAlive() { this.captureHealth = timestamp(); }
  mouseInput(pressed: boolean, allowStart = true) {
    const rising = pressed && !this.mouseHeld;
    this.mouseHeld = pressed; this.mouseHeartbeat = timestamp();
    if (this.trigger !== 'countdown' || !this.armed) return;
    if (!pressed) {
      this.mouseReleased = true;
      if (this.engine) this.disarm('Fire released.');
    } else if (rising && this.waiting && this.mouseReleased && allowStart) {
      this.waiting = false; this.startBurst();
    }
  }
  async calibrate(countdown = 5) {
    if (!Number.isInteger(countdown) || countdown < 3 || countdown > 15) throw new Error('Choose a countdown from 3 to 15 seconds.');
    if (!this.output.profileReady) throw new Error('Connect the desktop pointer first.');
    if (timestamp() - this.captureHealth > 750) throw new Error('Start live screen capture before calibration.');
    if (this.flight) throw new Error('Wait for the previous movement to finish.');
    this.disarm('Calibration prepared.');
    const run = this.calibration = {}, epoch = this.epoch;
    let measuring = false, last = timestamp();
    const current = () => this.calibration === run && this.epoch === epoch;
    const check = () => {
      const now = timestamp();
      if (!current()) throw new Error('Calibration cancelled.');
      if (now - last > 200) throw new Error('Timing gap; calibration cancelled.');
      last = now;
      if (!this.output.profileReady) throw new Error('Desktop pointer disconnected; calibration cancelled.');
      if (now - this.captureHealth > 750 || measuring && now - this.captureTime > 500) throw new Error('Capture frames stalled; calibration cancelled.');
      if (measuring && !this.calibrationFocusAllowed()) throw new Error('Switch to the game before calibration starts.');
      if (measuring && this.mouseHeld) throw new Error('Release fire while calibrating.');
    };
    const wait = async (ms: number) => {
      const end = timestamp() + ms;
      while (timestamp() < end) { await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, end - timestamp())))); check(); }
    };
    const legs: { axis: number; units: number; beforeStart: number; moveStart: number; moveEnd: number; end: number }[] = [];
    try {
      for (let seconds = countdown; seconds > 0; seconds--) {
        this.publish({ type: 'calibration-countdown', seconds }); await wait(1000);
      }
      measuring = true; check(); this.publish({ type: 'calibration-start' });
      for (const axis of [0, 1]) for (const direction of [1, -1]) {
        this.publish({ type: 'calibration-axis', axis, direction });
        const beforeStart = timestamp(); await wait(300); const moveStart = timestamp();
        for (let step = 0; step < 12; step++) {
          check(); this.flight = true;
          try {
            if (!await this.output.moveProfile(axis === 0 ? direction : 0, axis === 1 ? direction : 0, current)) throw new Error('Calibration movement was cancelled.');
          } finally { this.flight = false; }
          await wait(35);
        }
        const moveEnd = timestamp(); await wait(350);
        legs.push({ axis, units: direction * 12, beforeStart, moveStart, moveEnd, end: timestamp() });
      }
      return { legs };
    } finally {
      if (this.calibration === run) { this.calibration = undefined; void this.output.disarm(); }
    }
  }
  arm(profile: WeaponProfile, mode: VisionMode, trigger: VisionTrigger = 'simulator', countdown = 5) {
    if (!['countdown', 'simulator'].includes(trigger)) throw new Error('Unknown recording trigger.');
    if (trigger === 'simulator' && !this.server) throw new Error('Enable the optional simulator link first.');
    if (trigger === 'countdown') {
      if (!Number.isInteger(countdown) || countdown < 3 || countdown > 15) throw new Error('Choose a countdown from 3 to 15 seconds.');
      if (mode === 'simulator') throw new Error('Virtual movement requires the simulator link trigger.');
      if (timestamp() - this.captureHealth > 750) throw new Error('Start live screen capture before the countdown.');
      if (timestamp() - this.mouseHeartbeat > 350) throw new Error('Connect the fire-button listener first.');
    }
    if (!['observe', 'simulator', 'pointer'].includes(mode)) throw new Error('Unknown lab output.');
    if (mode === 'pointer' && !this.output.profileReady) throw new Error('Connect the desktop pointer first.');
    if (profile.units !== 'counts' || profile.recoils.length !== 1 || profile.recoils[0].activate.length || profile.recoils[0].multipliers.some(v => v !== 1)) throw new Error('The lab expects one counts pattern.');
    const maxPatternMs = trigger === 'countdown' ? 15000 : 5000;
    if (profile.recoils[0].vectors.length * 60000 / profile.rpm > maxPatternMs) throw new Error(trigger === 'countdown' ? 'Use a pattern of at most fifteen seconds.' : 'Use a burst of at most five seconds for this prototype.');
    this.disarm('Candidate prepared.');
    this.profile = structuredClone(profile); this.mode = mode; this.trigger = trigger; this.armed = true;
    if (!this.timer) this.timer = setInterval(() => { void this.tick(); }, 1000 / 60);
    if (trigger === 'countdown') {
      this.deadline = timestamp() + countdown * 1000; this.remaining = countdown;
      this.emit({ type: 'countdown', seconds: countdown });
    }
    this.emit({ type: 'armed', ...this.state, rpm: profile.rpm, shots: profile.recoils[0].vectors.length });
  }
  input(firing: boolean) {
    if (this.calibration) return;
    if (this.trigger !== 'simulator') return;
    this.heartbeat = timestamp();
    const rising = firing && !this.firing;
    this.firing = firing;
    if (!firing) { this.stop('Fire released.'); return; }
    if (!rising || !this.armed || !this.profile || this.flight) return;
    this.startBurst();
  }
  private startBurst() {
    if (!this.armed || !this.profile || this.flight) return;
    this.engine = new RecoilEngine(this.profile);
    this.engine.setInput({ shooting: true, aiming: false, crouching: false, paused: false });
    this.started = this.lastTick = timestamp(); this.patternFinished = false; this.epoch++;
    this.emit({ type: 'burst-start', t: this.started, rpm: this.profile.rpm, shots: this.profile.recoils[0].vectors.length, mode: this.mode });
  }
  private async tick() {
    const now = timestamp();
    if (this.armed && this.trigger === 'countdown') {
      if (now - this.captureHealth > 750) { this.disarm('Live capture lost; take stopped.'); return; }
      if (now - this.mouseHeartbeat > 350) { this.disarm('Mouse listener lost; take stopped.'); return; }
      if (this.engine && now - Math.max(this.captureTime, this.started) > 500) { this.disarm('Capture frames stalled; take stopped.'); return; }
      if (this.deadline) {
        if (now - this.deadline > 100) { this.disarm('Timing gap; countdown cancelled.'); return; }
        const seconds = Math.max(0, Math.ceil((this.deadline - now) / 1000));
        if (seconds !== this.remaining) { this.remaining = seconds; if (seconds) this.emit({ type: 'countdown', seconds }); }
        if (now >= this.deadline) {
          this.deadline = 0; this.waiting = true; this.mouseReleased = !this.mouseHeld;
          this.emit({ type: 'waiting', ...this.state }); return;
        }
      }
    }
    if (!this.engine || !this.profile) return;
    if (this.trigger === 'countdown' && now - this.started >= 30000) { this.disarm('Recording reached the 30-second limit. Release fire before rearming.'); return; }
    if (this.trigger === 'simulator' && now - this.heartbeat > 300) { this.disarm('Simulator heartbeat lost.'); return; }
    const elapsed = now - this.lastTick;
    if (elapsed < 0 || elapsed > 100) { this.disarm('Timing gap; take stopped.'); return; }
    if (this.flight) return;
    const duration = this.profile.recoils[0].vectors.length * 60000 / this.profile.rpm;
    const delta = Math.min(elapsed, Math.max(0, this.started + duration - this.lastTick));
    this.lastTick = now;
    const [x, y] = this.engine.advance(delta), epoch = this.epoch;
    if (x || y) {
      try {
        this.flight = true;
        if (this.mode === 'pointer') {
          const sent = await this.output.moveProfile(x, y, () => !!this.engine && this.epoch === epoch);
          if (!sent) throw new Error('Movement was cancelled.');
        }
        if (this.epoch === epoch) this.emit({ type: 'move', t: timestamp(), x: this.mode === 'observe' ? 0 : x, y: this.mode === 'observe' ? 0 : y, mode: this.mode });
      } catch (error) { if (this.epoch === epoch) this.disarm(String(error)); }
      finally { this.flight = false; }
    }
    if (this.engine && this.epoch === epoch && now - this.started >= duration) {
      if (this.trigger === 'countdown') {
        if (!this.patternFinished) {
          this.patternFinished = true;
          this.emit({ type: 'pattern-end', t: now, shots: this.profile.recoils[0].vectors.length, durationMs: duration });
        }
      } else this.stop('Burst complete.');
    }
  }
  stop(reason = 'Stopped.') {
    const active = !!this.engine;
    this.engine = undefined; this.calibration = undefined; this.deadline = 0; this.remaining = 0; this.waiting = false; this.mouseReleased = false; this.epoch++;
    void this.output.disarm();
    if (active) this.emit({ type: 'burst-end', t: timestamp(), reason, durationMs: timestamp() - this.started, patternFinished: this.patternFinished });
  }
  disarm(reason = 'Lab disarmed.') { this.armed = false; this.stop(reason); this.publish({ type: 'status', ...this.state, reason }); }
  close() {
    this.disarm('Lab closed.');
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    const client = this.client; this.client = undefined; client?.end();
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined; this.url = ''; this.token = randomBytes(24).toString('hex');
  }
}
