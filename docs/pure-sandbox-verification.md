# Pure Sandbox service verification — 2026-10-27

Branch: `codex/pure-sandbox-service`, based on `with-agent-sandbox`.
No deployment, image publication, commit or push was performed.

## Observed local results

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run test:coverage`: 23 files, 279 tests passed; statements/lines 95.35%,
  branches 88%, functions 96.4%. Existing thresholds were not reduced.
- `npm run test:upstream`: 24 files, 358 tests passed.
- `npm run smoke:native-service`: passed with real Codex CLI 0.155.0 on macOS.
  Verified session-local writes, denied sibling absolute/relative reads and writes,
  denied symlink escape, denied control-home read, denied loopback network access,
  binary HTTP upload/download, create-only writes, and directory listing.
- The existing `/bin/true` preflight failed on this macOS host. Added a failing
  regression test first, then changed it to `/usr/bin/true` and reran checks.
- `git diff --check`: passed.

Unit tests mock execution where needed to exercise lifecycle/error paths; those
mocks do not establish OS isolation. The separate smoke script uses the real native
sandbox and no model/cloud calls. Local Node is 20.19.0; the production Dockerfile
still pins the Node 22 slim family. Target-image validation remains outstanding.

## Initial deployment limitation (superseded by the Linux test below)

The configured Podman endpoint refused connections. No Linux image was built or run.
The same native smoke must pass inside the actual Linux container with its real
shared-storage mount, non-root user and runtime security policy. Do not infer Linux
sandbox availability from the macOS result or weaken sandbox policy on failure.

CPU/memory/PID limits and protection against malicious detached processes belong to
the outer runtime. Storage parent directories must not be mutable by untrusted peers.
The first implementation binds one instance to one configured session, runs one
operation at a time, and exposes bounded synchronous execution rather than durable
jobs, PTY, streaming or E2B SDK compatibility.

## Linux shared-volume integration — completed 2026-10-27

Built the current implementation in a real Linux arm64 Podman VM. Final tested image:
`ceeeb0d254ac6ee7efd69c4c9c2c22e0b6815450e6c53556616d65dfa6b5bfcb`.
Runtime: Node 22.23.3, Codex CLI 0.155.0, Debian bookworm slim; Podman client 6.1.2.
No image was pushed and no production storage or identity was used.

### Test setup and control

Two non-root containers, each limited to 512 MiB and 128 PIDs, mounted the same
named volume at `/shared`. Both used uid `alice`, with sessions `a` and `b`.
Parent data directories were deliberately mode 0777. The test asserted each
service user was not uid 0 and each container had `Privileged=false`.
An unsandboxed `podman exec cat` diagnostic successfully read the sibling sentinel
in each direction. Thus the denied HTTP command operations were not caused by a
missing volume or unrelated POSIX ownership.

### Observed results

| Check, run in both directions | Result |
| --- | --- |
| Native sandbox preflight | HTTP 200 under the compatible label configuration below |
| Node command output and local file creation | Success, expected stdout `42` |
| Binary HTTP upload/download | Exact byte equality |
| Directory listing | HTTP 200 |
| Command reads and overwrites: absolute sibling path | Denied, ENOENT in restricted view |
| Command reads and overwrites: parent traversal | Denied, ENOENT in restricted view |
| Command reads and overwrites: symlink to sibling | Denied, ENOENT in restricted view |
| File API reads/writes: absolute or parent path | HTTP 400 |
| File API reads/writes: symlink to sibling | HTTP 422 |
| Cross-session new file creation through command and API | Denied |
| Post-test integrity | Both sentinels unchanged; foreign files absent |

The final run recorded 38 passed checkpoints, plus non-root/privileged-mode checks,
byte equality and explicit command-create assertions. Diagnostic commands additionally
confirmed independent stdout/stderr and a nonzero exit code of 7 were preserved.
The tests use real HTTP requests and real native Linux sandboxing, not mocks.

### Required outer-runtime configuration

Default Podman SELinux labeling failed with:
`bwrap: Can't mount devpts on /newroot/dev/pts: Permission denied`.
The service returned 503; no command execution fallback occurred.

A controlled retry with `--security-opt label=disable` for only the temporary
service containers allowed preflight and the full matrix to pass. No privileged
mode, added SYS_ADMIN capability, seccomp-unconfined setting, legacy Landlock
fallback or Codex permission bypass was used. Default seccomp stayed enabled.
This establishes a compatible test configuration, not universal support for
all default container policies. Production still needs its own compatible SELinux
policy and the same test on its actual mount type; this test used a Podman volume,
not a production OSS/FUSE mount. The OCI image build ignored Docker HEALTHCHECK;
readiness here was tested explicitly through HTTP. Use Docker image format when
retaining that image healthcheck is required.

### Regression discovered and fixed

Before the fix, a Linux sandboxed Node `console.log(42)` returned exit 0 with
empty output, while direct `fs.writeSync` and shell output worked. The failing
HTTP test was preserved before changing the executor. The executor now invokes
a fixed trusted Bash wrapper that converts inherited output socketpairs into
real pipes, without evaluating any caller arguments. Following this change,
Node stream output, binary file downloads and exit status were correct.
The syscall-level cause was not traced; the pipe conversion is verified by the
before/after test, while the socketpair/network interaction remains the diagnosis.

Post-fix checks: typecheck and build passed; 279 tests passed, lines/statements
95.35%, branches 87.99%, functions 96.4%. The macOS native smoke also passed again.
No vendored code changed during this Linux-test follow-up; the earlier 358 upstream
tests remain the result for the unchanged vendored code.

All temporary test containers, shared volumes and credential files were removed.
The local test images are retained for reproduction. No commit or push was made.
