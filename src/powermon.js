// powermon - monitor Raspberry Pi undervoltage events (vcgencmd get_throttled) and
// mitigate when the cell modem is implicated, by auto-disabling it with backoff/retry.
// Also emits 'undervoltageEdge' which wifiman.js uses to self-heal the wifi hotspot.
//
// Copyright ©2026 Sensorgnome project

const Fs = require('fs')
const Fsp = require('fs').promises
const Path = require('path')
const TimeSeries = require('./timeseries.js')

const VCGENCMD = '/usr/bin/vcgencmd'
const POLL_MS = 5 * 1000          // fine enough to catch the shortest observed events (~4s)
const EVAL_MS = 5 * 60 * 1000     // mitigation decision cadence
const SAVE_MS = 60 * 1000

const ts_dir = '/data/ts'
const CONFIG_PATH = '/etc/sensorgnome/power.json'
const STATE_PATH = Path.join(ts_dir, 'power-mitigation-state.json')

const DEFAULTS = {
  auto_mitigate: true,
  undervoltage_threshold_pct: 1.0,
  correlation_ratio: 2.0,
  retry_cooldown_min: 120,
  retry_cooldown_max_min: 720,
  trial_duration_min: 15,
}

// minimum number of 'day'-bucket samples before trusting its average (~1h of polling)
const MIN_DAY_SAMPLES = Math.ceil(3600 * 1000 / POLL_MS)

class PowerConfig {
  constructor(path) {
    this.path = path
    this.data = { ...DEFAULTS }
    try {
      const d = JSON.parse(Fs.readFileSync(path).toString())
      for (const k in d) if (k in this.data) this.data[k] = d[k]
    } catch (e) {
      if (e.code != 'ENOENT') console.log('PowerConfig: error loading', path, e.message)
    }
  }

  update(values) {
    let changed = false
    for (const k in values) {
      if (k in this.data && this.data[k] !== values[k]) {
        this.data[k] = values[k]
        changed = true
      }
    }
    if (changed) this.save()
  }

  async save() {
    try {
      await Fsp.writeFile(this.path + '~', JSON.stringify(this.data, null, 2))
      await Fsp.rename(this.path + '~', this.path)
    } catch (e) {
      console.log('PowerConfig: error saving', this.path, e.message)
    }
  }
}

// default/cleared mitigation state
function freshMitState(cfg) {
  return { disabled: false, trial: false, backoffMin: cfg.retry_cooldown_min,
           nextRetryAt: 0, trialEndsAt: 0, evidence: null }
}

class PowerMon {
  constructor(matron) {
    this.matron = matron
    this.config = new PowerConfig(CONFIG_PATH)
    this.underNow = false
    this.sinceBoot = false
    this.range = TimeSeries.ranges[0]
    this.pollTimer = null
    this.evalTimer = null
    this.saveTimer = null

    this.mitState = freshMitState(this.config.data)
    this._loadState()

    Fs.mkdirSync(ts_dir, { recursive: true })
    this.ts = {
      events:      new TimeSeries(ts_dir, 'power-events'),
      duty:        new TimeSeries(ts_dir, 'power-duty'),
      dutyCellOn:  new TimeSeries(ts_dir, 'power-duty-cellon'),
      dutyCellOff: new TimeSeries(ts_dir, 'power-duty-celloff'),
    }

    this.matron.on('dash_power_auto_mitigate', (state) => this.setAutoMitigate(state == 'ON'))
    this.matron.on('dash_enable_cell', (state) => this._onManualCellToggle(state == 'ON'))
  }

  start() {
    // if we restarted mid-backoff, re-apply the disable (CellMan.start() has already run)
    if (this.mitState.disabled && !this.mitState.trial) {
      console.log('PowerMon: restoring cellular auto-disable from saved state')
      if (typeof CellMan != 'undefined' && CellMan) CellMan.enableCellular(false)
    }
    this._emitStatus()
    this._emitMitigation()
    this.buildGraphs(this.range)

    this.poll()
    this.pollTimer = setInterval(() => this.poll(), POLL_MS)
    this.evalTimer = setInterval(() => this.evaluateMitigation(), EVAL_MS)
    this.saveTimer = setInterval(() => this.saveSeries(), SAVE_MS)
  }

