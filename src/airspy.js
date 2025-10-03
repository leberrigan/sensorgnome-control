/*
  implement a plan for an airspy device

  This object represents a plugged-in airspy device and associated plan.
  As soon as it is created, it begins applying the plan.  This means:
  - issuing VAH commands to start the device (on whatever schedule)
  - issuing shell commands to set device parameters (on whatever schedule)
  - respond to "devRemoved" messages by shutting down
  - respond to "devStalled" messages by and resetting + restarting the
    device

  Most of the work is done by a modified version of rtl_tcp, to which
  we establish two half-duplex connections.  airspy_tcp listens to the
  first for commands to start/stop streaming and set tuning and
  filtering parameters.  airspy_tcp sends streamed samples down the
  second connection.  The first connection is from nodejs, running
  this module.  Commands are sent to that connection, and it replies
  with a JSON-formatted list of current parameter settings.

  The second connection is opened by vamp-alsa-host, after we ask it
  to "open" the airspy device.  We watch for the death of vamp-alsa-host
  in which case we need to restart airspy_tcp, since its only handles
  two connections and dies after noticing either has closed.

  Parameters settings accepted by airspy_tcp are all integers; this module
  is responsible for converting to/from natural units.
  example:

    parameter    airspy_tcp unit   "natural unit"
                   (integer)    (floating point)
   ---------------------------------------------
    frequency     166370000        166.376 MHz
    tuner_gain       105             10.5 dB

  "Natural units" are used in deployment.txt, the web interface, and
  the matron's "setParam" messages.

*/

var enableAGC = false; // automatic gain control


AIRSPY = function(matron, dev, devPlan) {
    console.log("airspy: start");
    Sensor.Sensor.call(this, matron, dev, devPlan);
    // path to the socket that libairspy will use
    // e.g. /tmp/airspy-1:4.sock for a device with usb path 1:4 (bus:dev)
    this.sockPath = "/tmp/airspy-" + dev.attr.usbPath + ".sock";
    // path to libairspy
    this.prog = "/usr/local/bin/airspy_tcp";

    // hardware rate needed to achieve plan rate;
    // same algorithm as used in vamp-alsa-host/AIRSPYMinder::getHWRateForRate
    // i.e. find the smallest exact multiple of the desired rate that is in
    // the allowed range of hardware rates.

    console.log("Airspy device attributes: ", JSON.stringify(dev.attr) )

    console.log("airspy: requested rate of: " + devPlan.plan.rate);

    var rate = devPlan.plan.rate;
    if (rate != 48e3 && rate != 3e6 && rate != 6e6 && rate != 10e6) {
        console.log("airspy: requested rate not within hardware range; using 48000");
        rate = 48e3;
    }

    this.hw_rate = 6e6; // Only rate that is a multiple of 48khz

    // callback closures
    this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    this.this_logServerError   = this.logServerError.bind(this);
    this.this_VAHdied          = this.VAHdied.bind(this);
    this.this_VAHdata          = this.VAHdata.bind(this);
    this.this_serverDied       = this.serverDied.bind(this);
    this.this_serverError      = this.serverError.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    //this.this_cmdSockError     = this.cmdSockError.bind(this);
    this.this_cmdSockClose     = this.cmdSockClose.bind(this);
    //this.this_cmdSockEnd       = this.cmdSockEnd.bind(this);
    this.this_spawnServer      = this.spawnServer.bind(this);

    // handle situation where program owning other connection to libairspy dies
    this.matron.on("VAHdied", this.this_VAHdied);

    // listen to data to adjust gain based on noise level
    this.matron.on("vahData", this.this_VAHdata);

    // storage for the setting list sent by libairspy
    this.replyBuf = ""; // buffer the reply stream, in case it crosses transmission unit boundaries

    // libairspy replies with a 12-byte header, before real command replies; we ignore this
    // as the info is available elsewhere
    this.gotCmdHeader = false;

    this.restart = false; // when true, we're killing the server and want a restart

    this.killing = false; // when true, we've deliberately killed the server

    this.agc_at = 0; // timestamp of last AGC change

    console.log("airspy: created");
};

AIRSPY.prototype = Object.create(Sensor.Sensor.prototype);
AIRSPY.prototype.constructor = AIRSPY;

