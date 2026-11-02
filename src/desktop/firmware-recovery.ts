import type { BoardState } from './board';

export interface FirmwarePort { path: string; usbVendorId?: number; usbProductId?: number; serialNumber?: string }
export function findFirmwarePort(target: FirmwarePort, ports: FirmwarePort[]): FirmwarePort | undefined {
  const matches = ports.filter(port => port.usbVendorId === target.usbVendorId && port.usbProductId === target.usbProductId
    && (target.serialNumber ? port.serialNumber === target.serialNumber : port.path === target.path));
  return matches.length === 1 ? matches[0] : undefined;
}

interface RecoveryOptions {
  target: FirmwarePort;
  expectedVersion: string | null;
  requireRelay: boolean;
  ports(): Promise<FirmwarePort[]>;
  connect(path: string): Promise<void>;
  disconnect(): Promise<void>;
  restart(port: FirmwarePort): Promise<void>;
  state(): BoardState;
  progress(stage: string): void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

// Reset only when the application has not answered. A healthy application waiting
// for Bluetooth must not be bounced back into a disconnect/reconnect loop.
export async function recoverFirmware(options: RecoveryOptions): Promise<{ version: string; relayReady: boolean }> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const until = now() + (options.timeoutMs ?? 30000);
  let nextReset = now() + 6000, resets = 0, applicationSeen = false;
  let healthySince: number | undefined, firstUptime = 0, lastError = '';
  while (now() < until) {
    let port: FirmwarePort | undefined;
    try { port = findFirmwarePort(options.target, await options.ports()); }
    catch (error) { lastError = String(error); }
    if (port) {
      let state = options.state();
      if (!state.connected || state.path !== port.path) {
        options.progress('Waiting for the board to start and answer over USB');
        try { await options.connect(port.path); } catch (error) { lastError = String(error); }
        state = options.state();
      }
      const status = state.status;
      if (state.path === port.path && state.connected && state.ready && status?.usb && !state.error) {
        applicationSeen = true;
        if (options.expectedVersion && status.firmware !== options.expectedVersion) throw new Error(`The board started firmware ${status.firmware}, but ${options.expectedVersion} was expected. The update is not confirmed.`);
        if (!status.relay?.selfTest) throw new Error('The firmware started, but the mouse relay startup checks did not pass.');
        const relayReady = !!(status.ble && status.secure && status.subscribed && status.relay.mouseReady && status.relay.mouseSecure);
        if (relayReady || !options.requireRelay) {
          if (healthySince === undefined) { healthySince = now(); firstUptime = status.uptime; }
          options.progress(relayReady ? 'Checking that both mouse links stay connected' : 'Checking the running firmware');
          // Require a later status/heartbeat as well as a stable link interval.
          if (now() - healthySince >= 1500 && status.uptime > firstUptime) return { version: status.firmware, relayReady };
        } else {
          healthySince = undefined;
          options.progress(!status.ble || !status.secure || !status.subscribed
            ? 'Firmware is running; waiting for Windows Bluetooth to reconnect'
            : 'Firmware is running; wake the mouse to reconnect its Bluetooth link');
        }
      } else {
        healthySince = undefined;
        if (!applicationSeen && now() >= nextReset && resets < 2) {
          resets++;
          options.progress(`Retrying board restart (${resets}/2)`);
          // Never take the reset port while the input worker still owns it.
          await options.disconnect();
          try { await options.restart(port); } catch (error) { lastError = String(error); }
          nextReset = now() + 6000;
          await wait(1000);
        }
      }
    } else { healthySince = undefined; options.progress('Waiting for Windows to rediscover this board'); }
    await wait(500);
  }
  if (applicationSeen) throw new Error('The firmware started, but a stable mouse relay was not confirmed. Wake the mouse and check Windows Bluetooth, then retry recovery.');
  throw new Error(`The board did not return after restart. Press its RESET button without holding BOOT, or reconnect USB, then retry recovery.${lastError ? ` Last connection error: ${lastError}` : ''}`);
}
