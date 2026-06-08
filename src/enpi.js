// Enpi class: interface with environmental sensor
var Fs = require("fs")

class Enpi {
    constructor(matron, prog) {
        this.matron = matron
        this.prog = prog
        this.child = null
        this.quitting = false
        this.provisioned = false
        this.inetOK = false

        this.lat = null
        this.lon = null
        
        this.uploadsLogFile = '/var/log/enpi/uploader.log'
        this.enpiConfigFile = `${this.prog}/enpi-config.json`
        this.iotConfigFile = `${this.prog}/provisioning/iot-config.json`
        this.CMD_PATH = `${this.prog}/env/bin/python3`
        this.CMD_ENV = { ...process.env, PYTHONUNBUFFERED: 1 } // ensure stdout is unbuffered
        
        this.sensors = this.loadConfig(this.enpiConfigFile)
        this.iot = this.loadConfig(this.iotConfigFile)


        console.log("enpi: Starting enpi.js...")

        // Have to set GPIO 24 to an INPUT because it's sometimes set as an OUTPUT by default
        ChildProcess.execSync('raspi-gpio set 24 ip')

        matron.on("quit", () => this.quit())
        matron.on("devAdded", (dev) => this.devAdded(dev))
        matron.on("devRemoved", (dev) => this.devRemoved(dev))
        
        
        for (const sensor in this.sensors) {
            if (this.sensors[sensor].active) {
                if (!this.sensors[sensor].configured) this.configure( sensor )
                this.matron.emit(`enpi_${sensor}_toggle`, 'on')
            } else {
                this.matron.emit(`enpi_${sensor}_status`, 'off')
                this.matron.emit(`enpi_${sensor}_toggle`, 'off')
            }
        }

        this.matron.emit(`enpi_upload_config_status`, false)
        //setTimeout(()=>this.provision(),1000)
        this.matron.on("netInet", (status)=>{
            this.inetOK = status === "OK"
            const anySensorActive = Object.entries(this.sensors)
                .some(([name, s]) => name !== "upload" && s.active)
            if (this.inetOK && anySensorActive) this.provision()
        })

        this.getSoftwareVersion()

        console.log("enpi: enpi.js initiated.")
    }
    loadConfig(filename) {
        return JSON.parse( Fs.readFileSync(filename, "utf8") )
    }
    devRemoved(dev) {
        if (dev?.attr?.radio == "none" && dev?.attr?.type == "SQM-LU") {
            this.toggle("light", "off")
            this.matron.emit("enpi_light_toggle", "off")
        }
    }
    devAdded(dev) {
        if (dev?.attr?.radio == "none" && dev?.attr?.type == "SQM-LU") {
            setTimeout(() => {
                this.toggle("light", "on")
                this.matron.emit("enpi_light_toggle", "on")
            }, 1000)
        }
    }
    saveConfig() {
        const toWrite = {} // Copy the object
        const propsToSave = [
            "lineBuffer",
            "script",
            "active",
            "frequency",
            "intervalSecs"
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
    
    configure( sensorName ) {
        const s = this.sensors[sensorName]
        console.log(`enpi: config: ${sensorName}: ${s.script} ${s.active?"ACTIVE":"INACTIVE"}`)
        if (!s.active) return
        if (!s) return console.log(`enpi: unknown sensor ${sensorName} in config`)

        this.matron.emit(`enpi_${sensorName}_toggle`, 'on')
        if (s.configured) this.stop( sensorName )

        this.sensors[sensorName].configured = true
        console.log(`enpi-${sensorName}: configured`)

        this.start( sensorName )
    }

    provision() {
        if (this.provisioned) return

        let log = ""
        let lineBuffer = ""

        const proc = ChildProcess.spawn(this.CMD_PATH, [`${this.prog}/provisioning/provision-device.py`])

        proc.stdout.on("data", (data) => {
            lineBuffer += data.toString()
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop()
            for (const line of lines) {
                if (!line.trim()) continue
                console.log("enpi: provision:", line)
                log += "\n" + line
                this.matron.emit("enpi_update_log", log)
                try {
                    const msg = JSON.parse(line)
                    if (msg[0] === "status") {
                        const status = msg[1]
                        this.matron.emit("enpi_provisioning_status", status)
                        if (status === "already-provisioned" || status === "provisioned") {
                            this.provisioned = true
                        }
                        if ((status === "provisioned" || status === "already-provisioned") && msg[2]) {
                            this.matron.emit("enpi_provisioning_info", msg[2])
                        }
                    } else if (msg[0] === "error") {
                        this.matron.emit("enpi_provisioning_status", `error: ${msg[1]}`)
                    }
                } catch (e) {
                    console.log("enpi: provision: bad JSON:", line)
                }
            }
        })

        proc.stderr.on("data", (data) => {
            const text = data.toString()
            console.log("enpi: provision stderr:", text)
            log += "\n" + text
            this.matron.emit("enpi_update_log", log)
        })

        proc.on("error", (err) => {
            console.log("enpi: provision error:", err)
            this.matron.emit("enpi_provisioning_status", "error")
        })

        proc.on("close", (code) => {
            const text = code === 0
                ? "Provisioning completed successfully."
                : `Provisioning failed with exit code ${code}.`
            console.log("enpi: provision close:", text)
            log += "\n" + text
            this.matron.emit("enpi_update_log", log)
        })
    }

    start(sensorName) {
        const s = this.sensors[sensorName]
        if (!s || s.quitting || s.child) {
            console.log(`enpi-${sensorName}: Can't start because: ${!s?"Sensor undefined":s.quitting?"Currently quitting": "Child already exists"}`)
            return
        }
        if (!s.configured) {
            console.log(`enpi-${sensorName}: Not yet configured.`)
            return this.configure( sensorName )
        }

        console.log("Enpi: Starting", this.CMD_PATH, `${this.prog}/${s.script}`)
        
        this.matron.emit(`enpi_${sensorName}_status`, 'starting')
        s.child = ChildProcess.spawn(this.CMD_PATH, [`${this.prog}/${s.script}`], { env: this.CMD_ENV })
            .on("exit", () => this.childDied(sensorName))
            .on("kill", () => this.childDied(sensorName))
            .on("error", () => this.childDied(sensorName))

        s.child.stdout.on("data", chunk => {
            s.lineBuffer += chunk.toString()
            const lines = s.lineBuffer.split('\n')
            s.lineBuffer = lines.pop() // hold back incomplete last line

            for (const line of lines) {
                if (!line.trim()) continue
                try {
                    const data = JSON.parse(line)
                    if (data[0] == "status") {
                        console.log(`enpi-${sensorName}: status:`, data[1])
                        this.matron.emit(`enpi_${sensorName}_status`, data[1])
                    } else {
                        console.log(`enpi-${sensorName}: got data:`, line)
                        this.matron.emit(`enpi_${sensorName}_gotData`, data)
                    }
                    if (sensorName == "upload") this.get_upload_logs()
                } catch(e) {
                    console.log(`enpi-${sensorName}: bad JSON:`, line)
                }
            }
        })
        s.child.stdout.on("error", () => {})

        s.child.stderr.on("data", x => {
            for (const line of x.toString().split('\n')) {
                if (line.trim()) console.log(`enpi-${sensorName}.py stderr:`, line)
            }
        })
        s.child.stderr.on("error", () => {})

        if (s.intervalSecs > 0) {
            console.log(`enpi-${sensorName}: Waiting for ${s.intervalSecs} seconds before running again.`)
            if (s.interval) clearInterval(s.interval)
            s.interval = setInterval(()=>{
                this.start(sensorName)
            }, s.intervalSecs * 1e3)
        }
    }

    stop(sensorName) {
        console.log(`enpi-${sensorName}: Quitting sensor process...`)
        const s = this.sensors[sensorName]
        if (s?.interval) {
            console.log(`enpi-${sensorName}: Clearing interval`)
            clearInterval(s.interval)
        }
        if (!s || !s.child) {
            this.matron.emit(`enpi_${sensorName}_status`, "off")
            console.log(`enpi-${sensorName}: Sensor process already inactive`)
            return
        }
        s.quitting = true
        s.restarting = false
        s.child.kill()
        this.matron.emit(`enpi_${sensorName}_status`, "off")
    }

    childDied(sensorName) {
        console.log(`enpi-${sensorName}.py exited`)
        const s = this.sensors[sensorName]
        if (!s) return
        s.child = null
        if (s.intervalSecs > 0) {
            console.log(`enpi-${sensorName}.py exited as expected.`)
        } else if (!s.quitting) {
            if (!s.restarting) {
                console.log(`enpi-${sensorName}.py exited unexpectedly! Attempting to restart...`)
                s.restarting = true
                this.configure( sensorName )
            } else {
                console.log(`enpi-${sensorName}.py exited unexpectedly, again! Not going to attempt restarting again.`)
                s.restarting = false
            }
        }
        s.quitting = false
    }
    quit() {
        for (const sensor of Object.keys(this.sensors)) {
            this.stop(sensor)
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
        }
    }

    toggle(sensor, value = "off") {
        this.sensors[sensor].active = value == "on"
        if (!this.sensors.upload.active && Object.values(this.sensors).some( values => values.active )) {
            if (!this.sensors.upload.configured) this.configure('upload')
            this.sensors.upload.active = true
        }
        if (value === "on") {
            this.start(sensor)
            if (this.inetOK) this.provision()
        } else this.stop(sensor)
        if (this.sensors.upload.active && !Object.values(this.sensors).some( values => values.active )) this.stop('upload')
        this.saveConfig()
    }   
}


exports.Enpi = Enpi