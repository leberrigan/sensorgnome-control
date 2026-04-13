
Additional Cell Modem controls for SensorGnome
===========

This repo is for testing out new cell modem controls on the SensorGnome. In particular, helping troubleshoot modem connection to Canadian cell providers.

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
3. Copy rules file to `/etc/udev/rules.d/`
    ```
    sudo cp -r rules.d/ /etc/udev/rules.d/
    ```
4. Stop `sg-control`
    ```
    sudo systemctl stop sg-control
    ```

5. Install node packages
    ```
    cd /src
    sudo npm install
    cd ..
    ```
6. Run the wrapper shell script
    ```
    sudo ./mon.sh
    ```


The last command should start the sg-control process using the files from the repo rather than what's installed on the SG.
