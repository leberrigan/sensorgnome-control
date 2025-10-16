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
    this.cmdSock = null; // control socket
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
    this.connectCmdTimeout = null;
    this.connectDataTimeout = null;
    this.checkRateTimer = null;
    this.frames = {}; // last frame count&time for each plugin {at: Date.now(), frames:N, bad:N}

    // callback closures
    this.this_childDied        = this.childDied.bind(this);
    this.this_logChildError    = this.logChildError.bind(this);
    this.this_cmdSockConnected = this.cmdSockConnected.bind(this);
    this.this_connectCmd       = this.connectCmd.bind(this);
    this.this_connectData      = this.connectData.bind(this);
    this.this_doneReaping      = this.doneReaping.bind(this);
    this.this_gotCmdReply      = this.gotCmdReply.bind(this);
    this.this_gotData          = this.gotData.bind(this);
    this.this_quit             = this.quit.bind(this);
    this.this_serverReady      = this.serverReady.bind(this);
    this.this_cmdSockProblem   = this.cmdSockProblem.bind(this);
    this.this_dataSockProblem  = this.dataSockProblem.bind(this);
    this.this_spawnChild       = this.spawnChild.bind(this);
    this.this_grhAccept        = this.grhAccept.bind(this);
    this.this_grhSubmit        = this.grhSubmit.bind(this);
    this.this_grhStartStop     = this.grhStartStop.bind(this);

    matron.on("quit", this.this_quit);
    matron.on("grhSubmit", this.grhSubmit);
    matron.on("grhStartStop", this.grhStartStop);
    matron.on("grhAccept", this.grhAccept);

    this.reapOldGRHandSpawn();
}

// sample rate checker parameters
const checkRatesInterval = 10_000; // ms
const maxOutOfBounds = 2; // number of consecutive OOB checks that trigger a reset
const boundsPCT = 5; // nominal +/- bounds percentage



GRH.prototype.childDied = function(code, signal) {
//    console.log("GnuRadio child died\n")
    if (this.inDieHandler)
        return;
    this.inDieHandler = true;
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.dataSock) {
        this.dataSock.destroy();
        this.dataSock = null;
    }
    if (! this.quitting)
        setTimeout(this.this_spawnChild, 5000);
    if (this.connectCmdTimeout) {
        clearTimeout(this.connectCmdTimeout);
        this.connectCmdTimeout = null;
    }
    if (this.connectDataTimeout) {
        clearTimeout(this.connectDataTimeout);
        this.connectDataTimeout = null;
    }
    this.inDieHandler = false;
    this.matron.emit("grhDied")
};

GRH.prototype.reapOldGRHandSpawn = function() {
    ChildProcess.execFile("/usr/bin/killall", ["-KILL", "grh"], null, this.this_doneReaping);
    if (this.checkRateTimer)
        clearInterval(this.checkRateTimer);
};

GRH.prototype.doneReaping = function() {
    this.spawnChild();
};

GRH.prototype.spawnChild = function() {
    if (this.quitting)
        return;
    this.cmdSock = null;
    const args = ["-s", this.sockName];
    
    console.log("GnuRadio launching", this.prog, ...args);
    const child = ChildProcess.spawn(this.prog, args);

    child.on("exit", this.this_childDied);
    child.on("error", this.this_childDied);
    child.stdout.on("data", this.this_serverReady);
    child.stderr.on("data", this.this_logChildError);
    this.child = child;
    this.frames = {};

};

GRH.prototype.cmdSockConnected = function() {
    // process any queued command
    while (this.commandQueue.length) {
        console.log("GnuRadio command (queued): ", JSON.stringify(this.commandQueue[0]));
        this.cmdSock.write( this.commandQueue.shift() );
    }
};

GRH.prototype.serverReady = function(data) {
    this.child.stdout.removeListener("data", this.this_serverReady);
    this.connectCmd();
    this.connectData();
    this.matron.emit("GRHstarted");
};

GRH.prototype.logChildError = function(data) {
    console.log("GnuRadio stderr: " + data.toString().trim());
};

GRH.prototype.connectCmd = function() {
    // server is listening for connections, so connect
    if (this.cmdSock) {
        return;
    }
//    console.log("about to connect command socket\n")
    this.cmdSock = Net.connect(this.sockPath, this.this_cmdSockConnected);
    this.cmdSock.on("error" , this.this_cmdSockProblem);
    this.cmdSock.on("data"  , this.this_gotCmdReply);
};

GRH.prototype.connectData = function() {
    if (this.dataSock) {
        return;
    }
//    console.log("about to connect data socket\n")
    this.dataSock = Net.connect(this.sockPath, function() {});

    this.dataSock.on("error" , this.this_dataSockProblem);
    this.dataSock.on("data"  , this.this_gotData);
}