AIRSPY.prototype.airspytcpCmds = {
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


AIRSPY.prototype.hw_devPath = function() {
    // the device path parsable by vamp-alsa-host/RTLMinder;
    // it looks like rtlsdr:/tmp/airspy-1:4.sock
    // This is because I haven't made a custom vamp-also-host plugin for airspy yet
    return "airspy:" + this.sockPath;
    //return "airspy:" + this.sockPath;
};

AIRSPY.prototype.hw_init = function(callback) {
    //console.log("calling hw_init on airspy");
    this.initCallback = callback;
    this.spawnServer();   // launch the rtl_tcp process
};


AIRSPY.prototype.getSerial = function() {
    const [bus, device] = (this.dev.attr.usbPath || "0:0")
        .split(":")
        .map( x => x.padStart(3, '0') );

    const path = `/dev/bus/usb/${bus}/${device}`;
    let output;

    console.log("Getting serial number for Airspy device at path:", path);
    try {
        output = ChildProcess.execSync(`udevadm info -q all -n ${path}`).toString();
    } catch (err) {
        console.warn(`Failed to get udev info for ${path}:`, err.message);
        return null;
    }


    const serialMatch = output.match(/ID_SERIAL=([^\n]+)/);

    const serial = serialMatch ? serialMatch[1].split(":").pop() : null;   
    console.log("Found serial number:", serial);

    this.serno = serial;

}

AIRSPY.prototype.spawnServer = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
    //console.log("about to delete command socket with path: " + this.sockPath);
    try {
        // Note: node throws on this call if this.sockPath doesn't exist;
        Fs.unlinkSync(this.sockPath);
    } catch (e) {
        //console.log("Error removing command socket: " + e.toString());
    };

    this.getSerial();
    
    
    // set the libusb buffer size so it holds approximately 8 ms of I/Q data
    // We round up to the nearest multiple of 512 bytes, as required by libusb
    var usb_buffer_size = this.hw_rate * 0.008;
    usb_buffer_size = 512 * Math.ceil(usb_buffer_size / 512.0);

    var args = [
        "-p", this.sockPath, 
    //    "-d", this.dev.attr.usbPath, 
        "-S", this.serno,
        "-s", this.hw_rate,
        "-B", usb_buffer_size
    ];
    //var args = ["sockpath: ", this.sockPath, ", tcp_port: ", tcp_port, ", usb_port: ", this.dev.attr.port,  ", hw_rate: ", this.hw_rate, ", buffer_size: ", usb_buffer_size];
    console.log("AIRSPY spawning server: " + this.prog + " " + args.join(" "));
    
    const server = ChildProcess.spawn(this.prog, args, { shell: false });

    server.on("close", this.this_serverDied);
    server.on("error", this.this_serverError);
    server.stdout.on("data", this.this_serverReady);
    server.stderr.on("data", (data) => console.log("AIRSPY server stderr: " + data.toString().trim()));
    server.stderr.on("close", () => console.log("AIRSPY server stderr closed"));
    this.server = server;
};

AIRSPY.prototype.serverReady = function(data) {
    if (this.inDieHandler)
        return;
    console.log("AIRSPY server stdout: " + data.toString().trim());
    if (data.toString().match(/Listening/)) {
        if(this.server) {
            this.server.stdout.removeListener("data", this.this_serverReady);
            this.connectCmd();
        }
    }
};

AIRSPY.prototype.connectCmd = function() {
    // server is listening for connections, so connect
    console.log("AIRSPY connected to libairspy server");
    if (this.cmdSock || this.inDieHandler) {
        console.log("AIRSPY already has command socket connected");
        return;
    }
    //console.log("connecting command socket with path: " + this.sockPath);
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("close" , this.this_cmdSockClose);
    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

// AIRSPY.prototype.cmdSockError = function(e) {
//     if (! e)
//         return;
//     console.log("Got command socket error " + e.toString());
//     if (this.cmdSock) {
//         this.cmdSock.destroy();
//         this.cmdSock = null;
//     }
//     if (this.quitting || this.inDieHandler)
//         return;
//     setTimeout(this.this_hw_stalled, 5001);
// };

// AIRSPY.prototype.cmdSockEnd = function(e) {
//     if (! e)
//         return;
//     console.log("Got command socket end " + e.toString());
//     if (this.cmdSock) {
//         this.cmdSock.destroy();
//         this.cmdSock = null;
//     }
//     if (this.quitting || this.inDieHandler)
//         return;
//     setTimeout(this.this_hw_stalled, 5001);
// };

AIRSPY.prototype.cmdSockClose = function(e) {
    if (!e )
        return;
    console.log("AIRSPY: Got command socket close " + e.toString());
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_hw_stalled, 5001);
};

