This is a fork of (https://github.com/tve/sensorgnome-control)[sensorgnome-control].

---

Environmental Sensor for SensorGnome
===========

This repo is for building and testing environmental sensor logging with the SensorGnome using the SQM-LU light level sensor and a custom bonnet for the raspberry pi with the PMS5003 particulate sensor and BME/BMP280 for air temperature, pressure, and humidity.


---

Testing instructions:
 

1. Clone the repo to the home folder: 
    ```
    cd /home/gnome/
    sudo git clone --branch cell_options --single-branch https://github.com/leberrigan/sensorgnome-control-enpi.git
    ```
2. Change directory to the repo folder 
    ```
    cd /home/gnome/sensorgnome-control
    ```

3. Stop `sg-control`
    ```
    sudo systemctl stop sg-control
    ```

4. Install node packages
    ```
    cd src
    sudo npm install
    ```
5. Run the wrapper shell script
    ```
    cd ..
    sudo ./mon.sh
    ```


The last command should start the sg-control process using the files from the repo rather than what's installed on the SG.

---

## To do

- Mods to flexdash
    -- enpi status
        - on
        - off
        - error
    -- enpi toggle
        - on/off
    -- enpi sample rate
    -- sample schedule
    -- aws bucket name
    -- aws connection status
    -- change bucket and auth key
    -- upload status
        - was the last upload successful
        - what files are waiting to upload
    -- download button
        