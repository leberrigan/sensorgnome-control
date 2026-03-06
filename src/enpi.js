// Enpi class: interface with environmental sensor
var Fs = require("fs")

class Enpi {
    constructor(matron, prog) {
        this.matron = matron
        this.prog = prog
        this.child = null
        this.quitting = false
        
        this.lat = null
        this.lon = null
        this.gpsFixed = false
        this.pendingDailyStarts = [] // sensors waiting for a GPS fix

        console.log("ENPI: Starting enpi.js...")
        this.sensors = {
            air: {
                child: null,
                lineBuffer: "",
                CMD_ARGS: [ this.prog + "/enpi-air.py"],
                quitting: false,
                schedule: null
            },
            light: {
                child: null,
                lineBuffer: "",
                CMD_ARGS: [ this.prog + "/enpi-light.py"],
                quitting: false,
                schedule: null
            }
        }

        // Update lat/lon whenever GPS gets a fix
        matron.on("gotGPSFix", (fix) => {
            if (!["no-dev", "no-sat"].includes(fix.state) && !this.gpsFixed) {
                this.gpsFixed = true
                this.lat = fix.lat
                this.lon = fix.lon
                // Start any Daily schedules that were waiting
                for (const sensorName of this.pendingDailyStarts) {
                    console.log(`enpi-${sensorName}: got GPS fix, starting Daily schedule. Fix: ${JSON.stringify(fix)}`)
                    this.sensors[sensorName].schedule.start()
                }
                this.pendingDailyStarts = []
            }
        })
        matron.on("quit", () => this.quit())
        
        
        this.CMD_PATH = `${this.prog}/env/bin/python3`
        this.CMD_ARGS = [ this.prog + "/enpi-air.py"] // stdin->stdout is default
        this.CMD_ENV = { ...process.env, PYTHONUNBUFFERED: 1 } // ensure stdout is unbuffered
        console.log("ENPI: enpi.js initiated.")
        
        this.configure(Acquisition.lookup("1", "enpi-light")?.plan)
        this.configure(Acquisition.lookup("1", "enpi-air")?.plan)
    }
    
    configure(cfg) {

        console.log(`enpi: config: ${JSON.stringify(cfg)}`)
        const sensorName = cfg.key.devType.split('-')[1] // e.g. "enpi-light" -> "light"
        const sensorSched = cfg.schedule
        const s = this.sensors[sensorName]
        if (!s) return console.log(`enpi: unknown sensor ${sensorName} in config`)

        if (s.schedule) {
            s.schedule.stop()
            s.schedule = null
        }

        const schedType = sensorSched.type.toLowerCase()
        s.schedule = this._makeSchedule(sensorName, sensorSched)

        if (schedType === "daily") {
            if (this.gpsFixed) {
                // Fix already came in before config — start immediately
                s.schedule.start()
            } else {
                // Defer start until gotGPSFix
                console.log(`enpi-${sensorName}: waiting for GPS fix before starting Daily schedule`)
                this.pendingDailyStarts.push(sensorName)
                for (const i in (cfg?.devParams || [])) {
                    switch (cfg.devParams[i].name) {
                        case "fallbackLat":
                            this.fallbackLat = cfg.devParams[i].schedule?.value || 0
                            break;
                        case "fallbackLon":
                            this.fallbackLon = cfg.devParams[i].schedule?.value || 0
                            break;
                    }
                }

                console.log(`enpi-${sensorName}: using fallback lat/lon: ${this.fallbackLat},${this.fallbackLon}`)

                // Fallback: if no fix within 10 minutes, use fallback coords if provided
                if (this.fallbackLat && this.fallbackLon) {
                    setTimeout(() => {
                        if (!this.gpsFixed) {
                            console.log(`enpi-${sensorName}: no GPS fix after 10min, using fallback coords`)
                            this.lat = this.fallbackLat
                            this.lon = this.fallbackLon
                            this.sensors[sensorName].schedule.start()
                        }
                    }, 0.1 * 60 * 1000)
                }
            }
        } else {
            // AlwaysOn etc. don't need GPS — start immediately
            s.schedule.start()
        }
    }