AIRSPY.prototype.cmdSockConnected = function() {
    // process any queued command
    console.log("AIRSPY: Got command socket connected");
    if (this.initCallback) {
        var cb = this.initCallback;
        this.initCallback = null;
        cb();
    }
};

AIRSPY.prototype.VAHdied = function() {
    this.hw_delete();
};

AIRSPY.prototype.serverError = function(err) {
    console.log("libairspy server got error: " + JSON.stringify(err))
};

AIRSPY.prototype.serverDied = function(code, signal) {
    console.log("libairspy server died, code:" + code + " signal:" + signal)
    this.server = null
    this.close() // in Sensor
    if (!this.killing) {
        console.log("libairspy server died, code:" + code + " signal:" + signal)
        this.matron.emit('devState', this.dev.attr?.port, "error", `libairspy server died, exit code ${code}`)
    }
    // restart if we said so, or the process exited with non-zero status and not due to a signal
    //if (this.restart || (code && !signal)) this.hw_restart();
    if (this.restart || !signal) this.hw_restart();
};

AIRSPY.prototype.hw_delete = function() {
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

AIRSPY.prototype.hw_startStop = function(on) {
    // just send the 'streaming' command with appropriate value
    this.hw_setParam({par:"streaming", val:on?1:0});
    console.log("airspy::hw_startStop = " + on);
};

// hw_restart is called when either data from the device seems to have stalled
// (which can be due to chrony stepping the clock forward) or when libairspy has died
AIRSPY.prototype.hw_restart = function() {
    // pretend the device has been removed then added, this will trigger deletion of all resources
    // and then relaunch of libairspy.
    console.log("airspy::hw_reset - faking a remove & re-add");
    // copy the device structure (really - this is the best node has to offer for cloning POD?)
    var dev = JSON.parse(JSON.stringify(this.dev));
    // re-add after 5 seconds
    setTimeout(function(){TheMatron.emit("devAdded", dev)}, 5000);
    // remove now
    this.matron.emit("devRemoved", this.dev);
};

AIRSPY.prototype.hw_stalled = function() {
    // relaunch libairspy and re-establish connection
    console.log("airspy::hw_stalled");
    this.restart = true
    this.hw_delete()
};

// tune gain to set the noise floor into the -35..-45dB range
AIRSPY.prototype.VAHdata = function(line) {
    if (exports.enableAGC && line.startsWith("p"+this.dev.attr?.port) && Date.now()-this.agc_at > 60_000) {
        // lotek data
        const ll = line.trim().split(',')
        if (ll.length < 6) return
        const noise = parseFloat(ll[4])
        if (!Number.isFinite(noise) || noise > -10 || noise < -1000) return
        if (noise >= -45 && noise <= -35) return
        // should adjust gain, get info together
        var dev = HubMan.getDevs()[this.dev.attr.port];
        
        const tgv = [0,15] // min/max gains, in dB

        if (!Array.isArray(tgv)) return
        const gainProfile = dev?.settings?.gain_profile || {
            lna_gain: 10,
            mixer_gain: 10,
            vga_gain: 5
        };

        if (!Number.isFinite(gain)) return
        let ix
        if (noise > -35) {
            // noise too high, need to turn gain down
            ix = tgv.findLastIndex(v => v < gain)
        } else if (noise < -45) {
            // noise too low, need to turn gain up
            ix = tgv.findIndex(v => v > gain)
        }
        if (noise > -35) {
            // Too noisy — reduce gain
            if (gainProfile.lna_gain > tgv[0]) gainProfile.lna_gain--;
            else if (gainProfile.mixer_gain > tgv[0]) gainProfile.mixer_gain--;
            else if (gainProfile.vga_gain > tgv[0]) gainProfile.vga_gain--;
        } else if (noise < -45) {
            // Too quiet — increase gain
            if (gainProfile.lna_gain < tgv[1]) gainProfile.lna_gain++;
            else if (gainProfile.mixer_gain < tgv[1]) gainProfile.mixer_gain++;
            else if (gainProfile.vga_gain < tgv[1]) gainProfile.vga_gain++;
        }

        if (ix >= 0) {
            console.log(`AIRSPY: adjusting lna_gain for P${this.dev.attr.port} to ${ gainProfile.lna_gain }dB, noise is ${noise}dB`);
            console.log(`AIRSPY: adjusting mixer_gain for P${this.dev.attr.port} to ${ gainProfile.mixer_gain }dB, noise is ${noise}dB`);
            console.log(`AIRSPY: adjusting vga_gain for P${this.dev.attr.port} to ${ gainProfile.vga_gain }dB, noise is ${noise}dB`);

            this.hw_setParam({ par: 'lna_gain', val: gainProfile.lna_gain });
            this.hw_setParam({ par: 'mixer_gain', val: gainProfile.mixer_gain });
            this.hw_setParam({ par: 'vga_gain', val: gainProfile.vga_gain });


            this.agc_at = Date.now();
            FlexDash.set(`airspy_gain/${this.dev.attr.port}`, { ...gainProfile });

        }     
    }
    FlexDash.set('detections_5min', this.detections)
};

/* AIRSPY.prototype.hw_setParam = function(parSetting, callback) {
    // create the 5-byte command and send it to the socket
    var cmdBuf = Buffer.alloc(5);
    var par = parSetting.par, val = parSetting.val;

    // fix up any parameter values to match rtl_tcp semantics

    switch (par) {
    case "frequency":
        // convert from MHz to Hz
        val = Math.round(val * 1.0E6);
        break;
    case "tuner_gain":
        // convert from dB to 0.1 dB
        FlexDash.set(`rtl_sdr_gain/${this.dev.attr.port}`, val)
        val = Math.round(val * 10);
        break;
    case "if_gain1":
    case "if_gain2":
    case "if_gain3":
    case "if_gain4":
    case "if_gain5":
    case "if_gain6":
        // encode gain stage in upper 16 bits of value, convert dB to 0.1 dB in lower 16 bits
        val = ((par.charCodeAt(7)-48) << 16) + Math.round(val * 10);
        break;
    }
    var cmdNo = this.rtltcpCmds[parSetting.par];
    if (cmdNo && this.cmdSock) {
        console.log(`AIRSPY: set parameter ${par} (${cmdNo}) to ${val}`);
        try {
            cmdBuf.writeUInt8(cmdNo, 0);
            cmdBuf.writeUInt32BE(val, 1); // note: rtl_tcp expects big-endian
            this.cmdSock.write(cmdBuf, callback);
        } catch(e) {
            this.matron.emit("setParamError", {type:"airspy", port: this.dev.attr.port, par: par, val:val, err: e.toString()})
        }
    };
}; */
AIRSPY.prototype.hw_setParam = function(parSetting, callback) {
    
    var cmdBuf = Buffer.alloc(5);
    let val = parSetting.val;
    let par = parSetting.par;

    switch (par) {
        case "frequency":
            val = Math.round(val * 1.0E6); // MHz to Hz
            break;
    }

    var cmdNo = this.airspytcpCmds[ par ];
    if (cmdNo && this.cmdSock) {
        console.log(`AIRSPY: set parameter ${par} (${cmdNo}) to ${val}`);
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
    } else {
        console.warn(`Unknown parameter: ${par}`);
    }

    //if (callback) callback();
};


AIRSPY.prototype.logServerError = function(data) {
    console.log("libairspy got error: " + data.toString().trim());
};

AIRSPY.prototype.gotCmdReply = function(data) {

    // airspy_tcp command replies are single JSON-formatted objects on a
    // single line ending with '\n'.  Although the reply should fit in
    // a single transmission unit, and so be completely contained in
    // the 'data' parameter from a single call to this function, we
    // play it safe and treat the replies as a '\n'-delimited stream
    // of JSON strings, parsing each complete string into
    // this.dev.settings


    // skip the 12 byte header
    this.replyBuf += data.toString('utf8', this.gotCmdHeader ? 0 : 12);
    // console.log("gotCmdReply: " + data.toString('utf8', this.gotCmdHeader ? 0 : 12));
    this.gotCmdHeader = true;
    for(;;) {
	var eol = this.replyBuf.indexOf("\n");
	if (eol < 0)
	    break;
        var replyString = this.replyBuf.substring(0, eol);
	    this.replyBuf = this.replyBuf.substring(eol + 1);
        var dev = HubMan.getDevs()[this.dev.attr.port];
        if (dev) {
            
//            console.log("Airspy: got response: ", replyString);

            dev.settings = JSON.parse(replyString);
            for (p in dev.settings) {
                var val = dev.settings[p];
                switch (p) {
                    case "frequency":
                        // convert to MHz from Hz
                        val = val / 1.0E6;
                        break;
                };
                dev.settings[p] = val;
            }
            this.matron.emit('airspyInfo', this.dev.attr?.port, {...dev.settings})
        }
    }
};

exports.AIRSPY = AIRSPY;
exports.enableAGC = enableAGC;
