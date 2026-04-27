This is a fork of (https://github.com/tve/sensorgnome-control)[sensorgnome-control].

---

Environmental Sensor for SensorGnome
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

With internet connection, run: curl -sSL https://raw.githubusercontent.com/sensorgnome-org/enviroPi/sensorgnome/install.sh | sudo bash


---

## To do

- Mods to flexdash
    -- download button
        