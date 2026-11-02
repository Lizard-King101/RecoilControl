# XIAO ESP32-C3 mouse relay

Firmware **0.7.0 / protocol 4** forwards **Cobra Pro Bluetooth → ESP32-C3 →
Windows Bluetooth**, with optional weapon-profile corrections from the app.
Physical passthrough runs independently of USB commands. It decodes the source
HID descriptor and forwards relative
X/Y, up to eight buttons, vertical wheel, and horizontal pan when exposed by the
mouse. Keyboard/media remaps and vendor features such as Synapse configuration
are outside this mouse-only relay.

PlatformIO uses the Arduino framework, NimBLE-Arduino, and Adafruit NeoPixel's
ESP32 RMT implementation. Versions are pinned in `platformio.ini`.

## Hardware and power

- Seeed Studio XIAO ESP32-C3. **COM3** is the example port used below; substitute
  the port shown on your machine.
- 24 WS2812B LEDs, data on **D7 = GPIO20**, USB/5V power and common ground.
- Native USB Serial/JTAG carries setup and telemetry. It is not a USB mouse host;
  use the Cobra's Bluetooth mode, not its USB cable or 2.4 GHz dongle.
- The Windows mouse advertises as **Mouse Relay C3**.

Brightness (0–255, default 96) and the LED count (1–60, default 24) are set from the
app's **Status lights** card and saved in board NVS. Every frame passes through a
power limiter: each channel is estimated at 20 mA at full and each LED at 1 mA idle,
and a frame whose estimate exceeds 350 mA is dimmed uniformly. Sparse effects keep
full brightness; a full white ring is held back. These are datasheet estimates, not
measurements; with the board's own draw they aim to stay inside a 500 mA USB port.
Firmware before 0.7.0 capped every channel at 12/255. Startup clears the strip. Closing the app leaves the relay running while the board has power;
unplugging its only power source stops it.

## Build and pair

Install PlatformIO Core (or the PlatformIO IDE extension) and make `pio` available
in your terminal. From the repository root:

```powershell
npm run firmware:build
npm run firmware:upload -- --upload-port COM3
npm start
```

`firmware:build` also packages `firmware.bin` and `boot_app0.bin` into
`firmware/release` with a manifest of versions, addresses, and SHA-256 checksums. After
the first upload, the app's **Firmware** card can install new builds over USB: it writes
only `otadata` (0xe000) and `app0` (0x10000) from the board's partition table, verifying
each by MD5, and never rewrites the bootloader, partition table, or NVS.

Disconnect the app from COM3 before uploading or using a serial monitor. Keep
a second mouse available for setup.

1. In Windows Bluetooth settings, add **Mouse Relay C3**. If migrating from
   pre-0.3 firmware, first remove the old **Recoil Control C3** entry: version 0.3
   changes the HID descriptor and clears old board bonds once. Subsequent uploads retain pairings.
2. Open **Setup → Board & Bluetooth** in the app and connect your board's port.
   A single connected board is picked up automatically. The screen switches to
   relay controls. Existing 0.3 pairings are retained: the Windows HID format and
   Bluetooth identity are unchanged. Driver capture stays disabled.
