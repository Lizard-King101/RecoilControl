import { constants, setPriority } from 'node:os';
import { AntiRecoil } from './anti-recoil';
import { inspectBackend, missingDriverMessage } from './input';
import { akProfile } from './profiles';
import { RecoilEngine } from './recoil-engine';
import { loadWindowsBackend } from './windows-input';

function demo(): void {
  console.log('Simulated one-second bursts. No input hooks or mouse output are used.');
  const results = akProfile.recoils.map(profile => {
    const engine = new RecoilEngine();
    engine.setInput({
      shooting: true, paused: false,
      aiming: profile.activate.includes('aiming'),
      crouching: profile.activate.includes('crouching'),
    });
    let x = 0;
    let y = 0;
    for (let frame = 0; frame < 60; frame++) {
      const movement = engine.advance(1000 / 60);
      x += movement[0];
      y += movement[1];
    }
    return { profile: engine.profile.name, x, y };
  });
  console.table(results);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (args.length > 1 || (mode && !['--help', '--doctor', '--demo', '--trace'].includes(mode))) {
    throw new Error('Usage: npm run cli -- [--help | --doctor | --demo | --trace]');
  }
  if (mode === '--help') {
    console.log('npm run cli -- --trace  Run with input/output counters once per second. Starts disabled.');
    console.log('Recoil Control\n\nnpm start          Open the desktop app and HUD settings.\nnpm run cli        Run the standalone controller, initially disabled.\nnpm run serve:cli  Run the CLI with source watching.\nnpm run doctor     Check native modules and driver-visible mice without capturing input.\nnpm run demo       Simulate recoil without native input.\n\nEnter + Numpad Plus toggles. Escape disables. Hold either Shift to pause.\nRight mouse aims; either Ctrl crouches. Ctrl+C exits the CLI.');
    return;
  }
  if (mode === '--demo') { demo(); return; }

  console.log(`Anti Recoil | Node ${process.version} | ${process.platform}/${process.arch}`);
  const backend = loadWindowsBackend();
  if (mode === '--doctor') {
    console.log('Native input modules loaded.');
    const mice = inspectBackend(backend);
    console.log(`Driver-visible mice: ${mice}`);
    if (mice === 0) throw new Error(missingDriverMessage);
    console.log('Ready for live input. No input was captured.');
    return;
  }

  const trace = mode === '--trace';
  const app = new AntiRecoil(backend, {
    onStatus: message => console.log(trace ? `${new Date().toISOString()} ${message}` : message),
    onError: error => console.error('Input error:', error),
  });
  let traceTimer: ReturnType<typeof setInterval> | undefined;
  let previous = '';
  const report = () => {
    const snapshot = JSON.stringify(app.diagnostics);
    if (snapshot !== previous) {
      previous = snapshot;
      console.log(`${new Date().toISOString()} TRACE ${snapshot}`);
    }
  };
  let closing = false;
  const shutdown = async (error?: unknown) => {
    if (closing) return;
    closing = true;
    clearInterval(traceTimer);
    if (error) { console.error(error); process.exitCode = 1; }
    try { await app.dispose(); if (trace) report(); } catch (cleanupError) {
      console.error('Shutdown error:', cleanupError);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGBREAK', () => void shutdown());
  process.once('uncaughtException', error => void shutdown(error));
  process.once('unhandledRejection', error => void shutdown(error));
  try {
    app.start();
    if (trace) {
      console.log('TRACE counters are cumulative. movementsAccepted means driver acceptance, not game acknowledgement.');
      report();
      traceTimer = setInterval(report, 1000);
      traceTimer.unref();
    }
    try { setPriority(constants.priority.PRIORITY_ABOVE_NORMAL); } catch {
      console.warn('Using normal process priority.');
    }
  } catch (error) {
    await app.dispose();
    throw error;
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
