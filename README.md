# Recoil Control

A Windows desktop app with a configuration window and a compact always-on-top
HUD, continued from the `experimental` branch. The input engine also has a CLI.

The configuration window includes game collections, weapon and stance editing,
JSON profile import/export, mouse DPI setup and physical measurement, output
previews, and manual weapon calibration. The HUD shows the selected game, weapon,
stance, DPI, and live enabled/paused status.

ESP32 firmware **0.7.0 combines the physical relay, weapon profiles, pull recording, and animated status LEDs**:
Razer Cobra Pro Bluetooth → XIAO ESP32-C3 → Windows Bluetooth. Physical movement,
buttons, and scrolling work without the app. When explicitly enabled, the selected
profile adds bounded corrections to that same mouse connection. Fire and ADS come
from the Cobra; keyboard shortcuts use Windows hooks. Closing/disconnecting the
app stops recoil while physical passthrough continues. The **ESP32 board** screen
shows both links, input counts, recoil reports, and board forwarding times.

Firmware for 24 WS2812B LEDs on **D7/GPIO20** lives in
[`firmware/`](firmware/README.md), with pinned PlatformIO dependencies and a hard
LED brightness cap. See that guide for pairing, tests, timeout behavior, and
backups. Interception is not required for the relay. Its legacy output mode remains
separate, and driver DPI capture is disabled in relay mode. Current Rust
calibration remains unverified.

## Setup

Use Node.js 24 or newer on x64 Windows. From this project directory:

```powershell
npm ci
npm test
npm run doctor
npm start
```

`doctor` loads the native addons and counts driver-visible mice, without capturing
input or moving the cursor. A nonzero exit code means live input is unavailable.
Zero mice usually means the Interception driver is missing or Windows has not
restarted since its installation. It can also mean no supported mouse is connected.

The native driver is a separate, machine-wide installation. To install it, run
this command from an **Administrator PowerShell** in this directory, then restart
Windows yourself:

```powershell
& .\node_modules\node-interception\interception\driver\install-interception.exe /install
```