  saveSeries() {
    for (const k in this.ts) this.ts[k].save()
  }

  // ===== polling & event detection

  poll() {
    ChildProcess.execFile(VCGENCMD, ['get_throttled'], (err, stdout) => {
      if (err) { console.warn('PowerMon: vcgencmd failed:', err.message); return }
      const m = (stdout || '').toString().match(/0x([0-9a-fA-F]+)/)
      if (!m) return
      this._handleBits(parseInt(m[1], 16))
    })
  }

  _handleBits(bits) {
    const now = Date.now()
    const under = (bits & 0x1) != 0
    const sinceBoot = (bits & 0x10000) != 0

    if (under && !this.underNow) {
      this.ts.events.add(now, 1)
      this.matron.emit('undervoltageEdge', { state: 'start', at: now })
    } else if (!under && this.underNow) {
      this.matron.emit('undervoltageEdge', { state: 'end', at: now })
    }
    this.underNow = under
    this.sinceBoot = this.sinceBoot || sinceBoot

    const cellOn = typeof CellMan != 'undefined' && CellMan && CellMan.cell_state === 'connected'
    const v = under ? 1 : 0
    this.ts.duty.avg(now, v)
    if (cellOn) this.ts.dutyCellOn.avg(now, v)
    else this.ts.dutyCellOff.avg(now, v)

    this._emitStatus()
    this.buildGraphs(this.range)
  }

  _emitStatus() {
    this.matron.emit('powerStatus', { underNow: this.underNow, sinceBoot: this.sinceBoot })
  }

  // ===== FlexDash graph data (range-selectable, driven by the shared detection-range picker)

  setRange(range) {
    if (!TimeSeries.ranges.includes(range)) return
    this.range = range
    this.buildGraphs(range)
  }

  buildGraphs(range) {
    const now = Date.now()
    const [times, events] = this.ts.events.get(range, now)
    const [, duty] = this.ts.duty.get(range, now)
    const data = times.map((t, i) => [
      Math.floor(t / 1000),
      events[i],
      duty[i] == null ? null : Math.round(duty[i] * 1000) / 10, // fraction -> %
    ])
    this.matron.emit('powerGraphs', { data, labels: ['events', 'undervoltage %'], title: `power (${range})` })
  }

  // ===== mitigation: auto-disable cellular when it's implicated, with backoff/retry

  _lastPct(ts, range, now) {
    const [, values] = ts.get(range, now)
    const v = values[values.length - 1]
    return v == null ? null : v * 100
  }

  setAutoMitigate(enable) {
    this.config.update({ auto_mitigate: enable })
    this._emitMitigation()
  }

  evaluateMitigation() {
    const now = Date.now()
    if (this._maybeRetry(now)) return // retry/trial logic handled this tick

    if (!this.config.data.auto_mitigate) return
    if (this.mitState.disabled) return // waiting out backoff or in a trial
    if (typeof CellMan == 'undefined' || !CellMan) return
    if (['no-modem', 'disabled'].includes(CellMan.cell_state)) return // nothing to disable

    if ((this.ts.dutyCellOn.cnt && this.ts.dutyCellOn.cnt['day'] || 0) < MIN_DAY_SAMPLES) return

    const onPct = this._lastPct(this.ts.dutyCellOn, 'day', now) ?? 0
    const offPct = this._lastPct(this.ts.dutyCellOff, 'day', now) ?? 0
    const { undervoltage_threshold_pct: threshold, correlation_ratio: ratio } = this.config.data

    if (onPct > threshold && onPct > offPct * ratio) {
      this._disableCellular(now, { onPct, offPct })
    }
  }

