# Vision lab: Linux recording prototype

Open **Loadout → Pattern → Vision lab** with a configured weapon/setup selected.
The lab is separate from the existing Windows/BLE gameplay controller. It can
capture an existing FPS, review clips, and apply desktop mouse movement without
the BLE board or any game-side integration. A separate Linux mouse listener reads
the selected physical mouse’s left button. The lab never presses fire for you.

## First test

1. Open your FPS and find a textured, stationary scene. Keep the weapon, stance,
   zoom, and sensitivity consistent between takes.
2. In the lab, choose a screen/window. On Wayland, the desktop picker opens
   directly for this capture request; no second Start capture click is needed. Set the center crop between **15–30% of the source's
   width and height**. The center reticle and bottom of the crop are masked by
   default; drag rectangles to ignore a sight or weapon. Reset restores defaults.
3. Enter the weapon RPM and **Shots to measure** (up to 120 shots / 15 seconds).
   A one-entry starter profile defaults to a 30-shot target, bounded by that duration.
   Existing longer patterns default to their full length within the limit. New
   shot entries start at zero assistance; accepting measured updates can extend
   the selected stance without changing other stances or setups. Leave **Start a take**
   on **Countdown → hold fire**. There is no link to copy or code to add to the game.
4. Under Live recording, click **Find mice**, select the physical mouse you use
   to fire, and click **Connect mouse**. If permission is needed, use **Allow
   selected mouse…**, approve the Linux dialog, then connect (see permissions below).
5. Start with **Observe only**. Choose a countdown of 3–15 seconds, click **Count
   down & arm**, and switch to the game. The high tone means **armed and waiting**.
   Aim, then hold left mouse to start recording and assistance. Release stops both.
   If already holding at the tone, release and press again. Reaching the selected shot count stops further movement but **keeps recording
   until release**. The lab reports that the pattern finished without disarming.
   A 30-second recording limit remains as a backstop. Each arming produces
   one take; screen sharing stays on for the next one. Adjust **First shot offset**
   for game firing latency and capture delay relative to mouse-down. RPM and actual
   shot onset are not detected automatically.
6. Before assisted takes, connect the desktop pointer and click **Calibrate Linux
   pointer…**. Switch to the game during the countdown, hold your test zoom, and
   keep the mouse/player still without firing. The lab measures both axes in both
   directions and fills the signed scales only if tracking and agreement pass.
   Re-aim afterward. You can also enter measured **scene pixels per positive
   mouse unit** for X and Y manually. For example,
   if +1 unit of mouse Y moves the visible background upward by 2 pixels, Y is
   **-2**, not +2. Screen resolution, capture scaling, zoom, and the chosen input
   path affect this measurement. The checkbox acknowledges your measured scale.
7. Review usable intervals, accept a small update, then record another burst to
   validate it. For assistance, connect the desktop pointer and select **Linux
   desktop pointer**. The pattern remains fixed within each take. Undo restores
   the preceding candidate. Save writes the candidate and RPM to this setup;
   other setups, unmeasured later shots, and other stance vectors are preserved.

The main input controller is disabled when opening/arming the lab. The lab has its
own Stop button; Escape stops it while the lab has focus. Clicking inside the lab
does not start a take. Main gameplay stance/hotkey bindings are not used here.
Closing the lab, stopping capture, or disconnecting the mouse listener stops output.
A lost mouse heartbeat (350 ms), lost capture health signal (750 ms), or timing gap
also disarms. While armed and waiting, a stationary stream may have no new frames;
during a take, missing frames for 500 ms stops output. Interrupted takes cannot be
accepted; shot intervals extending beyond release are preserved unchanged.

The preview's **Screen sharing · live** indicator is independent of take status.
A completed take leaves capture running. If the desktop ends the stream, the lab
reports that explicitly and asks you to choose a source again.

## Linux fire-button permission

This prototype uses the kernel's evdev interface to observe the selected mouse
without grabbing it, so the game still receives its ordinary mouse input. The
helper opens the device read-only, reports only left-button state, and does not
forward keyboard events or pointer motion. Disconnecting or closing the lab stops
that helper. Lost input packets or delayed button events abort the take.

On desktops where mouse nodes are not readable by your user, **Allow selected
mouse…** explicitly invokes `pkexec` and `setfacl` for just that selected
`/dev/input/eventN`, granting your current user read access. The app continues to
run as your normal user. This requires Python 3, polkit's `pkexec`, and `setfacl`
from the ACL package. The grant normally lasts until the device is recreated
(unplug/reboot); it is not a persistent udev rule or membership in the input group.
Other processes running under your user can also read that device while granted.
The listener’s Disconnect button stops reads but does not remove the ACL grant.
To revoke an explicitly added grant early, close the listener and run
`sudo setfacl -x u:$(id -u) /dev/input/eventN`, using the same selected device.

