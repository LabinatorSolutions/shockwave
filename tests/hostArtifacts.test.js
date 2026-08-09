// The host artifacts: everything the companion puts on the server OUTSIDE its
// containers — the runtime files in the install directory, the one command on
// PATH, and the symlink pointing at it.
//
// These used to be fetched from raw.githubusercontent by a hardcoded list that
// appeared twice: once in install.sh and once in updater/apply.sh. This file
// existed to keep those two lists in agreement, and it did — while missing the
// failure that actually happened, because the dangerous copy of the list is
// neither of these. It is the one ON THE SERVER, inside whatever apply.sh that
// box last installed.
//
// Deleting api/traefik/gen-router.sh in v1.0.85 (the cert fix) removed it from
// both lists here, so the suite stayed green — and jammed every box still on
// v1.0.84 permanently. Their apply.sh still named the file, the fetch 404'd,
// and the fetch is upstream of the step that would have replaced apply.sh. The
// desktop reported the upgrade as accepted every time.
//
// So the list is gone. The host files ship INSIDE the image (api/Dockerfile,
// /host-files) and both paths copy them out of the tagged image, which means
// the file set always comes from the release being installed and there is
// nothing on the server that can be stale. What is pinned here is that
// property, plus the host-artifact rules that survived it:
//
//   1. The image delivers every file the host needs.
//   2. Neither script carries a runtime-file list or fetches runtime files
//      over the network — reintroducing either brings the whole class back.
//   3. apply.sh moves files into place, never copies over them (it is
//      replacing itself while the shell is still reading it).
//   4. install.sh creates exactly ONE symlink on PATH, to the dispatcher.
//   5. apply.sh creates none. It cannot: watch.sh mounts only the install
//      directory into the helper. That is what makes rule 4 load-bearing —
//      the symlink target must never change, or upgrades can't maintain it.
//   6. Directly-executed files ship executable, since `docker cp` preserves
//      the mode the image was built with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = fs.readFileSync(path.join(root, 'api/install.sh'), 'utf8');
const apply = fs.readFileSync(path.join(root, 'api/updater/apply.sh'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'api/Dockerfile'), 'utf8');

// The command on PATH. One file, one symlink, forever.
const DISPATCHER = 'host/shockwave';

// Every file the companion needs on the host, as a path relative to the install
// directory. This list lives HERE and nowhere else: it is an assertion about
// what a release must deliver, not a thing any script reads. A script holding
// it is what this file exists to prevent.
const REQUIRED = [
  'docker-compose.yml',
  'init.sql',
  'traefik/traefik.yml',
  'updater/watch.sh',
  'updater/apply.sh',
  DISPATCHER,
];

// Where the image stages the host files, mirroring the install dir's layout.
const IMAGE_DIR = '/host-files';

// Resolve the Dockerfile's COPY lines into /host-files to the set of paths they
// land at, relative to the install directory. A source ending in `/` is a
// directory and contributes every file in it.
function deliveredByImage() {
  const landed = new Set();
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    const dest = parts.pop();
    if (!dest.startsWith(IMAGE_DIR)) continue;
    // '/host-files/' -> '', '/host-files/traefik/' -> 'traefik/'
    const prefix = dest.slice(IMAGE_DIR.length).replace(/^\/+/, '');
    for (const src of parts) {
      if (src.endsWith('/')) {
        const dir = path.join(root, src);
        for (const name of fs.readdirSync(dir)) {
          if (fs.statSync(path.join(dir, name)).isFile()) landed.add(prefix + name);
        }
      } else {
        landed.add(prefix + path.basename(src));
      }
    }
  }
  return landed;
}

test('the image delivers every file the host needs', () => {
  const landed = deliveredByImage();
  const missing = REQUIRED.filter((f) => !landed.has(f));
  assert.deepEqual(missing, [],
    `these must be on the server but no Dockerfile COPY puts them in ${IMAGE_DIR}: ${missing.join(', ')}. `
    + 'Both install.sh and apply.sh take the host files out of the image, so a file the image '
    + 'does not carry is one no install and no upgrade can ever deliver.');
});