  // returns true if it handled a retry/trial transition this tick (caller should skip
  // the normal trigger check, since we're already mid-mitigation)
  _maybeRetry(now) {
    if (!this.mitState.disabled) return false

    if (this.mitState.trial) {
      const recentPct = this._lastPct(this.ts.duty, '5mins', now) ?? 0
      if (recentPct > this.config.data.undervoltage_threshold_pct) {
        if (typeof CellMan != 'undefined' && CellMan) CellMan.enableCellular(false)
        this.mitState.trial = false
        this.mitState.backoffMin = Math.min(this.mitState.backoffMin * 2, this.config.data.retry_cooldown_max_min)
        this.mitState.nextRetryAt = now + this.mitState.backoffMin * 60 * 1000
        this.mitState.evidence = { recentPct }
        this._saveState()
        this._emitMitigation()
        console.log(`PowerMon: retry trial failed (${recentPct.toFixed(2)}% undervoltage), backing off ${this.mitState.backoffMin}min`)
        return true
      }
      if (now >= this.mitState.trialEndsAt) {
        console.log('PowerMon: retry trial succeeded, leaving cellular enabled')
        this._clearMitigation()
        return true
      }
      return true
    }

    if (now >= this.mitState.nextRetryAt) {
      console.log('PowerMon: backoff elapsed, re-enabling cellular for a trial')
      if (typeof CellMan != 'undefined' && CellMan) CellMan.enableCellular(true)
      this.mitState.trial = true
      this.mitState.trialEndsAt = now + this.config.data.trial_duration_min * 60 * 1000
      this._saveState()
      this._emitMitigation()
      return true
    }
    return true // still waiting out the backoff
  }

  _disableCellular(now, evidence) {
    if (typeof CellMan != 'undefined' && CellMan) CellMan.enableCellular(false)
    this.mitState.disabled = true
    this.mitState.trial = false
    this.mitState.backoffMin = this.config.data.retry_cooldown_min
    this.mitState.nextRetryAt = now + this.mitState.backoffMin * 60 * 1000
    this.mitState.evidence = evidence
    this._saveState()
    this._emitMitigation()
    console.log(`PowerMon: auto-disabling cellular (undervoltage ${evidence.onPct.toFixed(2)}% while connected vs ${evidence.offPct.toFixed(2)}% while not); retry at ${new Date(this.mitState.nextRetryAt).toISOString()}`)
  }

  _clearMitigation() {
    this.mitState = freshMitState(this.config.data)
    this._saveState()
    this._emitMitigation()
  }

  // manual UI toggle always wins over our backoff
  _onManualCellToggle(enable) {
    if (!enable) return
    if (this.mitState.disabled) {
      console.log('PowerMon: manual cellular enable overrides auto-mitigation backoff')
      this._clearMitigation()
    }
  }

  _emitMitigation() {
    const s = this.mitState
    let color = 'green', title = 'OK', text = ''
    if (s.disabled && !s.trial) {
      color = 'red'
      title = 'Cellular auto-disabled (undervoltage)'
      text = `Undervoltage ${s.evidence?.onPct?.toFixed(2)}% of time while cell connected vs `
           + `${s.evidence?.offPct?.toFixed(2)}% while not.\nRetrying at ${new Date(s.nextRetryAt).toLocaleString()}.`
    } else if (s.trial) {
      color = 'amber'
      title = 'Cellular re-enabled (trial)'
      text = `Checking whether undervoltage recurs; trial ends ${new Date(s.trialEndsAt).toLocaleString()}.`
    }
    this.matron.emit('powerMitigation', { color, title, text, autoMitigate: this.config.data.auto_mitigate })
  }

  // ===== persisted mitigation state (survives sg-control restarts)

  _loadState() {
    try {
      const d = JSON.parse(Fs.readFileSync(STATE_PATH).toString())
      this.mitState = { ...this.mitState, ...d }
    } catch (e) {
      if (e.code != 'ENOENT') console.log('PowerMon: error loading state', e.message)
    }
  }

  async _saveState() {
    try {
      Fs.mkdirSync(ts_dir, { recursive: true })
      await Fsp.writeFile(STATE_PATH + '~', JSON.stringify(this.mitState, null, 2))
      await Fsp.rename(STATE_PATH + '~', STATE_PATH)
    } catch (e) {
      console.log('PowerMon: error saving state', e.message)
    }
  }
}

module.exports = PowerMon
