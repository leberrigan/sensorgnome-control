// burstfinder: manage a burstfinder child process, sending it vahData messages, then
//  emitting bfOut and gotBurst messages.

const Stream = require('stream');

class BurstFinder {
    constructor(matron, prog) {
        this.matron             = matron
        this.prog               = prog
        this.child              = null
        this.quitting           = false

        matron.on("quit", () => this.quit())
        matron.on("vahData", x => this.gotInput(x))
        matron.on("grhData", x => this.gotInput(x))

        this.CMD_PATH = this.prog + "/burstfinder"
        this.CMD_ARGS = [ "-b" ] // stdin->stdout is default; -b enables burst output; codes bundled in executable
        this.CMD_ENV = { PYTHONUNBUFFERED: 1 } // ensure stdout is unbuffered
    }

    start() {
        if (this.quitting) return
        if (this.child) return
    
        // launch the burst finder executable process
        console.log("Starting", this.CMD_PATH, this.CMD_ARGS.join(' '))
        this.child = ChildProcess.spawn(this.CMD_PATH, this.CMD_ARGS, {env:this.CMD_ENV})
            .on("exit", ()=>this.childDied())
            .on("error", ()=>this.childDied())

        this.child.stdout.on("data", x => {
            // console.log("From tagfinder:", x.toString());
            for (let line of x.toString().split('\n')) {
                if (!(/^[0-9]/.test(line))) continue
                console.log("FROM BF: " + line)
                // line = f'{sen:.0f},{ts:.4f},{id:.0f},{freq_mean:.3f},{freq_sd:.3f},{freq_diff:.3f},
                //        {sig_mean:.3f},{sig_sd:.3f},{sig_diff:.3f},{noise_mean:.3f},{interval_diff_max:.5f},
                //        {snr_min:.3f},{used_pulses:.0f},{num_pulses:.0f},{warning:.0f}\n'
                this.matron.emit("bfOut", { text: "b"+line, src:'BF' }) // send raw line to output file
                const text = line
                const ll = line.split(',')
                if (ll.length != 15) {
                    console.log("Invalid burstfinder line:", line)
                    continue
                }
                const info = [ ll[0], ll[1], ll[2] ]
                const burst = {
                    text: line, info, meanFreq: ll[3], sdFreq: ll[4], meanSig: ll[6], sdSig: ll[7],
                    meanNoise:ll[9], minSnr:ll[11], src:'BF',
                }
                this.matron.emit("gotBurst", burst)
                // line = 'L' + line
                // console.log(`Lotek tag: ${line}`)
            }
        })
        this.child.stdout.on("error", x => {})
        
        this.child.stderr.on("data", x => {
            for (let line of x.toString().split('\n')) {
                if (line.trim()) console.log("Burstfinder:", line)
            }
        })
        this.child.stderr.on("error", x => {})
    }

    restart() {
        console.log("Restarting burstfinder")
        if (this.child) {
            this.child.kill("SIGKILL") // childDied() will restart it...
        } else {
            this.start()
        }
    }

    childDied(code, signal) {
        this.child = null
        if (!this.quitting) {
            setTimeout(() => this.start(), 5000)
            console.log("burstfinder died, restarting in 5 secs")
        }
    }

    quit() {
        if (!this.child) return
        this.quitting = true
        this.child.kill("SIGKILL")
    }    

    gotInput(x) {
        if (!this.child) return
        if (typeof x != 'string' || !x.startsWith('p')) return
        try {
            this.child.stdin.write(x.trimStart('p') + '\n')
            console.log("TO BF: " + x.trimStart('p'))
        } catch(e) {
            console.log("Error writing to burstfinder:", e)
        }
    }

}

exports.BurstFinder = BurstFinder
