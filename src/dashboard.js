// dashboard - Event listeners and formatters for the web dashboard
// Copyright ©2021 Thorsten von Eicken, see LICENSE

const AR = require('archiver')
const Path = require('path')
const CP = require('child_process')
//const Pam = require('authenticate-pam')
const Fs = require('fs')
const crypto = require('crypto')
const TimeSeries = require('./timeseries.js')


const top100k = Fs.readFileSync("/opt/sensorgnome/web-portal/top-100k-passwords.txt").toString().split('\n')

const TAGDBFILE   = "/etc/sensorgnome/SG_tag_database.sqlite" // FIXME: needs to come from main.js...
const wifi_hotspot = "/opt/sensorgnome/wifi-button/wifi-hotspot.sh"
const remote_access = "/etc/sensorgnome/remote.json"
const SixfabUpsHat = "/opt/sensorgnome/ups-hat/ups_manager.py"
const vnstat = "/usr/bin/vnstat"
const ts_dir = "/data/ts"

const LotekFreqs = [ 166.380, 150.100, 150.500 ]

// Returns a hex colour sweeping red→amber→green across the gauge's dBm range.
// flexdash 0.4.90's color2hhex() only handles hex and Vuetify named colours, not hsl().
function signalColor(dbm, min, max) {
    if (dbm == null) return '#9E9E9E'
    const t = Math.max(0, Math.min(1, (dbm - min) / (max - min)))
    const h = t * 120, s = 0.7, l = 0.4
    const a = s * Math.min(l, 1 - l)
    const f = n => {
        const k = (n + h / 30) % 12
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
        return Math.round(255 * c).toString(16).padStart(2, '0')
    }
    return `#${f(0)}${f(8)}${f(4)}`
}

// The Dashboard class communicates between the web UI (FlexDash) and the "core" processing,
// mainly using the "Matron" event system. It consists of a number of handlers divided into two
// groups: the "handleSomeEvent" handlers that react to Matron events and propagate the data to
// the dashboard, and the "handle_dash_some_event" handlers that react to user input events
// from the dashboard and cause some changes to occur.
class Dashboard {

    constructor(matron) {
        this.matron = matron

        // ===== Event listeners
        for (const ev of [
            // normal events funneled through matron (i.e. from app)
            'gotGPSFix', 'chrony', 'gotTag', 'setParam', 'setParamError', 'devAdded', 'devRemoved',
            'df', 'sdcardUse', 'vahData', 'grhData', 'netDefaultRoute', 'netInet', 'netMotus', 'netWifiState',
            'netHotspotState', 'netWifiConfig', 'portmapFile', 'tagDBInfo', 'motusRecv',
            'motusUploadResult', 'netDefaultGw', 'netDNS', 'lotekFreq', 'netCellState', 'netCellReason', "netScanStatus",
            'netCellInfo', 'netCellConfig', 'cttRadioVersion', 'digibabelRadioVersion', 'vahRate', 'vahFrames', 'devState',
            'rtlInfo', 'acquisition', 'gotBurst','airspyInfo',
            "enpi_light_status", "enpi_air_status", "enpi_light_toggle", "enpi_air_toggle","enpi_air_gotData","enpi_light_gotData",
            'enpi_status', 'enpi_sample_rate','enpi_sample_schedule','enpi_aws_buket_name', 'enpi_upload_status',
            'enpi_upload_log','enpi_upload_gotData','enpi_update_log', 'enpi_version',
            'enpi_provisioning_status', 'enpi_provisioning_info',
            
            // dashboard events triggered by a message from FlexDash
            'dash_enpi_toggle','dash_enpi_sample_rate','dash_enpi_sample_schedule','dash_enpi_download',
            'dash_enpi_force_upload','dash_enpi_upload_config', 'dash_enpi_provision',
            'dash_download', 'dash_upload', 'dash_deployment_update', 'dash_enable_wifi',
            'dash_enable_hotspot', 'dash_config_wifi', 'dash_update_portmap', 'dash_creds_update',
            'dash_upload_tagdb', 'dash_df_enable', 'dash_df_tags', 'dash_software_reboot',
            'dash_software_enable', 'dash_software_check', 'dash_software_upgrade',
            'dash_allow_shutdown', 'dash_software_shutdown', 'dash_software_restart',
            'dash_download_logs', 'dash_lotek_freq_change', 'dash_config_cell', 'dash_toggle_train',
            'dash_remote_cmds', 'dash_detection_range', 'dash_alter_bootCount', 'dash_enable_agc',
            "dash_enpi_air_toggle", "dash_enpi_light_toggle", "dash_enpi_detection_range", "dash_enpi_secrets_file",
            'dash_enpi_update',
            'dash_show_pulses', 'dash_cellular_priority', 'dash_burstfinder_burst',
            'dash_burstfinder_filter_file', 'dash_burstfinder_filter_ui',
            'dash_burstfinder_method', 'dash_cell_debug', 'dash_cell_scan',
            'dash_scan_carriers', 'dash_scan_carriers_enable',
            'netCellSeenImsi', 'netCellBadImsi', 'dash_cell_bad_imsi',
            'netCellSignal', 'netWifiSignal', 'dash_enable_cell', 'netWifiIP',
            'netWifiNetworks', 'netWifiScanEnabled', 'netCellICCID', 'dash_cellular_iccid_show',
            'dash_wifi_networks_scan',
            'dash_wifi_connect_ssid', 'dash_wifi_connect_password', 'dash_wifi_connect'
        ]) {
            this.matron.on(ev, (...args) => {
                let fn = 'handle_'+ev
                try {
                    if (!(fn in this)) console.log("Missing Dashboard handler:", ev)
                    else if (args.length <= 1) this[fn](...args)
                    else this[fn](...args)
                } catch(e) {
                    console.log(`Handler ${fn} failed:`, e)
                }
            })
        }

        // keep track of data file summary stats
        matron.on("data_file_summary", (stats) => FlexDash.set('data_file_summary', stats))
        matron.on("detection_stats", (hourly, daily) => this.updateDetectionStats(hourly, daily))

        // 5 minutes of detections in 10 second bins for sparklines
        this.detections = {
            ctt: Array(5*6).fill(null),
            lotek: Array(5*6).fill(null)
        }
        this.detection_log = []

        // direction finding log
        this.df_enable = false
        this.df_tags = {tag1: "1.1", tag2: '78664c3304'}
        this.df_log = []

        // time-series
        this.ts = {}
        this.tsRefreshInterval = null
        Fs.mkdirSync(ts_dir, {recursive: true})
        this.handle_dash_detection_range(TimeSeries.ranges[0])
        setInterval(() => this.tsSave(), 60000)

        this.pulse_ts = [] // timestamp of last pulse per port

        // prime some data
        setTimeout(() => {
            this.handle_motusRecv({})
            this.handle_devState()
            this.handle_acquisition(Acquisition)
        }, 1000)

        console.log("Dashboard handlers registered")
    }
    
    start() {
        // register download handler with FlexDash
        FlexDash.registerGetHandler("/data-download/:what", (req, res) => this.data_download(req, res))
        FlexDash.registerGetHandler("/logs-download/:what", (req, res) => this.logs_download(req, res))

        setInterval(() => this.detectionShifter(), 10000)

        //setInterval(() => this.tsGenRandom(), 8300)

        // set (relatively) static data
        this.setDeployment()
        FlexDash.set('acquisition', JSON.stringify(Acquisition, null, 2))
        FlexDash.set('net_hotspot_ssid', Machine.machineID)
        this.setDashCreds({ current_password: "?????????", new_password: "", confirm_new_password: ""})
        this.setRemoteManagement()

        // some static machine info
        FlexDash.set('machineinfo', Machine)
        setTimeout(()=>FlexDash.set('machineinfo', Machine), 15000) // sdCardSize comes delayed
        FlexDash.set('software/enable', false)
        FlexDash.set('software/enable_upgrade', false)
        FlexDash.set('software/enable_shutdown', false)
        this.allow_poweroff = false
        FlexDash.set("software/available", "Not yet checked...")
        FlexDash.set("software/log", "- empty -")
        this.setDashTrain()
        this.getUptime()
        this.matron.on("gpsSetClock", () => this.getUptime())

        // direction finding info is not saved between restarts...
        FlexDash.set('df_enable', 'OFF')
        FlexDash.set('df_tags', this.df_tags)
        FlexDash.set('df_log', "")
        FlexDash.set('rtl_sdr_gain', {})
        FlexDash.set('airspy_gain', {})
        FlexDash.set('lotek_show_pulses', "on")
        this.show_pulses = true
        FlexDash.set('cellular/iccid', '**********************')
        FlexDash.set('wifi/connect/enabled', false)
        FlexDash.set('wifi/ssid', 'No network')

        FlexDash.monitoring = this.monitoring.bind(this)

        //this.startUpsHatUpdater()

        setTimeout(() => this.updateNetUsage(), 10*1000)
        setInterval(() => this.updateNetUsage(), 300*1000)
        
    }
    
