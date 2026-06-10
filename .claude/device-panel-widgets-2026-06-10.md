# Device Panel Widgets — 2026-06-10

## Goal
Replace the static SimpleTable device list with a DynamicPanel that shows interactive
per-device controls when radios are plugged in.

## Per-device widgets (in order, vertical stack)
- Label: `Port N` (200% size, bold) — visual separator between devices
- Label: port_path (bound to `devices/${port}/port_path`)
- Label: type (bound to `devices/${port}/type`)
- Stat: state (bound to `devices/${port}/state`)
- TextField: frequency MHz (bound to `devices/${port}/frequency`, output → `dev_freq/${port}`)
- Toggle: GRH on/off (bound to `devices/${port}/grh`, output → `dev_grh/${port}`)
- Toggle: Attenuation — disabled placeholder for now

## Data paths published per device
| Path | Content |
|------|---------|
| `devices/${port}` | {port, port_path, type} — pre-existing |
| `devices/${port}/state` | state string: init/running/error-xxx |
| `devices/${port}/frequency` | MHz as number, null for non-Lotek devices |
| `devices/${port}/grh` | boolean — true if device is using GRH backend |
| `device_panel_widgets` | flat array of widget configs for all devices |

## Output events (dashboard input from user)
| Event | Handler | Action |
|-------|---------|--------|
| `dash_dev_freq/${port}` | `handle_dev_freq(port, v)` | validate, set FlexDash, emit devFreqChg |
| `dash_dev_grh/${port}` | `handle_dev_grh(port, v)` | set FlexDash, emit devGrhChg |

Handlers registered dynamically in handle_devAdded, removed in handle_devRemoved.

## Files changed
1. `flexdash/src/widgets/dynamic-panel.vue` — DynamicChild gains `$conn` injection + `onSend` output
2. `sensorgnome-control/src/dashboard.js` — buildDeviceWidgets, rebuildDevicePanelWidgets, handler updates
3. `sensorgnome-control/src/fd-config.json` — new widget `w00042` (DynamicPanel), added to grid g03145

## Pending / not yet done
- devFreqChg event is emitted but no listener yet — freq change doesn't actually retune radio
- devGrhChg event is emitted but no listener yet — GRH toggle doesn't actually restart radio
- Attenuation remains a disabled placeholder until per-dongle attenuation is defined
