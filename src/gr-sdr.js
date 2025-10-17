/*
  implement a plan for an gnuradio device

*/

GR_SDR = function(matron, dev, devPlan) {

    console.log("Gnuradio device: start");

    Sensor.Sensor.call(this, matron, dev, devPlan);
    // path to the socket that GnuRadio will use
    // e.g. /tmp/GnuRadio-1:4.sock for a device with usb path 1:4 (bus:dev)
    
    this.sockPath = "/tmp/gnuradio-" + dev.attr.usbPath + ".sock";
    // hardware rate needed to achieve plan rate;
    // i.e. find the smallest exact multiple of the desired rate that is in
    // the allowed range of hardware rates.

    var rate = devPlan.plan.rate;
    if (rate != 48e3 && rate != 3e6 && rate != 6e6 && rate != 10e6) {
        console.log("GnuRadio: requested rate not within hardware range; using 48000");
        rate = 48e3;
    }

    this.hw_rate = 6e6; // Only rate that is a multiple of 48khz

    console.log("GnuRadio: ", JSON.stringify(this))
    console.log("GnuRadio binding: ", this.grhDied)
    // callback closures
    // this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    // this.this_logServerError   = this.logServerError.bind(this);
    this.this_grhDied          = this.grhDied.bind(this);
    this.this_grhData          = this.grhData.bind(this);
    // this.this_serverDied       = this.serverDied.bind(this);
    // this.this_serverError      = this.serverError.bind(this);
    // this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    // this.this_connectCmd       = this.connectCmd.bind(this);
    // this.this_serverReady      = this.serverReady.bind(this);
    // this.this_cmdSockError     = this.cmdSockError.bind(this);
    // this.this_cmdSockClose     = this.cmdSockClose.bind(this);
    // this.this_cmdSockEnd       = this.cmdSockEnd.bind(this);
    // this.this_spawnServer      = this.spawnServer.bind(this);

    // handle situation where program owning other connection to libairspy dies
    this.matron.on("grhDied", this.this_grhDied);

    // listen to data to adjust gain based on noise level
    this.matron.on("grhData", this.this_grhData);

    // storage for the setting list sent by libairspy
    this.replyBuf = ""; // buffer the reply stream, in case it crosses transmission unit boundaries

    // libairspy replies with a 12-byte header, before real command replies; we ignore this
    // as the info is available elsewhere
    this.gotCmdHeader = false;

    this.restart = false; // when true, we're killing the server and want a restart

    this.killing = false; // when true, we've deliberately killed the server

    this.agc_at = 0; // timestamp of last AGC change

    console.log("GnuRadio: created");
};

GR_SDR.prototype = Object.create(Sensor.Sensor.prototype);
GR_SDR.prototype.constructor = GR_SDR;


GR_SDR.prototype.getDeviceID = function() {
    if (this.dev.attr.type == "airspy") {
            
        const [bus, device] = (this.dev.attr.usbPath || "0:0")
            .split(":")
            .map( x => x.padStart(3, '0') );

        const path = `/dev/bus/usb/${bus}/${device}`;
        let output;

        console.log("Getting serial number for GnuRadio device at path:", path);
        try {
            output = ChildProcess.execSync(`udevadm info -q all -n ${path}`).toString();
        } catch (err) {
            console.warn(`Failed to get udev info for ${path}:`, err.message);
            return null;
        }

        const serialMatch = output.match(/ID_SERIAL=([^\n]+)/);

        const serial = serialMatch ? serialMatch[1].split(":").pop() : null;   
        console.log("Found serial number:", serial);

        return serial;

    } else {
        return this.dev.attr.usbPath;
    }
}


GR_SDR.prototype.extractPluginParams = function() {
    
    for (param of this.plan.plugins[0].params) {
        this.plan[param.name] = param.value;
    }
    for (param of this.plan.devParams) {
        this.plan[param.name] = param.schedule.value;
    }
}

GR_SDR.prototype.grhDied = function() {
    this.hw_delete();
};


GR_SDR.prototype.hw_init = function(callback) {
    // Get the serial number or device ID
    this.extractPluginParams();
    callback();   // immediately go to callback
};
    