    getUptime() {
        let uptime = parseInt(Fs.readFileSync("/proc/uptime").toString(), 10)
        if (!(uptime > 0)) uptime = 0
        FlexDash.set('boot_time', Date.now() / 1000 - uptime)
    }
    
    // generate info about a device, called on devAdded
    genDevInfo(dev) {
        var info = {
            port: dev.attr.port,
            port_path: (dev.attr["port_path"] || "--").replace(/\_/g, '.'),
            type: dev.attr.type,
        }
        // switch (dev.attr.type) {
        // case "gps": info.attr = dev.attr.kind; break
        // case "CTT/CornellRcvr": info.attr = "433Mhz"; break
        // case "funcubeProPlus": info.attr = "?Mhz"; break
        // case "funcubePro": info.attr = "?Mhz"; break
        // case "rtlsdr": info.type = dev.attr.prod; info.attr = "?Mhz"; break
        // }
        return info
    }

    handle_rtlInfo(port, info) {
        if (port && info?.tuner_type) {
            FlexDash.set(`devices/${port}/type`, 'rtlsdr/'+info.tuner_type)
        }
    }

    handle_airspyInfo(port, info) {
        if (port && info?.tuner_type) {
            FlexDash.set(`devices/${port}/type`, 'airspy/'+info.tuner_type)
        }
    }
    handle_dash_alter_bootCount(obj) {
        if (!obj?.bootCount) return
        const bc = parseInt(obj.bootCount)
        if (bc < 1 || bc > 1000) return
        console.log("Setting bootCount to", bc)
        Machine.bootCount = bc
        FlexDash.set('machineinfo', Machine)
        Fs.writeFileSync("/etc/sensorgnome/bootcount", bc.toString() + '\n')
    }

    // update the number of radios connected on devAdded/Removed
    updateNumRadios() {
        return {
            ctt: Object.values(HubMan.devs).filter(d => d.attr?.radio.startsWith("CTT") || d.attr?.radio == "DigiBabel").length,
            vah: Object.values(HubMan.devs).filter(d => ["VAH", "GRH"].includes( d.attr?.radio) ).length,
        //    grh: Object.values(HubMan.devs).filter(d => d.attr?.radio == "GRH").length,
            sensors: Object.values(HubMan.devs).filter(d => d.attr?.radio == "none").length,
            all: Object.values(HubMan.devs).filter(d => d.attr?.radio && d.attr?.radio != "none" ).length,
            // bad: radios with invalid port
            bad: Object.keys(HubMan.devs).filter(p => (p < 0 || p > 20) && HubMan.devs[p].attr?.radio).length,
        }
    }

    // update the state of all the radios, triggered by devAdded/Removed and also devState
    handle_devState() {
        setTimeout(() => { // give HubMan a chance to process the devState event first
            const green = "#4CAF50", red = "#F44336", yellow = "#FFC107"
            let color = green, cnt = 0, text = []
            for (const dev of Object.values(HubMan.devs).filter(dev => dev.attr?.radio != "none")) {
                switch (dev.state) {
                case "running":
                    text.push(`port ${dev.attr?.port} is running OK`)
                    break;
                case "init":
                    if (color == green) color = yellow
                    cnt++
                    text.push(`port ${dev.attr?.port} is initializing`)
                    break;
                case "error":
                    color = red
                    cnt++
                    text.push(`port ${dev.attr?.port}: "${dev.msg}"`)
                    break;
                default:
                    if (color == green) color = yellow
                    cnt++
                    text.push(`port ${dev.attr?.port}: ${dev.state}`)
                    break;
                }
                if (dev.attr?.radio < 1 || dev.attr?.radio > 10) {
                    color = red
                    cnt++
                    text.push(`port ${dev.attr?.port}: invalid port, must be in range [1..10]`)
                }
            }
            text = cnt > 0 ? text.join('\n\n') : ''
            const title = cnt>0 ? `${cnt} errors` : '--'
            //console.log("Radio state:", JSON.stringify({ color, enabled: cnt>0, title, text }))
            FlexDash.set('radio_state', { color, enabled: cnt>0, errors: cnt, title, text }) // title doesn't work :-(
        }, 10)
    }
    
    handle_gotGPSFix(fix) { FlexDash.set('gps', fix) } // {lat, lon, alt, time, state, ...}
    handle_chrony(info) { FlexDash.set('chrony', info) } // {rms_error, time_source}
    handle_df(info) { FlexDash.set('df', info) } // {source, fstype, size, used, use%, target}
    handle_sdcardUse(pct) { FlexDash.set('sdcard_use', pct) }
    handle_setParam(info) { } // FlexDash.set('param', info) } // {param, value, error}
    handle_setParamError(info) { } // FlexDash.set('param', info) } // {param, error}
    handle_devAdded(info) {
        FlexDash.set(`devices/${info.attr.port}`, this.genDevInfo(info))
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsAddDevice(info)
        this.handle_devState()
    }
    handle_devRemoved(info){
        FlexDash.unset(`devices/${info.attr.port}`)
        FlexDash.set(`radios`, this.updateNumRadios())
        this.tsRemoveDevice(info)
        this.handle_devState()
    }
    handle_digibabelRadioVersion(info) {
        const v = info.version.replace(/\..*/, '')
        FlexDash.set(`devices/${info.port}/type`, 'DigiBabel.v' + v)
    }
    handle_cttRadioVersion(info) {
        const v = info.version.replace(/\..*/, '')
        FlexDash.set(`devices/${info.port}/type`, 'CTTv' + v)
    }
    handle_portmapFile(txt) { FlexDash.set('portmap_file', txt) }
    handle_dash_update_portmap(portmap) { HubMan.setPortmap(portmap) }
    handle_tagDBInfo(data) { FlexDash.set('tagdb', data) }
    handle_motusUploadResult(data) { FlexDash.set('motus_upload', data) }
    handle_lotekFreq(f) { FlexDash.set('lotek_freq', f) }
    handle_dash_show_pulses(v) {
        FlexDash.set('lotek_show_pulses', v=="on" ? "on" : "off")
        this.show_pulses = v == "on"
    }

    handle_acquisition(config) {
        // update burstfinder config elements
        FlexDash.set('burstfinder',
            Object.fromEntries(Object.entries(config.burstfinder).map((
                [k,v]) => [k, v==true?"on":v==false?"off":v]
        ))
        )
    }
    handle_dash_burstfinder_method(v) { 
        if (['burstfinder','pulsefilter'].includes(v)) this.updateBFConfig("method", v)
    }
    handle_dash_burstfinder_filter_file(v) { this.updateBFConfig("filter_file", v=="on") }
    handle_dash_burstfinder_filter_ui(v) { this.updateBFConfig("filter_ui", v=="on") }
    updateBFConfig(key, value) {
        const burstfinder = { ...Acquisition.burstfinder, [key]: value }
        Acquisition.update({ burstfinder })
    }

    // ===== Network / Internet

