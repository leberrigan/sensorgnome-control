// Enpi class: interface with environmental sensor
var Fs = require("fs")

class Enpi {
    constructor(matron, prog, secrets_file) {
        this.matron = matron
        this.prog = prog
        this.child = null
        this.quitting = false
        
        this.lat = null
        this.lon = null
        this.gpsFixed = false
        this.pendingDailyStarts = [] // sensors waiting for a GPS fix
        this.uploadsLogFile = '/var/log/enpi/uploader.log'
        this.enpiConfigFile = `${this.prog}/enpi-config.json`
        this.CMD_PATH = `${this.prog}/env/bin/python3`
        this.CMD_ENV = { ...process.env, PYTHONUNBUFFERED: 1 } // ensure stdout is unbuffered
        this.SECRETS_PATH = secrets_file //
        
        this.sensors = this.loadConfig(this.enpiConfigFile)


        console.log("enpi: Starting enpi.js...")

        // Have to set GPIO 24 to an INPUT
        ChildProcess.execSync('raspi-gpio set 24 ip')

        // Update lat/lon whenever GPS gets a fix
        matron.on("gotGPSFix", (fix) => {
            if (!["no-dev", "no-sat"].includes(fix.state) && !this.gpsFixed) {
                this.gpsFixed = true
                this.lat = fix.lat
                this.lon = fix.lon
                // Start any Daily schedules that were waiting
                for (const sensorName of this.pendingDailyStarts) {
                    if (this.sensors[sensorName].active)
                        console.log(`enpi-${sensorName}: got GPS fix, starting Daily schedule. Fix: ${JSON.stringify(fix)}`)
                        this.sensors[sensorName].schedule.start()
                }
                this.pendingDailyStarts = []
            }
        })
        matron.on("quit", () => this.quit())
        
        
        console.log("enpi: enpi.js initiated.")
        
        for (const sensor in this.sensors) {
            if (this.sensors[sensor].active) {
                this.configure(Acquisition.lookup("1", `enpi-${sensor}`)?.plan)
                this.matron.emit(`enpi_${sensor}_toggle`, 'on')
            } else {
                this.matron.emit(`enpi_${sensor}_status`, 'off')
                this.matron.emit(`enpi_${sensor}_toggle`, 'off')
            }
        }

        this.matron.emit(`enpi_upload_config_status`, false)
        setTimeout(()=>this.validateSecrets(this.SECRETS_PATH),1000)
        this.getSoftwareVersion()
    }
    loadConfig(filename) {
        return JSON.parse( Fs.readFileSync(filename, "utf8") )
    }
    saveConfig() {
        const toWrite = {} // Copy the object
        const propsToSave = [
            "lineBuffer",
            "script",
            "active",
            "frequency"
        ]
        for (const sensor in this.sensors) {
            toWrite[sensor] = Object.fromEntries( 
                Object.entries(this.sensors[sensor]).filter(
                    ([key,value]) => propsToSave.includes( key ) 
                )
            )
        }
        Fs.writeFileSync(this.enpiConfigFile, JSON.stringify(toWrite))
    }
    get_upload_logs() {
        const text = ChildProcess.execSync('tail -50 '+this.uploadsLogFile).toString();
        this.matron.emit(`enpi_upload_log`, text)
        console.log(`enpi-upload: read log text (${text.length} lines)`)
    }
    
