// config.js - manage configuration, including deployment and acquisition

var Fs = require("fs")
var Fsp = require("fs").promises

// fields that can be updated
const UPDATABLE = [ 'label', 'memo', 'lotek_freq', 'agc', 'burstfinder', 'rtlsdr', 'gnuradio_enabled']

// Acquisition settings for receivers and other sensors, including operating plans
class Acquisition {
    constructor(path) {
        this.path = path
        try {
            let text = Fs.readFileSync(path).toString()
            text = text.replace(/\/\/.*$/mg, "") // remove trailing '//' comments
            var d = JSON.parse(text)
            // handle upgrade when we switched from short_label to label in rc-6
            if (d.short_label && !d.label) {
                d.label = d.short_label
                delete d.short_label
            }
            // ensure AGC enable is defined
            d.agc = !!d.agc
            // ensure gnuradio_enabled is defined, default off
            if (d.gnuradio_enabled === undefined) d.gnuradio_enabled = false
            // insert default burstfinder output settings
            const bf_def = {
                filter_file: false,
                filter_ui: false,
                method: 'burstfinder',
                both_ui: false,
            }
            d.burstfinder = {...bf_def, ...d.burstfinder}

            // log some info
            for (let j in d) this[j] = d[j]
            // Restore per-port overrides from port-specific plan entries so that
            // GRH/VAH choices made in previous sessions survive restarts.
            this.devModeOverrides = {}
            for (const p of (this.plans || [])) {
                if (/^\d+$/.test(p.key.port)) {
                    this.devModeOverrides[p.key.port] = p.pulseFinder === 'gnuradio' ? 'GRH' : 'VAH'
                }
            }
            console.log(`lotek freq: ${this.lotek_freq}`)
            console.log(`enableAGC: ${this.agc}`)
            if (this.lotek_freq) this.fix_freq(this.lotek_freq)
            console.log(`Aquisition: found ${this.plans.length} plans`)
            this.emitAll()
        } catch (e) {
            console.log("Error loading acquisition.txt:", e)
            throw e
        }
    }    
    
    // lookup returns the LAST plan matching the given device type and port.
    // Last-match means port-specific entries appended at the end of plans override wildcards.
    lookup(port, devType) {
        let result = null
        for (const p of this.plans) {
            try {
                if (String(port).match(new RegExp(p.key.port)) &&
                    String(devType).match(new RegExp(p.key.devType)))
                {
                    result = { devLabel: `p${port}`, plan: p }
                }
            } catch { /* ignore malformed regex */ }
        }
        return result
    }

    // Create or update a port-specific plan entry for the given port and devType.
    // changes: { pulseFinder: 'gnuradio'|null, devParams: { paramName: value, ... } }
    // null pulseFinder deletes the field (reverts to VAH on base-GRH plans).
    setPortPlan(port, devType, changes) {
        const portStr = String(port)
        let plan = this.plans.find(p =>
            p.key.port === portStr &&
            (() => { try { return String(devType).match(new RegExp(p.key.devType)) } catch { return false } })()
        )
        if (!plan) {
            // Clone the last-matching base plan and pin it to this port
            const base = this.lookup(portStr, devType)?.plan
            if (!base) return
            plan = JSON.parse(JSON.stringify(base))
            plan.key = { port: portStr, devType: base.key.devType }
            this.plans.push(plan)
        }
        if ('pulseFinder' in changes) {
            if (changes.pulseFinder === null) delete plan.pulseFinder
            else plan.pulseFinder = changes.pulseFinder
        }
        if (changes.devParams) {
            for (const [name, value] of Object.entries(changes.devParams)) {
                const dp = (plan.devParams || []).find(p => p.name === name)
                if (dp) dp.schedule.value = value
            }
        }
        this._saveToFile()
    }

    // Remove port-specific plan entries for the given port (all devTypes).
    // Returns true if anything was removed.
    resetPortPlan(port) {
        const portStr = String(port)
        const before = this.plans.length
        this.plans = this.plans.filter(p => p.key.port !== portStr)
        if (this.plans.length !== before) { this._saveToFile(); return true }
        return false
    }

    // Remove all port-specific entries (those whose key.port is a bare port number).
    // Returns true if anything was removed.
    resetAllPortPlans() {
        const before = this.plans.length
        this.plans = this.plans.filter(p => !/^\d+$/.test(p.key.port))
        if (this.plans.length !== before) { this._saveToFile(); return true }
        return false
    }

    // update the radio frequencies to a given lotek freq
    fix_freq(f) {
        for (let plan of this.plans) {
            for (let dp of plan.devParams || []) {
                if (dp.name == "frequency") {
                    const freq = f-0.004 // Why is the offset frequency hard-coded like this??
                    console.log(`setting ${plan.key.devType} frequency to ${freq}`)
                    dp.schedule.value = freq
                }
            }
        }
        console.log(`setting module_options.find_tags.params[1] to ${f}`) // Omg this is flaky
        this.module_options.find_tags.params[1] = f
    }

    emitAll() {
        const data = {}
        for (let k of [...UPDATABLE, 'gps'])
            data[k] = this[k]
        TheMatron.emit("acquisition", data)
    }

    // update acquisition object
    update(new_values) {
        console.log("Acquisition: updating", new_values)
        let changed = false
        for (let k of UPDATABLE) {
            if (k in new_values) {
                if (this[k] != new_values[k]) {
                    changed = true
                    this[k] = new_values[k]
                    console.log("Acquisition: updating", k, "to", new_values[k])
                }
            }
        }
        if (changed) {
            this._saveToFile()
            if ('lotek_freq' in new_values) this.fix_freq(new_values.lotek_freq)
            this.emitAll()
        }
    }

    _saveToFile() {
        console.log("Saving ", this.path)
        const data = {}
        for (let k of [...UPDATABLE, 'gps', 'plans', 'module_options'])
            data[k] = this[k]
        try {
            Fs.writeFileSync(this.path + "~", JSON.stringify(data, null, 2))
            try {
                Fs.renameSync(this.path, this.path + ".bak")
            } catch (e) {
                if (e.code != "ENOENT") throw e
            }
            Fs.renameSync(this.path + "~", this.path)
        } catch (e) {
            console.log("ERROR: failed to save acquisition config: ", e)
        }
    }

    // Persist a devParam value change (e.g. gain slider) for a given device type.
    // Updates the in-memory plan and writes acquisition.json atomically.
    updateDevParam(devType, paramName, value) {
        let changed = false
        for (let plan of this.plans) {
            let regex
            try { regex = new RegExp(plan.key.devType) } catch { continue }
            if (!String(devType).match(regex)) continue

            for (let dp of plan.devParams || []) {
                if (dp.name === paramName) {
                    dp.schedule.value = value
                    changed = true
                }
            }

            // For VAH-default plans with a gnuradio sub-object: also sync tuner_gain
            // to gnuradio.gain.rf so the next GRH session starts with the updated value.
            if (plan.gnuradio && paramName === 'tuner_gain') {
                try {
                    const gain = JSON.parse(plan.gnuradio.gain)
                    gain.rf = value
                    plan.gnuradio.gain = JSON.stringify(gain)
                    changed = true
                } catch (e) { /* ignore malformed gain string */ }
            }
        }
        if (changed) {
            console.log(`Acquisition: persisting ${paramName}=${value} for ${devType}`)
            this._saveToFile()
        }
    }

}

module.exports = { Acquisition }