    // events from WifiMan, propagate to the UI
    handle_netInet(status) { FlexDash.set('net_inet_status', status) }
    handle_netMotus(status) { FlexDash.set('net_motus_status', status) }
    handle_netDefaultRoute(state) { FlexDash.set('net_default_route', state || "none") }
    handle_netDefaultGw(state) { FlexDash.set('net_default_gw', state) }
    handle_netDNS(state) { FlexDash.set('net_dns', state) }
    handle_netHotspotState(state) { FlexDash.set('net_hotspot_state', state || "??") }
    handle_netWifiState(state) {
        FlexDash.set('net_wifi_state', state || "??")
        FlexDash.set('net_wifi_enabled', state != "INACTIVE" ? "ON" : "OFF")
    }
    handle_netWifiConfig(config) {
        config = Object.fromEntries(['country','ssid','passphrase'].map(k=>[k,config[k]]))
        config.passphrase = "********"
        FlexDash.set('net_wifi_config', config)
    }
    handle_netCellState(state) {
        FlexDash.set('cellular/state', state || "??")
        FlexDash.set('cellular/enabled', (state === 'disabled' || state === 'no-modem') ? 'OFF' : 'ON')
    }
    handle_netCellReason(reason) { FlexDash.set('cellular/reason', reason || "") }
    handle_netScanStatus(status) { 
		status = typeof status === "object" ? status : typeof status === "string" ? [status,""] : ["",""]
		FlexDash.set('cellular/scan_status', status[0] || "")
		FlexDash.set('cellular/scan_status_detailed', status[1] || "")
	}
    handle_netCellCarrier(carrier) { FlexDash.set('cellular/carrier', carrier || "Any") }
    handle_netCellCarriers(carriers) { 
		FlexDash.set('cellular/carriers_data', carriers || []) 
		FlexDash.set('cellular/carriers_columns', ["Carrier Code", "Carrier Name", "Technology", "Availability"]) 
	}
    handle_netCellConfig(data) {
        FlexDash.set('cellular/config', data || {})
        FlexDash.set('cellular/config_labels', Object.keys(data||{}))
    }
    handle_netCellInfo(info) {
        FlexDash.set('cellular/info', info || {})
        FlexDash.set('cellular/info_labels', Object.keys(info||{}))
    }
    
    // events from the dashboard, change wifi/hotspot/cell state or settings
    handle_dash_enable_wifi(state) { WifiMan.enableWifi(state == "ON").then(() => {}) }
    handle_dash_enable_hotspot(state) { WifiMan.enableHotspot(state == "ON") }
    handle_dash_config_wifi(config) { WifiMan.setWifiConfig(config).then(() => {}) }
    handle_dash_config_cell(config) { CellMan.setCellConfig(config) }
    handle_dash_enable_cell(state) { CellMan.enableCellular(state === 'ON') }
    handle_dash_scan_carriers() { CellMan.scanCarriers() }
    handle_dash_scan_carriers_enable(enabled) { FlexDash.set('scan_carriers/enable',enabled) }
    handle_dash_cellular_priority(prio) {
        CellMan.setCellPriority(prio)
        setTimeout(()=>FlexDash.set('cellular/priority', CellMan.getCellPriority()), 5000)
    }
    handle_dash_cell_debug() {
        CellMan.getCellDebug().then(dbg => FlexDash.set('cellular/debug', dbg))
    }
    handle_dash_cell_scan() {
        FlexDash.set('cellular/debug', "Scan takes 10-20 seconds...")
        CellMan.getCellScan().then(dbg => FlexDash.set('cellular/debug', dbg))
    }
    // Seen-IMSI reference table (populated from check-modem.sh log)
    handle_netCellSeenImsi(rows) {
        FlexDash.set('cellular/telecom/header', ["MCC", "MNC", "Operator", "Region", "Rejected"])
        FlexDash.set('cellular/telecom/data', rows || [])
    }
    // Bad-IMSI table (currently blocked prefixes)
    handle_netCellBadImsi(rows) {
        FlexDash.set('cellular/bad_imsi/header', ["MCC", "MNC", "Operator", "Region"])
        FlexDash.set('cellular/bad_imsi/data', rows || [])
    }
    // User edits the blocked list from the UI; expects array of 5-6 digit prefix strings
    handle_dash_cell_bad_imsi(data) {
        if (!Array.isArray(data)) return
        CellMan.setCellConfig({ 'bad-imsi-prefixes': data })
    }
    handle_netCellSignal(s) {
        FlexDash.set('cellular/signal/dbm',   s?.dbm ?? null)
        FlexDash.set('cellular/signal/label',  s ? `${s.dbm} dBm (${s.rat})` : '—')
        FlexDash.set('cellular/signal/color',  signalColor(s?.dbm, -120, -50))
    }
    handle_netWifiSignal(s) {
        FlexDash.set('net_wifi_signal/dbm',   s?.dbm ?? null)
        FlexDash.set('net_wifi_signal/label',  s ? `${s.dbm} dBm` : '—')
        FlexDash.set('net_wifi_signal/color',  signalColor(s?.dbm, -90, -30))
    }
    handle_netWifiIP(ip) { FlexDash.set('net_wifi_ip', ip || '—') }
    handle_netWifiNetworks(rows) {
        rows = rows || []
        this.wifi_networks_rows = rows
        const connected = rows.find(r => r[2] === 'Connected')
        const labels = ['No network', ...rows.map(r => `${r[0]} (${r[1]} dBm)`)]
        FlexDash.set('wifi/available', labels)
        FlexDash.set('wifi/ssid', connected ? connected[0] : 'No network')
        FlexDash.set('wifi/networks/data', rows)
        if (this.wifi_connecting) {
            this.wifi_connecting = false
            if (!connected || connected[0] !== this.wifi_connect_ssid) {
                FlexDash.set('wifi/connect/enabled', true) // connection failed, re-enable
            }
        }
    }
    handle_dash_wifi_connect_ssid(label) {
        if (!label || label === 'No network') {
            FlexDash.set('wifi/connect/enabled', false)
            return
        }
        const row = (this.wifi_networks_rows || []).find(r => `${r[0]} (${r[1]} dBm)` === label)
        this.wifi_connect_ssid = row ? row[0] : label
        this.wifi_connect_password = ''
        FlexDash.set('wifi/ssid', this.wifi_connect_ssid)
        FlexDash.set('wifi/password', '[SET WIFI PASSWORD HERE]')
        FlexDash.set('wifi/connect/enabled', true)
    }
    handle_dash_wifi_connect_password(password) {
        this.wifi_connect_password = password
    }
    handle_dash_wifi_connect() {
        if (!this.wifi_connect_ssid) return
        WifiMan.setWifiConfig({ ssid: this.wifi_connect_ssid, passphrase: this.wifi_connect_password || '' }).then(() => {})
        FlexDash.set('wifi/ssid', this.wifi_connect_ssid)
        FlexDash.set('wifi/password', '********')
        FlexDash.set('wifi/connect/enabled', false)
        this.wifi_connecting = true
        setTimeout(() => WifiMan.scanWifiNetworks(), 12000)
    }
    handle_netCellICCID(iccid) { FlexDash.set('cellular/iccid', iccid || '') }
    handle_dash_cellular_iccid_show() { CellMan.fetchAndRevealICCID() }
    handle_netWifiScanEnabled(enabled) { FlexDash.set('wifi/networks/scan_enabled', enabled) }
    handle_dash_wifi_networks_scan() { WifiMan.scanWifiNetworks() }

    // upload info
    handle_motusRecv(info) {
        const dash = {
            project_id: info.project || "UNSET",
            deployment_status: info.status || "UNKNOWN",
            station_name: info.deployment,
            project_color: info.project ? "green" : "red",
            status_color: info.status == "active" ? "green" : "red",
        }
        FlexDash.set('motus_recv', dash)
    }



    ////////////////////////
    // ENPI