    configure(cfg) {
        if (typeof (cfg) !== "object" || Object.keys(cfg).length == 0) return console.log("enpi: there is not config provided")
        console.log(`enpi: config: ${JSON.stringify(cfg)}`)
        const sensorName = cfg?.key?.devType?.split('-')[1] // e.g. "enpi-light" -> "light"
        const sensorSched = cfg?.schedule
        const s = this.sensors[sensorName]
        if (!s.active) return
        if (!s) return console.log(`enpi: unknown sensor ${sensorName} in config`)

        this.matron.emit(`enpi_${sensorName}_toggle`, 'on')
        if (s.schedule) {
            s.schedule.stop()
            s.schedule = null
        }

        const schedType = sensorSched.type.toLowerCase()
        s.schedule = this._makeSchedule(sensorName, sensorSched)
        s.configured = true
        console.log(`enpi-${sensorName}: configured`)

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
                s.interval = setInterval(()=>{
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
        if (!s.configured) {
            console.log(`enpi-${sensor}: Not yet configured.`)
            return this.configure( Acquisition.lookup("1", `enpi-${sensor}`)?.plan )
        }
        if (!this.sensors.upload.configured) this.configure( Acquisition.lookup("1", `enpi-upload`)?.plan )

        console.log("Starting", this.CMD_PATH, `${this.prog}/${s.script}`)
        
        this.matron.emit(`enpi_${sensor}_status`, 'starting')
        s.child = ChildProcess.spawn(this.CMD_PATH, [`${this.prog}/${s.script}`], { env: this.CMD_ENV })
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
        console.log(`enpi-${sensor}: Quitting sensor process...`)
        const s = this.sensors[sensor]
        if (s?.interval) clearInterval(s.interval)
        if (!s || !s.child) {
            this.matron.emit(`enpi_${sensor}_status`, "off")
            console.log(`enpi-${sensor}: Sensor process already inactive`)
            return
        }
        s.quitting = true
        s.child.kill()
        this.matron.emit(`enpi_${sensor}_status`, "off")
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
        
    getEnpiVersion() {
        try {
            return ChildProcess.execSync(
                'python3 - << "EOF"\n' +
                'import sys\n' +
                'sys.path.insert(0, "/opt/sensorgnome/enpi")\n' +
                'from enpi import __version__\n' +
                'print(__version__)\n' +
                'EOF'
            ).toString().trim();
        } catch (err) {
            return null;
        }
    }

    getSoftwareVersion() {
        const version = this.getEnpiVersion()

        this.matron.emit('enpi_version', version);
    }
    updateSoftware() {

        let log = ""
        
        const url = "https://raw.githubusercontent.com/sensorgnome-org/enviroPi/sensorgnome/update.sh";

        // 1. Spawn curl
        const curl = ChildProcess.spawn("curl", ["-sSL", url]);

        // 2. Spawn sudo bash
        const proc = ChildProcess.spawn("sudo", ["bash"], {stdio: ["pipe", "pipe", "pipe"]});

        // 3. Pipe curl → bash
        curl.stdout.pipe(proc.stdin);

        // 4. Capture stdout (echo output)
        proc.stdout.on("data", (data) => {
            const text = data.toString()
            console.log("enpi: ", text)
            log += "\n" + text
            this.matron.emit("enpi_update_log",log)   // or send to UI / logger
        });

        // 5. Capture stderr
        proc.stderr.on("data", (data) => {
            const text = data.toString();
            console.log("enpi: ", text)
            log += "\n" + text
            this.matron.emit("enpi_update_log",log)   // or send to UI / logger
        });

        // 6. Error handling
        curl.on("error", (err) => {
            console.log("enpi: ", err)
            log += "\n" + err
            this.matron.emit("enpi_update_log", log)   // or send to UI / logger
            console.error("curl failed:", err);
        });

        // 7. Exit handling
        proc.on("close", (code) => {
            let text
            if (code === 0) {
                text = "Update script completed successfully."
            } else {
                text = `Update script failed with exit code ${code}.`
            }
            console.log("enpi: ", text)
            log += "\n" + text
            this.matron.emit("enpi_update_log",log)   // or send to UI / logger
        })

        this.getSoftwareVersion()
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
        let content
        
        try {
            content = Fs.readFileSync(filepath, 'utf8')
        } catch (err) {
            if (err.code === "ENOENT") {
                console.log("enpi: Secrets file does not exist")
            } else {
                throw err // real error, re‑throw
            }
            return false
        }
        
        const entries = content.match(/^([A-z]|_|[0-9])+=.*$/gm)
        let errors = ["No entries"]
        if (entries && entries.length > 0) {
            errors = entries.map( entry => {
                const key = entry.match(/([A-z]|_|[0-9])+(?=\=)/gm)
                const value = entry.replace(`${key}=`, '')
                return this.validateSecret(key, value)
            }).filter(error => typeof error === "string")
            console.log(`enpi: Done. Found ${errors.length} errors.`)
        } else {
            console.log("enpi: found empty secrets file")
        }
        
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
        this.sensors[sensor].active = value == "on"
        this.sensors.upload.active = Object.values(this.sensors).map( values => values.active ).includes( true )
        if (value === "on") this.start(sensor)
        else this.stop(sensor)
        if (!this.sensors.upload.active) this.stop('upload')
        this.saveConfig()
    }   
}


exports.Enpi = Enpi