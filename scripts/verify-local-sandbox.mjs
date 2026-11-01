// Real Codex/Linux enforcement check. No model or cloud credentials required.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { localSandboxConfig, localSandboxOverrides } from '../dist/vendor/runloop/src/acp/local-sandbox.js';
const root = await mkdtemp(join(tmpdir(), 'agentcore-native-isolation-'));
const helperHome = await mkdtemp(join(process.cwd(), '.sandbox-test-home-'));
const server = createServer(socket => socket.end());
try {
  const user = join(root, 'user-a'), other = join(root, 'user-b'), home = helperHome;
  const cwd = join(user, 'session');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(other)]);
  await writeFile(join(other, 'secret'), 'other-user-data');
  await symlink(other, join(cwd, 'escape'));
  const cli = process.env.AGENTCORE_AGENT_CLI ?? 'codex';
  const config = await localSandboxConfig({ userRoot: user, readRoots: [] }, cwd, cli);
  await writeFile(join(home, 'config.toml'), 'default_permissions = "agentcore_local"\n' + config.join('\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    fs.writeFileSync('allowed', 'ok');
    assert.equal(fs.readFileSync('allowed', 'utf8'), 'ok');
    fs.writeFileSync('../user-level', 'ok');
    for (const p of [${JSON.stringify(join(other, 'secret'))}, '../../user-b/secret', 'escape/secret']) {
      assert.throws(() => fs.readFileSync(p));
      assert.throws(() => fs.writeFileSync(p, 'overwrite'));
    }
    const socket = require('node:net').connect(${port}, '127.0.0.1');
    socket.on('connect', () => { console.error('NETWORK_ESCAPE'); socket.destroy(); process.exitCode = 2; });
    socket.on('error', () => console.log('PASS: user read/write, cross-user and symlink denial, network denial'));
    socket.setTimeout(1000, () => { socket.destroy(); console.log('PASS: network unreachable'); });
  `;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(cli, ['sandbox', '-P', 'agentcore_local', '-C', cwd, ...localSandboxOverrides(config).flatMap(value => ['-c', value]), '--', process.execPath, '--openssl-config=/dev/null', '-e', probe], {
      env: { ...process.env, CODEX_HOME: home }, stdio: 'inherit',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, 'Native sandbox unavailable or isolation assertions failed; never bypass it');
} finally {
  server.close();
  await rm(helperHome, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