    handle_enpi_status(status) {FlexDash.set('enpi/status', status || "??")}
    handle_enpi_sample_rate(sample_rate) {FlexDash.set('enpi/sample_rate', sample_rate || "??")}
    handle_enpi_sample_schedule(sample_schedule) {FlexDash.set('enpi/sample_schedule', sample_schedule || "??")}
    handle_enpi_aws_bucket_name(bucket_name) {FlexDash.set('enpi/aws/bucket_name', bucket_name || "??")}
    handle_enpi_aws_status(status) {FlexDash.set('enpi/aws/status', status || "??")}
    handle_enpi_upload_status(status) {FlexDash.set('enpi/upload/status', status || "??")}
    handle_enpi_upload_log(text) {FlexDash.set('enpi/upload/log', text || "??")}
    handle_enpi_upload_gotData(data) {FlexDash.set('enpi/upload/info', data?.[1] || {})}
    
    handle_enpi_version(text) {FlexDash.set('enpi/version', text || "??")}
    handle_enpi_update_log(text) {FlexDash.set('enpi/update/log', text || "??")}
    handle_enpi_provisioning_status(status) { FlexDash.set('enpi/provisioning/status', status || "??") }
    handle_enpi_provisioning_info(info) { FlexDash.set('enpi/provisioning/info', info || {}) }
    handle_dash_enpi_update() {Enpi.updateSoftware()}

    handle_dash_enpi_toggle(toggle) {Enpi.set('toggle',toggle)}
    handle_dash_enpi_sample_rate(sample_rate) {Enpi.set('sample_rate',sample_rate)}
    handle_dash_enpi_sample_schedule(sample_schedule) {Enpi.set('sample_schedule',sample_schedule)}
    handle_dash_enpi_provision(config) {Enpi.provision()}
    handle_dash_enpi_download(download) {Enpi.set('download',download)}
    handle_dash_enpi_force_upload(force) {Enpi.set('upload/force', force)}

    // Light level and air quality sensors
    handle_enpi_air_status(status) { FlexDash.set('enpi/air/status', status || "??") }
    handle_enpi_air_toggle(value) { FlexDash.set('enpi/air/toggle', value) }
    handle_enpi_light_status(status) { FlexDash.set('enpi/light/status', status || "??") }
    handle_enpi_light_toggle(value) { FlexDash.set('enpi/light/toggle', value) }

    handle_dash_enpi_air_toggle(toggle) { Enpi.set('air/toggle',toggle) }
    handle_dash_enpi_light_toggle(toggle) { Enpi.set('light/toggle',toggle) }

    
    // Lazy-init TimeSeries for an enpi sensor on first data; call ts_enpi_setup once.
    _enpiEnsureSensor(sensor) {
        if (this.enpi?.[sensor]?.ts) return
        if (!this.enpi) this.enpi = {}
        const schemas = {
            light: ['readings', 'light_level', 'temp'],
            air:   ['readings', 'temp', 'pressure', 'humidity', 'pm1', 'pm2_5', 'pm10'],
        }
        this.enpi[sensor] = {
            ts: Object.fromEntries(
                (schemas[sensor] || []).map(dtype => [dtype, new TimeSeries(ts_dir, `enpi-${sensor}-${dtype}`)])
            )
        }
        if (!this.enpi_setup_done) {
            this.enpi_setup_done = true
            this.ts_enpi_setup()
        }
    }

    // process data from air quality sensor
    handle_enpi_air_gotData(data) {
        // ts,temp,pressure,humidity,pm1,pm2.5,pm10, pc0.3, pc0.5,pc1,pc2.5,pc5,pc10
        try {
            const f = typeof data === "string" ? data.split(',') : data
            if (f.length != 13) return
            this._enpiEnsureSensor('air')
            const time = Math.round(parseFloat(f[0])*1000)
            const temp = parseFloat(f[1])
            const pressure = parseFloat(f[2]) / 10 // hpa to kpa
            const humidity = parseFloat(f[3])
            const pm1 = parseInt(f[4])
            const pm2_5 = parseInt(f[5])
            const pm10 = parseInt(f[6])
            if (this.enpi?.air?.ts?.readings) this.enpi.air.ts.readings.add(time, 1)
            if (this.enpi?.air?.ts?.temp) this.enpi.air.ts.temp.avg(time, temp)
            if (this.enpi?.air?.ts?.pressure) this.enpi.air.ts.pressure.avg(time, pressure)
            if (this.enpi?.air?.ts?.humidity) this.enpi.air.ts.humidity.avg(time, humidity)
            if (this.enpi?.air?.ts?.pm1) this.enpi.air.ts.pm1.avg(time, pm1)
            if (this.enpi?.air?.ts?.pm2_5) this.enpi.air.ts.pm2_5.avg(time, pm2_5)
            if (this.enpi?.air?.ts?.pm10) this.enpi.air.ts.pm10.avg(time, pm10)
        } catch (e) {
            console.warn("enpi: handle_enpi_air_gotData", e)
        }
    }
    // process data from light level sensor
    handle_enpi_light_gotData(data) {
        // ts,light_level,frequency,count,duration,temp
        try {
            const f = typeof data === "string" ? data.split(',') : data
            if (f.length != 6) return
            this._enpiEnsureSensor('light')
            const time = Math.round(parseFloat(f[0])*1000)
            const light_level = parseFloat(f[1])
            const temp = parseFloat(f[5])
            if (this.enpi?.light?.ts?.readings) this.enpi.light.ts.readings.add(time, 1)
            if (this.enpi?.light?.ts?.light_level) this.enpi.light.ts.light_level.avg(time, light_level)
            if (this.enpi?.light?.ts?.temp) this.enpi.light.ts.temp.avg(time, temp)
        } catch (e) {
            console.warn("handle_enpi_light_gotData", e)
        }
    }
    
    ts_enpi_setup() {
        setInterval(() => this.ts_enpi_save(), 60000)
        this.enpi_ts_ix = 2 // Day
        this.handle_dash_enpi_detection_range(TimeSeries.ranges[this.enpi_ts_ix])
    }

    handle_dash_enpi_detection_range(range) {
        try {
            const ix = TimeSeries.ranges.indexOf(range)
            if (ix < 0) { console.log("handle_dash_enpi_detection_range: bad range", range); return }
            this.enpi_ts_ix = ix
            this.ts_enpi_refresh()
            if (this.enpiRefreshInterval) clearInterval(this.enpiRefreshInterval)
            this.enpiRefreshInterval = setInterval(() => this.ts_enpi_refresh(), TimeSeries.intervals[ix])
        } catch (e) {
            console.warn("ts_enpi_refresh", e)
        }
    }

    ts_enpi_show( sensor, combinedData ) {
        
        // assemble the set of time-series to show
        const tsSet = []
        const labels = []

        for (const dtype in this.enpi?.[sensor]?.ts) {
            tsSet.push(this?.enpi?.[sensor]?.ts[dtype])
            labels.push(`${dtype}`)
        }
        if (tsSet.length == 0) {
            FlexDash.set(`enpi/${sensor}/detections`, { data: [], labels })
            return
        }
        const now = Date.now()
        const range = TimeSeries.ranges[this.enpi_ts_ix]
        //console.log("enpi: tsSet:", JSON.stringify(tsSet))
        const [times, values] = tsSet[0].get(range, now)
        //console.log("enpi: Got:", values)
        const interval = TimeSeries.intervals[this.enpi_ts_ix]
        console.log("enpi: this.enpi_ts_ix=", this.enpi_ts_ix)
        const fct = v => v// == null ? null : v * 3600*1000 / interval
        const data = times.map((t, i) => [Math.floor(t/1000), fct(values[i])])
        for (let i = 1; i < tsSet.length; i++) {
            const [times, values] = tsSet[i].get(range, now)
            if (times.length != data.length) throw new Error("tsShow: times length mismatch")
            if (Math.floor(times[0]/1000) != data[0][0]) throw new Error("tsShow: data start mismatch")
            for (let j=0; j<data.length; j++) data[j].push(fct(values[j]))
        }
        var pmData = times.map((t, i) => [Math.floor(t/1000)])
        var pmLabels = []
        if (!combinedData.temp)
            combinedData.temp = {
                data: times.map((t, i) => [Math.floor(t/1000)]),
                labels: [],
                title: `Temperature (${range})`
            }
        if (!combinedData.readings)
            combinedData.readings = {
                data: times.map((t, i) => [Math.floor(t/1000)]),
                labels: [],
                title: `Readings (${range})`
            }
        for (const dtype in this.enpi?.[sensor]?.ts) {
            const dtypeData = this?.enpi?.[sensor]?.ts[dtype].data[range]
            if (dtype.startsWith("pm")) {
                // Plot particulates together
                pmData.map( (d,i) => d.push(dtypeData[i]) )
                pmLabels.push(dtype)
            } else if (dtype.startsWith("temp") || dtype == "readings") {
                // Plot temperature together
                combinedData[dtype].data.map( (d,i) => d.push(dtypeData[i]) )
                combinedData[dtype].labels.push(sensor)
            } else {
                var dtypeTimedData = times.map((t, i) => [Math.floor(t/1000), fct(dtypeData[i])])
                var dtypeLabels = [dtype]
                var dtypeTitle = dtype + " (" + range + ")"
                FlexDash.set(`enpi/${sensor}/${dtype}`, { data: dtypeTimedData, labels: dtypeLabels, title: dtypeTitle})
            }
        }
        if (pmLabels.length > 0) 
            FlexDash.set(`enpi/${sensor}/pm`, { data: pmData, labels: pmLabels, title: `Particulates (${range})`})
        
        if (combinedData.temp.labels.length > 0) 
            FlexDash.set(`enpi/temp`, combinedData.temp)
        if (combinedData.temp.labels.length > 0) 
            FlexDash.set(`enpi/readings`, combinedData.readings)
        


        const title = sensor + " (" + range + ")" // can't set dynamic title :-(
        FlexDash.set(`enpi/${sensor}/detections`, { data, labels, title })
        // console.log(`enpi: ts_enpi_show: ${sensor} ${now} ${data.length} points, labels=${labels}`)
        // console.log('enpi: ',JSON.stringify(data))
        return combinedData
    }