GR_SDR.prototype.gnuRadioCmds = {
    // table of command recognized by airspy_tcp
    //
    // - the command is sent as a byte, followed by a big-endian 32-bit parameter
    //agc
    // - units for parameters below are those understood by airspy_tcp, and are integers
    //
    // - parameters have the same name in deployment.txt, but some of the units
    //   differ there, since they are allowed to be reals.
    frequency:		    1,    // Hz
    rate:			    2,    // 3e6, 6e6, or 10e6 SPS
    lna_gain:		    3,    // 0–15 dB
    mixer_gain: 	    4,    // 0–15 dB
    vga_gain:		    5,    // 0–15 dB
    linearity_gain:	    6,    // 0-20
    sensitivity_gain:   7,    // 0-20
    lna_agc:		    8,    // true/false
    mixer_agc:		    9,    // true/false
    agc:		        10,   // true/false
    bias_tee:		    11,   // true/false
    streaming:	        15,   // true/false
    // Optional: add callback or buffer size settings
};


GR_SDR.prototype.hw_devPath = function() {
    return "gnuradio:" + this.sockPath;
};


GR_SDR.prototype.hw_delete = function() {
    //console.log("airspy::hw_delete");
    if (this.server) {
        this.killing = true;
        this.server.kill("SIGKILL");
        console.log("libairspy server", this.server.pid, this.server.killed ? "killed" : "not killed");
        //this.server = null;
    }
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
};

GR_SDR.prototype.hw_startStop = function(on) {
    // just send the 'streaming' command with appropriate value
    this.hw_setParam({par:"streaming", val:on?1:0});
    console.log("GnuRadio::hw_startStop = " + on);
};

// hw_restart is called when either data from the device seems to have stalled
// (which can be due to chrony stepping the clock forward) or when libairspy has died
GR_SDR.prototype.hw_restart = function() {
    // pretend the device has been removed then added, this will trigger deletion of all resources
    // and then relaunch of libairspy.
    console.log("GnuRadio::hw_reset - faking a remove & re-add");
    // copy the device structure (really - this is the best node has to offer for cloning POD?)
    var dev = JSON.parse(JSON.stringify(this.dev));
    // re-add after 5 seconds
    setTimeout(function(){TheMatron.emit("devAdded", dev)}, 5000);
    // remove now
    this.matron.emit("devRemoved", this.dev);
};

GR_SDR.prototype.hw_stalled = function() {
    // relaunch libairspy and re-establish connection
    console.log("GnuRadio::hw_stalled");
    this.restart = true
    this.hw_delete()
};

// tune gain to set the noise floor into the -35..-45dB range
GR_SDR.prototype.grhData = function(line) {
    FlexDash.set('detections_5min', this.detections)
};

GR_SDR.prototype.hw_setParam = function(parSetting, callback) {
    
    let val = parSetting.val;
    let par = parSetting.par;

    let cmd = `${par} ${this.dev.attr.port} ${val}`

    this.matron.emit("grhSubmit", cmd, callback, this);

/*     var cmdBuf = Buffer.alloc(5);
    let val = parSetting.val;
    let par = parSetting.par;

    switch (par) {
        case "frequency":
            val = Math.round(val * 1.0E6); // MHz to Hz
            break;
    }

    var cmdNo = this.gnuRadioCmds[ par ];
    if (cmdNo && this.cmdSock) {
        console.log(`GnuRadio: set parameter ${par} (${cmdNo}) to ${val}`);
        try {
            if (!callback) 
                callback = (err) => {
                    if (err) console.error("Command write failed:", err);
                    else console.log("Command sent");
                };
            cmdBuf.writeUInt8(cmdNo, 0);
            cmdBuf.writeUInt32BE(val, 1); // note: airspy_tcp expects big-endian
            this.cmdSock.write(cmdBuf, callback);
        } catch(e) {
            this.matron.emit("setParamError", {type:"airspy", port: this.dev.attr.port, par: par, val:val, err: e.toString()})
        }
    } else if (cmdSock) {
        console.warn(`Unknown parameter: ${par}`);
    } */

    //if (callback) callback();
};


exports.GR_SDR = GR_SDR;
