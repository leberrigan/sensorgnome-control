# Session: sysmonitor dashboard integration — 2026-06-17

## Goal
Add system resource monitoring (CPU %, CPU temp, memory %, disk %) to FlexDash.
User will wire up fd-config.json widgets; we provide the FlexDash data paths.

## Files changed
- `src/sysmonitor.js` — NEW: polls /proc/stat, /proc/meminfo, /sys/class/thermal every 30s
- `src/dashboard.js` — added sysmonitorData event handler, ts_sysmon TimeSeries, sysmonShow()
- `src/main.js` — registered SysMonitor singleton

## Design decisions
- 30s poll interval — /proc reads are zero-cost kernel reads, 30s is conservative
- CPU %: delta between successive /proc/stat reads (no subprocess needed)
- Temp: /sys/class/thermal/thermal_zone0/temp (millidegrees → °C)
- Disk: piggybacks on existing sdcardUse event from machine.js (10 min cadence)
- Shares ts_ix range with detection graphs (same range selector drives all plots)
- All TimeSeries stored in /data/ts/ (same as detection TS)

## FlexDash paths for fd-config.json
### Scalar gauges (current value)
- `system/cpu`           — CPU usage % (0-100)
- `system/temp`          — CPU temperature °C
- `system/mem_pct`       — Memory used % (0-100)
- `system/mem_avail_mb`  — Memory available MB
- `system/disk`          — /data partition used % (updates every 10 min)

### Time-series plots (uPlot chart widget)
- `system/graphs/cpu`    — {data, labels, title}
- `system/graphs/temp`   — {data, labels, title}
- `system/graphs/mem`    — {data, labels, title}
- `system/graphs/disk`   — {data, labels, title}

Data format for plots: `{ data: [[unix_ts, value], ...], labels: ['cpu'], title: 'cpu (5mins)' }`

### Existing paths still present (from machine.js)
- `sdcard_use`           — /data partition % (unchanged)
- `df`                   — full filesystem table array (unchanged)
- `machineinfo`          — machine ID, version, memorySize, bootCount (unchanged)

## Status: COMPLETE
