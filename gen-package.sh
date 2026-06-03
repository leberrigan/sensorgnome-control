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

# generate flexdash.html from the tarball's index.html:
#   - prefix asset paths with ./flexdash/
#   - extract the hashed bundle src and load it dynamically after auth (so socket.io
#     never connects until the user has authenticated via the injected overlay)
#   - inject sio/title/username into flexdash_options for server-side patching
python3 - <<'EOF'
import re

with open('src/public/flexdash/index.html') as f:
    html = f.read()

# prefix asset paths for subdirectory extraction
html = html.replace('src="./assets/', 'src="./flexdash/assets/')
html = html.replace('href="./assets/', 'href="./flexdash/assets/')
html = html.replace('href="./favicon.ico"', 'href="./flexdash/favicon.ico"')

# extract the hashed bundle src and remove the script tag; loaded dynamically after auth
m = re.search(r'<script type="module"[^>]+src="([^"]+)"[^>]*></script>', html)
bundle_src = m.group(1) if m else './flexdash/assets/index.js'
html = re.sub(r'<script type="module"[^>]+src="[^"]+"[^>]*></script>', '', html)

# inject flexdash_options with server-patchable placeholders for title and username
html = html.replace('flexdash_options = {}',
    "flexdash_options = {\n        title: 'SG',\n        sio: window.location.origin + '/fd',\n        username: 'gnome'\n      }")

# build auth overlay; bundle src is embedded at build time (hash changes each release)
overlay = '''
  <!-- SG auth overlay: shown until authenticated; bundle is loaded dynamically after login -->
  <div id="sg-auth" style="position:fixed;inset:0;background:#f5f5f5;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:sans-serif">
    <div style="padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);min-width:300px">
      <h2 id="sg-id" style="margin:0 0 1.5rem;font-size:1.1rem;color:#555"></h2>
      <div id="sg-form" style="display:none">
        <label style="display:block;margin-bottom:1rem;font-size:.9rem">User
          <input id="sg-u" type="text" readonly style="display:block;width:100%;padding:.5rem;margin-top:.25rem;border:1px solid #ccc;border-radius:4px;font-size:1rem;box-sizing:border-box;background:#f9f9f9;color:#666">
        </label>
        <label style="display:block;margin-bottom:1.25rem;font-size:.9rem">Password
          <input id="sg-p" type="password" style="display:block;width:100%;padding:.5rem;margin-top:.25rem;border:1px solid #ccc;border-radius:4px;font-size:1rem;box-sizing:border-box">
        </label>
        <button onclick="sgLogin()" style="width:100%;padding:.75rem;background:#1976D2;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:1rem">Login</button>
        <p id="sg-err" style="color:#f44336;margin-top:.75rem;display:none;font-size:.9rem">Incorrect password</p>
      </div>
    </div>
  </div>
  <script>
    ;(function() {
      var bundleSrc = 'BUNDLE_SRC_PLACEHOLDER'
      document.getElementById('sg-id').textContent = flexdash_options.title || 'SG'
      document.getElementById('sg-u').value = flexdash_options.username || 'gnome'
      function sgLoad() {
        document.getElementById('sg-auth').style.display = 'none'
        var s = document.createElement('script')
        s.type = 'module'; s.crossOrigin = 'anonymous'; s.src = bundleSrc
        document.head.appendChild(s)
      }
      window.sgLogin = async function() {
        document.getElementById('sg-err').style.display = 'none'
        var r = await fetch('/login', {method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({user: document.getElementById('sg-u').value,
                                password: document.getElementById('sg-p').value})})
        if (r.ok) sgLoad()
        else document.getElementById('sg-err').style.display = 'block'
      }
      fetch('/auth', {credentials:'include'}).then(function(r) {
        if (r.ok) sgLoad()
        else { document.getElementById('sg-form').style.display = ''; document.getElementById('sg-p').focus() }
      }).catch(function() { document.getElementById('sg-form').style.display = ''; document.getElementById('sg-p').focus() })
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && document.getElementById('sg-form').style.display !== 'none') window.sgLogin()
      })
    })()
  </script>'''.replace('BUNDLE_SRC_PLACEHOLDER', bundle_src)

html = html.replace('</body>', overlay + '\n</body>')

with open('src/public/flexdash.html', 'w') as f:
    f.write(html)
print('Generated flexdash.html from flexdash/index.html (bundle: ' + bundle_src + ')')
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
