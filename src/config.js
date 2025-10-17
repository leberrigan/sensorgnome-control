// config.js - manage configuration, including deployment and acquisition

var Fs = require("fs")
var Fsp = require("fs").promises

// fields that can be updated
const UPDATABLE = [ 'label', 'memo', 'lotek_freq', 'burstfinder', 'agc', 'rtlsdr']

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
            // insert default burstfinder output settings
            const bf_def = {
                filter_file: false,
                filter_ui: false,
                method: 'burstfinder',
                both_ui: false,
            }
            d.burstfinder = {...bf_def, ...d.burstfinder}

            //
            for (let j in d) this[j] = d[j]
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
    // lookup returns the first plan matching the given device type and port
    lookup(port, devType) {
        const plans = this.plans
        for (let i in plans) {
            console.log("Checking plan", i, plans[i].key.port, plans[i].key.devType)
            if (port.match(new RegExp(plans[i].key.port)) &&
                devType.match(new RegExp(plans[i].key.devType)))
            {
                // kludge: if no USB hub, set port label to 'p0' meaning 'plugged directly into beaglebone'
                return {
                    devLabel: `p${port}`,
                    plan: plans[i],
                }
            }
        }
        return null
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
        // save to file
        if (changed) {
            console.log("Saving ", this.path)
            const data = {}
            for (let k of ['label','memo','lotek_freq','agc','gps','plans','module_options'])
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
            // update (restart) radios
            if ('lotek_freq' in new_values) this.fix_freq(new_values.lotek_freq)
            this.emitAll()
        }
    }

}

module.exports = { Acquisition }
