
### [sg-control process starts]
      │
      ▼
Main (src/main.js)
  └─ Initiate all the core utilities
        └─ vamp-alsa-host (vah.js)
        └─ gnu-radio-host (grh.js)




### [Device Connects]
      │
      ▼
HubMan (src/hubman.js)
  └─ Watches /dev/sensorgnome for device changes (Fs.watch)
  └─ When a new device file appears:
         └─ Calls devChanged("rename", filename)
             └─ Parses device attributes (type, port, etc.)
             └─ Adds device to internal map
             └─ Emits "devAdded" event to Matron with device info

      │
      ▼
Matron (src/matron.js)
  └─ Listens for "devAdded" events
  └─ On "devAdded":
         └─ Looks up acquisition plan for device (via Acquisition.lookup)
         └─ If a plan is found:
                └─ Creates a new Sensor object:
                       Sensor = Sensor.getSensor(this, dev, devPlan)
         └─ Stores Sensor in Matron.devices[dev.attr.port]
         └─ If type is special (e.g., FSK receiver) no plan is needed:
            └─ 

      │
      ▼
Sensor (src/sensor.js)
  └─ Immediately begins applying its plan:
         └─ Issues commands to start/configure the sensor
            └─ Creates a device object depending on type:
                └─ USBAUDIO (usbaudio.js)
                └─ RTLSDR (rtlsdr.js)
                    └─ Starts tcp srver with sensorgnome-librtlsdr
                └─ AIRSPY (airspy.js)
                    └─ Starts tcp srver with sensorgnome-airspy_tcp/libairspy
         └─ Listens for "devRemoved", "devStalled" events



For GnuRadio integration, follow same workflow as best as possible, except devices are configured using gnuradio plugin (osmosdr) so ignore any creation of sensor objects
    └─ Initiate gnu-radio-host.py 