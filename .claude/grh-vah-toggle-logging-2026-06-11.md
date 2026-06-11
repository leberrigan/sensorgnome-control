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
