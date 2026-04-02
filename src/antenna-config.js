

const SERVER = 'https://motus.org'
const URL_RECEIVERS = '/api/receivers/deployments'
const URL_ANTENNAS = '/api/receivers/antennas'

// get station deployment info from the Motus API
async function getStationMetadata(ENDPOINT) {
    if (typeof ENDPOINT !== "string" || ENDPOINT.length < 2) throw new Error("Invalid endpoint selected: ", ENDPOINT)
    // Motus API requests need to have a timestamp...
    const date = (new Date()).toISOString().replace(/[-:T]/g,'').replace(/\..*/,'')
    const query = JSON.stringify({date, serialNo: Machine.machineID})
    const resp = await centra(SERVER+ENDPOINT, 'GET')
        .query({json: query})
        .timeout(20*1000)
        .send()
    if (resp.statusCode == 200) {
        const j = await resp.json()
        //console.log("Receiver info:", JSON.stringify(j))
        let deployment = { status: 'unknown', project: 460, name: null, antennas: [] }
        for (const r of j.data || []) {
            if (r.receiverID == Machine.machineID) {
                if (r.deploymentStatus == "active" || !deployment.project) {
                    deployment = {
                        status: r.deploymentStatus,
                        project: r.recvProjectID,
                        deployment: r.deploymentName,
                    }
                    console.log("Motus deployment info: " + JSON.stringify(deployment))
                }
            }
        }
        return deployment
    }
    throw new Error(`Unexpected status ${resp.statusCode} query: ${query}`)
}

class AntennaConfig {
    constructor(matron, configfile) {
        this.matron = matron
        this.configfile = configfile
        this.info = false;
        this.online = false; // Whether the station has internet access

        //this.session = null // session cookie
        this.config = {
            lastUpdated: false,
            sgid: Machine.machineID,
            sgkey: Machine.machineKey,
            session_token: null,
            antennas: []
        }

        // start when there is internet
        if (!WifiMan.motus_status == "OK") {
            this.getStationInfo();
        } else {
            this.matron.emit("netMotus", status)
            matron.once('netMotus', this.checkInetStatus);
        }
//        setInterval(()=>this.matron.emit("antennaConfig", this.config), )
    }

    checkInetStatus(status) {
        const update = this.config.lastUpdated < new Date() - 24*60*60*1e3
        if (status == "OK" && update) {
            this.getStationInfo();
        } else if (update) {
            matron.once('netMotus', this.checkInetStatus)
        } else {
            setTimeout( this.getStationInfo, 24*60*60*1e3 ); // Check again in a day if it's already up to date
        }
    }

    async getStationInfo() {
        const deployment = await getStationMetadata( URL_RECEIVERS );
        const antennas = await getStationMetadata( URL_ANTENNAS );
        deployment.antennas = antennas;
        this.matron.emit('motusRecv', deployment)
        if (!deployment.project) throw new Error("Receiver not registered with a project")
        this.config.antennas = antennas;
        this.matron.emit("antennaConfig", antennas);
    }
}


module.exports = { AntennaConfig }
