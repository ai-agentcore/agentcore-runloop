# Performance measurements and reproduction

[简体中文](performance.md) · [README](../README.en.md)

## Latest retest: 4 vCPU / 8 GiB, sequential requests

At 11:09 UTC+8 on 2026-11-02, we planned 10 sequential requests to a new Endpoint. **Six were issued: five succeeded, then HTTP 429 stopped the run.** No concurrent requests or retries were used; each request had a new session. The deployer reported **4 vCPU / 8 GiB and 20 sessions**. The previously supplied model name, `qwen3.8-max`, was carried forward without independent verification. The prompt below was unchanged and requested only `BENCH_OK`.

| Client-observed metric (5 successful samples) | Min | P50 | Max |
| --- | ---: | ---: | ---: |
| First SSE event | 0.028 s | 0.044 s | 0.292 s |
| First text increment, including activity text | 1.050 s | **1.325 s** | 6.955 s |
| First final-answer text | 1.675 s | **1.923 s** | 7.555 s |
| Completion | 1.675 s | **1.923 s** | 7.555 s |

The first request took 6.955 s to first text; this is not a verified cold start. The next four successful requests ranged from 1.050 to 1.536 s, with a median of 1.272 s. The table retains the slow first sample. First text measures receipt of a nonempty text increment at the client, not exact model-server TTFT. Applications showing only final-answer events should use the first-final-answer metric.

HTTP 429 indicates a request limit, but the upstream error body was not collected, so its source is unverified. A configured 20-session allowance does not establish support for 20 concurrent requests. This run does not measure concurrent capacity, long-output throughput or tool workloads, nor establish a benefit from increased CPU/memory. [Sanitized samples](performance-4c8g-samples.json).

The old Endpoint measurements below are retained as history and must not be pooled with this run.

## Historical run: 1 vCPU / 2 GiB

The preliminary run on 2026-11-02 recorded **5 successful requests and 4 HTTP 502 responses out of 9 requests**. Among successful requests, median first visible text was **1.35 s** and median completion was **1.95 s**. The service continued returning 502, so further probing stopped. This is not a stable performance baseline, concurrency capacity measurement or production SLA.

The deployer reported `qwen3.8-max`, 1 vCPU / 2 GiB, in Hangzhou. Hardware was not independently checked through the control plane. The deployed image tag, execution mode, Skill/MCP bindings, instance count, cold/warm state and model caching state are unknown. A macOS client measured the service over the public network; the full duration cannot be attributed to AgentCore or Codex alone.

## Workload and success criteria

- Prompt: `Reply with exactly BENCH_OK. Do not use tools.` Expected output: 8 characters.
- Each AG-UI request used a fresh thread ID with an identical `X-AgentCore-Session-ID`, plus unique run and message IDs.
- Requests contained empty `tools`, `context`, `state` and `forwardedProps`. This does not establish that no server-side MCP tools or Skills were bound. The successful samples emitted no tool-call events.
- Success requires HTTP 200, valid SSE, `RUN_FINISHED`, no `RUN_ERROR`, and a final answer equal to `BENCH_OK`. HTTP 200 alone is insufficient.
- No automatic retries. Failures remain in the request denominator; latency statistics use successful requests only.

## Samples and latency

| Phase | Requests | Successful | Observation |
| --- | ---: | ---: | --- |
| First observation | 1 | 1 | First text 2.00 s; completion 2.60 s. Not a verified cold start. |
| Subsequent sequential requests | 5 | 4 | The fifth returned HTTP 502; sequential sampling stopped. |
| Concurrency 2 | 2 | 0 | Both returned HTTP 502. This does not establish concurrency capacity. |
| Single recovery check | 1 | 0 | HTTP 502 persisted about 72 seconds after the first failure. |
| Total | **9** | **5** | **5/9 (55.6%)**, limited to this sample. |

The planned follow-up was 10 sequential requests and 3 pairs at concurrency 2. The initial probe still issued the first concurrent pair after the sequential phase failed; both requests failed and further pairs stopped. Recovery was checked separately. The reproduction script now stops all subsequent phases on any failed request or failed pair.

The following timings include **5 successful samples only**, in seconds. P50 is the sample median. The sample is too small to report meaningful P95/P99 values.

| Client-observed metric | Min | P50 | Max |
| --- | ---: | ---: | ---: |
| First SSE event | 0.032 | 0.044 | 0.266 |
| First visible text, activity or final answer | 1.117 | 1.347 | 2.004 |
| First final-answer text | 1.750 | 1.954 | 2.601 |
| Completion, `RUN_FINISHED` | 1.750 | 1.954 | 2.601 |

Timing starts immediately before client `fetch`, using a monotonic clock. The first event can be `RUN_STARTED`, not an answer. The adapter streams candidate activity through `THINKING_TEXT_MESSAGE_CONTENT` and promotes the final candidate to `TEXT_MESSAGE_CONTENT` on completion. First visible text and first final-answer text are therefore distinct; neither is a model-server TTFT measurement. Activity and final-answer text can repeat the same content, so adding their character counts would inflate throughput.

[Sanitized per-request measurements](performance-samples.json) include every success and failure, without endpoints, credentials, session identifiers or raw response bodies. The cause of HTTP 502 is unknown. It must not be presented as confirmed OOM, model failure or throttling; gateway logs, instance restart records and model invocation logs are needed to determine the cause.

## Reproduce

Use Node.js 22+. These variables belong only to the measurement script and do not change Agent runtime configuration. Set your HTTPS AG-UI endpoint and enter the API key without echoing it or storing it in shell history or source files.

```sh
export AGENTCORE_BENCHMARK_URL='https://<your-agent-endpoint>/ag-ui/agent'
printf 'API key: '
IFS= read -r -s AGENTCORE_BENCHMARK_API_KEY
printf '\n'
export AGENTCORE_BENCHMARK_API_KEY
AGENTCORE_BENCHMARK_REQUESTS=10 node scripts/benchmark-agui.mjs > /tmp/agentcore-benchmark.json
unset AGENTCORE_BENCHMARK_API_KEY
```

By default the script runs 10 sequential requests only. After confirming stability, prefix the command with `AGENTCORE_BENCHMARK_PAIRS=3` to run three pairs at concurrency 2 after all sequential requests succeed. Each request has a 120-second timeout. Limits are 30 sequential requests and 3 pairs; any failure stops subsequent phases and produces a nonzero exit status. Output contains metrics only, without credentials, endpoints or raw response bodies.

Script checks: `node --test scripts/benchmark-agui.test.mjs`.

## Workloads still to validate

Short answers establish only basic connectivity. Business-level evidence should separately measure file processing, Skill loading, MCP calls, artifact publication, and end-to-end task correctness and duration, with inspectable input and deliverables. Concurrency tests require known instance counts and scaling policy. Cold-start tests require a confirmed new or recreated instance. None of these was completed in this run, so they are not presented as verified case studies.
