
Additional Cell Modem controls for SensorGnome
===========

This repo is for building and testing environmental sensor logging with the SensorGnome using the SQM-LU light level sensor and a custom bonnet for the raspberry pi with the PMS5003 particulate sensor and BME/BMP280 for air temperature, pressure, and humidity.


### Details

A total of three sensors on two hardware components are used to measure:

    Particulates (pm1.0, pm2.5,pm10) - PMS5003
    Humidity, temperature, air pressure - BME280
    Light levels - SQM-LU

Air sensors are all attached to a custom-built "bonnet" for the Raspberry Pi purpose-built for Motus, using the pin headers for connection plus a daughter board for with

Light level sensor is a USB device made by UniHedron used to detect light pollution.
# Installation

With internet connection, run: 
```
curl -sSL https://raw.githubusercontent.com/sensorgnome-org/enpi/sensorgnome/install.sh | sudo bash -s -- enpi-cell
```


---

## To do

### Localization

- Sources:
    - GPS       // Location based on GPS
    - Manual    // User enters the location manually
    - Internet  // Location is estimated using IP (internet-connected stations only)
    - Cell      // Location is estimated based on cellular towers (cell-enabled stations only)
- States:
    - Active    // Location was recorded recently
    - Backup    // Location was not recorded recently
    - None      // No location has been recorded


- Prioritization

. | Active | Backup
-- | -- | -- 
GPS | 1 | 5
Manual | 2 | 2
Internet | 3 | 6
Cell | 4 | 7

- Notes:
    - Web interface needs to allow users to set priority
    - Need to create a warning when there are certain conflicts

-----


---

## Scripts

### Get enpi version

```

python3 - << "EOF"
import sys
sys.path.insert(0, "/opt/sensorgnome/enpi")
from enpi import __version__
print(__version__)
EOF

```