// Comments explain these rules, so matching raw text would flag the explanation
// as a violation. Assert against the code only.
const code = (sh) => sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('neither path fetches runtime files over the network', () => {
  for (const [name, sh] of [['install.sh', install], ['apply.sh', apply]]) {
    assert.doesNotMatch(code(sh), /raw\.githubusercontent\.com/,
      `${name} must take the host files out of the image, not off GitHub. Fetching them by path `
      + 'reintroduces a file list, and the copy that matters is the one frozen on the server.');
  }
});

test('apply.sh derives what to install from the image, never from a list', () => {
  // The staged set is discovered by walking what the image actually shipped.
  assert.match(code(apply), /find \. -type f/,
    'apply.sh must install whatever the image carries — a hardcoded FILES list is the bug '
    + 'this design removed: it is baked into the copy on the server and frozen at the release '
    + 'that box last installed.');
  assert.doesNotMatch(code(apply), /^FILES="/m,
    'apply.sh must not declare a runtime-file list.');
});

test('apply.sh moves files into place and never copies over them', () => {
  assert.match(code(apply), /\bmv "\$STAGE\//,
    'apply.sh replaces itself while the shell is still reading it, so the install has to be a '
    + 'rename (which swaps the inode and leaves our open fd on the old one), never a copy.');
  assert.doesNotMatch(code(apply), /\bcp\s+[^\n]*"\$COMPANION_DIR/,
    'copying over $COMPANION_DIR truncates the running apply.sh in place.');
  // A rename only works within one filesystem, so the staging dir has to sit in
  // the bind-mounted install dir rather than the container's own /tmp.
  assert.match(code(apply), /mktemp -d "\$COMPANION_DIR\//,
    'the staging dir must be inside $COMPANION_DIR or every mv is a cross-device copy, '
    + 'which is the in-place overwrite the rename exists to avoid.');
});

test('install.sh creates exactly one symlink on PATH, to the dispatcher', () => {
  const links = [...install.matchAll(/ln -sf?\s+"?([^"\s]+)"?\s+"?(\/usr\/local\/bin\/[^"\s]+)"?/g)]
    .map((m) => ({ target: m[1], link: m[2] }));
  assert.equal(links.length, 1,
    `expected exactly 1 symlink into /usr/local/bin, found ${links.length}: ${links.map((l) => l.link).join(', ')}. `
    + 'Add subcommands to api/host/shockwave instead — a new symlink is a host artifact upgrades cannot create.');
  assert.match(links[0].target, /\$DIR\/host\/shockwave$/);
  assert.equal(links[0].link, '/usr/local/bin/shockwave');
});

test('apply.sh creates no symlinks and writes nothing outside the install dir', () => {
  assert.doesNotMatch(code(apply), /\bln -s/,
    'apply.sh cannot make symlinks — watch.sh mounts only $COMPANION_DIR into its helper.');
  assert.doesNotMatch(code(apply), /\/usr\/local\/bin/,
    'apply.sh cannot write to /usr/local/bin — it is not mounted.');
});

test('the dispatcher ships executable and both paths assert it', () => {
  const st = fs.statSync(path.join(root, 'api', DISPATCHER));
  assert.ok(st.mode & 0o111,
    `api/${DISPATCHER} must be executable in the repo — the image COPY preserves this mode and `
    + '`docker cp` carries it to the host, so the repo bit is now what makes the command runnable.');
  for (const [name, sh] of [['install.sh', install], ['apply.sh', apply]]) {
    assert.match(code(sh), new RegExp(`chmod 755 "\\$\\{?\\w+\\}?/${DISPATCHER}"`),
      `${name} must also chmod 755 ${DISPATCHER} — /usr/local/bin/shockwave points at it, and a `
      + 'file that lands 644 is a command that reports "permission denied" with nothing to explain why.');
  }
});
