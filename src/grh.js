/*
    Gnu Radio

    Handles radios thru osmocom/audio input, data acquisition, and pulse detection via gnuradio-sg-adapter.py


    Framework looks like this:
        - sg-control spawns a python wrapper for gnuradio and connects to it via gnuradio.sock
        - sg-control sends commands to the wrapper via gnuradio.sock whenever a new device connects, setting the frequency and sample rate.
        - the wrapper spawns a subprocess which is a gnuradio flow graph each time sg-control tells it about a new device connecting using the parameters sg-control tells it about (frequency, device type, sample rate, device port number).
        - The wrapper kills the subprocess when sg-control tells it the device has disconnected
        - The wrapper receives data from the flow graph and sends it to sg-control.

*/

GRH = function(matron, prog, sockName) {

    this.matron = matron;
    this.prog = prog;
    this.sockName = sockName;
    this.sockPath = "/tmp/" + sockName;
    this.sock = null; // control socket
    this.dataSock = null; // data socket
    this.child = null; // child process
    this.replyHandlerQueue = []; // list of reply handlers in order of commands being sent out
                                 // each handler is an object with these fields:
                                 // callback: function(reply, par) to call with reply and extra parameter
                                 // par:  extra parameter for callback
                                 // n: number of times to use this handler

    this.commandQueue = []; // list of commands queued before command connection is established
    this.replyBuf = "";
    this.dataBuf = "";
    this.quitting = false;
    this.inDieHandler = false;
    this.connectTimeout = null;
    this.connectDataTimeout = null;
    this.checkRateTimer = null;
    this.frames = {}; // last frame count&time for each plugin {at: Date.now(), frames:N, bad:N}

    // mirrors Acquisition.gnuradio_enabled; controls whether the subprocess is allowed to run
    this.gnuradioActive = !!(typeof Acquisition !== 'undefined' && Acquisition.gnuradio_enabled);

    // callback closures
    this.this_childDied        = this.childDied.bind(this);
    this.this_logChildError    = this.logChildError.bind(this);
    this.this_sockConnected    = this.sockConnected.bind(this);
    this.this_connect          = this.connect.bind(this);
    this.this_connectCmd       = this.connect.bind(this);
    this.this_connectData      = this.connect.bind(this);
    this.this_doneReaping      = this.doneReaping.bind(this);
    this.this_gotReply         = this.gotReply.bind(this);
    this.this_gotCmdReply      = this.gotReply.bind(this);
    this.this_gotData          = this.gotData.bind(this);
    this.this_quit             = this.quit.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    this.this_sockProblem      = this.sockProblem.bind(this);
    this.this_dataSockProblem  = this.sockProblem.bind(this);
    this.this_spawnChild       = this.spawnChild.bind(this);
    this.this_grhAccept        = this.grhAccept.bind(this);
    this.this_grhSubmit        = this.grhSubmit.bind(this);
    this.this_grhStartStop     = this.grhStartStop.bind(this);

    matron.on("quit", this.this_quit);
    matron.on("grhSubmit", this.this_grhSubmit);
    matron.on("grhStartStop", this.this_grhStartStop);
    matron.on("grhAccept", this.this_grhAccept);
    matron.on("gnuradioEnabled", (enabled) => this.setEnabled(enabled));

    this.reapOldGRHandSpawn();
}

// sample rate checker parameters
const checkRatesInterval = 10_000; // ms
const maxOutOfBounds = 2; // number of consecutive OOB checks that trigger a reset
const boundsPCT = 5; // nominal +/- bounds percentage



GRH.prototype.childDied = function(code, signal) {
    console.log("GnuRadio Child Died! ", code)
//    console.log("GnuRadio child died\n")
    if (this.inDieHandler)
        return;
    this.inDieHandler = true;
    if (this.sock) {
        this.sock.destroy();
        this.sock = null;
    }
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (!this.quitting && this.gnuradioActive)
        setTimeout(this.this_spawnChild, 5000);
    if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
    }
    if (this.connectDataTimeout) {
        clearTimeout(this.connectDataTimeout);
        this.connectDataTimeout = null;
    }
    this.inDieHandler = false;
    this.matron.emit("grhDied")
};

