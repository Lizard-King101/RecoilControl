const { AntiRecoil } = require('../build/anti-recoil');

const flush = () => new Promise(setImmediate);
const mouseStroke = (state = 0, extra = {}) => ({
  type: 'mouse', state, flags: 0, x: 0, y: 0, rolling: 0, information: 0, ...extra,
});

function fixture({ mice = 1 } = {}) {
  const contexts = [];
  const errors = [];
  const messages = [];
  const sent = [];
  const timers = new Set();
  let now = 1000;
  const backend = {
    mice,
    hookStarts: 0,
    hookStops: 0,
    createContext() {
      const context = {
        captures: [], destroyed: false, pending: null,
        mouseCount: () => backend.mice,
        capture(enabled) { this.captures.push(enabled); },
        wait(timeout) {
          if (this.pending) throw Error('Concurrent native waits');
          this.timeout = timeout;
          return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
        },
        deliver(device = null) {
          const pending = this.pending;
          this.pending = null;
          if (!pending) throw Error('No pending wait');
          pending.resolve(device);
        },
        fail(error = Error('Native wait failed')) {
          const pending = this.pending;
          this.pending = null;
          pending.reject(error);
        },
        destroy() {
          if (this.pending) throw Error('Destroyed a context while wait was still running');
          if (this.destroyed) throw Error('Destroyed twice');
          this.destroyed = true;
        },
      };
      contexts.push(context);
      return context;
    },
    listenKeyboard(down, up) {
      this.hookStarts++;
      this.down = down;
      this.up = up;
      return () => { this.hookStops++; };
    },
  };
  const clock = {
    now: () => now,
    every(callback) { timers.add(callback); return () => timers.delete(callback); },
  };
  const app = new AntiRecoil(backend, {
    clock, onStatus: message => messages.push(message), onError: error => errors.push(error),
  });
  const device = (id = 11) => ({
    id, stroke: null, failSend: false,
    receive() { return this.stroke; },
    send(stroke) {
      if (this.failSend) return false;
      sent.push({ id, stroke });
      return true;
    },
  });
  return {
    app, backend, contexts, errors, messages, sent, timers, device,
    get context() { return contexts.at(-1); },
    tick(delta = 1000 / 60) { now += delta; for (const callback of [...timers]) callback(); },
    async input(device, stroke) {
      device.stroke = stroke;
      contexts.at(-1).deliver(device);
      await flush();
    },
    async start() { app.start(); await app.setEnabled(true); },
    async stop() {
      const done = app.dispose();
      if (contexts.at(-1)?.pending) contexts.at(-1).deliver();
      await done;
    },
  };
}

module.exports = { fixture, flush, mouseStroke };
