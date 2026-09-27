const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Debian package metadata targets a private runtime and required system services', () => {
  const control = read('packaging/debian/control.in');
  assert.match(control, /^Package: mailbridge$/m);
  assert.match(control, /^Architecture: @ARCH@$/m);
  assert.match(control, /^Depends: .*adduser.*ca-certificates.*libc6.*systemd$/m);
  assert.match(control, /^Recommends: spamd$/m);
  assert.match(control, /bundles a private Node\.js 22 runtime/);
});

test('systemd unit runs unprivileged with protected configuration and writable state only', () => {
  const unit = read('packaging/debian/mailbridge.service');
  assert.match(unit, /^User=mailbridge$/m);
  assert.match(unit, /^Group=mailbridge$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/mailbridge\/mailbridge\.env$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/mailbridge$/m);
  assert.match(unit, /^ReadOnlyPaths=\/etc\/mailbridge$/m);
  assert.doesNotMatch(unit, /AmbientCapabilities|CapabilityBoundingSet=.*CAP_/);
});

test('package scripts preserve configuration and queued mail across removal', () => {
  const postinst = read('packaging/debian/postinst');
  const postrm = read('packaging/debian/postrm');
  const setup = read('packaging/debian/mailbridge-setup');

  assert.match(postinst, /adduser --system/);
  assert.match(postinst, /\/var\/lib\/mailbridge\/queue/);
  assert.match(postinst, /\/var\/lib\/mailbridge\/plugins/);
  assert.match(postinst, /-o root -g mailbridge -m 0750 \/var\/lib\/mailbridge\/plugins/);
  assert.doesNotMatch(postrm, /rm\s+-rf|rm\s+-r/);
  assert.match(postrm, /prevent accidental queued-mail loss/);
  assert.match(setup, /scripts\/setup\.js --system/);
  assert.match(setup, /chmod 0600 .*mailbridge-r2-private\.pem/);
});

test('Debian builder pins and verifies the bundled Node runtime', () => {
  const builder = read('packaging/debian/build-deb.sh');
  assert.match(builder, /node_version="\$\{NODE_VERSION:-22\.23\.2\}"/);
  assert.match(builder, /SHASUMS256\.txt/);
  assert.match(builder, /sha256sum -c/);
  assert.match(builder, /npm ci --omit=dev/);
  assert.match(builder, /dpkg-deb --root-owner-group --build/);
});

test('APT repository publishes only Debian Trixie', () => {
  const distributions = read('packaging/apt-repo/distributions');
  assert.match(distributions, /^Codename: trixie$/m);
  assert.doesNotMatch(distributions, /^Codename: (?:bullseye|bookworm|noble|resolute)$/m);
  assert.doesNotMatch(distributions, /^Architectures:.*arm64/m);
});

test('APT publisher preserves history and signs both repository metadata formats', () => {
  const workflow = read('.github/workflows/deploy-apt-repo.yml');
  assert.match(workflow, /aws s3 sync \"s3:\/\/\$\{R2_BUCKET_NAME\}\/\" apt-repo\//);
  assert.match(workflow, /aws s3 sync apt-repo\/ \"s3:\/\/\$\{R2_BUCKET_NAME\}\/\"/);
  assert.match(workflow, /\.r2\.cloudflarestorage\.com/);
  assert.match(workflow, /aws s3api head-bucket/);
  assert.match(workflow, /R2_ACCOUNT_ID: \$\{\{ vars\.R2_ACCOUNT_ID \}\}/);
  assert.match(workflow, /R2_BUCKET_NAME: \$\{\{ vars\.R2_BUCKET_NAME \}\}/);
  assert.doesNotMatch(workflow, /\$\{!value\}/);
  assert.doesNotMatch(workflow, /rclone/);
  assert.match(workflow, /--detach-sign/);
  assert.match(workflow, /--clearsign/);
  assert.match(workflow, /concurrency:/);
});
