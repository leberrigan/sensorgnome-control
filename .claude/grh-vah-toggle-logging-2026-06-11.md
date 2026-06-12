# GRH/VAH Toggle + Gain + Device Logging — 2026-06-11

## Goal
Make the per-device GRH/VAH toggle and gain dropdown in FlexDash actually work, add
structured device logging, and expose it via `devices_log` FlexDash key.

## Files changing
- `src/dashboard.js`
- `src/sensor.js`

## Key findings

### handle_dev_grh — was broken
`matron.emit('devGrhChg', ...)` fired but nothing listened. Fixed by:
1. Storing per-port mode in `Acquisition.devModeOverrides[port]`
2. Emitting `devRemoved` + `devAdded` (with updated `attr.radio`) to restart the device
   in the new mode via a 500ms delayed re-add.

### handle_dev_attn — was broken
`matron.emit('devAttnChg', ...)` fired but nothing listened. Fixed by emitting
`requestSetParam` with the device-type-specific parameter name:
- airspy/airspyhf → `sensitivity_gain`
- rtlsdr/nanobabel → `tuner_gain`
- funcubeproplus/funcubepro → `lna_gain`

### sensor.js getSensor — needed override check
Added `Acquisition.devModeOverrides?.[dev.attr.port]` check so per-device
VAH/GRH switch persists across device restarts (within the current sg-control session).

### gain_enabled — disable for funcubePro in GRH
funcubePro (not Plus) is a VAH-only audio device; GRH doesn't control its RF gain.
Dropdown disabled when `typeLow === 'funcubepro' && grh === true`.

### Logging
- `this.devices_log = []` array, max 200 entries
- `devicesLogPush(msg)` timestamps and pushes to `FlexDash.set('devices_log', ...)`
- FlexDash key: `devices_log` (user wires up widget in fd-config)
- Log events: connect, disconnect, mode switch (attempt + confirmation), gain change

## Follow-up fixes (2026-06-11 session 2)

### NanoBabel stuck at init
NanoBabel is managed through the DigiBabel probe subsystem. After identification,
`HubMan.devs[port].attr.type = 'NanoBabel'` but no acquisition plan has
`devType` matching 'NanoBabel' (plans use 'rtlsdr' regex). When our devRemoved/devAdded
cycle re-adds a 'NanoBabel' device, the plan lookup returns null → GR_SDR constructor
crashes → device stays at init.
Fix (session 2): bail out of handle_dev_grh early for NanoBabel, log that replug is required.
REVERTED (session 3): user wants NanoBabel mode switching enabled; early-return removed.
Status: will still be stuck at init until either the NanoBabel subsystem handles devAdded
for type='NanoBabel' directly, or getSensor adds a case for 'NanoBabel' that uses RTLSDR driver.

### FunCube wrestling between GRH and VAH
Two root causes:
1. Timing: 500ms wasn't enough for GRH's audio subprocess to release the ALSA device.
   Fix: increase delay to 2000ms for funcubePro/funcubeProPlus. RESOLVED.
2. Stale retry loop: after VAH failed to open the ALSA device it scheduled
   `setTimeout(init, 10000)`. If user switched back to GRH during those 10s,
   the old VAH sensor's retry fired mid-GRH-session and contested the device.
   Fix: `this.cancelled = false` in Sensor constructor, `this.cancelled = true` in
   devRemoved, guard both vahOpenReply and grOpenReply retry with `!self.cancelled`,
   guard `Sensor.prototype.init` entry with `if (this.cancelled) return`.

## Follow-up fixes (2026-06-12 session 5)

### RTL-SDR GRH→VAH switch reverted to GRH — FIXED
RTL-SDR plans default to gnuradio (pulseFinder='gnuradio'), so switching to VAH passes the plan
compatibility check (plan CAN use VAH via the rtlsdr VAMP plugins). But the 500ms delay was too short:
GnuRadio's subprocess (gr_rtlsdr.py) hadn't released the USB device before rtl_tcp tried to open it.
rtl_tcp exited code 3 → RTLSDR.hw_reset emitted a devRemoved NOT in _intentionalRemove → cleared
devModeOverrides → next devAdded fell back to GRH.
Fix: detect if current radio mode is GRH and !grh (switching away from GRH), use 3000ms delay instead of 500ms.
```js
const isFromGRH = !grh && (dev.attr?.radio === 'GRH')
const delay = isAudioDev ? 2000 : (isFromGRH ? 3000 : 500)
```