GRH.prototype.cmdSockProblem = function(e) {
    console.log("GnuRadio: command socket problem " + e.toString());
    if (this.cmdSock) {
        this.cmdSock.destroy();
        this.cmdSock = null;
    }
    if (this.quitting || this.inDieHandler)
        return;
    setTimeout(this.this_connectCmd, 5001);
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
    if (this.cmdSock) {
        for (const c of cmd) {
            if (c != 'list') console.log("GnuRadio command: ", c);
            this.cmdSock.write(c + '\n');
        }
    } else {
        // console.log("GnuRadio about to queue: " + cmd + "\n");
        for (var i in cmd)
            this.commandQueue.push(cmd + '\n');
    }
};


// Submit a start/stop command to grh. Uses grhSubmit to send the command but then remembers
// whether the port is on or off so that the rate check knows whether to expect data.
GRH.prototype.grhStartStop = function (startstop, port, callback, callbackPars) {
    const cmd = startstop + " " + port;
    this.grhSubmit(cmd, callback, callbackPars);
    // info from GnuRadio comes back as 'pN', the 'p' stands for Plugin...
    if (startstop != 'start') {
        delete this.frames['p'+devLabel]; // remove plugin from list being monitored
    }
};


GRH.prototype.gotCmdReply = function (data) {
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

        if (reply.async) {
            // if async field is present, this is not a reply to a command
            console.log("GnuRadio async: ", JSON.stringify(reply));
            this.matron.emit(reply.event, reply.devLabel, reply);
        } else {
            // deal with the new reply
            var handler = this.replyHandlerQueue.shift();

            if (!handler)
                continue;
            if (handler.callback)
                handler.callback(reply, handler.par);
        }
    }
};

GRH.prototype.grhAccept = function(pluginLabel) {
    // indicate that GnuRadio should accept data from the specified plugin
    if (this.dataSock) {
        console.log("GnuRadio asking to receive " + pluginLabel);
        this.dataSock.write("receive " + pluginLabel + "\n");
        this.frames[pluginLabel] = { at: Date.now(), frames: null, bad: 0 };
    }
};



GRH.prototype.gotData = function(data) {
    this.dataBuf += data.toString();
    const lines = this.dataBuf.split('\n');
    this.dataBuf = lines.pop();
    //for (const l of lines) console.log("grData:", l)
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

var logRateCnt = 0;

GRH.prototype.checkRatesReply = function(reply) {
    // NOTE: `p` in this function refers to a value like `p2` where the `p` really stands for
    // GnuRadio Plugin, but `p` is also used as Port designator here. The use of the same letter is
    // actually a coincidence. It works, but not great.
    // check that all the plugins are producing data at the correct rate
    const now = Date.now()
    const minFct = 1 - boundsPCT/100
    const maxFct = 1 + boundsPCT/100
    console.log("GnuRadio rates: ", JSON.stringify(reply, null, 2));
    //console.log(`GnuRadio frames: ${JSON.stringify(this.frames, null, 2)}`);
    for (const p in this.frames) {
        const fp = this.frames[p];
        if (p in reply) {
            var info = reply[p];
            if (info.type != 'PluginRunner') {
                console.log(`GnuRadio checkRates: ${p} is not a plugin? ${JSON.stringify(info)}`);
                continue;
            }
            // console.log(`GnuRadio info for ${p} at ${now} (dt=${now-fp.at}): ${JSON.stringify(info, null, 2)}`);
            this.matron.emit("grhFrames", p, now, info.totalFrames);
            // if fp.frames is null it just started and we don't have an initial frame count, so
            // get that (we used to set frames to 0 when starting but it takes a long time to actually
            // start and that caused low frame rates)
            if (fp.frames === null) {
                this.frames[p] = { ...fp, at: now, frames: info.totalFrames };
                continue;
            }
            // calculate the rate
            const dt = now - fp.at;
            if (dt < checkRatesInterval*0.9) continue; // too soon to calculate stable rate
            const df = info.totalFrames - fp.frames;
            const rate = df / dt * 1000;
            this.matron.emit("grhRate", p, now, rate);
            // OK or not?
            const ok = rate > info.rate*minFct && rate < info.rate*maxFct;
            if (!ok || logRateCnt++ < 100)
                console.log(`GnuRadio rate for ${p}: nominal ${info.rate}, actual ${rate.toFixed(0)} frames/sec`);
            if (!ok) fp.bad++; else fp.bad = 0;
            if (fp.bad >= maxOutOfBounds) {
                const msg = `GnuRadio rate for ${p} is out of range: nominal ${info.rate}, actual ${rate.toFixed(0)} frames/sec`
                console.log(msg);
                this.matron.emit("devStalled", p, msg);
                fp.bad = 0; // reset count so we don't continuously signal devStalled
            }
            // Update the current frame count for the next check
            this.frames[p] = { ...fp, at: now, frames: info.totalFrames };
        } else if (fp.frames > 0 || Date.now() - fp.at > checkRatesInterval*0.9) {
            // plugin has died
            console.log(`GnuRadio plugin ${p} has died`);
            this.matron.emit("devStalled", p, `port ${p} is not producing data`);
        }
    }
};

module.exports = GRH;