    _makeSchedule(sensorName, schedCfg) {
        const callback = (newState, oldState) => {
            console.log(`enpi-${sensorName}: schedule ${oldState} -> ${newState}`)
            if (newState === "on") this.start(sensorName)
            else this.stop(sensorName)
        }

        switch (schedCfg.type.toLowerCase()) {
            case "alwayson":
                return new Schedule.AlwaysOn(callback)

            case "daily": {
                const self = this
                
                // Parses "sunset", "sunrise", "sunset-1", "sunrise+2.5" etc.
                // Returns a function compatible with Schedule.Daily
                const parseTimeExpr = (expr) => {
                    const match = expr.match(/^(sunrise|sunset)([+-]\d+(\.\d+)?)?$/)
                    if (!match) throw new Error(`enpi: invalid schedule time expression: "${expr}"`)
                    
                    const base = match[1]         // "sunrise" or "sunset"
                    const offset = parseFloat(match[2] || 0) * 3600 * 1000  // hours -> ms

                    return function(d) {
                        // try{
                            const baseTime = this[base](self.lat, self.lon, d)
                            const date = new Date(baseTime + offset)
                            console.log("enpi: date: ", date)
                            return date
                        /* } catch(e){
                            console.warn("Enpi: date parsing error: ", e);
                            console.warn("Enpi: date parsing error: ", Schedule.sunrise);
                            return new Date()
                        } */
                    }
                }

                //console.log("enpi: start date: ",parseTimeExpr(schedCfg.startTime)(new Date()))
                //console.log("enpi: end date: ",parseTimeExpr(schedCfg.stopTime)(new Date()))
                return new Schedule.Daily(callback, 
                    parseTimeExpr(schedCfg.startTime), 
                    parseTimeExpr(schedCfg.stopTime))
            }

            default:
                console.log(`enpi-${sensorName}: unknown schedule type ${schedCfg.type}`)
                return new Schedule.AlwaysOn(callback)
        }
    }

    start(sensor) {
        const s = this.sensors[sensor]
        if (!s || s.quitting || s.child) return

        console.log("Starting", this.CMD_PATH, s.CMD_ARGS.join(' '))
        s.child = ChildProcess.spawn(this.CMD_PATH, s.CMD_ARGS, { env: this.CMD_ENV })
            .on("exit", () => this.childDied(sensor))
            .on("error", () => this.childDied(sensor))

        s.child.stdout.on("data", chunk => {
            s.lineBuffer += chunk.toString()
            const lines = s.lineBuffer.split('\n')
            s.lineBuffer = lines.pop() // hold back incomplete last line

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const data = JSON.parse(line)
                    if (data[0] == "status") {
                        console.log(`enpi-${sensor}: status:`, data[1])
                        this.matron.emit(`enpi_${sensor}_state`, data[1])
                    } else {
                        console.log(`enpi-${sensor}: got data:`, line)
                        this.matron.emit(`enpi_${sensor}_gotData`, data)
                    }
                } catch(e) {
                    console.log(`enpi-${sensor}: bad JSON:`, line)
                }
            }
        })
        s.child.stdout.on("error", () => {})

        s.child.stderr.on("data", x => {
            for (const line of x.toString().split('\n')) {
                if (line.trim()) console.log(`enpi-${sensor}.py stderr:`, line)
            }
        })
        s.child.stderr.on("error", () => {})

    }

    stop(sensor) {
        const s = this.sensors[sensor]
        if (!s || !s.child) return
        s.quitting = true
        s.child.kill()
    }

    childDied(sensor) {
        const s = this.sensors[sensor]
        if (!s) return
        s.child = null
        if (!s.quitting) {
            console.log(`enpi-${sensor}.py exited unexpectedly`)
        }
        s.quitting = false
    }
    quit() {
        for (const sensor of Object.keys(this.sensors)) {
            this.stop(sensor)
        }
    }

    set(setting_path, value) {
        const [sensor, setting] = setting_path.split('/')
        switch (setting) {
            case "toggle":
                this.toggle(sensor, value)
                break
        }
    }

    toggle(sensor, value = "off") {
        if (value === "on") this.start(sensor)
        else this.stop(sensor)
    }   
}


exports.Enpi = Enpi