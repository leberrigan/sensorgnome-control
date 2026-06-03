#! /bin/bash -e
DESTDIR=build-temp
sudo rm -rf $DESTDIR
mkdir $DESTDIR

# npm update to pull in the latest versions of all dependencies
(cd src; npm --no-fund update)

# install FlexDash in there
mkdir src/public/flexdash
curl -L https://s3.amazonaws.com/s3.voneicken.com/flexdash/flexdash-0.4.90.tgz | \
    tar xzf - -C src/public/flexdash

# generate flexdash.html from the tarball's index.html, prefixing asset paths with ./flexdash/
# and injecting the socket.io connection options so sendIndexHtml can patch the title
python3 - <<'EOF'
with open('src/public/flexdash/index.html') as f:
    html = f.read()
html = html.replace('src="./assets/', 'src="./flexdash/assets/')
html = html.replace('href="./assets/', 'href="./flexdash/assets/')
html = html.replace('href="./favicon.ico"', 'href="./flexdash/favicon.ico"')
html = html.replace('flexdash_options = {}',
    "flexdash_options = {\n        title: 'SG',\n        sio: window.location.origin + '/fd'\n      }")
with open('src/public/flexdash.html', 'w') as f:
    f.write(html)
print('Generated flexdash.html from flexdash/index.html')
EOF

# install the control application files as user gnome=1000
SG=$DESTDIR/opt/sensorgnome
install -d $SG/control
cp -r src/* $SG/control
cp gen-support $SG
cp install-node-18.sh $SG
sudo chown -R 1000:1000 $SG/control

# install default acquisition file and tag database into templates dir
sudo install -d $DESTDIR/opt/sensorgnome/templates -o 1000 -g 1000
sudo install -m 644 acquisition.json SG_tag_database.sqlite $DESTDIR/opt/sensorgnome/templates

# service file should be owned by root
sudo install -d $DESTDIR/etc/systemd/system -o 0 -g 0
sudo install -m 644 -o 0 -g 0 *.service $DESTDIR/etc/systemd/system

# logrotate control file
sudo install -d $DESTDIR/etc/logrotate.d
sudo install -m 644 sg-control.rotate $DESTDIR/etc/logrotate.d/sg-control

cp -r DEBIAN $DESTDIR
sed -e "/^Version/s/:.*/: $(TZ=PST8PDT date +%Y.%j)/" -i $DESTDIR/DEBIAN/control # set version: YYYY.DDD
mkdir -p packages
dpkg-deb -Zxz --build $DESTDIR packages
# dpkg-deb --contents packages
ls -lh packages