3. Switch the Cobra Pro to **BT**. Hold **button 5 + wheel click + right button**
   for three seconds until it blinks, then click **Pair Cobra Pro** in the app.
   The board scans for up to 60 seconds. Windows pairs to the relay; pair the
   Cobra to the board here. See
   [Razer's instructions](https://mysupport.razer.com/app/answers/detail/a_id/5387).
4. Wait for both links, then move the mouse and release all buttons before
   testing clicks. A button held during reconnect is suppressed until released.

The saved mouse identity and bonds live in board NVS. Reconnection retries
increase to a maximum 15-second delay. Explicit pairing accepts advertised names
`Cobra Pro` and `Razer Cobra Pro`; multiple matches in one scan are rejected.
Only a successful encrypted HID connection replaces the saved identity.

## Desktop testing

Select a configured weapon and connect the board. **F7** toggles
compensation; **Escape** disables. Shift and configuration focus pause corrections;
release fire before resuming. Right mouse selects ADS; Ctrl selects crouch.
Fire/ADS come directly from the Cobra's BLE reports. Keyboard shortcuts use normal
Windows hooks, without Interception. The HUD shows the weapon and **RELAY / ACTIVE**.
These are the desktop defaults; **Controls** saves separate bindings per game.

Only Assault Rifle contains the original legacy recoil values. This integration
does not update or certify those patterns for current Rust. Start with a short
burst and compare fire presses, accepted corrections, and observed movement.
Profile changes, app restarts, USB faults, timing gaps over 100 ms, and the existing
10-second burst limit disable recoil until explicitly re-enabled.

Use the Board screen's **Mouse test area** to test left, right, middle, and side
buttons, and scrolling in both directions. It shows Windows-delivered events
beside board received/forwarded counts. Reset counters before comparing runs.

Timing measures **board report receipt → BLE notification callback**. It excludes
the sensor, first radio hop, Windows processing, and display. It is not an
end-to-end latency benchmark or proof that a game consumed the input. The screen
also shows negotiated link intervals, queue depth, discarded reports, decode/send
errors, and disconnect counts. Compare the feel with a direct mouse connection.

Use **Disconnect app**, leave board power connected, and continue moving/clicking
for at least ten seconds. Reconnect USB to inspect counters. Also test idle/resume
and mouse power-off/on. Physical tests require the real mouse; UI automation does
not exercise that path.

## Timeout and recovery

- No input-inactivity timer disconnects either Bluetooth link. BLE supervision
  handles actual link loss; the requested supervision timeout is six seconds.
- USB freshness expires after five seconds only for telemetry. The session
  remains valid and the next `PING` restores freshness. The app automatically
  renegotiates after a lost acknowledgement. Neither case stops the relay.
- Corrections use a separate single-frame buffer, not the physical input queue.
  Each carries the board's button generation and timestamp, expires after 100 ms,
  and requires physical left-button hold. Release, button changes, DISARM, session
  reset, and link loss cancel pending correction without clearing physical input.
  No autonomous recoil loop runs on the board. A notification already submitted
  to Bluetooth cannot be recalled.
- USB button telemetry arrives every 30 ms or on a detected button change while
  the session is open. Stale telemetry disables app output. Skipped button
  generations disable it rather than reusing a missed release/press.
- Serial output is nonblocking and omitted when its buffer is full, so an absent
  USB reader cannot stall mouse forwarding.
- Source loss, upstream reconnect, overflow, and stale input clear queued motion
  and enqueue button release. Held buttons need release before reuse.
- The queue holds 64 reports. Adjacent motion with identical button states may
  merge; press/release edges remain separate. Input over 250 ms old is discarded.
- Only an outstanding BLE notification has a two-second completion timeout. A
  genuine stall resets the Windows link and advertises again.
- NimBLE-Arduino 2.5.2 leaves its notification callback's connection information
  empty. Completion is matched to the sole upstream mouse characteristic,
  avoiding a false timeout/disconnect loop caused by checking that empty handle.

The ring follows the setup steps, then compensation. Effects live in
`src/led_effects.h` and redraw at 25 fps only while animating; static states are
never resent, because each strip update briefly blocks the relay loop. Every channel
passes through brightness and the power limiter. The design canvas has a live preview
of each state, and the app's Status lights card highlights the one showing now.

| LEDs | Meaning |
| --- | --- |
| Blinking red | Startup self-test failed; passthrough stopped |
| Blue breathing | Windows link not ready: add **Mouse Relay C3** in Windows |
| Fast purple twin comets | Scanning/pairing the Cobra |
| Amber breathing | Windows ready; Cobra missing |
| Green sweep, then low teal breathing | Both links ready; the app is not connected |
| Steady soft green | App connected; compensation off |
| Ember wipe, then steady ember | Armed. Each correction sent flashes it toward warm white |
| Every other LED amber, marching | Armed but paused (Shift held, or the app has focus) |
| Red breathing (whole ring) | Recording a pull: solid red with a hot sweep during a burst, a white flash per captured take |

Armed and paused come from the app's `IND` command and fall back to standby when
the app session ends, so the ring never shows "armed" after the app is gone.

BLE uses normal bonded encryption. PnP `1209:0001` is the shared
[pid.codes test PID](https://pid.codes/1209/0001/), not an assigned product ID for
distribution. The device identifies itself as a prototype mouse.

## Serial protocol 4

115200 baud; ASCII commands and JSON replies/status, one per line. IDs increase
within a session and must be positive signed 32-bit integers.

```text
HELLO 1 RC4
PING 2
STATUS 3
LED 4 6
PAIR 5
RESETSTATS 6
DISARM 7
TRACE 8 1
IND 9 1
LEDS 10 24
```

`HELLO` starts/resynchronizes a session. `LED` accepts 0–255 (0–12 before 0.7.0) and
`LEDS` 1–60 (0.7.0); both are saved on the board. `PAIR` starts
explicit pairing; `RESETSTATS` clears diagnostic counters. `DISARM` is a
correction-only stop that leaves physical passthrough untouched. `IND` (0.6.0) sets
the LEDs to standby (0), armed (1), or paused (2); it is display only, reported
as `relay.indicator`, and reset by `HELLO` or a lost session. `ARM`, `MOVE`,
and legacy `FRAME` always return `passthrough_only`.
`RFRAME <id> <button-generation> <board-timestamp-ms> <x> <y>` accepts at most
±127 counts per axis, with one correction outstanding. It requires fresh source
telemetry and both links. Its reply follows transmission or cancellation and
includes `sent: true|false`; expired or failed reports are never retried.
Replies contain `kind`, `id`, `ok`, and `error`. Status includes board identity,
protocol, USB freshness, Windows link flags, LEDs, uptime, and a `relay` object
containing source-link state, counters, and timings.
Fast `input` JSON lines carry `buttons`, `generation`, `stamp`, and `connected`.
The app also supports older protocol 2 output and protocol 3 passthrough firmware.

## Verification

```powershell
npm test
npm run test:desktop
# Disconnect the app from COM3 before either hardware check:
npm run board:check -- COM3
npm run test:board-worker -- COM3
```

Startup tests run on the actual C3 and prevent forwarding if parser or queue
checks fail. They cover signed axes, padding, wheel/pan, malformed reports, click
edges, held-button suppression, large-delta splitting, and stale-motion removal.
App tests cover protocol validation, synthetic-output rejection, and USB recovery.
The protocol check expires a heartbeat and checks link continuity and recovery
with the same session. The worker check stalls Electron's main thread and checks
continued heartbeats and blocked recoil. Neither generates physical test motion.

The old `test:board-profile -- --move` is for firmware 0.2 and is not a relay test.
The relay input path has been user-tested in Rust; current recoil calibration
remains unverified. Keep separate CLI/driver controllers closed during testing.

### In-app update validation, 2026-11-02

Firmware 0.7.0 was successfully reinstalled through the desktop updater, and the
user confirmed that the update and restart worked. The app now verifies the
running firmware, startup checks, fresh telemetry, and stable Bluetooth links
before reporting completion. The final automated run passed 105 regression tests
and the isolated desktop checks; it did not reflash the board.

The reset uses an explicit RTS pulse with DTR released. The bundled
[esptool-js 0.7.0 hard reset](https://github.com/espressif/esptool-js/blob/v0.7.0/src/reset.ts)
only releases RTS, which could leave this board in the flasher. Recovery releases
the serial handle, follows USB identity across COM changes, and makes at most two
additional reset attempts if firmware does not answer. A responding application
waiting for Bluetooth is not repeatedly reset.

If recovery times out, focus the main window and press **Alt+R** or choose
**Retry board recovery**. This does not rewrite flash. See the
[update and recovery instructions](../README.md#firmware-updates-and-recovery)
for physical recovery and interrupted-write limitations.

### Local bring-up, 2026-11-01

The Cobra paired successfully and the board decoded movement, buttons, and wheel
reports. Both encrypted Bluetooth links remained connected after the callback
fix. The hardware USB-timeout and blocked-Electron checks passed, as did 52 app
tests and desktop integration. Initially the user reported no Windows cursor
movement despite board transmit callbacks.

Diagnostics found the legacy Interception `mouse` filter on the relay's Windows
driver stack and 409 registered PointerClass entries after the initial reconnect
loop. The relay enumerated as a started HID mouse but was absent from the active
Raw Input mouse list. This was consistent with Interception's
[documented reconnect-limit bug](https://github.com/evilC/AutoHotInterception#known-issues).
With explicit user approval,
the bundled uninstaller completed successfully at 13:04 local time; configured
class filters now contain only Microsoft's `mouclass` and `kbdclass`. The user
then restarted Windows and confirmed automatic reconnection and working mouse
passthrough without launching the app. With the app closed, they also confirmed
smooth pointer movement, left/right/middle clicks, both side buttons, scrolling
up/down, and resume after about 30 seconds idle, without sticking or noticeable
delay. These are user-observed desktop results, not an instrumented end-to-end
latency measurement. A separate Cobra power-off/on test remains unverified.
Windows HID inspection now opens the relay successfully, reports the expected
eight-byte input report including its ID, and correctly parses X/Y test values
offline. The same device previously failed to open before the restart.

The post-restart serial counter check could not open COM3 (access denied), so no
new board timing or error-counter measurements were recorded for that run.
That 0.3 baseline kept recoil disabled. Keyboard shortcuts use ordinary Windows hooks/Electron
and do not require Interception; legacy driver output and raw DPI capture do.

### Pull recording (0.5.0)

`TRACE <id> 1` makes the board stream the physical Cobra movement it relayed as
`{"kind":"motion","seq":n,"stamp":µs,"dx":…,"dy":…,"buttons":…}` lines: at most every
8 ms while moving, and immediately on a button change. `TRACE <id> 0`, a new HELLO, or
a lost USB session stops it. Movement is accumulated until the USB buffer accepts a
line, so none is dropped; `seq` restarts at 0 for each session and lets the app
discard any take with a gap. Tracing never changes what is forwarded to Windows and
carries no recoil corrections. Status reports `relay.tracing`; its presence tells the
app the firmware can record. Protocol 4 and HELLO RC4 are unchanged.

Firmware 0.5.0 was flashed and used for pull recording, and 0.6.0 for the first LED
effects. 0.7.0 (breathing, full-ring recording, 0–255 brightness with the power
limiter, saved LED count) has also been flashed and reinstalled with the desktop
updater. After uploading, run `npm run test:board-worker` with the
relay connected: it starts and stops a recording and checks that compensation stays
off and no corrections are sent.

### Profile relay validation, 2026-11-01

Firmware 0.4.0 compiled and flashed successfully. Its onboard tests passed,
including correction/physical-motion mixing, cancellation while holding fire,
fresh-release gating, expiry, and link-loss cancellation. Both saved Bluetooth
pairings reconnected automatically. The 56 app regression tests and desktop
integration passed. Hardware checks confirmed that a USB heartbeat expiry and a
2.3-second Electron main-thread stall leave the relay connected, with zero decode
or send errors during those checks. The user then confirmed that a short burst
with the selected Assault Rifle profile applied compensation in Rust while normal
aiming continued to work. This validates the tested input path, not current recoil
calibration: the profile still uses legacy tuning. The user completed and then
explicitly repeated the app-quit test: with compensation disabled and the app
closed, aiming, clicks, and scrolling continued normally in Rust for at least
ten seconds. Subsequent process inspection confirmed the earlier app instance
had exited and a new instance was running. COM3 was busy during the later serial
probe, so no fresh serial-counter result is claimed for the manual quit-app test.

## Profile-output backup

The backup files below are local bring-up artifacts, ignored by Git and **not
included in a clone**. These restore instructions only apply if you have those files.

The verified passthrough-only 0.3 firmware is saved in
`backups/passthrough-0.3.0.bin` and `backups/passthrough-0.3.0-source.zip`.
Restore its app image at **0x10000** on the same board to return to passthrough-only
operation. It shares the current HID format and saved pairings.

Before this change, the firmware 0.2 app image and source were saved in
`backups/profile-output-0.2.0.bin` and
`backups/profile-output-0.2.0-source.zip`. To roll back on the same board,
disconnect COM3 and write the app image at **0x10000** with esptool. Remove/re-pair
the Windows Bluetooth device because the HID descriptor changes back. This
image does not restore old NVS bonds.

## Original lamp firmware backup

Before flashing, the entire 4 MB flash was saved locally to:

`backups/pre-recoil-c3-20261101.bin`

SHA-256:
`39F3AEC69B821BAB9C07D20983EF27D3ACA5B286CB1C074755CB6BA7BA1B858F`

Backups and build outputs are ignored by Git. To restore that exact lamp image
to the same board, first disconnect the app/serial monitor, then run from the
repository root:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" `
  "$env:USERPROFILE\.platformio\packages\tool-esptoolpy\esptool.py" `
  --chip esp32c3 --port COM3 --baud 460800 write_flash 0 `
  firmware/backups/pre-recoil-c3-20261101.bin
```

This replaces the current firmware and its saved Bluetooth bonds with the backup.
