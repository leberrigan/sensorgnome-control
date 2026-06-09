// nanobabel.js - manage NanoBabel UHF FSK tag receivers
//
//   The device reports detections via a USB serial adapter (115200 baud, 8N1).
//   Initialization: send COMBINED mode command (0x25 0x44 0x00 0x01 0x03 0x6D)
//   so the device streams both burst (tag) and pulse packets.
//
//   All data packets begin with 0x23 ('#') followed by a type byte:
//
//   BURST packet (type 0x74, 19 bytes) — tag detection:
//     [0]     0x23  start byte
//     [1]     0x74  type
//     [2-3]         unk0
//     [4-6]         halfSecs  (24-bit LE, half-seconds since device power-on)
//     [7]           pad
//     [8-9]         ticks     (16-bit LE, clock cycles @ CLOCK_FREQ Hz since last half-second)
//     [10-11]       tagID     (16-bit LE)
//     [12]          avgADC    (0-255)
//     [13]          pad
//     [14]          width     (pulse width in clock cycles)
//     [15]          pad
//     [16]          maxADC    (0-255)
//     [17]          pad
//     [18]          checksum  (sum of bytes 0-17 mod 256)
//
//   PULSE packet (type 0x72, 17 bytes) — single pulse, no tag ID:
//     [0]     0x23  start byte
//     [1]     0x72  type
//     [2-3]         unk0
//     [4-6]         halfSecs  (24-bit LE)
//     [7]           pad
//     [8-9]         ticks     (16-bit LE)
//     [10]          width     (pulse width in clock cycles)
//     [11]          pad
//     [12]          avgADC    (0-255)
//     [13]          pad
//     [14]          maxADC    (0-255)
//     [15]          pad
//     [16]          checksum
//
//   Output records (written to AllOut / emitted as events):
//
//   Pulse:  emitted as vahData, format matches pulsefilter.js parsePulse:
//     p<port>,<ts>,0,<maxADC>,<avgADC>,<maxADC-avgADC>
//   fields: port, ts, freq=0 (n/a), sig=maxADC, noise=avgADC, snr=maxADC-avgADC
//
//   Burst:  written to AllOut directly + emitted as gotTag for the detection log:
//     n<port>,<ts>,<tagID>,<widthMs>,<maxADC>,<avgADC>
//   where <tagID> is the 16-bit tag ID as a decimal integer, 'n' prefix = NanoBabel.

const {SerialPort} = require('serialport')

let didEnum = false
let debugId = 1
const DEBUG_RAW_HEX = false

const START_BYTE  = 0x23  // '#' — all data packets begin with this
const BURST_TYPE  = 0x74  // tag detection
const PULSE_TYPE  = 0x72  // single pulse (no tag ID)
const BURST_LEN   = 19
const PULSE_LEN   = 17
const CLOCK_FREQ  = 131072  // Hz

// Mode commands — checksum = sum of all preceding bytes mod 256
const CMD_COMBINED = Buffer.from([0x25, 0x44, 0x00, 0x01, 0x03, 0x6D])
const CMD_IDLE     = Buffer.from([0x25, 0x44, 0x00, 0x01, 0x00, 0x6A])

class NanoBabel {
  constructor(matron, dev, options) {
    if (!didEnum) this.enum()

    this.matron = matron
    this.dev = dev
    this.options = options ?? {}
    this.debugRawHex = !!(this.options.debugRawHex ?? DEBUG_RAW_HEX)
    this.sp = null
    this.buffer = Buffer.alloc(0)
    this.retries = 0
    this.deviceEpoch = null  // wall-clock offset: wallTime = deviceEpoch + deviceTimeSecs

    this.matron.on("devRemoved", (dev) => this.devRemoved(dev))
    this.init_sp()
  }

  getPort() { return this.dev?.attr?.port ?? '?' }
  getPath() { return this.dev?.path ?? '<removed>' }

  enum() {
    didEnum = true
    SerialPort.list().then(list => list.forEach(p => console.log("SerialPort: " + JSON.stringify(p) + "\n")))
  }

  close() {
    if (this.sp) {
      if (this.sp.isOpen) this.sp.close()
      this.sp = null
      console.log("Removed " + this.getPath())
    }
  }

  devRemoved(dev) {
    if (!this.dev || dev.path != this.dev.path) return
    this.close()
    this.dev = null
  }