### sensor.js close/startStop pulseFinder check — FIXED (session 5)
Sensor.prototype.close and startStop used plan.pulseFinder === "gnuradio" to decide whether to
send GRH or VAH commands. With new plans (no pulseFinder), GR_SDR instances would send VAH
close/start-stop — leaving gr_rtlsdr.py/gr_funcubepp.py alive and holding the USB device.
rtl_tcp then fails to open: "Failed to open rtlsdr device 1:15" → hw_reset loop.
Fix: replaced plan.pulseFinder checks with `this/self instanceof GR_SDR.GR_SDR`
(already used in sensor.js initDone). GR_SDR is always in GnuRadio mode regardless of plan.

### VAH/GRH default modes fixed — session 5
acquisition.json: rtlsdr and funcubeProPlus now use lotek-plugins.so (VAH default, no pulseFinder).
airspy/airspyhf keep pulseFinder:"gnuradio" (GRH-only).
Changes:
- acquisition.json: added gnuradio:{samp_rate, gain, additional_args} sub-object to rtlsdr and
  funcubeProPlus plans so GR_SDR has the params it needs when the user toggles to GRH.
- gr-sdr.js extractPluginParams: reads from plan.gnuradio if present (VAH-default plans);
  falls back to plugins[0].params for legacy GnuRadio-only plans.
- dashboard.js handle_devAdded: initial grh FlexDash value now computed from plan.pulseFinder +
  override (same logic as getSensor), not from attr.radio (hubman stamps 'GRH' regardless).
- dashboard.js buildDeviceWidgets: removed NanoBabel from showGain (no gain control).

### VAH stale callback cascade — FIXED (session 5)
Root cause: `childDied` did NOT clear `replyHandlerQueue` or `commandQueue`. On VAH restart,
`cmdSockConnected` replayed stale commands to the fresh VAH. Stale `vahOpenReply` handlers fired
(no cancelled guard), pushed more stale `vahAttachReply` onto the queue, consuming the new sensor's
reply slot → "VAH asking to receive p12" / "HUH?" cascade.

Fixes:
1. vah.js `childDied`: clear `replyHandlerQueue = []` and `commandQueue = []` on crash
2. sensor.js `vahOpenReply`: add `if (self.cancelled) return` before `self.isOpen = true`
3. vah.js `vahSubmit` commandQueue path: `cmd + '\n'` → `cmd[i] + '\n'` (pre-existing bug)

### NanoBabel toggle — disabled, shows "NB"
NanoBabel has no VAMP pulse-detect plan and no standalone GRH support.
Toggle widget now shows static "NB" in both on/off states, disabled (non-clickable).
Previously showed interactive GRH/VAH toggle which would crash if clicked.

### FlexDash popup help text
Written markdown description of all device controls (mode toggle, gain, status, log).

## Follow-up fixes (2026-06-11 session 3)

### FunCube VAH crash loop — RESOLVED (session 3+4)

**Session 4 fix (final):** Added plan compatibility check at the TOP of handle_dev_grh.
Before doing any devRemoved/devAdded cycle, look up Acquisition.plans for this devType.
If `plan.pulseFinder === 'gnuradio'`, the plan has only GnuRadio plugins; VAH cannot load
them. Revert the FlexDash toggle to 'GRH' and return immediately. No crash at all.
The `_intentionalRemove` safety net stays in case other paths trigger unexpected removals.

### FunCube VAH crash loop — intermediate analysis (session 3)
With the 2000ms delay, VAH opens the ALSA device successfully (ALSA conflict resolved).
But funcubeProPlus plan only has `detect_pulses.py:grPulseDetect` plugin (gnuradio-specific).
VAH tries to load it as a VAMP plugin → "No library found" → exit code 11 → VAHdied →
HubMan removes audio devices → VAHstarted → re-enumerate → devModeOverrides[12]='VAH' still
set → USBAudio created → same crash → infinite loop.
Fix: `_intentionalRemove` Set in dashboard.js. Added to handle_dev_grh before emitting
devRemoved. handle_devRemoved: if port is NOT in _intentionalRemove (unexpected removal),
clear devModeOverrides[port]. The first (intentional) devRemoved preserves the override so
the re-add can use it. The second (crash-caused) devRemoved clears it, so re-enumeration
uses the plan's default mode (GRH for funcubeProPlus). Loop breaks after one crash.

