# Profile authoring and tuning

Return to the [project README](../README.md) for setup and default shortcuts.

## Attachment setups

Each weapon starts with **Base**, its original pattern without attachments. In
**Loadout → Attachment setup → Add setup**, name a combination, copy Base or another
setup (or start blank), and add attachment rows. Slot and attachment names are free
text with suggestions from this game's saved setups; use Optic, Muzzle, or any
custom slot your game needs. Each setup allows one attachment per slot, up to 12
slots; each weapon supports up to 24 additional setups. No JSON editing is needed.

Select a setup above the Pattern/Tune tabs. **Edit pattern**, strength, live stance
tuning, recording, and calibration all apply to that setup alone. Copies preserve
the source pattern, strength, and sensitivity reference, but require testing again.
They are independent snapshots: later Base edits do not change copies. Attachment
names do not apply automatic game-specific multipliers. Adjust strength under
**Tune**, or edit individual shots, RPM, and stances in the workshop.

**Edit** renames a setup or changes its attachment list. Changing those labels
leaves its pattern intact. Delete asks for confirmation and returns to Base.
**Duplicate** copies the entire weapon and all its setups; **Add weapon → Copy**
uses the source weapon's selected setup as the new Base pattern.

The selected setup is remembered per weapon across switches and restarts. The HUD
shows its name and, while unlocked, offers a setup selector. HUD switches use the
same pause-and-release-fire behavior as weapon switches; releasing a hold-to-enable
binding still stops compensation. Switching in configuration leaves output off.
Save or discard live tuning before changing setups. Empty selected setups produce
no compensation and are skipped by previous/next weapon shortcuts.

Exports bundle Base and every attachment setup, including their custom stance
definitions. Import creates a new editable weapon without installing anyone else's
shortcuts or local calibration records. This provides portable files for sharing;
the Community tab also supports local game-pack publishing, previews, and file sharing. See [Community library](community-library.md) for the local service and hosting plan. Online publishing is not enabled yet.

## Stances per game

Choose Crouch and optionally Prone when creating a game collection. Under
**Controls → Stances**, add, rename, or remove named postures and assign a key with
**Hold** or **Toggle** behavior. Click a binding to record a key, middle mouse, or
side button; Escape cancels, and Save applies it. Standing/default and right-mouse ADS are built in.
Rust starts with Crouch only; Prone is opt-in. You can also define a custom posture,
such as Mounted, without editing JSON. Each game supports up to 16 postures.

Save the game's stances, then open **Edit pattern → + Stances**. Pick a stance and
a pattern to copy. The copy is independent: change its strength, edit shots, or use
the existing after-burst fixes. ADS variants are separate optional patterns; there
is no need to author every combination. **Add all missing stances** copies the
default pattern for the remaining combinations. Rename or remove the current
pattern in the same panel; Undo restores removals. The default fallback cannot be
removed. Remove a posture's patterns from all its weapons and attachment setups before removing that posture
from the game.

Only one posture is selected at a time. The most recently pressed posture key wins;
releasing a hold restores a still-held posture or standing. A toggle ends when
pressed again, another posture is chosen, or Escape is pressed. Toggled posture is
preserved across weapon switches, but cleared on game or stance-binding changes.
It is not saved across launches. Typing in configuration does not toggle posture.
Match the game's own key and behavior; the app does not detect posture automatically.

Pattern selection prefers posture + ADS, then the posture's hip-fire pattern,
then standing ADS, then default. Unassigned posture keys still allow editing and
previewing. Previewing a stance never changes live input or moves the mouse.

![Pattern workshop with draggable shot positions and after-burst adjustments](images/pattern-workshop.png)

## Live stance tuning

Set your DPI, game sensitivity, and ADS multiplier under **Settings → Mouse &
sensitivity** first. In **Loadout → Tune**, **Output strength** scales all stances;
**Apply strength** saves those global values. **Save calibration** records the
setup you tested while preserving the current output. Calibrated profiles scale
inversely with changes to game sensitivity and ADS multiplier; verify that
adjustment in-game. DPI does not directly multiply raw output counts.

