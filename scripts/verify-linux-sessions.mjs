// Real Linux HTTP integration test. Uses only disposable containers and a named volume.
// Usage: PODMAN_CONNECTION=agentcore-builder node scripts/verify-linux-sessions.mjs IMAGE
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);
const image = process.argv[2];
if (!image) throw new Error('Supply a locally built Linux image');
const security = process.env.AGENTCORE_TEST_DISABLE_SELINUX_LABEL === '1' ? ['--security-opt', 'label=disable'] : [];
const prefix = process.env.PODMAN_CONNECTION ? ['--connection', process.env.PODMAN_CONNECTION] : [];
async function podman(...args) { return (await exec('podman', [...prefix, ...args], { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
const tag = `sandbox-proof-${randomBytes(5).toString('hex')}`;
const temp = await mkdtemp(join(tmpdir(), tag));
const volume = `${tag}-shared`;
const names = [];
const results = [];
const record = (test, detail) => { results.push({ test, detail }); console.log(`PASS ${test}: ${detail}`); };
try {
  await podman('volume', 'create', volume);
  // Deliberately make the data readable/writable to both containers at the Unix
  // permission layer, so a denial proves more than different POSIX owners.
  await podman('run', '--rm', '--user', '0', '-v', `${volume}:/shared`, image,
    'sh', '-c', 'mkdir -p /shared/alice/a /shared/alice/b && chmod -R 777 /shared');
  const sessions = [];
  for (const id of ['a', 'b']) {
    const token = randomBytes(32).toString('hex');
    const envFile = join(temp, `${id}.env`);
    await writeFile(envFile, `AGENTCORE_HOST=0.0.0.0\nAGENTCORE_WORKDIR=/shared\nAGENTCORE_SANDBOX_UID=alice\nAGENTCORE_SANDBOX_SESSION_ID=${id}\nAGENTCORE_RUNLOOP_API_TOKEN=${token}\n`, { mode: 0o600 });
    const name = `${tag}-${id}`; names.push(name);
    await podman('run', '-d', ...security, '--name', name, '--memory', '512m', '--pids-limit', '128',
      '-p', '127.0.0.1::8080', '--env-file', envFile, '-v', `${volume}:/shared`, image);
    assert.notEqual(await podman('exec', name, 'id', '-u'), '0', 'service must not run as root');
    assert.equal(await podman('inspect', '--format', '{{.HostConfig.Privileged}}', name), 'false');
    const binding = await podman('port', name, '8080');
    const port = binding.match(/:(\d+)$/)?.[1]; assert.ok(port);
    const base = `http://127.0.0.1:${port}`;
    let ready;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(20000) }); if (ready.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
      // A started listener reporting sandbox failure is actionable; do not retry
      // for minutes or turn off the sandbox to manufacture a successful result.
      if (ready?.status === 503) break;
    }
    if (ready?.status === 503) {
      // Fixture-only diagnostic: no production credentials, no token in CLI arguments.
      const diagnostic = await podman('exec', name, 'node', '--input-type=module', '-e',
        `import {NativeExecutor} from './dist/src/sandbox-service/executor.js';
         import {loadSandboxConfig} from './dist/src/sandbox-service/config.js';
         const e=new NativeExecutor(loadSandboxConfig());
         try {await e.prepare()} catch(x) {console.log(x.cause?.message ?? x.message)} finally {await e.close()}`);
      console.error('NATIVE_PREFLIGHT_DIAGNOSTIC', diagnostic);
    }
    assert.equal(ready?.status, 200, `session ${id} native preflight (expected 200, observed ${ready?.status})`);
    const headers = { Authorization: `Bearer ${token}` };
    const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(70000) });
    const command = async code => {
      const response = await request('/v1/exec', { method: 'POST', body: JSON.stringify({ command: '/usr/local/bin/node', args: ['-e', code] }) });
      assert.equal(response.status, 200); return response.json();
    };
    sessions.push({ id, name, request, command });
    record(`session-${id}-ready`, 'native preflight succeeded, non-root service');
  }
  if (process.env.AGENTCORE_TEST_DIAGNOSTICS === '1') {
    for (const s of sessions) {
      for (const payload of [
        { command: '/bin/sh', args: ['-c', 'printf hello; printf error >&2; exit 7'] },
        { command: '/usr/local/bin/node', args: ['--openssl-config=/dev/null', '-e', 'console.log(42);process.exitCode=5'] },
        { command: '/usr/local/bin/node', args: ['-e', 'const fs=require("node:fs");fs.writeSync(1,"sync-output\\n");process.stdout.on("error",e=>fs.writeSync(2,String(e.code)));process.stdout.write("stream-output\\n")'] },
      ]) {
        const response = await s.request('/v1/exec', { method: 'POST', body: JSON.stringify(payload) });
        console.log('FIXTURE_DIAGNOSTIC', s.id, await response.json());
      }
    }
  }
  for (const s of sessions) {
    const result = await s.command(`require('node:fs').writeFileSync('command.txt', ${JSON.stringify(s.id)}); console.log(6*7)`);
    assert.equal(result.exitCode, 0); assert.equal(result.stdout.trim(), '42', JSON.stringify(result));
    const data = new Uint8Array([0, 255, 128, s.id.charCodeAt(0)]);
    assert.equal((await s.request('/v1/files?path=data.bin', { method: 'PUT', body: data })).status, 201);
    const download = await s.request('/v1/files?path=data.bin'); assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), data);
    assert.equal((await s.request('/v1/directories')).status, 200);
    record(`session-${s.id}-normal`, 'command + binary upload/download + list succeeded');
  }
  for (const s of sessions) {
    const other = s.id === 'a' ? 'b' : 'a';
    const visible = await podman('exec', s.name, 'cat', `/shared/alice/${other}/command.txt`);
    assert.equal(visible, other);
    record(`session-${s.id}-mount-control`, 'unsandboxed container diagnostic can read sibling sentinel on the shared mount');
    const setup = await s.command(`require('node:fs').symlinkSync('/shared/alice/${other}', 'escape')`);
    assert.equal(setup.exitCode, 0);
    for (const path of [`/shared/alice/${other}/command.txt`, `../${other}/command.txt`, 'escape/command.txt']) {
      for (const operation of ['read', 'write']) {
        const action = operation === 'read' ? `fs.readFileSync(p)` : `fs.writeFileSync(p, 'CORRUPTED')`;
        const result = await s.command(`const fs=require('node:fs'),p=${JSON.stringify(path)};try{${action};process.exitCode=9}catch(e){console.log(e.code)}`);
        assert.equal(result.exitCode, 0, `${s.id} ${operation} ${path}`);
        assert.match(result.stdout.trim(), /^(EACCES|EPERM|ENOENT|EROFS)$/);
        record(`session-${s.id}-command-${operation}`, `${path}: denied (${result.stdout.trim()})`);
      }
      for (const method of ['GET', 'PUT']) {
        const response = await s.request(`/v1/files?path=${encodeURIComponent(path)}`, { method, ...(method === 'PUT' ? { body: 'CORRUPTED' } : {}) });
        assert.equal(response.status, path.startsWith('escape/') ? 422 : 400);
        record(`session-${s.id}-file-${method}`, `${path}: HTTP ${response.status}`);
      }
    }
    for (const path of [`/shared/alice/${other}/api-new-file`, `../${other}/api-new-file`, 'escape/api-new-file']) {
      const response = await s.request(`/v1/files?path=${encodeURIComponent(path)}`, { method: 'PUT', body: 'CORRUPTED' });
      assert.equal(response.status, path.startsWith('escape/') ? 422 : 400);
      record(`session-${s.id}-file-create`, `${path}: HTTP ${response.status}`);
    }
    const create = await s.command(`const fs=require('node:fs');try{fs.writeFileSync('/shared/alice/${other}/new-file','bad');process.exitCode=9}catch(e){console.log(e.code)}`);
    assert.equal(create.exitCode, 0); assert.match(create.stdout.trim(), /^(EACCES|EPERM|ENOENT|EROFS)$/);
  }
  for (const s of sessions) {
    assert.equal(await (await s.request('/v1/files?path=command.txt')).text(), s.id);
    const clean = await s.command("console.log(require('node:fs').existsSync('new-file') || require('node:fs').existsSync('api-new-file'))");
    assert.equal(clean.stdout.trim(), 'false');
    record(`session-${s.id}-integrity`, 'original sentinel unchanged; cross-session new file absent');
  }
  console.log(JSON.stringify({ status: 'passed', image, assertions: results.length, platform: await podman('exec', names[0], 'uname', '-sm'), securityOptions: security }));
} finally {
  for (const name of names) await podman('rm', '-f', name).catch(() => {});
  await podman('volume', 'rm', volume).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