After restarting, run `npm run doctor` again. Use `/uninstall` with the same
installer, followed by a restart, to remove the driver. The application and
`npm ci` never install or remove drivers automatically. See the
[upstream installation instructions](https://github.com/Rami-Sabbagh/node-interception#installation).

Electron downloads its desktop runtime on first launch if it is not already
installed. The app's configuration screens remain usable when the input driver
is unavailable; live activation and physical DPI measurement require the driver.

### Board connection and firmware updates

The app connects to the board by itself when exactly one is plugged in over USB, and
again after it is replugged. **Disconnect** is respected until that board is unplugged;
with several boards plugged in, choose one under **Setup › Board & Bluetooth**.

The **Firmware** card there shows the version on the board and the one bundled with the
app. **Update** (pressed twice to confirm) disconnects the app, which also stops
compensation and any recording, restarts the board into its ROM bootloader over USB, and
writes and MD5-verifies only the application and its boot selector with
[esptool-js](https://github.com/espressif/esptool-js). The bootloader, partition table,
and NVS (Bluetooth pairings, brightness, LED count) are not touched, and the app
reconnects when the board restarts. The ROM bootloader cannot be overwritten, so a failed
update can always be retried, or recovered with `npm run firmware:upload`.
`npm run firmware:build` packages each build into `firmware/release` with checksums.

## Run

```powershell
npm start
```

The app starts **disabled**. Use the switch at the top right or the toggle hotkey.
Compensation pauses while the configuration window or interactive HUD is focused. Switch to your
practice session, minimize the window, or choose **HUD mode** before testing.
Changing game, pattern, or input settings returns the controller to standby.
HUD and keyboard weapon selection retain the enabled state for configured weapons,
while selecting an empty weapon turns compensation off. Release fire after switching.
Selection from the main weapon list returns to standby.
Buttons already held when capture starts must be released and pressed again.

| Control | Action |
| --- | --- |
| F7 | Toggle recoil control |
| F5 / F6 | Previous / next configured weapon |
| Escape | Disable immediately |
| F8 | Toggle live stance tuning (does not enable compensation) |
| F9, while tuning | Cycle tuning target: each stance, then follow current stance |
| Left / Right, while tuning | Decrease / increase tuning target horizontal strength |
| Down / Up, while tuning | Decrease / increase tuning target vertical strength |
| Hold either Shift | Pause compensation; release to begin a fresh burst |
| Left mouse | Apply compensation while held |
| Right mouse | Select aiming profile |
| Either Ctrl | Select crouching profile |
| Ctrl+Shift+H | Restore the configuration window from HUD mode |
| Close configuration window | Exit the app and release input capture |

These are the desktop defaults. **Controls** saves a separate set of action keys,
pause/crouch hold keys, and optional direct weapon shortcuts for each game.
Shortcuts are observed, not consumed: they also reach the game. Modifier combinations
must match exactly; release extra Ctrl/Alt/Shift keys when using a plain function key.
Duplicate shortcuts are rejected. Escape and Ctrl+Shift+H remain fixed. Existing
settings migrate to these defaults without changing saved weapon patterns.
The standalone CLI retains **Enter + Numpad Plus**.

### Live tuning and the pattern workshop

Open **Calibration → Live stance tuning**, or press **F8** away from the
configuration window. By default, arrow keys follow your current ADS/crouch stance.
Choose **Tuning target → Lock: Crouch ADS** (or another stance) to edit it after
releasing the mouse and Ctrl. While tuning, **F9** cycles through the available
stances and back to **Follow current stance**. The lock selects which values the
arrows edit; compensation continues to use your actual ADS/crouch buttons. The HUD
names the editing target and shows **LOCKED** or **FOLLOW** separately from the
actual output stance. Save, discard, or changing profiles resets the target to
following. F8/Escape keep the target for the next tuning burst in the same session.

The default step is one percentage point of the saved strength;
the panel also offers 2% and 5%. Holding an arrow does not repeat adjustments.
The HUD shows the current stance, horizontal/vertical percentages, and step.
Arrow keys are observed, so they also reach the foreground application.

Changes stay in memory until **Save tuning**. F8 stops editing while retaining the
applied draft. Escape stops editing and disables compensation. **Discard** restores
saved strengths and disables compensation. Save also disables compensation; enable
it again when ready. Saving applies every edited stance to its stored pattern and
starts a new draft at 100% of those saved values. The calibration cards and weapon
preview show saved first-shot counts, before global strength and sensitivity scaling.
For counts patterns, saving folds the gain into the shot vectors and normally resets
their extra multipliers to 1 × 1. A new session can increase the saved result again;
the stored multiplier's old 2× ceiling no longer strands tuning at 100% after saving.
Each session allows up to 300% of the saved strength, subject to the pattern's actual
per-shot storage bounds. Calibration shows each axis's session maximum, and the HUD
marks a reached limit. Saving does not bypass the actual per-shot bound.
Save/discard before switching weapons, editing patterns, or
reconnecting. Closing the app discards the draft. The physical ESP32 mouse relay
does not depend on tuning or the app staying connected.

**Loadout → Edit pattern** opens the full-window pattern workbench. Stance chips
switch the stance being edited. The canvas shows the draft's cumulative shot
endpoints with the last saved version dashed behind it. The shot timeline below
selects one shot (click) or a range (Shift+click); **Select all** resets it.

**Record a pull** (relay firmware 0.5.0 or later) builds a stance from your own hand.
Set the shots per magazine, press **Start recording**, then fire full magazines in a
practice range while pulling the mouse to stay on target. The HUD shows **REC** and the
take count. Compensation stays off, and cannot be enabled, until recording stops;
leaving the workbench stops it too. Each take runs from a fire press to its release.
Takes with lost movement data, under 250 ms, or over 15 seconds are discarded with a
reason; the latest five are kept. Takes are split into shots at the pattern's fire
rate, and shots after the magazine runs dry are ignored. **Use recording** combines
the takes with a per-shot median and rates their consistency. Takes whose ADS state
does not match the stance are skipped (crouch cannot be detected from the mouse).
The result is divided by the weapon's strength and sensitivity/ADS calibration so
output reproduces the recorded movement, sets the stance multiplier to 1 × 1, and
records the current DPI/sensitivity as the calibration if none existed. Undo restores
the previous shots.

**Fix after a test burst** adjusts the selected range: **Went high / Went low** scale
its vertical pull up or down; **Drifted left / right** push X against the drift by a
share of the range's average shot size (at least 0.5 counts). Fix size is 5%, 10%, or
20%. With unsaved changes, Back or Escape asks before discarding.

Collapsible tools keep the earlier editing options: the shot table (add/duplicate/
remove shots, paste X/Y pairs), reshape a range by percentage, build from shot
positions, generate a constant pattern or a linear ramp, and copy a stance. Drag an endpoint or
select a shot and enter its X/Y position to reshape it; the other endpoints stay
fixed, so the two connecting vectors change. Position editing includes stance
multipliers and requires them to be nonzero. Range tools scale selected shot vectors
independently on X/Y; a negative scale mirrors an axis. These actions have undo.
The preview updates before saving and never sends mouse movement.

**Build from shot positions / a recoil guide** accepts one cumulative X/Y position
per shot in firing order, relative to an origin at (0, 0), with positive Y down.
Choose game recoil to invert both axes, or desired compensation to retain them.
An adjustable reference scale converts coordinates to counts. Conversion replaces
only the current stance and resets its extra multiplier to 1 × 1. Screen pixels
are not mouse counts; reference paths still require in-game tuning. This is manual
guide conversion, not automatic screen capture or game-recoil recording.

**Add weapon → Create & edit pattern** opens the workshop with a blank pattern or a
copy of a configured weapon. Blank patterns start with zero movement and a generic
600 RPM that you should replace. Copies keep tuning and calibration but clear the
direct shortcut. The weapon list also supports **Duplicate** for separate variants.
LR-300 and Custom SMG remain available as empty slots for authoring your own patterns.

New and edited patterns use raw **counts per shot**. RPM changes timing without
changing each shot's distance. Opening a legacy pattern converts its vectors and
stance multipliers to counts while preserving its integrated movement, within
integer rounding. The converted editor multipliers start at 1 × 1 because saved
stance strength is already included in the shot counts. Cancelling the editor
leaves the saved pattern untouched. Each
shot keeps the existing velocity easing. The workshop preview includes stance
strength, before global weapon strength and sensitivity scaling. Counts-format
exports use `recoil-control/weapon-v2`; imports accept both v1 and v2.

These tools help measure and tune local profiles; they do not supply verified
current Rust recoil patterns. The saved AK standing-strength trial remains your
starting point until you save further adjustments.

The toggle requires the **numpad** plus key. Ordinary mouse input continues to pass
through, including middle/side buttons and horizontal scrolling. Output goes to
the mouse that initiated the burst. After a device failure, the app disables
compensation and reports the error; toggle again after resolving it.

If output stops when a game has focus, close other copies of the app and run
`npm run cli -- --trace`. It starts disabled. Toggle it on after focusing the game
and compare the timestamped counters with a desktop test. Escape disables it
globally, including when used for a game's menu; Shift pauses it.

The trace reports received mouse events, left-button presses, pause reasons,
timer ticks, maximum tick interval, and attempted/accepted output packets.
Counters accumulate for that process; compare their changes between bursts.
If `firePresses` increases but output does not, inspect enabled/pause state and
timer intervals (intervals over 250 ms discard output). If `movementsAccepted`
increases, the driver accepted output, but that does **not** prove the game used
it. Trace mode records aggregate counts and controller state, not typed text,
screen contents, or mouse coordinates. It uses the same legacy profile as the CLI.
The desktop app exposes the same counters under **Input setup → Live input
diagnostics**, using the currently selected profile. Read the totals before and
after testing without saving settings in between, since saving reloads the profile.

A local compatibility test on 2026-11-01 found that, while Rust was running,
the controller's timer continued normally but received no mouse events, even
after Rust was minimized. After Rust was closed and the controller toggled off
and on, physical mouse capture and generated movement resumed. This points to
a conflict involving the current Interception backend and software running with
Rust; the responsible component (including whether anti-cheat is involved) has
not been established. Driver enumeration and an enabled/Active label alone do
not verify working capture. That legacy backend's Rust compatibility remains
unresolved. The separate ESP32 BLE relay with firmware 0.4 was subsequently
user-tested in Rust on 2026-11-01: compensation and normal aiming worked together
through one mouse connection. The profile values remain legacy tuning.

In **HUD overlay**, enable the panel and apply its settings. Drag it while unlocked;
use its previous/next buttons or weapon selector to switch, and On/Off to toggle.
Previous/next skips empty profiles. Save or discard live tuning before switching.
The extra controls hide when the HUD is locked;
lock it to make clicks pass through to the application underneath. Position,
opacity, and lock state are saved. HUD mode hides the configuration window.
If the restore shortcut is already in use, the HUD must remain unlocked so its
settings button can bring the main window back. Desktop overlays may not appear
over exclusive fullscreen games; use borderless/windowed mode.

## Profiles and Rust recoil

The Rust collection starts with Assault Rifle, LR-300, MP5A4, Thompson, Custom SMG,
and M249 slots. Only Assault Rifle contains movement data: the old AK values,
explicitly marked **Legacy tuning**. Other slots require your own data. There is
no claim that a current, verified recoil dataset is bundled.

Facepunch's [June 2022 combat update](https://rust.facepunch.com/news/the-combat-update)
describes drift and inaccuracy that vary between bursts. A fixed movement path
cannot exactly cancel those variations. Profile previews show **our mouse
output**, not measured in-game recoil. Use local measurements to replace the
legacy profile, and check tuning again after game updates.

Use **Edit pattern** to set fire rate, per-stance multipliers, vectors, and the
end/loop behavior. One vector is entered as `X, Y` per line. Negative X moves left;
positive Y moves down. The default stance can be copied into all four stances
as a starting point. Exported JSON includes data and provenance; imported files
are validated and treated as custom tuning, not verified local calibration.

Use the + beside **Game collection** to create another game with its own loadout
and sensitivity settings. **Add weapon** creates a blank slot in that collection.

## DPI and calibration

1. Under **Input setup**, enter the active mouse DPI, game sensitivity, and ADS
   multiplier. Initial values are editable defaults, not detected settings.
2. For a physical DPI check, measure a horizontal distance on the mouse pad,
   start measurement, move in one direction, and press Escape to finish. Enter
   the actual distance and apply the measured DPI. Capture ends after 20 seconds.
   Compensation is off throughout; ordinary input is forwarded unchanged.
3. In **Calibration**, preview the output on the canvas and adjust horizontal and
   vertical strength. Apply strength before testing in your practice session.
4. After testing the stances, **Save calibration** records this local setup. It
   preserves current output while rebasing the sensitivity reference.

Injected movement uses raw counts, so DPI does not directly multiply output.
A calibrated profile scales inversely with saved game sensitivity and ADS
multiplier. This is a first-order adjustment; verify it in the actual game.
DPI measurement does not change your mouse's firmware/DPI stage.

Settings are stored at `%APPDATA%\Recoil Control\settings.json`. Writes use a
temporary file and preserve the previous file as `settings.json.backup`.
Invalid settings are reported and preserved for recovery. No profiles or enabled
state are fetched from the internet; live activation never persists across launches.

## Development and verification

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run serve` | Build and open the desktop app |
| `npm run cli` | Build and run the original CLI |
| `npm run serve:cli` | Run the CLI with source watching |
| `npm run build` | Compile TypeScript into `build/` |
| `npm run typecheck` | Check source without emitting files |
| `npm test` | Build and run simulated-input regression tests |
| `npm run test:desktop` | Run isolated, offscreen renderer/IPC integration checks |
| `npm run demo` | Print simulated one-second bursts; no native addons or hooks |
| `npm run doctor` | Check native-module loading and driver availability |
| `npm run cli -- --help` | Show command-line help |

Tests cover mouse forwarding, input combinations, pause, immediate disable,
rapid toggles, pending native waits, device failures, timing, profile modes,
configuration-focus pause, settings validation, persistence, DPI capture, and
calibration scaling. Desktop checks exercise collection creation, pattern editing,
input settings, calibration, and HUD settings with compensation kept disabled.
They do not establish compatibility with a particular game or calibrate the
profile for its sensitivity, resolution, or current recoil behavior.

## Code layout

- `src/profiles.ts`: weapon data and profile conditions.
- `src/recoil-engine.ts`: pure calculations, independent of Windows/native modules.
- `src/anti-recoil.ts`: hotkeys, input state, activation, and shutdown lifecycle.
- `src/input.ts`: the input and clock interfaces used by the controller and tests.
- `src/windows-input.ts`: the Windows native-module adapter.
- `src/index.ts`: command-line startup, diagnostics, demo, and signal handling.
- `src/desktop/main.ts`: Electron windows, validated IPC, persistence, and worker lifecycle.
- `src/desktop/worker.ts`: native input in a separate utility process.
- `src/desktop/settings.ts`: settings schema, validation, and calibration scaling.
- `src/desktop/measurement.ts`: raw input capture for physical DPI measurement.
- `ui/`: sandboxed configuration and HUD renderers with a narrow preload API.

Native modules are isolated from both renderers. Only local content loads, Node
integration is disabled, and IPC validates both the sender and submitted data.
The controller's lifecycle remains independent of the configuration UI.

The restored engine retains the experimental profile values but integrates motion
over elapsed time, preserves subpixel movement, and discards long-stall backlogs.
That fixes the old frame-rate-dependent calculation; the legacy tuning should be
rechecked on real hardware.

`node-interception` 2.0.4 has incomplete declaration files (an undeclared `External`
type), so `skipLibCheck` is enabled for dependencies. Application code remains
strictly checked. The dependency is pinned; its upstream repository is archived.
The lockfile is retained to make installs reproducible.
