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
        this.uploadsLogFile = '/var/log/enpi/uploader.log'
        

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
            },
            upload: {
                child: null,
                lineBuffer: "",
                CMD_ARGS: [ this.prog + "/enpi-upload.py"],
                quitting: false,
                schedule: null,
                // If alwaysOn, do you want to run it at a certain frequency?
                frequency: 1, // Times per hour
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
        this.UPLOADS_POLL = [ this.prog + "/enpi-upload.py", "-p"] // stdin->stdout is default
        this.UPLOADS_PATH = [ this.prog + "/enpi-upload.py"] // stdin->stdout is default
        this.SECRETS_PATH = `${this.prog}/secrets.env` //
        console.log("ENPI: enpi.js initiated.")
        
        for (const sensor in this.sensors) {
            this.configure(Acquisition.lookup("1", `enpi-${sensor}`)?.plan)
        }

        this.matron.emit(`enpi_upload_config_status`, false)
        setTimeout(()=>this.validateSecrets(this.SECRETS_PATH),1000)
        
    }

    get_upload_logs() {
        const text = ChildProcess.execSync('tail -50 '+this.uploadsLogFile).toString();
        this.matron.emit(`enpi_upload_log`, text)
        console.log(`enpi-upload: read log text (${text.length} lines)`)
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
            if (s.frequency) {
                const sleep_secs = 60*60 / s.frequency
                console.log(`enpi-${sensorName}: Waiting for ${sleep_secs} seconds before running again.`)
                setTimeout(()=>{
                    s.schedule.start()
                },sleep_secs*1e3)
            }
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
        this.matron.emit(`enpi_${sensor}_status`, 'starting')
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
                        this.matron.emit(`enpi_${sensor}_status`, data[1])
                    } else {
                        console.log(`enpi-${sensor}: got data:`, line)
                        this.matron.emit(`enpi_${sensor}_gotData`, data)
                    }
                    if (sensor == "upload") this.get_upload_logs()
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
    sensorConfig(sensor, config) {

        switch(sensor) {
            case "upload":
                this.updateSecrets(this.SECRETS_PATH, config)
                break
        }

    }
    updateSecrets(filepath, updates) {
        const errors = Object.entries(updates).map(([key, value]) => {
            if (key == "secret_key" && value.replace(/\**/g,'').length == 40 )
                return updateSecret(filepath, key, value);
        }).filter(error => typeof error === "string");

        this.matron.emit(`enpi_upload_config_status`, errors)
    }

    updateSecret(filepath, key, value) {

        const error = this.validateSecret(key, value)
        if (error)
            return error

        let content = Fs.readFileSync(filepath, 'utf8');
        
        const regex = new RegExp(`^${key}=.*$`, 'm');
        
        if (regex.test(content)) {
            // Key exists, replace it
            content = content.replace(regex, `${key}=${value}`);
        } else {
            // Key doesn't exist, append it
            content += `\n${key}=${value}`;
        }
        
        Fs.writeFileSync(filepath, content, 'utf8');

        return false
    }
    validateSecrets(filepath) {
        
        console.log("enpi: validating secrets...")
        let content = Fs.readFileSync(filepath, 'utf8');
        
        const entries = content.match(/^([A-z]|_|[0-9])+=.*$/gm)

        const errors = entries.map( entry => {
            const key = entry.match(/([A-z]|_|[0-9])+(?=\=)/gm)
            const value = entry.replace(`${key}=`, '')
            return this.validateSecret(key, value)
        }).filter(error => typeof error === "string")
        console.log(`enpi: Done. Found ${errors.length} errors.`)
        
        this.matron.emit(`enpi_upload_config_status`, errors)
        
    }
    validateSecret(key, value) {
        switch(key) {
            case "AWS_ACCESS_KEY_ID":
                if (!/^AKIA[A-Z0-9]{16}$/.test(secrets.AWS_ACCESS_KEY_ID))
                    return 'AWS_ACCESS_KEY_ID must be 20 characters and start with AKIA'
            case "AWS_SECRET_ACCESS_KEY":
                if (!/^[A-Za-z0-9/+=]{40}$/.test(secrets.AWS_SECRET_ACCESS_KEY)) 
                    return 'AWS_SECRET_ACCESS_KEY must be 40 characters'
            case "BUCKET_NAME":
                if (!/^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$/.test(secrets.BUCKET_NAME))
                    return 'BUCKET_NAME must be 3-63 characters, lowercase letters, numbers and hyphens only';
        }
        
        return false;
    }


    set(setting_path, value) {
        console.log(`enpi: received setting: ${setting_path} -> ${value}`)
        const [sensor, setting] = setting_path.split('/')
        switch (setting) {
            case "toggle":
                this.toggle(sensor, value)
                break
            case "force":
                this.start(sensor)
                break
            case "config":
                this.sensorConfig(sensor, value)
                break
        }
    }

    toggle(sensor, value = "off") {
        if (value === "on") this.start(sensor)
        else this.stop(sensor)
    }   
}


exports.Enpi = Enpi