Open **Loadout → Tune → Live stance tuning**, or press **F8** away from the
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
starts a new draft at 100% of those saved values. The Tune panel and weapon
preview show saved first-shot counts, before global strength and sensitivity scaling.
For counts patterns, saving folds the gain into the shot vectors and normally resets
their extra multipliers to 1 × 1. A new session can increase the saved result again;
the stored multiplier's old 2× ceiling no longer strands tuning at 100% after saving.
Each session allows up to 300% of the saved strength, subject to the pattern's actual
per-shot storage bounds. The Tune panel shows each axis's session maximum, and the HUD
marks a reached limit. Saving does not bypass the actual per-shot bound.
Save/discard before switching weapons, editing patterns, or
reconnecting. Closing the app discards the draft. The physical ESP32 mouse relay
does not depend on tuning or the app staying connected.

## Pattern workshop

**Loadout → Edit pattern** opens the full-window pattern workbench. Stance chips
switch the stance being edited. The canvas shows the draft's cumulative shot
endpoints with the last saved version dashed behind it. The shot timeline below
selects one shot (click) or a range (Shift+click); **Select all** resets it.

### Record a pull

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

### Edit shots and convert guides

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

### Add weapons and save patterns

**Add weapon → Create & edit pattern** opens the workshop with a blank pattern or a
copy of a configured weapon. Blank patterns start with zero movement and a generic
600 RPM that you should replace. Copies keep tuning and calibration but clear the
direct shortcut. The weapon list also supports **Duplicate** to copy a complete weapon and all its setups.
LR-300 and Custom SMG remain available as empty slots for authoring your own patterns.

New and edited patterns use raw **counts per shot**. RPM changes timing without
changing each shot's distance. Opening a legacy pattern converts its vectors and
stance multipliers to counts while preserving its integrated movement, within
integer rounding. The converted editor multipliers start at 1 × 1 because saved
stance strength is already included in the shot counts. Cancelling the editor
leaves the saved pattern untouched. Each shot keeps the existing velocity easing.
The workshop preview includes stance
strength, before global weapon strength and sensitivity scaling. Counts-format
exports now use `recoil-control/weapon-v4`; imports still accept v1, v2, and v3.

## Portable profile format

Weapon v4 exports include the used stance definitions as `{ id, name }` records
beside the weapon. Pattern activation contains at most one of those stable posture
IDs plus optional `aiming`. Display names can change without changing activation;
the UI creates IDs for custom stances. Pattern counts, timing, tuning, and activation
are validated on import, including unique posture IDs and activation combinations.

Imports add an editable local weapon copy and any missing stance definitions. They
preserve existing patterns and local controls, clear the imported weapon shortcut
and calibration, and leave new posture keys unassigned. Assign those keys under
Controls. Existing stance IDs retain the local name; different IDs with the same
display name receive a numbered label. Unsupported future versions are rejected
instead of being partially imported. Older app versions cannot read v4 exports.

Local settings migrate from v1/v2 to v3 on save and keep the existing backup behavior.
Legacy files get the original Crouch definition when missing; existing weapon
patterns become Base without changing their output. The weapon's root pattern,
tuning, provenance, and calibration describe Base. `setups` contains independent
records with `id`, `name`, `attachments: [{ slot, name }]`, and those same pattern
fields. `selectedSetupId` chooses `base` or a setup ID. Unknown settings versions,
duplicate setup IDs/names, duplicate attachment slots, and invalid references are
rejected. Local settings and imported files are capped at 20 million characters;
saving checks the same limit as loading before replacing the previous file.

These tools help measure and tune local profiles; they do not supply verified
current Rust recoil patterns. The bundled AK values are a legacy starting point.

## Delete games and weapons

Use **Delete game** in the Loadout heading to remove the selected game collection,
including its weapons, attachment setups, controls, and input settings. Use
**Delete weapon** in the Pattern tab to remove the selected weapon and all its
attachment variants. Both show a confirmation naming the target and affected
content. Cancel is initially focused; changes made to that target while the dialog
is open require a fresh confirmation.

Deleting the active item selects its next neighbor, or the previous neighbor at
the end of the list. Other collections remain unchanged. The last weapon can be
deleted while retaining the game's settings, and the last game can be deleted
without creating a replacement. Empty loadouts offer Add weapon / Import weapon;
an empty app offers Add game / Browse community. The HUD and compensation remain
inactive with no weapon selected. Empty collections persist across restarts.

Deletion permanently removes the local item and disables compensation. Save or
discard a live tuning draft before deleting. Published community-library packs
and previously exported files are separate copies and are preserved. To remove
a published pack as well, use **Remove local listing** in Community.
