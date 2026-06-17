// sysmonitor.js - CPU usage, CPU temperature, and memory monitoring
// Polls /proc/stat, /sys/class/thermal, /proc/meminfo every 30s and emits 'sysmonitorData'.
// Disk usage is handled by machine.js (emits 'sdcardUse' every 10 min).
const Fs = require('fs')

class SysMonitor {
    constructor(matron) {
        this.matron = matron
        this.prevCpu = null  // last /proc/stat reading for delta calculation
    }

    start() {
        setTimeout(() => this.poll(), 5 * 1000)
        setInterval(() => this.poll(), 30 * 1000)
    }

    poll() {
        try {
            const cpu = this._cpuUsage()
            const temp = this._cpuTemp()
            const mem = this._memUsage()
            this.matron.emit('sysmonitorData', { cpu, temp, ...mem })
        } catch (err) {
            console.warn('SysMonitor:', err.message)
        }
    }

    _cpuUsage() {
        const line = Fs.readFileSync('/proc/stat').toString().split('\n')[0]
        const parts = line.trim().split(/\s+/).slice(1).map(Number)
        // fields: user nice system idle iowait irq softirq steal ...
        const idle = parts[3] + (parts[4] || 0)  // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0)
        const prev = this.prevCpu
        this.prevCpu = { idle, total }
        if (!prev || total === prev.total) return null
        const pct = (1 - (idle - prev.idle) / (total - prev.total)) * 100
        return Math.round(pct * 10) / 10
    }

    _cpuTemp() {
        try {
            const raw = Fs.readFileSync('/sys/class/thermal/thermal_zone0/temp').toString().trim()
            return Math.round(parseInt(raw, 10) / 100) / 10  // millidegrees → °C
        } catch {
            return null
        }
    }

    _memUsage() {
        const info = {}
        Fs.readFileSync('/proc/meminfo').toString().split('\n').forEach(line => {
            const m = line.match(/^(\w+):\s+(\d+)/)
            if (m) info[m[1]] = parseInt(m[2], 10)
        })
        const total = info.MemTotal || 1
        const avail = info.MemAvailable || 0
        return {
            memUsedPct: Math.round((1 - avail / total) * 1000) / 10,
            memAvailMB: Math.round(avail / 1024),
        }
    }
}

module.exports = SysMonitor