GRH.prototype.reapOldGRHandSpawn = function() {
    if (this.checkRateTimer)
        clearInterval(this.checkRateTimer);
    // Kill the host wrapper, then kill any orphaned flowgraph subprocesses (gr_rtlsdr.py,
    // gr_funcubepp.py, etc.). killall -KILL grh orphans these; they keep USB devices locked.
    ChildProcess.execFile("/usr/bin/killall", ["-KILL", "grh"], null, () => {
        ChildProcess.execFile("/usr/bin/pkill", ["-KILL", "-f", "/usr/bin/gr_"], null, this.this_doneReaping);
    });
};

GRH.prototype.doneReaping = function() {
    this.spawnChild();
};

GRH.prototype.setEnabled = function(enabled) {
    this.gnuradioActive = !!enabled;
    if (enabled) {
        if (!this.child) this.reapOldGRHandSpawn();
    } else {
        if (this.child) this.child.kill("SIGTERM");
    }
};

GRH.prototype.spawnChild = function() {
    if (this.quitting || !this.gnuradioActive)
        return;
    this.sock = null;
    const args = ["/usr/bin/gnu-radio-host.py", "-s", this.sockPath];
    
    console.log("GnuRadio launching", this.prog, ...args);
    const child = ChildProcess.spawn(this.prog, args);

    child.on("exit", this.this_childDied);
    child.on("error", this.this_childDied);
    child.stdout.on("data", this.this_serverReady);
    child.stderr.on("data", this.this_logChildError);
    this.child = child;
    this.frames = {};

};

GRH.prototype.sockConnected = function() {
    // process any queued command
    while (this.commandQueue.length) {
        console.log("GnuRadio command (queued): ", JSON.stringify(this.commandQueue[0]));
        this.sock.write( this.commandQueue.shift() );
    }
    if (!this.checkRateTimer)
        this.checkRateTimer = setInterval(() => this.checkRates(), checkRatesInterval);
};

GRH.prototype.serverReady = function(data) {
    console.log("GnuRadio server ready");
    this.child.stdout.removeListener("data", this.this_serverReady);
    this.connect();
//    this.connectData();
    this.matron.emit("GRHstarted");
};

GRH.prototype.logChildError = function(data) {
    console.log("GnuRadio stderr: " + data.toString().trim());
};

GRH.prototype.connect = function() {
    // server is listening for connections, so connect
    if (this.sock) {
        return;
    }
//    console.log("about to connect command socket\n")
    this.sock = Net.connect(this.sockPath, this.this_sockConnected);
    this.sock.on("error" , this.this_sockProblem);
    this.sock.on("data"  , this.this_gotReply);
};

/* GRH.prototype.connectData = function() {
    if (this.dataSock) {
        return;
    }
//    console.log("about to connect data socket\n")
    this.dataSock = Net.connect(this.sockPath, function() {});

    this.dataSock.on("error" , this.this_dataSockProblem);
    this.dataSock.on("data"  , this.this_gotData);
} */

GRH.prototype.sockProblem = function(e) {
    console.log("GnuRadio: command socket problem " + e.toString());
    if (this.sock) {
        this.sock.destroy();
        this.sock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_connect, 5001);
};

GRH.prototype.dataSockProblem = function(e) {
    console.log("GnuRadio: data socket problem " + e.toString());
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_connectData, 5001);
};


// Submit a command to grh and register a callback for the reply
GRH.prototype.grhSubmit = function (cmd, callback, callbackPars) {
    // add the callback to the reply queue and issue the command; if there are multiple commands,
    // send all replies to the callback with a single call.
    // Also, if callback is null, the command is assumed not to return a reply.
    if (!Array.isArray(cmd))
        cmd = [cmd];
    if (callback)
        this.replyHandlerQueue.push({callback: callback, par: callbackPars});
    if (this.sock) {
        for (const c of cmd) {
            if (c != 'list') console.log("GnuRadio command: ", c);
            this.sock.write(c + '\n');
        }
    } else {
        // console.log("GnuRadio about to queue: " + cmd + "\n");
        for (var i in cmd)
            this.commandQueue.push(cmd[i] + '\n');
    }
};


