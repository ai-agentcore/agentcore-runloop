import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { NativeExecutor } from '../dist/src/sandbox-service/executor.js';
import { createSandboxApp } from '../dist/src/sandbox-service/app.js';

const root = await mkdtemp(join(tmpdir(), 'sandbox-service-proof-'));
const token = 'fixture-token-for-native-smoke-only-0000000';
const executor = new NativeExecutor({ root, uid: 'alice', sessionId: 'one', cli: process.env.AGENTCORE_SANDBOX_CLI ?? 'codex', token, host: '127.0.0.1', port: 8080 });
const server = createServer(socket => socket.end());
try {
  const other = join(root, 'alice', 'two');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'secret'), 'other-session-secret');
  await executor.initialize();
  await symlink(other, join(root, 'alice', 'one', 'escape'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    fs.writeFileSync('allowed','ok'); assert.equal(fs.readFileSync('allowed','utf8'),'ok');
    for (const p of [${JSON.stringify(join(other, 'secret'))}, '../two/secret', 'escape/secret']) {
      assert.throws(() => fs.readFileSync(p)); assert.throws(() => fs.writeFileSync(p,'bad'));
    }
    assert.throws(() => fs.writeFileSync('../outside','bad'));
    assert.equal(process.env.AGENTCORE_RUNLOOP_API_TOKEN, undefined);
    assert.throws(() => fs.readFileSync(require('node:path').join(process.env.CODEX_HOME, 'config.toml')));
    const socket = require('node:net').connect(${port}, '127.0.0.1');
    socket.on('connect',()=>{socket.destroy();process.exitCode=7});
    socket.on('error',()=>{});socket.setTimeout(1000,()=>socket.destroy());
  `;
  const result = await executor.run([process.execPath, '--openssl-config=/dev/null', '-e', probe]);
  assert.equal(result.exitCode, 0, 'Native command isolation failed');
  assert.equal(await readFile(join(other, 'secret'), 'utf8'), 'other-session-secret');
  const app = createSandboxApp(token, executor);
  const headers = { Authorization: `Bearer ${token}` };
  const data = new Uint8Array([0, 255, 10, 13, 128]);
  assert.equal((await app.request('/v1/files?path=bytes', { method: 'PUT', headers, body: data })).status, 201);
  assert.deepEqual(new Uint8Array(await (await app.request('/v1/files?path=bytes', { headers })).arrayBuffer()), data);
  assert.equal((await app.request('/v1/files?path=escape/secret', { headers })).status, 422);
  assert.equal((await app.request('/v1/files?path=bytes', { method: 'PUT', headers, body: data })).status, 422);
  assert.equal((await app.request('/v1/directories', { headers })).status, 200);
  console.log('PASS: real native sandbox, session read/write, sibling and symlink denial, network denial, binary HTTP roundtrip');
} finally {
  server.close();
  await executor.close();
  await rm(root, { recursive: true, force: true });
}
