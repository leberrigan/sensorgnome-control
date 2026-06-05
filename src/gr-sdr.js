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

    this.hw_rate = devPlan.plan.rate; // Only rate that is a multiple of 48khz

//    console.log("GnuRadio: ", JSON.stringify(this))
//   console.log("GnuRadio binding: ", this.grhDied)
    // callback closures
    // this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    // this.this_logServerError   = this.logServerError.bind(this);
    this.this_grhDied          = this.grhDied.bind(this);

    this.matron.on("grhDied", this.this_grhDied);

    console.log("GnuRadio: created");
};

GR_SDR.prototype = Object.create(Sensor.Sensor.prototype);
GR_SDR.prototype.constructor = GR_SDR;


GR_SDR.prototype.getDeviceID = function() {
    // FCD Pro+ is an audio device. Return a compound "USB_PATH:ALSA_CARD" string so the
    // flow graph has both: USB path for `fcd -p` RF tuning, and card number for audio.source.
    if (this.dev.attr.type === "funcubeProPlus") {
        return `${this.dev.attr.usbPath}:${this.dev.attr.alsaDev}`;
    }

    // For all other SDR devices (rtlsdr, airspy, airspyhf): get the hardware serial via
    // udevadm. ID_SERIAL_SHORT is the firmware serial that osmosdr/Soapy accept directly,
    // allowing correct device selection when multiple units of the same type are connected.
    const [bus, device] = (this.dev.attr.usbPath || "0:0")
        .split(":")
        .map(x => x.padStart(3, '0'));
    const path = `/dev/bus/usb/${bus}/${device}`;

    try {
        const output = ChildProcess.execSync(`udevadm info -q all -n ${path}`).toString();
        const shortMatch = output.match(/ID_SERIAL_SHORT=([^\n]+)/);
        if (shortMatch) {
            const serial = shortMatch[1].trim();
            console.log(`GnuRadio device serial (${this.dev.attr.type} @ ${path}):`, serial);
            return serial;
        }
        const serialMatch = output.match(/ID_SERIAL=([^\n]+)/);
        if (serialMatch) {
            const serial = serialMatch[1].trim().split(":").pop();
            console.log(`GnuRadio device serial (fallback) (${this.dev.attr.type} @ ${path}):`, serial);
            return serial;
        }
    } catch (err) {
        console.warn(`Failed to get udev info for ${path}:`, err.message);
    }

    console.warn(`No serial found for ${this.dev.attr.type} on port ${this.dev.attr.port}, using port number`);
    return this.dev.attr.port;
}


GR_SDR.prototype.extractPluginParams = function() {
    for (let param of this.plan.plugins[0].params) {
        this.plan[param.name] = param.value;
    }
    for (let param of this.plan.devParams) {
        this.plan[param.name] = param.schedule.value;
    }
}

GR_SDR.prototype.grhDied = function() {
    this.hw_delete();
};

GR_SDR.prototype.devRemoved = function(dev) {
    // clean up GRH-specific listeners before delegating to base class
    this.matron.removeListener("grhDied", this.this_grhDied);
    // unregister from rate monitoring
    this.matron.emit("grhStartStop", "stop", this.dev.attr.port);
    Sensor.Sensor.prototype.devRemoved.call(this, dev);
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
    // nothing to do here — gnu-radio-host.py manages the subprocess lifecycle,
    // and the close command is sent from sensor.js:close()
};

GR_SDR.prototype.hw_startStop = function(on) {
    // GnuRadio subprocesses stream continuously while alive; no explicit start/stop needed
    console.log("GnuRadio::hw_startStop = " + on + " (no-op)");
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
    console.log("GnuRadio::hw_stalled — restarting device");
    this.hw_restart();
};

GR_SDR.prototype.hw_setParam = function(parSetting, callback) {
    const cmd = `${parSetting.par} ${this.dev.attr.port} ${parSetting.val}`;
    this.matron.emit("grhSubmit", cmd, callback, this);
};


exports.GR_SDR = GR_SDR;