// Submit a start/stop command to grh. Uses grhSubmit to send the command but then remembers
// whether the port is on or off so that the rate check knows whether to expect data.
GRH.prototype.grhStartStop = function (startstop, port, callback, callbackPars) {
    const cmd = startstop + " " + port;
    this.grhSubmit(cmd, callback, callbackPars);
    // info from GnuRadio comes back as 'pN', the 'p' stands for Plugin...
    if (startstop != 'start') {
        delete this.frames['p'+port]; // remove plugin from list being monitored
    }
};


GRH.prototype.gotReply = function (data) {
    // vamp-alsa-host replies are single JSON-formatted strings on a single line ending with '\n'
    // if multiple commands are submitted with a single call to grhSubmit,
    // their replies are returned in an array with a single call to the callback.
    // Otherwise, the reply is sent bare (i.e. not in an array of 1 element).
    this.replyBuf += data.toString();
    // console.log("GnuRadio replied: " + data.toString());
    for(;;) {
        var eol = this.replyBuf.indexOf("\n");
        if (eol < 0) break;
        var replyString = this.replyBuf.substring(0, eol);
	    this.replyBuf = this.replyBuf.substring(eol + 1);

        if (replyString.length == 0)
            continue;

	    var reply = JSON.parse(replyString);

        if (reply.status == "data") {
//            console.log(reply.data)
            this.this_gotData( reply.data );
            continue;
        }
        if (reply.async) {
            // if async field is present, this is not a reply to a command
            console.log("GnuRadio async: ", JSON.stringify(reply));
            this.matron.emit(reply.event, reply.devLabel, reply);
        } else {
            // deal with the new reply
            var handler = this.replyHandlerQueue.shift();

            if (!handler)
                continue; // discard stale/unhandled replies (e.g. post-close subprocess noise)
            console.log("GnuRadio reply: ", reply);
            if (handler.callback)
                handler.callback(reply, handler.par);
        }
    }
};

GRH.prototype.grhAccept = function(pluginLabel) {
    // register this port for rate/alive monitoring
    console.log("GnuRadio registering for monitoring: " + pluginLabel);
    this.frames[pluginLabel] = { at: Date.now(), bad: 0 };
};



GRH.prototype.gotData = function(data) {
    this.dataBuf += data.toString();
    const lines = this.dataBuf.split('\n');
    this.dataBuf = lines.pop();
    for (const l of lines) this.matron.emit("grhData", l);
};

GRH.prototype.quit = function() {
    this.quitting = true;
    this.child.kill("SIGKILL");
    };

GRH.prototype.getRawStream = function(devLabel, rate, doFM) {
    // return a readableStream which will produce raw output from the specified device, until the socket is closed
    var rawSock = Net.connect(this.sockPath, function(){});
    rawSock.stop = function() {rawSock.write("rawStreamOff " + devLabel + "\n"); rawSock.destroy();}

    rawSock.start = function() {rawSock.write("rawStream " + devLabel + " " + rate + " " + doFM + "\n")};
    return rawSock;
};

GRH.prototype.checkRates = function() {
    this.grhSubmit("list", reply => this.checkRatesReply(reply));
};

GRH.prototype.checkRatesReply = function(reply) {
    // reply is {"p3": {"alive": true, "pid": 12345}, ...} from gnu-radio-host.py
    for (const p in this.frames) {
        const fp = this.frames[p];
        if (p in reply) {
            if (!reply[p].alive) {
                const msg = `GnuRadio subprocess for ${p} has died`;
                console.log(msg);
                this.matron.emit("devStalled", p, msg);
                delete this.frames[p];
            }
        } else {
            // port registered locally but not known to GRH — only flag after one full interval
            if (Date.now() - fp.at > checkRatesInterval) {
                const msg = `GnuRadio subprocess for ${p} is not in device list`;
                console.log(msg);
                this.matron.emit("devStalled", p, msg);
                delete this.frames[p];
            }
        }
    }
};

module.exports = GRH;
