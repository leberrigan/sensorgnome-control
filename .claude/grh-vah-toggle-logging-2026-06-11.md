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

## Follow-up fixes (2026-06-11 session 3)

### FunCube VAH crash loop (root cause identified)
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

## Still pending / known bugs (from memory)
All 8 bugs from gnuradio-integration.md are still unaddressed:
1. gr_airspyhf.py set_freq args swapped
2. grh.js grhStartStop — was `devLabel`, now fixed (used `port`)
3. grh.js grhSubmit — bug: pushes `cmd` not `cmd[i]` — STILL present
4. sensor.js close() — VAH close emitted for GRH devices (but gr-sdr.js overrides devRemoved now, so close() is reached via base Sensor.devRemoved which calls this.close() after hw_delete)
5. additional_args passing (str(list) corruption)
6. gr_airspy.py no stdin reader
7. checkRateTimer never set up — FIXED in grh.js (set in sockConnected)
8. grhAccept never fires — dataSock always null — STILL present (dataSock commented out)