A read-only list of available mouse devices and permissions is available with:

```sh
python3 scripts/mouse-buttons.py --list
```

## Optional simulator link

For exact firing synchronization in a simulator you can modify, select **Simulator
link · optional**, enable the localhost link, and use the client below. This also
unlocks **Simulator events** virtual output. Arm, then press fire in the simulator.
Release ends the take; missing fire-state updates for 300 ms disarm output. The
link lasts only while the lab is open and does not control countdown-mode takes.

## Browser simulator client

Import or copy [simulator-client.mjs](../scripts/simulator-client.mjs) into your
simulator project. It uses browser APIs only, with no package dependency.

```js
import { connectRecoilLab } from './simulator-client.mjs';

const lab = connectRecoilLab(urlPastedFromLab, {
  onMove(dx, dy) {
    // Same units/sign as your simulator's manual mouse movement.
    // Called ONLY in Simulator events mode. Never also apply real pointer output.
    simulator.applyMouseDelta(dx, dy);
  },
  onBurst({ rpm, shots, t, mode }) {
    // Start the simulated recoil sequence here for reproducible timing.
    // t is the lab's epoch timestamp in milliseconds, useful for diagnostics.
    simulator.startBurst({ rpm, shots });
  },
  onEnd() { simulator.stopBurst(); },
  onStatus(value) { console.log(value); },
});
canvas.addEventListener('mousedown', e => { if (e.button === 0) lab.setFiring(true); });
window.addEventListener('mouseup', e => { if (e.button === 0) lab.setFiring(false); });
// On simulator teardown: lab.close();
```

The helper sends fire state every 100 ms and releases on window blur. In real
pointer mode, let your simulator consume its ordinary mouse/pointer-lock events;
the helper deliberately does not apply `move` events a second time. The API is
also usable from a native simulator:

- `GET /events?token=...`: server-sent JSON events (`ready`, `armed`, `burst-start`,
  `move`, `burst-end`). `move` has signed `x`, `y`, epoch timestamp `t`, and `mode`.
- `POST /input?token=...` with `{"firing":true}` or `{"firing":false}`: send an
  update every 100 ms, including release. Only a new false→true transition after
  arming begins a burst. `armed` events contain the selected `rpm` and `shots`.
- Observe mode emits no nonzero movement. Simulator mode emits virtual movement
  only. Pointer mode delivers movement to the desktop and emits it for logging.

The server binds only to 127.0.0.1 on an ephemeral port. It requires a random
per-session token, checks the Host header, accepts browser origins only from
localhost/127.0.0.1 (or local files), and supports one SSE consumer. It exposes no
file access, shell commands, profile writes, or keyboard/button injection. Do not
publish the URL as part of shared profiles. No server is started until Enable link.

## Real Linux mouse output

**Connect desktop pointer** opens a pointer-only, nonpersistent Remote Desktop
portal session. Approve the desktop dialog, select **Linux desktop pointer**, and
arm. This path sends relative motion via `NotifyPointerMotion`; no mouse buttons
or keyboard events are generated. It requires Python 3, PyGObject (`gi`), and a
desktop implementing the RemoteDesktop portal. KDE's portal and Python bindings
were detected on the development machine. Permission can be disconnected from the
lab or revoked from the desktop; reconnect explicitly afterward.

This is desktop software movement, not raw BLE/HID sensor counts. Pointer
acceleration, scaling and the game's input handling can change its effect.
Calibrate with the selected output. Treat saved results as provisional when moving
to BLE and retest the same units/signs/zoom there. The relative-output interface is
compatible with the existing BLE controller, but live BLE-assisted CV recording
is not wired into this prototype.

To check portal availability without requesting control or moving the pointer:

```sh
python3 scripts/portal-pointer.py --check
```

## Guided pointer calibration

Calibration uses the existing countdown and live capture, without a fire-button
listener or simulator link. Connect the Linux desktop pointer first. It sends
12 one-unit movements on X, returns with 12 negative movements, then repeats on Y.
Movements are spaced by at least 35 ms, with still periods before and after each
leg. No clicks or key presses are sent. Stop, capture loss, pointer disconnection,
or returning focus to the lab cancels further movement. Cancellation does not
attempt a return movement; re-aim manually.