  init_sp() {
    if (!this.dev) return
    this.matron.emit("devState", this.dev.attr.port, "init")
    const path = this.dev.path
    const sp = new SerialPort({
      path,
      baudRate: 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    const did = debugId++

    sp.on("open", () => {
      console.log(`Opened NanoBabel SerialPort #${did} ${path}`)
      setTimeout(() => this.sendInitCommand(), 1000)
    })

    sp.on("close", () => {
      console.log(`NanoBabel SerialPort #${did} ${path} was closed`)
      if (this.dev && !this.dev.state?.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", "port was closed")
    })

    sp.on("error", err => {
      console.log(`Error on NanoBabel SerialPort #${did} ${path}: ${err.message}\nStack: ${err.stack}`)
      if (this.dev && !this.dev.state?.startsWith("err"))
        this.matron.emit("devState", this.dev.attr.port, "error", err.message)
      if (sp.isOpen) sp.close()
      if (this.retries++ < 3) {
        setTimeout(() => this.init_sp(), this.retries < 3 ? 10000 : 60000)
      }
    })

    sp.on("data", data => {
      if (this.debugRawHex) {
        const ts = (Date.now() / 1000).toFixed(3)
        console.log(`NanoBabel raw rx port ${this.getPort()} ts=${ts} len=${data.length} hex=${data.toString('hex')}`)
      }
      this.buffer = Buffer.concat([this.buffer, data])
      this.processBuffer()
    })

    this.sp = sp
    console.log("Starting NanoBabel read stream using SerialPort at", path)
  }

  sendInitCommand() {
    if (!this.dev || !this.sp || !this.sp.isOpen) return
    if (this.debugRawHex) {
      const ts = (Date.now() / 1000).toFixed(3)
      console.log(`NanoBabel raw tx port ${this.getPort()} ts=${ts} hex=${CMD_COMBINED.toString('hex')}`)
    }
    this.sp.write(CMD_COMBINED, err => {
      if (!this.dev) return
      if (err) {
        const msg = `NanoBabel init failed: ${err.message}`
        console.log(msg)
        this.matron.emit("devState", this.getPort(), "error", msg)
        return
      }
      console.log(`NanoBabel port ${this.getPort()}: sent combined mode command`)
      this.matron.emit("devState", this.dev.attr.port, "running")
    })
  }

  processBuffer() {
    while (true) {
      // Find start byte
      const startIdx = this.buffer.indexOf(START_BYTE)
      if (startIdx === -1) {
        if (this.buffer.length > 1) this.buffer = this.buffer.slice(-1)
        break
      }
      if (startIdx > 0) this.buffer = this.buffer.slice(startIdx)

      // Need at least 2 bytes to know the type
      if (this.buffer.length < 2) break

      const dataType = this.buffer[1]
      let packetLen
      if (dataType === BURST_TYPE) {
        packetLen = BURST_LEN
      } else if (dataType === PULSE_TYPE) {
        packetLen = PULSE_LEN
      } else {
        // Not a recognized packet type starting at this position — advance one byte
        this.buffer = this.buffer.slice(1)
        continue
      }

      if (this.buffer.length < packetLen) break

      const packet = this.buffer.slice(0, packetLen)
      const ok = this.parsePacket(packet, dataType)
      this.buffer = this.buffer.slice(ok ? packetLen : 1)
    }
  }

  verifyChecksum(packet) {
    // Checksum = sum of all bytes except the last, mod 256
    let sum = 0
    for (let i = 0; i < packet.length - 1; i++) sum += packet[i]
    return (sum & 0xFF) === packet[packet.length - 1]
  }

  parsePacket(packet, dataType) {
    const port = this.getPort()

    if (!this.verifyChecksum(packet)) {
      console.log(`NanoBabel checksum mismatch on port ${port}: ${packet.toString('hex')}`)
      return false
    }

    if (dataType === BURST_TYPE) {
      this.handleBurst(packet)
    } else if (dataType === PULSE_TYPE) {
      this.handlePulse(packet)
    }

    return true
  }

  wallTs(packet) {
    // Convert device hardware timestamp to calibrated wall-clock seconds.
    // halfSecs and ticks come from every packet at the same offsets [4-6] and [8-9].
    const deviceTimeSecs = packet.readUIntLE(4, 3) * 0.5 + packet.readUInt16LE(8) / CLOCK_FREQ
    if (this.deviceEpoch === null) {
      this.deviceEpoch = Date.now() / 1000 - deviceTimeSecs
      console.log(`NanoBabel port ${this.getPort()}: calibrated deviceEpoch=${this.deviceEpoch.toFixed(3)}`)
    }
    return this.deviceEpoch + deviceTimeSecs
  }

  handlePulse(packet) {
    const port   = this.getPort()
    const avgADC = packet[12]
    const maxADC = packet[14]
    const ts     = this.wallTs(packet).toFixed(4)
    const snr    = maxADC - avgADC

    // Format matches pulsefilter.js parsePulse: p<port>,<ts>,<freq>,<sig>,<noise>,<snr>
    // freq=0 (NanoBabel has no frequency), sig=maxADC, noise=avgADC, snr=maxADC-avgADC
    const record = `p${port},${ts},0,${maxADC},${avgADC},${snr}`
    this.matron.emit("vahData", record)
    console.log(`NanoBabel pulse: ${record}`)
  }

  handleBurst(packet) {
    if (!this.dev) return
    const port     = this.getPort()
    const tagIdRaw = packet.readUInt16LE(10)
    const avgADC   = packet[12]
    const width    = packet[14]
    const maxADC   = packet[16]
    const ts       = this.wallTs(packet).toFixed(4)
    const widthMs  = (width / CLOCK_FREQ * 1000).toFixed(4)

    const record = `n${port},${ts},${tagIdRaw},${widthMs},${maxADC},${avgADC}`

    if (typeof AllOut !== 'undefined') AllOut.write(record + '\n')
    this.matron.emit("gotTag", record)
    console.log(`NanoBabel burst: ${record}`)
  }
}

module.exports = NanoBabel