### NanoBabel mode switching re-enabled (session 3)
Removed early-return block from handle_dev_grh. User confirmed it should be enabled.
Whether it works end-to-end depends on whether the NanoBabel/DigiBabel module handles
devAdded with type='NanoBabel'. No sensor.js changes made; getSensor still returns null
for NanoBabel type (falls through default: rv=null).

### Gain dropdown initial value (session 3)
handle_devAdded was setting `devices/${port}/attn = null`. FlexDash dynamic binding
overrides static.value even when null, so the dropdown showed no selection.
Fix: compute initialAttn from plan defaults using same logic as buildDeviceWidgets:
- airspyhf: getAcqParam('airspyhf', 'sensitivity_gain') ?? 0
- airspy: getAcqParam('airspy', 'sensitivity_gain') ?? 12  
- rtlsdr/nanobabel: Math.round((getAcqParam('rtlsdr','tuner_gain') ?? 29.7) * 10) as string
- funcubepro/funcubeproplus: "1" (LNA on; plan stores lna_gain=20 dB, not the binary 0/1 UI value)

## Follow-up fix (2026-06-12 session 6)

### RTL-SDR fails to open at sg-control startup — FIXED
Root cause: `reapOldGRHandSpawn` kills `grh` (the Python host wrapper) but its subprocesses
(`gr_rtlsdr.py`, `gr_funcubepp.py`, etc.) become orphaned — SIGKILL on the parent does NOT kill
children on Linux. The orphan keeps the USB device locked, so when the new sg-control's rtl_tcp
tries to open it: "Failed to open rtlsdr device 1:15".

Fix in grh.js `reapOldGRHandSpawn`: after `killall -KILL grh`, chain a second kill:
```js
ChildProcess.execFile("/usr/bin/pkill", ["-KILL", "-f", "/usr/bin/gr_"], null, this.this_doneReaping);
```
`pkill -KILL -f "/usr/bin/gr_"` kills any process whose cmdline contains "/usr/bin/gr_"
(matches `python3 /usr/bin/gr_rtlsdr.py` etc.). pkill returns non-zero if no match, which is
fine — `this_doneReaping` ignores the error and proceeds to `spawnChild()`.

## Gain persistence (session 7 — 2026-06-12)

### devParam changes now persist to acquisition.json — DONE
When the user changes the gain dropdown in FlexDash, `handle_dev_attn` in dashboard.js now
calls `Acquisition.updateDevParam(dev.attr.type, par, parseFloat(v))` after emitting
`requestSetParam`.

`updateDevParam` (added to config.js):
- Finds the matching plan by `key.devType` regex
- Updates `devParams[paramName].schedule.value = value` (number, not string)
- For RTL-SDR plans with a `gnuradio` sub-object: also parses `gnuradio.gain` JSON and
  updates the `rf` field, so the next GRH session starts with the same gain value
- Calls `_saveToFile()` atomically (temp write → backup old → rename temp)

`_saveToFile()` (added to config.js):
- Extracted from the former inline block in `update()` so both `update()` and
  `updateDevParam()` share the same write path

## Still pending / known bugs (from memory)
All 8 bugs from gnuradio-integration.md are still unaddressed:
1. gr_airspyhf.py set_freq args swapped
2. grh.js grhStartStop — was `devLabel`, now fixed (used `port`)
3. grh.js grhSubmit — bug: pushes `cmd` not `cmd[i]` — STILL present
4. sensor.js close() — VAH close emitted for GRH devices — FIXED (instanceof check)
5. additional_args passing (str(list) corruption)
6. gr_airspy.py no stdin reader
7. checkRateTimer never set up — FIXED in grh.js (set in sockConnected)
8. grhAccept never fires — dataSock always null — STILL present (dataSock commented out)