The measurement compares anchored before/after patches rather than summing tiny
frame-to-frame offsets. It converts tracking pixels back into source-capture
pixels, checks still periods and cross-axis drift, and requires the two direction
estimates to agree within 25%. Missing frames, weak texture, a tiny response, or
inconsistent directions leave both previous scale values unchanged and uncheck
the calibration acknowledgement. Accepted results fill both signed scale fields,
check that acknowledgement, and select Linux desktop pointer output; they do not
modify or save weapon vectors or start a firing take. Values live in the lab window.

Windowed capture is supported. Repeat calibration after changing capture source,
window size, zoom, sensitivity, or output device. Camera recovery, smoothing, and
pointer acceleration can still make a measured scale imperfect at other movement
speeds. Validate with a new take. The app cannot identify all in-game setting changes.

## What the CV prototype measures

The source is cropped before CPU processing and resized to 256 pixels wide.
The tracker selects local corners and compares larger, contrast-normalized patches
between adjacent frames. When a kick exceeds the fine search, a half-resolution
search estimates the movement and the full-resolution patches verify it. Matches touching
masks, ambiguous matches, large displacement, and frames lacking enough agreeing
patches are rejected. Median translation estimates scene movement. There is no
remote analysis, screen-content upload, model download, or recorded-video storage.
Live frames are read directly from the capture track, independent of whether the
preview is visible; clips still use their presentation timestamps.
Opening a clip decodes it locally with the same tracker; set its first-shot offset
and whether that clip already included candidate assistance.

Shot intervals use entered RPM and mouse-down, the simulator event, or clip offset. Per-shot
residuals are differences between cumulative positions, so a previous shot's drift
is not counted again. Updates apply 1–25% of the inferred correction with a
per-axis cap. Observe-only takes estimate the whole target pattern; assisted takes
add only the residual to the played candidate. Gaps, missing boundaries, or weak
tracking leave the corresponding shots unchanged.

This first version estimates translation at integer tracking-pixel resolution. It
has no automatic RPM detection, camera
rotation model, bullet-impact detection, or reliable separation of weapon sway,
camera recovery, player movement and recoil. It uses video presentation timestamps
for clips and an arrival-anchored capture clock for live tracks, so a measured
first-shot offset is needed when capture latency is significant.
Use consistent stationary scenes and short clips; tracking agreement is not proof
of aim accuracy. Live settings and masks must stay unchanged during a take.

## When shots are skipped

For an Observe-only take, keep the camera still and hold fire without pulling down.
At 600 RPM each interval is 100 ms; twenty measured intervals cover two seconds.
Keep distinctive edges or labels in the center crop and mask only the weapon,
reticle, and muzzle flash. A repeated grid can still be ambiguous even if it looks
textured, so use the diagnostics rather than changing RPM to force a match.

Each rejected shot now shows its reason: missing start/end coverage, frame gaps,
insufficient frames per shot, low texture, ambiguous motion, disagreement, or
release before the interval ended. The summary reports captured frames, observed
frame rate, tracked frames, and the largest gap. Rejected intervals are never
silently filled with guessed corrections.

Each analysis overwrites `vision-diagnostics.json` in the app's user-data folder
(on this Linux desktop, `~/.config/Recoil Control/vision-diagnostics.json`). This
local debugging report contains numeric motion samples, timing, configuration, and
rejection reasons; it contains no images or video and is not uploaded. It lets us
inspect a failed live take without asking you to repeat the whole setup blindly.

## Verification

`npm test` covers known synthetic scene translations, masks/brightness changes,
invalid tracking, signed incremental updates, partial coverage, setup isolation,
stale edits, output-mode separation, countdown-to-armed, fresh press/release,
holding beyond pattern completion, one-entry starter expansion, recording limits, stationary capture, listener loss, and simulator heartbeat behavior.
It also tests larger camera jumps, a 20-shot sequence at 600 RPM, explicit rejection
reasons, and the Python mouse helper with synthetic input packets.
`npm run test:vision-desktop` generates and decodes a real WebM clip in Electron,
then exercises tracking, proposals, undo/save, a standalone countdown with synthetic
live capture and a simulated physical mouse adapter, holding past a one-shot
pattern, extending a starter profile, release, persistent
capture between takes, direct capture with a hidden preview, local diagnostic
reports, cancellation, and the optional private simulator transport.
It never reads actual input devices, changes permissions, or injects real movement. Actual pointer
response and live capture latency need a user session with the actual game. Games that use raw or captured input may
handle portal pointer motion differently; compatibility has not been verified.

References: [Chrome direct video-track processing](https://developer.chrome.com/docs/capabilities/web-apis/mediastreamtrack-insertable-media-processing),
[Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer/)
, [Linux input event codes](https://cdn.kernel.org/doc/html/latest/input/event-codes.html),
and [XDG Remote Desktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).