    // save all the environmental sensor time-series to file
    ts_enpi_save() {
        try {
            for (const sensor in this.enpi) {
                const ts = this.enpi[sensor]?.ts
                for (const dtype in ts) {
                    ts[dtype].save() // only does something if it's dirty
                }
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    ts_enpi_refresh() {
        
        try {
            // catch up all the graphs
            const now = Date.now()
            var combinedData = {temp: false, readings: false}
            for (const sensor in this.enpi) {
                const ts = this.enpi?.[sensor]?.ts || {}
                for (const dtype in ts) {
                    const fill = dtype == "readings" ? 0 : null
                    ts[dtype].append(now, fill, undefined)
                }
                combinedData = this.ts_enpi_show(sensor, combinedData)
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }






    // ===== Pulses and tag time-series

    // generate a filename for a device's time-series
    tsFilename(dev) {
        let prefix
        switch (dev.attr.radio) {
        case "CTT/Cornell": prefix = "ctt"; break
        case "DigiBabel": prefix = "ctt"; break
        case "VAH": prefix = "lotek"; break
        case "GNU": prefix = "lotek"; break
        default: return null
        }
        return `${prefix}-${dev.attr.port}`
    }

    // device got added, init the time-series for it
    tsAddDevice(dev) {
        const port = dev.attr.port
        if (dev.attr.type == "CTT/CornellRcvr" || dev.attr.radio == "DigiBabel") {
            // CTT devices only produce tag detections
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "ctt-tags-"+dev.attr.port),
            }
        } else if (dev.attr.type == "funcubeProPlus" || dev.attr.type == "funcubePro" || dev.attr.type == "rtlsdr" || dev.attr.type == "airspy") {
            // Lotek devices produce tag detections, pulses and noise figures
            this.ts[port] = {
                tags: new TimeSeries(ts_dir, "lotek-tags-"+dev.attr.port),
                pulses: new TimeSeries(ts_dir, "lotek-pulses-"+dev.attr.port),
                noise: new TimeSeries(ts_dir, "lotek-noise-"+dev.attr.port),
                snr: new TimeSeries(ts_dir, "lotek-snr-"+dev.attr.port),
                rate: new TimeSeries(ts_dir, "lotek-rate-"+dev.attr.port),
            }
        }
        console.log("tsAddDevice", dev.attr.port, port)
    }

    tsRemoveDevice(dev) {
        if (!this.ts[dev.attr.port]) return
        for (const ts of Object.values(this.ts[dev.attr.port])) ts.close()
        delete this.ts[dev.attr.port]
    }

    // process a tag detection from a device
    tsGotTag(tag) {
        // T3,1681004846.412,0FE36400,-96,v2
        // L6,1681004878.702,TestTags#1.1@166.38:25.1,3.809,0.011,-25.5,1.18,-54.4,1,3,0.0005,4.96e-05,166.38
        try {
            const f = tag.split(',')
            if (f.length < 2) return
            const mm = f[0].match(/^([A-Z])(\d+)/)
            if (!mm) return
            const port = mm[2]
            const time = Math.round(parseFloat(f[1])*1000)
            if (this.ts[port]?.tags) this.ts[port].tags.add(time, 1)
            // we already record noise and snr for the pulses, so don't do it again
            // if (this.ts[port]?.noise && f.length >= 8) {
            //     const noise = parseFloat(f[7])
            //     this.ts[port].noise.avg(time, noise)
            // }
            // if (this.ts[port]?.snr && f.length >= 8) {
            //     const snr = parseFloat(f[5]) - parseFloat(f[7])
            //     this.ts[port].snr.avg(time, snr)
            // }
        } catch (e) {
            console.warn("tsGotTag", e)
        }
    }

    // process a pulse from a lotek radio
    tsGotPulse(info) {
        // p6,1681004979.0929,3.785,-29.66,-54.81,25.6
        try {
            const f = info.split(',')
            if (f.length < 6) return
            const mm = f[0].match(/^p(\d+)/)
            if (!mm) return
            const port = mm[1]
            const time = Math.round(parseFloat(f[1])*1000)
            const noise = parseFloat(f[4])
            const snr = parseFloat(f[5])
            if (this.ts[port]?.pulses) this.ts[port].pulses.add(time, 1)
            if (this.ts[port]?.noise) this.ts[port].noise.avg(time, noise)
            if (this.ts[port]?.snr) this.ts[port].snr.avg(time, snr)
        } catch (e) {
            console.warn("tsGotPulse", e)
        }
    }

    tsGotRate(port, now, rate) {
        try {
            const time = Math.round(now)
            port = port.replace(/^[a-z]/, '');
            // console.log(`tsGotRate: ${port} ${time} ${rate} ${Object.keys(this.ts).join(",")}`)
            if (this.ts[port]?.rate) this.ts[port].rate.avg(time, rate)
            if (this.ts[port]?.rate) {
                const foo = this.ts[port].rate
                // console.log("tsGotRate", foo)
            }
        } catch (e) {
            console.warn("tsGotRate", e)
        }
    }

    // update a graph, what: lotek-tags, lotek-pulses, lotek-noise, ctt-tags
    tsShow(what) {
        const [prefix, series] = what.split('-')
        // assemble the set of time-series to show
        const tsSet = []
        const labels = []
        for (const port in this.ts) {
            if (series in this.ts[port] && this.ts[port][series].name.startsWith(prefix)) {
                tsSet.push(this.ts[port][series])
                labels.push(`port ${port}`)
            }
        }
        //console.log(`tsShow: ${what} ${tsSet.length} devices:`, tsSet.length)
        // get the data together
        if (tsSet.length == 0) {
            FlexDash.set(`detections/${series}`, { data: [], labels })
            return
        }
        const now = Date.now()
        const range = TimeSeries.ranges[this.ts_ix]
        const [times, values] = tsSet[0].get(range, now)
        //console.log("Got:", values)
        const interval = TimeSeries.intervals[this.ts_ix]
        const fct = ['noise','snr','rate'].includes(series)
            ? v => v
            : v => v == null ? null : v * 3600*1000 / interval
        const data = times.map((t, i) => [Math.floor(t/1000), fct(values[i])])
        for (let i = 1; i < tsSet.length; i++) {
            const [times, values] = tsSet[i].get(range, now)
            if (times.length != data.length) throw new Error("tsShow: times length mismatch")
            if (Math.floor(times[0]/1000) != data[0][0]) throw new Error("tsShow: data start mismatch")
            for (let j=0; j<data.length; j++) data[j].push(fct(values[j]))
        }
        const title = what.replace('-',' ') + " (" + range + ")" // can't set dynamic title :-(
        FlexDash.set(`detections/${what}`, { data, labels, title })
        //console.log(`tsShow: ${what} ${now} ${data.length} points, labels=${labels}`)
        //onsole.log(data)
    }

    // generate some random data, useful for testing only
    tsGenRandom() {
        const now = Date.now()
        console.log("tsGenRandom", Object.keys(this.ts))
        for (const port in this.ts) {
            const ts = this.ts[port]
            if (ts.pulses) {
                this.tsGotTag(`L${port},${now/1000},tag,0,0,0,0,${-50-Math.random()*10},0,0,0,0,166.38`)
                this.tsShow('lotek-tags')
                this.tsGotPulse(`p${port},${now/1000},0,0,${-50-Math.random()*10}`)
                this.tsShow('lotek-pulses')
                this.tsShow('lotek-noise')
                this.tsShow('lotek-snr')
                this.tsShow('lotek-rate')
            } else {
                this.tsGotTag(`T${port},${now/1000},12345678,0,1`)
                this.tsShow('ctt-tags')
            }
        }
    }

    // refresh the currently shown graphs
    tsRefresh() {
        try {
            // catch up all the graphs
            const now = Date.now()
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    const fill = ['noise','snr','rate'].includes(series) ? null : 0
                    ts[series].append(now, fill, undefined)
                }
            }
            // display
            for (const what of ['lotek-tags', 'lotek-pulses', 'lotek-noise', 'lotek-snr',
                    'lotek-rate', 'ctt-tags']) {
                this.tsShow(what)
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // save all the time-series to file
    tsSave() {
        try {
            for (const port in this.ts) {
                const ts = this.ts[port]
                for (const series in ts) {
                    ts[series].save() // only does something if it's dirty
                }
            }
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // the user clicked a range button, switch the range for the charts
    handle_dash_detection_range(range) {
        try {
            const ix = TimeSeries.ranges.indexOf(range)
            if (ix < 0) { console.log("handle_dash_detection_range: bad range", range); return }

            let intv = TimeSeries.intervals[ix]/1000 // in seconds
            if (intv < 120) intv += "s"
            else if (intv < 7200) intv = Math.round(intv/60) + "m"
            else if (intv < 2*86400) intv = Math.round(intv/3600) + "h"
            else intv = Math.round(intv/86400) + "d"
            FlexDash.set("detections/interval", intv)

            this.ts_ix = ix
            this.tsRefresh()

            if (this.tsRefreshInterval) clearInterval(this.tsRefreshInterval)
            this.tsRefreshInterval = setInterval(() => this.tsRefresh(), TimeSeries.intervals[ix])
        } catch (e) {
            console.warn("tsRefresh", e)
        }
    }

    // ===== Deployment configuration
    
    setDeployment() {
        // let data = Object.fromEntries(
        //     Object.entries(Deployment.data).map(e => 
        //         [ e[0].replace(/_/g,' '),
        //           e[0].includes('password') ? "********" : e[1]]
        // ))
        // delete data['module options']
        // let fields = ['short label', 'memo', 'upload username', 'upload password']
        FlexDash.set('deployment', {
            fields: ["memo"],
            // fields: ["label","memo"],
            data: { label: Acquisition.label, memo: Acquisition.memom, agc: Acquisition.agc?"on":"off" },
        })
        RTLSDR.enableAGC = !!Acquisition.agc
    }

    handle_dash_deployment_update(update) {
        console.log("handle_dash_deployment_update", update)
        Acquisition.update(Object.fromEntries(
            Object.entries(update).map(e => [e[0].replace(/ /g,'_'), e[1]])))
        this.setDeployment()
        // FlexDash.set('motus_login', `checking...`)
        // this.matron.emit("motus-creds")
    }

    handle_dash_enable_agc(value) {
        const enabled = value == 'on'
        RTLSDR.enableAGC = enabled
        Acquisition.update({ agc: enabled})
        this.setDeployment()
    }

    handle_dash_lotek_freq_change() {
        // update the acquisition settings
        let ix = LotekFreqs.indexOf(Acquisition.lotek_freq)
        ix = (ix+1) % LotekFreqs.length
        const f = LotekFreqs[ix]
        Acquisition.update({lotek_freq: f})
        // restart the radios and tag finder
        this.matron.emit("lotekFreqChg", f)
        HubMan.resetDevices()
    }

    setDashCreds(creds, message) {
        let data = Object.fromEntries(
            Object.entries(creds).map(e => [ e[0].replace(/_/g,' '), e[1]])
        )
        let fields = ['current password', 'new password', 'confirm new password']
        if (message) {
            console.log(`setDashCreds: ${message}`)
            data['message'] = message
            fields.unshift('message')
        }
        FlexDash.set('system_creds', { fields, data })
    }

    handle_dash_creds_update(update) {
        if (!(update['current password'] && update['new password'] && update['confirm new password'])) return
        let cp = update['current password'], np = update['new password']
        if (np != update['confirm new password']) {
            update['confirm new password'] = ""
            this.setDashCreds(update, "new passwords don't match")
            return
        }
        if (np.length < 8 || np.length > 32) {
            this.setDashCreds(update, "password must be 8 to 32 characters long")
            return
        }
        if (top100k.includes(np)) {
            this.setDashCreds(update, "please choose a less common password :-)")
            return
        }
        //Pam.authenticate(Machine.username, cp, (err) => {
        FlexDash.py_auth(Machine.username, cp, (err) => {
            if (err) {
                update['current password'] = ""
                this.setDashCreds(update, "incorrect current password")
            } else {
                // hash the pwd for the hotspot, uses the SSID as salt!
                const hpw = crypto.pbkdf2Sync(np, Machine.machineID, 4096, 256 / 8, "sha1").toString("hex")
                try {
                    CP.execFileSync("/usr/sbin/chpasswd", { input: `${Machine.username}:${np}\n` })
                    CP.execFileSync(wifi_hotspot, ["mode", "WPA-PSK", hpw])
                } catch(e) {
                    console.log("creds_update error", e)
                    return
                }
                this.setDashCreds({ current_password: "", new_password: "", confirm_new_password: ""},
                    "password updated")
            }
        }, {serviceName: 'login', remoteHost: 'localhost'})
    }

    // ===== Tag/Pulse detections for the last 5 minutes

    // shift/roll detection arrays by one element every 10 seconds
    detectionShifter() {
        this.detections.ctt.shift()
        this.detections.ctt.push(0)
        this.detections.lotek.shift()
        this.detections.lotek.push(0)
        FlexDash.set('detections_5min', this.detections)
    }

    detectionLogPush(data) {
        this.detection_log.push(data)
        let dll = this.detection_log.length
        if (dll > 100) this.detection_log.splice(0, dll-100)
        FlexDash.set("detection_log", this.detection_log.join("\n"))
    }

    fmtTagDetection(line) {
        const ll = line.trim().split(',')
        if (line[0] == 'L') {
            // Lotek tag: port,ts,fullID,freq,freq.sd,sig,sig.sd,noise,run.id,pos.in.run,slop,burst.slop,ant.freq
            const name = ll[2].replace(/@.*/, '')
            const ts = (new Date(parseFloat(ll[1])*1000)).toISOString().replace(/.*T/, '').replace(/\..+/, '')
            const snr = (parseFloat(ll[5]) - parseFloat(ll[7])).toFixed(1)
            return `TAG ${ll[0]} ${ts}: ${ll[2]} ${ll[3]}kHz snr:${snr}dB (${ll[5]}/${ll[7]}dB)`
        } else if (line[0] == 'T') {
            // CTT tag:
            return `TAG ${line}`
        } else {
            return line
        }
    }

    handle_gotTag(tag) {
        if (!tag.match(/^[A-Za-z]?[0-9]/)) return
        if (!tag.match(/^[A-Za-z]/)) tag = "L" + tag // "Lotek" prefix, ugh
        if (tag.startsWith("T")) this.detections.ctt[this.detections.ctt.length-1]++
        FlexDash.set('detections_5min', this.detections)
        this.detectionLogPush(this.fmtTagDetection(tag))
        this.tsGotTag(tag.trim())
        // direction finding
        if (this.df_enable && this.df_tags) {
            let tt = tag.trim().split(",")
            if (tt.length < 4) return
            let name = tt[2].replace(/.*#([^@]+)@.*/,'$1') // lotek mess
            let signal = tt.length > 7 ? (parseFloat(tt[5]) - parseFloat(tt[7])).toFixed(1) + "dB"
                                       : tt[3] + "dBm"
            if (name == this.df_tags.tag1 || name == this.df_tags.tag2 || this.df_tags.tag1 == "*") {
                this.dfLogPush(tt[0], name, signal)
            }
        }
    }

    handle_gotBurst(burst) {
        // { text, info, meanFreq, sdFreq, meanSig, sdSig, meanNoise, meanSnr }
        // info: [ s0.port, s0.ts/1000, this.tagid, ...intv, ...tags[this.tagid] ]
        const bf = Acquisition.burstfinder
        if (burst.src == 'BF' && bf.method != 'burstfinder' && !bf.both_ui) return
        if (burst.src == 'PF' && bf.method != 'pulsefilter' && !bf.both_ui) return

        const ts = (new Date(burst.info[1]*1000)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
        const meanFreq = parseFloat(burst.meanFreq).toFixed(3)
        const minSnr = parseFloat(burst.minSnr).toFixed(1)
        this.detectionLogPush(
            `BUR B${burst.info[0]} ${ts}: #${burst.info[2]} ${meanFreq}kHz snr:${minSnr}dB src=${burst.src}`
        )
    }

    handle_vahData(line) {
        //console.log(`vahData: ${data.toString().replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`)
        if (line.startsWith("p")) {
            this.detections.lotek[this.detections.lotek.length-1]++
            if (!Acquisition.burstfinder.filter_ui) {
                // convert to something more readable
                const ll = line.trim().split(',')
                const port =parseInt(ll[0][1])
                const last_ts = this.pulse_ts[port] || 0
                const this_ts = parseFloat(ll[1])*1000
                const delta_ms = this_ts - last_ts < 120_000 ? "Δ"+(this_ts-last_ts).toFixed(1)+"ms" : ""
                this.pulse_ts[port] = this_ts
                const ts = (new Date(this_ts)).toISOString().replace(/.*T/, '').replace(/\..*/, '')
                const snr = parseFloat(ll[5]).toFixed(1)
                this.detectionLogPush(
                    `PLS ${ll[0]} ${ts}: ${ll[2]}kHz snr:${snr}dB ` +
                    `(${parseFloat(ll[3]).toFixed(1)}/${parseFloat(ll[4]).toFixed(1)}dB) ${delta_ms}`
                )
            }
            this.tsGotPulse(line.trim())
        }
        FlexDash.set('detections_5min', this.detections)
    }

    handle_grhData(line) {
        this.handle_vahData(line);
    }

    handle_vahRate(port, now, rate) { this.tsGotRate(port, now, rate)}

    // capture VAH number of frames (samples) received for reporting via this.monitoring
    handle_vahFrames(port, now, frames) {
        port = port.replace(/^[a-z]/, '');
        FlexDash.set(`samples/${port}/frames`, frames)
        FlexDash.set(`samples/${port}/at`, now)
    }

    // handle tag database upload
    handle_dash_upload_tagdb(phase, info, resp) {
        if (phase === 'begin' && resp) {
            resp(info.size > 0 && info.size < 10*1024*1024 && TAGDBFILE)
        } else if (phase === 'done') {
            console.log("Tag DB upload done:", info)
            this.matron.emit("tagDBChg")
        }
    }

    // ===== Direction finding

    handle_dash_df_tags(tags) {
        if (typeof tags === 'object' && 'tag1' in tags && 'tag2' in tags) {
            this.df_tags = tags
            FlexDash.set("df_tags", tags)
            console.log("DF tags: " + JSON.stringify(tags))
        }
    }

    handle_dash_df_enable(en) {
        this.df_enable = en == true || en == "ON"
        FlexDash.set('df_enable', this.df_enable ? "ON" : "OFF")
        console.log("DF " + (this.df_enable ? "enabled" : "disabled"))
    }

    dfLogPush(port, name, signal) {
        const ts = new Date().toISOString().replace(/.*T/, '').replace(/\..+/, '')
        this.df_log.push(port + " " + ts + " " + name + " " + signal)
        let dfl = this.df_log.length
        // keep a fixed number of lines
        if (dfl > 10) this.df_log.splice(0, dfl-10)
        //console.log("df log: " + this.df_log.join(" | "))
        FlexDash.set("df_log", this.df_log.join("\n"))
    }

    // ===== /data file enumeration, download, (and upload?)

    // updateDetectionStats transforms the stats as they come from DataFiles into the format
    // required by the TimePLot widget of FlexDash, i.e. uPlot.
    // uPlot wants an array indexed by time, with each element being an array of values, the first
    // value being the X coordinate, and the rest being the series.
    updateDetectionStats(daily, hourly) {
        // get series names
        let series = Object.values(daily).reduce((series, day) => {
            Object.keys(day).forEach(d => series.add(d))
            return series
        }, new Set())
        series = Array.from(series.values()).sort()
        console.log(`updateDetectionStats: series=${series}`)

        // pivot daily stats
        const secs_per_day = 24*3600
        let today = Math.trunc(Date.now()/1000/secs_per_day)*secs_per_day
        let daily_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const day = today - (99-i)*secs_per_day
            daily_data[i] = [day, ...series.map(s =>
                day in daily && s in daily[day]? daily[day][s] : null)]
        }
        FlexDash.set("detection_series", series.map(s => s=='all' ? 'lotek' : s))
        FlexDash.set("detections_daily", daily_data)

        // pivot hourly stats
        const secs_per_hour = 3600
        let curhour = Math.trunc(Date.now()/1000/secs_per_hour)*secs_per_hour
        let hourly_data = Array(100)
        for (let i = 0; i < 100; i++) {
            const hour = curhour - (99-i)*secs_per_hour
            hourly_data[i] = [hour, ...series.map(s =>
                hour in hourly && s in hourly[hour]? hourly[hour][s] : null)]
        }
        FlexDash.set("detections_hourly", hourly_data)
    }

    // user pressed a download button, we need to turn-around and tell the dashboard to
    // actually perform the download (yes, it's a bit convoluted)
    // what: new/all/last
    handle_dash_download(what, socket) {
        FlexDash.download(socket, `/data-download/${what}`, 'foo.zip')
    }
    // To download through websocket see: https://stackoverflow.com/questions/29066117

    // Handle GET request to download data files
    // See https://stackoverflow.com/a/61313182/3807231
    data_download(req, resp) {
        console.log("data_download:", req.params.what)
        let files = DataFiles.downloadList(req.params.what)
        if (!files) {
            resp.writeHead(200, {'Content-Type': 'text/plain'})
            resp.send()
            return
        }
        // download date, will be recorded in "database"
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + ".zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
        // update the database with the date of the download
        let date = Math.trunc(now.getTime()/1000)
        DataFiles.updateUpDownDate('downloaded', files, date)
    }

    handle_dash_upload(_, socket) {
        MotusUp.uploadSoon(true) // force upload asap
    }

    // ===== Software updates

    // toggle to enable/disable all the software update functionality
    handle_dash_software_enable(value) {
        FlexDash.set('software/enable', value)
        if (!value) FlexDash.set('software/enable_upgrade', false)
    }
    // toggle to enable/disable all the software update functionality
    handle_dash_allow_shutdown(value) {
        FlexDash.set('software/enable_shutdown', value)
        this.allow_poweroff = value
    }

    // show and toggle release train
    releasemap = {stable:'bookworm',testing:'booktest',bookworm:'stable',booktest:'testing'}
    handle_dash_toggle_train(value) {
        FlexDash.set('software/train', value)
        if (['stable','testing'].includes(value)) {
            value = this.releasemap[value]
            Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
                if (err) {
                    console.log("Error reading sensorgnome.list:", err)
                    return
                }
                data = data.toString().replace(/(bookworm|booktest)/, value)
                Fs.writeFile('/etc/apt/sources.list.d/sensorgnome.list', data, (err) => {
                    if (err) {
                        console.log("Error writing sensorgnome.list:", err)
                        return
                    } else {
                        console.log("Changed release train to", value)
                    }
                })
            })
        }
    }
    setDashTrain() {
        Fs.readFile('/etc/apt/sources.list.d/sensorgnome.list', (err, data) => {
            if (err) {
                console.log("Error reading sensorgnome.list:", err)
                return
            }
            let train = data.toString().match(/(bookworm|booktest)/)
            if (train) {
                FlexDash.set('software/train', this.releasemap[train[1]])
            }
        })
    }

    handle_dash_software_restart() { Upgrader.restart() }
    handle_dash_software_reboot() { Upgrader.reboot() }
    handle_dash_software_shutdown() {
        if (this.allow_poweroff) Upgrader.shutdown()
    }
    handle_dash_software_check() { Upgrader.check() }
    handle_dash_software_upgrade(what) { Upgrader.upgrade(what) }

    // download logs button (what must be "all" for now)
    handle_dash_download_logs(what, socket) {
        FlexDash.download(socket, `/logs-download/${what}`, 'logs.zip')
    }

    // Handle GET request to download log files
    // See https://stackoverflow.com/a/61313182/3807231
    logs_download(req, resp) {
        console.log("log_download:", req.params.what)
        let files = Fs.readdirSync("/var/log", 'utf8')
        files = files.
            filter(f => f.startsWith("sg-control")||f.startsWith("syslog")).
            map(f=>'/var/log/'+f)
        //files.push("/var/log/syslog")
        let now = new Date()
        let filename = Machine.machineID + "-" + now.toISOString() + "-logs.zip"
        // tell the browser that we're sending a zip file
        resp.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-disposition': 'attachment; filename=' + filename
        })
        // stream zip archive into response
        console.log(`Streaming ZIP with ${files.length} log files`)
        let archive = AR('zip', { zlib: { level: 1 } }) // we're putting .gz files in...
        archive.pipe(resp)
        files.forEach(f => archive.file(f, { name: Path.basename(f) }))
        archive.finalize()
    }

    // ===== Remote management

    setRemoteManagement(new_config) {
        Fs.readFile(remote_access, (err, data) => {
            if (err) {
                console.log(`Error reading ${remote_access}: ${err}`)
                return
            }
            try {
                const config = JSON.parse(data)
                if (new_config) {
                    Object.assign(config, new_config)
                    Fs.writeFile(remote_access, JSON.stringify(config), (err) => {
                        if (err) console.log(`Error writing ${remote_access}: ${err}`)
                    })
                }
                FlexDash.set('remote/cmds', config.commands ? "enabled" : "disabled")
                config.webui = false // always show webui as disabled for now
                FlexDash.set("remote/webui", config.webui ? "enabled" : "disabled")
            } catch(e) {
                console.log(`Error parsing ${remote_access}: ${e}`)
            }
        })
    }

    handle_dash_remote_cmds(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ commands: v })
    }
    handle_dash_remote_webui(value) {
        const v = value === true || value == "enabled"
        this.setRemoteManagement({ webui: v })
    }

    // ===== Sixfab UPS HAT information

    // get all the available info about the UPS HAT from a custom python script that queries the
    // sixfab power-api. This produces a bunch of json metrics which we just dump into flexdash.
    // It returns true if successful, false otherwise
    getUpsHatInfo() {
        return new Promise((resolve, reject) => {
            ChildProcess.execFile(SixfabUpsHat, (code, stdout, stderr) => {
                //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
                if (code || stderr) reject(new Error(`${SixfabUpsHat} failed: ${stderr||code}`))
                try {
                    let data = JSON.parse(stdout)
                    FlexDash.set('ups_hat', data)
                    resolve(true)
                    // if the UPS HAT says that we should shut down, do it
                    if (data['shutdown']) {
                        console.log("UPS HAT says we should shut down")
                        MotusUp.uploadSoon(true) // force upload asap
                        // shut down before next HAT query
                        setTimeout(() => Upgrader.shutdown(), 50*1000)
                    }
                } catch (e) {
                    //console.log(`Got : ${stdout}`)
                    FlexDash.set('ups_hat', {input: {status:"error querying HAT"}, system:{}, battery:{}})
                    reject(new Error(`${SixfabUpsHat} failed: ${e}`))
                }
            })
        })
    }

    startUpsHatUpdater() {
        let ok = this.getUpsHatInfo()
        .then(() => {
            setInterval(() => this.getUpsHatInfo(), 60*1000)
        })
        .catch((e) => {
            console.log("Assuming no Sixfab UPS HAT:", e.message)
            FlexDash.set('ups_hat', {input: {status:"HAT not installed"}, system:{}, battery:{}})
        })
    }

    // ===== Network usage collected by vnStat

    updateNetUsage() {
        ChildProcess.execFile(vnstat, (code, stdout, stderr) => {
            //console.log(`Exec "${cmd} ${args.join(" ")}" -> code=${code} stdout=${stdout} stderr=${stderr}`)
            if (code || stderr) {
                console.log(`${vnstat} failed: ${stderr||code}`)
                return
            }
            try {
                // rows: [iface, when, rx, tx, total, predicted]
                const data = []
                let iface = '??'
                for (const line of stdout.split('\n')) {
                    const words = line.split(/  */)
                    if (words[0] == "") words.shift()
                    if (words.length == 1 && words[0].endsWith(':')) {
                        data.push(['','',words[0].slice(0,-1),'',''])
                    } else if (words.length == 0) {
                        // ignore
                    } else if (words[0].endsWith(':')) {
                        // ignore ("Not enough data available yet")
                    } else if (words[0] == 'rx') {
                        // ignore (header)
                    } else if (words[3] == '/') {
                        let row = [words.shift()]
                        while (words.length > 0) {
                            const w = words.shift()
                            if (w == '--') row.push('--')
                            else row.push(`${w} ${words.shift()}`)
                            if (words.length > 0 && words[0] == '/') words.shift()
                        }
                        data.push(row)
                    }
                }
                FlexDash.set('net_usage_data', data)
                FlexDash.set('net_usage_columns', ['when', 'rx', 'tx', 'total', 'predicted'])
            } catch (e) {
                //console.log(`Got : ${stdout}`)
                FlexDash.set('net_usage_data', {})
                console.log(`${vnstat} parsing failed:`, e)
            }
        })

        FlexDash.set('cellular/priority', CellMan.getCellPriority())
    }

    // ===== Return monitoring data in json format
    // This is in the dashboard module because most of the data is grabbed from the dashboard
    // state variables.
    monitoring() {
        return {
            radios: {
                counts: FlexDash.get('radios'),
                devices: FlexDash.get('devices'),
                samples: FlexDash.get('samples'),
                state: FlexDash.get('radio_state'),
            },
            detections: {
                series: FlexDash.get('detection_series'),
                daily: FlexDash.get('detections_daily'),
                hourly: FlexDash.get('detections_hourly'),
                tagdb: FlexDash.get('tagdb'),
            },
            gps: FlexDash.get('gps'),
            uploads: {
                result: FlexDash.get('motus_upload'),
                project_id: FlexDash.get('motus_recv/project_id'),
                deployment_status: FlexDash.get('motus_recv/status'),
            },
            files: {
                summary: FlexDash.get('data_file_summary'),
            },
            network: {
                wifi: FlexDash.get('net_wifi_state'),
                hotspot: FlexDash.get('net_hotspot_state'),
                cell: FlexDash.get('cellular/state'),
                inet: FlexDash.get('net_default_route'),
            },
            cell_info: FlexDash.get('cellular/info'),
        }
    }

}

module.exports = Dashboard
