#!/usr/bin/env node
'use strict';

// ============================================================================
// 融合测试工具（单文件、零依赖）—— 把三个独立测试程序合并为一个 js 程序：
//
//   1) A2A   子 agent      —— 挂在 /a2a          （回显 + HITL：按内容触发 suspend/resume）
//   2) AG-UI 模拟会话       —— 挂在 /ag-ui/agent  （回显 + HITL：按内容触发）
//   3) OpenAI Chat Completions —— 挂在 /openai/v1/chat/completions（stream/非 stream）
//   4) 流式 chunk 压测端点  —— 挂在 /stream        （每 N ms 推一个 NDJSON chunk）
//
// 一个进程、一个端口同时托管以上「程序」，按 path 路由。**HITL 不再有独立 path**——
// /a2a 与 /ag-ui/agent 这两个统一端点按**内容**（关键词，如「删除/授权/请提供」，仿「文章」长文那样；
// 或显式前缀 confirm:/input:/auth:/multi:）触发 suspend/resume，无触发则回显，共用无状态核心 hitlCore。
// 另外内置 client，可作为客户端调用任意接口（通用流式 / A2A / AG-UI / OpenAI 协议感知）。
//
// 协议契约对齐：
//   - A2A 0.3.0，JSON-RPC 2.0：POST <端点> method=message/stream（SSE）/ message/send（单次 JSON）；
//     SSE 每行 `data: <json>\n\n`，事件包在 envelope `{jsonrpc,id,result:<event>}`；
//     AgentCard 在 GET <端点>/.well-known/agent-card.json；HITL 用 input-required/auth-required 暂停。
//   - AG-UI：POST RunAgentInput，SSE 回 `data: <event>\n\n`（事件带 type）；文本走 TEXT_MESSAGE_*，
//     HITL 走 TOOL_CALL_*（前端补 ToolMessage 后再发 run 即 resume）。
//   - OpenAI：POST /openai/v1/chat/completions，stream=true 走 chat.completion.chunk + [DONE]。
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node agent.js [server]                    启动统一服务端（默认）
//   node agent.js client [url] [body]         通用流式客户端，调用任意接口
//   node agent.js a2a    [url] [text] [answer] A2A 客户端（自动跑完 HITL resume 循环）
//   node agent.js agui   [url] [text] [answer] AG-UI 客户端（自动跑完 HITL resume 循环）
//   node agent.js openai [url] [text]         OpenAI chat.completions 客户端（STREAM=0 非流式）
//   node agent.js demo                         本进程内启动 server 并依次冒烟全部程序
//
// ── 环境变量 ────────────────────────────────────────────────────────────────
//   FC_LISTEN_PORT / PORT  监听端口（server 模式，优先 FC_LISTEN_PORT，再 PORT，都没有则默认 9000）
//   HOST        监听地址（server 模式，默认 0.0.0.0）
//   PUBLIC_URL  对外可达地址，写进各 AgentCard.url（默认 http://localhost:<PORT>）
//   TARGET_URL / A2A_URL / AGUI_URL / OPENAI_URL  各 client 模式的目标地址（优先级高于位置参数）
//   METHOD / BODY / HEADERS  通用 client 模式的请求方法/请求体/额外头（JSON 字符串）
//   STREAM      openai 模式设 0 走非流式（默认流式）
// ============================================================================

const http = require('node:http');

// 端口优先级：FC_LISTEN_PORT（函数计算/AgentRun 注入）> PORT > 9000（兜底默认）
const FC_PORT = Number(process.env.FC_LISTEN_PORT);
const ENV_PORT = Number(process.env.PORT);
const PORT = FC_PORT || ENV_PORT || 9000;
const PORT_SOURCE = FC_PORT ? 'FC_LISTEN_PORT' : ENV_PORT ? 'PORT' : 'default(9000)';
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// 流式 chunk 端点的默认节奏
const INTERVAL_MS = 200; // 每个 chunk 间隔
const DEFAULT_TOTAL = 100; // 默认推 100 个（约 20s）
const A2A_CHUNK_MS = 80; // A2A 完成时分块增量的间隔
const MAX_BODY_BYTES = 1_000_000;
const MAX_STREAM_TOTAL = 100_000;
const MAX_STREAM_INTERVAL_MS = 60_000;
const HITL_TTL_MS = 5 * 60_000;
const MAX_PENDING_HITL = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);
const rid = (p) => `${p}_${Date.now()}_${rand()}`;

// 把时间戳格式化成 HH:MM:SS.mmm，方便肉眼对比延迟
function fmt(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ============================================================================
// 共享：A2A 协议工具
// ============================================================================

/** 从 A2A message.parts 抽取纯文本（对齐消费端 extractTextFromA2AParts） */
function extractText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p && p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

/** 把字符串切成 n 段，模拟流式增量输出 */
function chunkify(s, n = 4) {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

const STREAM_PIECE = 40; // 流式分片目标大小（字符）：内容越长分片越多，长文（如「文章」）自然切成上百片
/** 按固定分片大小切块（至少 minN 片），短文本保持原有流式颗粒度，长文本自动切出更多片 */
function streamPieces(text, minN = 4) {
  return chunkify(text, Math.max(minN, Math.ceil((text.length || 1) / STREAM_PIECE)));
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function jsonRpcError(res, id, code, message) {
  sendJSON(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'RequestBodyTooLargeError';
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      bytes += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(c);
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        reject(new RequestBodyTooLargeError());
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      if (!settled) resolve(raw);
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

/** A2A AgentCard —— basePath 为该 agent 挂载的子路径（如 /a2a） */
function agentCard({ name, description, basePath, skills }) {
  return {
    protocolVersion: '0.3.0',
    name,
    description,
    url: `${PUBLIC_URL}${basePath}`,
    preferredTransport: 'JSONRPC',
    version: '0.0.1',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
    supportsAuthenticatedExtendedCard: false,
  };
}

/**
 * 通用 A2A POST 处理器。decide(message) 返回：
 *   { kind:'complete', taskId, contextId?, text }
 *   { kind:'suspend',  state, taskId, contextId?, prompt }   // HITL
 * 据此渲染 message/stream（SSE）或 message/send（单次 JSON）。
 */
async function handleA2A(req, res, { label, decide }) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return jsonRpcError(res, null, -32700, 'Parse error');
  }
  const reqId = body.id ?? null;
  const method = body.method;
  const message = body?.params?.message;
  const resume = typeof message?.taskId === 'string' && message.taskId ? ` (resume ${message.taskId})` : '';
  console.log(`[${label}] ${method}${resume} in="${extractText(message).slice(0, 60)}"`);

  try {
    const d = decide(message);
    const contextId = d.contextId || (typeof message?.contextId === 'string' && message.contextId) || `ctx_${rand()}`;
    if (method === 'message/stream') return await a2aStream(res, reqId, d, contextId);
    if (method === 'message/send') return a2aSend(res, reqId, d, contextId);
    return jsonRpcError(res, reqId, -32601, `Method not found: ${method}`);
  } catch (err) {
    console.error(`[${label}] handler error:`, err);
    if (!res.headersSent) jsonRpcError(res, reqId, -32603, String(err));
    else res.end();
  }
}

/** 流式应答（message/stream）：suspend → 单条 input/auth-required；complete → 分块 artifact + completed */
async function a2aStream(res, reqId, d, contextId) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true);
  const emit = (result) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: reqId, result })}\n\n`);

  if (d.kind === 'suspend') {
    // 暂停：携带提问文本 + 新 taskId，然后结束流（任务挂起等待人介入）
    emit({
      kind: 'status-update',
      taskId: d.taskId,
      contextId,
      status: { state: d.state, message: { role: 'agent', parts: [{ kind: 'text', text: d.prompt }] } },
      final: false,
    });
    return res.end();
  }

  // 完成：working 占位 → 分块 artifact-update（流式增量）→ 终态 completed(final)
  emit({ kind: 'task', id: d.taskId, contextId, status: { state: 'working' } });
  const chunks = streamPieces(d.text, 4);
  for (let i = 0; i < chunks.length; i++) {
    emit({
      kind: 'artifact-update',
      taskId: d.taskId,
      contextId,
      artifact: { artifactId: 'result', name: 'result', parts: [{ kind: 'text', text: chunks[i] }] },
      append: i > 0,
      lastChunk: i === chunks.length - 1,
    });
    await sleep(A2A_CHUNK_MS);
  }
  emit({ kind: 'status-update', taskId: d.taskId, contextId, status: { state: 'completed' }, final: true });
  res.end();
}

/** 非流式应答（message/send）：单个 JSON-RPC result，suspend 也用 Task.status 表达 */
function a2aSend(res, reqId, d, contextId) {
  const status =
    d.kind === 'suspend'
      ? { state: d.state, message: { role: 'agent', parts: [{ kind: 'text', text: d.prompt }] } }
      : { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: d.text }] } };
  sendJSON(res, 200, { jsonrpc: '2.0', id: reqId, result: { kind: 'task', id: d.taskId, contextId, status } });
}

// ============================================================================
// 程序 1：A2A echo 子 agent（/a2a）—— 摘要 + 回显，永不暂停
// ============================================================================

const echoCard = () =>
  agentCard({
    name: 'echo_summary_agent',
    description: '把输入文本做一个极简摘要并回显的测试 Agent',
    basePath: '/a2a',
    skills: [
      {
        id: 'echo_summary',
        name: 'echo_summary',
        description: '对输入文本做极简摘要并原样回显',
        tags: ['test', 'echo', 'summary'],
        examples: ['帮我总结这段话并回显', '你好 A2A'],
      },
    ],
  });

function buildEchoReply(input) {
  const text = (input || '').trim();
  if (!text) return '【提示】没有收到任何文本内容。';
  const oneLine = text.replace(/\s+/g, ' ');
  const summary = oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
  return `【摘要】${summary}（共 ${text.length} 字）\n【回显】${text}`;
}

/** 用户输入命中关键词「文章」→ 回一篇约 5000 字长文（压测长内容流式输出）；否则走极简回显 */
function buildReply(input) {
  if (typeof input === 'string' && input.includes('文章')) {
    const article = buildArticle();
    console.log(`[reply] 命中关键词「文章」→ 流式输出长文（${article.length} 字）`);
    return article;
  }
  return buildEchoReply(input);
}

/** 生成约 5000 字的确定性长文（不依赖随机），专门用来压测各协议的长内容流式输出 */
function buildArticle() {
  const title = '# 流式输出压测长文 · 多协议 Agent 的内容分块传输\n\n';
  const lead =
    '本文由 multi-protocol test-agent 自动生成，用于测试 A2A / AG-UI / OpenAI 等协议在「长内容流式输出」场景下的分片、节奏与端到端正确性。' +
    '正文约五千字，按固定大小切块、逐块下发，便于观察首包延迟、分片间隔，以及客户端在长流下的累计拼接、缓冲与背压行为是否正确。\n\n';
  const topics = ['协议与传输', '分片策略', '首包延迟', '背压与缓冲', '断线与重连', '编码与多字节', '顺序与拼接', '节奏与限速', '错误与终止', '观测与度量'];
  const sentences = [
    '流式输出的本质，是把一段较长的结果拆成若干分片，按时间顺序逐步下发，让接收端可以边收边渲染，而不必等待整体生成完成。',
    '分片越小，单片延迟越低、界面越「跟手」，但协议与系统调用的固定开销会被放大；分片越大则吞吐更好却不够即时，需要在颗粒度之间权衡。',
    '首包延迟决定用户对「是否在响应」的第一印象，因此即便整体耗时不变，也应尽量让第一个分片尽快发出，把等待感前移消解。',
    '当生产端速度快于消费端时会产生背压，缺少节流的实现可能堆积内存甚至拖垮连接，健壮的做法是以可控节奏推送并感知下游能力。',
    '长流更容易遇到中途断线，良好的协议需要明确的终止信号与可恢复的状态，使断线重连之后既不重复也不丢失已经下发的内容。',
    '中文等多字节文本若按字节切分，可能把一个字符劈成两半，因此分片应以字符为单位进行，避免在客户端拼接时出现乱码。',
    '每个分片都应携带足够的顺序信息，接收端据此拼接还原；即便出现乱序到达或偶发重复，也不应破坏最终文本的完整与正确。',
    '在分片之间插入固定的时间间隔，可以稳定地模拟真实模型的吐字节奏，从而对客户端的渲染、滚动与缓冲做可重复的压力测试。',
    '流的结束必须有明确标志，例如终态事件或 [DONE] 标记，缺少终止信号会让客户端一直等待、无法判断响应究竟是否已经完成。',
    '可观测性是长流调试的关键：为每个分片打上序号与时间戳，就能算出首包延迟、分片间隔与端到端延迟的分布，进而定位瓶颈。',
  ];
  let body = '';
  let i = 0;
  while ((title + lead + body).length < 5000) {
    const topic = topics[i % topics.length];
    const para = `${sentences[i % sentences.length]}${sentences[(i + 3) % sentences.length]}${sentences[(i + 7) % sentences.length]}`;
    body += `## 第 ${i + 1} 节 · ${topic}\n\n${para}\n\n`;
    i += 1;
  }
  return title + lead + body;
}

// ============================================================================
// HITL 决策核心（共享）—— 统一端点 /a2a、/ag-ui/agent 按**内容**（关键词或前缀）触发 suspend/resume，
// 无触发则回显（含「文章」长文）。不再有独立 /hitl、/ag-ui/hitl path。
// ============================================================================

const MODES = ['confirm', 'input', 'auth', 'multi'];
const APPROVALS = ['是', '好', '好的', '可以', '同意', '确认', '批准', '继续', 'yes', 'y', 'ok', 'okay', 'approve', 'confirm'];
const pendingHitl = new Map();

/**
 * 解析任务 → { mode, payload }。两条触发途径（不需要切换 path）：
 *  ① 显式前缀 `confirm:/input:/auth:/multi:`（向后兼容）；
 *  ② 关键词触发（仿「文章」长文那样按内容命中）——无前缀时按关键词进对应 HITL 模式。
 * 都不命中 → mode='echo'（回显，含「文章」长文）。
 */
function parseMode(text) {
  const t = (text || '').trim();
  const m = /^([a-zA-Z]+)\s*:\s*([\s\S]*)$/.exec(t);
  if (m && MODES.includes(m[1].toLowerCase())) {
    return { mode: m[1].toLowerCase(), payload: m[2].trim() };
  }
  // 关键词触发（无前缀、同一 path）：命中即进对应 HITL 模式（关键词需够具体，避免误触普通回显）。
  if (/删除|删库|清空|危险操作|\bdrop\b/i.test(t)) return { mode: 'confirm', payload: t };
  if (/授权|付费|登录凭证|authorize|permission/i.test(t)) return { mode: 'auth', payload: t };
  if (/请提供|请输入|补充输入|缺少.*信息|哪个城市/i.test(t)) return { mode: 'input', payload: t };
  return { mode: 'echo', payload: t };
}

/** 归一化用户回复（去空白/标点、小写） */
function normalize(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 用户回复是否表示拒绝/取消 */
function isRejection(answer) {
  const n = normalize(answer);
  if (!n) return false;
  if (n.includes('reject') || n.includes('deny') || n.includes('cancel')) return true;
  return ['否', '不', '不行', '不要', '拒绝', '取消', '停止', '别', '算了', 'no', 'n'].some((w) => n === normalize(w));
}

/** 用户回复是否明确表示批准/继续 */
function isApproval(answer) {
  const n = normalize(answer);
  return !!n && APPROVALS.some((word) => n === normalize(word));
}

/** taskId 编码：`hitl_<mode>[_r<round>]_<timestamp>_<rand>`，便于校验 mode/轮次并降低碰撞概率 */
function makeTaskId(mode, round) {
  return `hitl_${mode}${round ? `_r${round}` : ''}_${Date.now()}_${rand()}`;
}
function parseTaskId(taskId) {
  const m = /^hitl_([a-z]+)(?:_r(\d+))?_/.exec(taskId || '');
  if (!m) return null;
  return { mode: m[1], round: m[2] ? Number(m[2]) : 1 };
}

function prunePendingHitl(now = Date.now()) {
  for (const [id, pending] of pendingHitl) {
    if (pending.expiresAt <= now) pendingHitl.delete(id);
  }
  while (pendingHitl.size >= MAX_PENDING_HITL) {
    pendingHitl.delete(pendingHitl.keys().next().value);
  }
}

function createPendingHitl(mode, round, payload) {
  prunePendingHitl();
  const id = makeTaskId(mode, round);
  pendingHitl.set(id, { mode, round, payload, expiresAt: Date.now() + HITL_TTL_MS });
  return id;
}

function takePendingHitl(id) {
  const pending = pendingHitl.get(id);
  pendingHitl.delete(id);
  if (!pending || pending.expiresAt <= Date.now()) return null;
  return pending;
}

/** 各 mode 首轮的提问文本（成为父级 suspend 的 prompt） */
function askPrompt(mode, payload, round) {
  switch (mode) {
    case 'confirm':
      return `【需要确认】我准备执行：「${payload || '(空任务)'}」。是否继续？回复"是/好的/可以"批准，"否/取消"拒绝。`;
    case 'input':
      return `【需要补充输入】要完成「${payload || '(空任务)'}」，请提供所需的具体输入值（例如城市名、参数等）。`;
    case 'auth':
      return `【需要授权】操作「${payload || '(空任务)'}」涉及敏感资源，是否授权继续？回复"是/同意"授权，"否/拒绝"取消。`;
    case 'multi':
      return round >= 2
        ? `【第 2 步确认】是否最终提交「${payload || '(空任务)'}」？回复"是"提交，"否"取消。`
        : `【第 1 步确认】是否开始处理「${payload || '(空任务)'}」？回复"是"继续到下一步，"否"取消。`;
    default:
      return '需要你的确认才能继续。';
  }
}

/** 完成时的结果文本，含可被 e2e/judge 校验的确定性 marker */
function completionText(mode, answer) {
  const ans = (answer || '').trim();
  switch (mode) {
    case 'confirm':
      return `【已确认·已执行】HITL_CONFIRM_DONE（用户批准了操作）`;
    case 'input':
      return `【已获取输入·已执行】HITL_INPUT_DONE: ${ans || '(空)'}`;
    case 'auth':
      return `【已授权·已执行】HITL_AUTH_DONE（用户已授权）`;
    case 'multi':
      return `【多轮全部确认·已执行】HITL_MULTI_DONE`;
    default:
      return buildReply(ans); // echo baseline：行为同 /a2a（含「文章」长文）
  }
}

function cancelledText(mode) {
  return `【已取消】HITL_CANCELLED（用户拒绝了 ${mode} 操作，未执行）`;
}

/**
 * HITL 核心决策（与协议无关）：靠 resumeId 区分「首轮 vs resume」，并从带 TTL 的 pendingHitl
 * 恢复可信的 mode/轮次/payload。resumeId = A2A 的 taskId 或 AG-UI 的 toolCallId，首轮为空。
 * 返回中性结果，由各协议适配层映射：
 *   { kind:'suspend',  mode, state, id, prompt }
 *   { kind:'complete', mode, id, text }
 */
function hitlCore(text, resumeId) {
  // resume：带 id，是对某次 input-required/auth-required（或 tool call）的回应
  if (resumeId) {
    const parsed = parseTaskId(resumeId);
    // taskId 无法解析 = 真正的非法恢复标识 → 拒绝（防乱传 id 当 resume）。
    if (!parsed) {
      return {
        kind: 'complete',
        mode: 'invalid',
        id: resumeId,
        text: '【恢复失败】HITL_RESUME_REJECTED（任务不存在、已过期或恢复标识无效）',
      };
    }
    // 无状态恢复（关键）：mode/round 已编码进 taskId。内存里有 pending 就用之（payload 完整）；
    // **跨 FC 实例**时内存 pending 丢失，从 taskId 重建 {mode,round}（payload 降级为空）——
    // 不再因「内存没命中」就 HITL_RESUME_REJECTED。这让 test-agent 成为真正的无状态可恢复 agent，
    // 与「不支持会话管理 → 收完整 messages + 带 resume 标识」的契约一致。
    const pending = takePendingHitl(resumeId) || { mode: parsed.mode, round: parsed.round, payload: undefined };
    // 内存命中但 mode/round 与 taskId 编码不符 = 真畸形（损坏/伪造），仍拒绝。
    if (pending.mode !== parsed.mode || pending.round !== parsed.round) {
      return {
        kind: 'complete',
        mode: 'invalid',
        id: resumeId,
        text: '【恢复失败】HITL_RESUME_REJECTED（任务不存在、已过期或恢复标识无效）',
      };
    }
    if (isRejection(text)) {
      return { kind: 'complete', mode: pending.mode, id: resumeId, text: cancelledText(pending.mode) };
    }
    if (pending.mode === 'input' && !(text || '').trim()) {
      const next = createPendingHitl(pending.mode, pending.round, pending.payload);
      return {
        kind: 'suspend',
        mode: pending.mode,
        state: 'input-required',
        id: next,
        prompt: `【输入不能为空】${askPrompt(pending.mode, pending.payload, pending.round)}`,
      };
    }
    if (pending.mode !== 'input' && !isApproval(text)) {
      const next = createPendingHitl(pending.mode, pending.round, pending.payload);
      return {
        kind: 'suspend',
        mode: pending.mode,
        state: pending.mode === 'auth' ? 'auth-required' : 'input-required',
        id: next,
        prompt: `【回答不明确】${askPrompt(pending.mode, pending.payload, pending.round)}`,
      };
    }
    // multi 第一轮 resume → 再要第二轮确认
    if (pending.mode === 'multi' && pending.round < 2) {
      const next = createPendingHitl('multi', 2, pending.payload);
      return {
        kind: 'suspend',
        mode: 'multi',
        state: 'input-required',
        id: next,
        prompt: askPrompt('multi', pending.payload, 2),
      };
    }
    return { kind: 'complete', mode: pending.mode, id: resumeId, text: completionText(pending.mode, text) };
  }

  // 首轮：按 mode 决定暂停或直接完成
  const { mode, payload } = parseMode(text);
  if (mode === 'echo') {
    return { kind: 'complete', mode: 'echo', id: makeTaskId('echo'), text: completionText('echo', payload) };
  }
  const id = createPendingHitl(mode, 1, payload);
  const state = mode === 'auth' ? 'auth-required' : 'input-required';
  return { kind: 'suspend', mode, state, id, prompt: askPrompt(mode, payload, 1) };
}

/** A2A 适配：把中性结果映射成 a2aStream/a2aSend 需要的 { taskId } 形状 */
function hitlDecide(message) {
  const resumeId = typeof message?.taskId === 'string' ? message.taskId : '';
  const d = hitlCore(extractText(message), resumeId);
  return d.kind === 'suspend'
    ? { kind: 'suspend', state: d.state, taskId: d.id, prompt: d.prompt }
    : { kind: 'complete', taskId: d.id, text: d.text };
}

// ============================================================================
// 程序 3：流式 chunk 端点（/stream）—— 每 interval ms 推一个 NDJSON chunk
// ============================================================================

function handleStreamChunks(req, res, u) {
  const total = boundedQueryInteger(u, ['count'], DEFAULT_TOTAL, 1, MAX_STREAM_TOTAL);
  const interval = boundedQueryInteger(u, ['interval', 'ms'], INTERVAL_MS, 1, MAX_STREAM_INTERVAL_MS);
  if (total === null || interval === null) {
    return sendJSON(res, 400, {
      error: `count must be an integer from 1 to ${MAX_STREAM_TOTAL}; interval/ms must be an integer from 1 to ${MAX_STREAM_INTERVAL_MS}`,
    });
  }
  console.log(`[stream] ${req.method} ${req.url}  total=${total} interval=${interval}ms  from=${req.socket.remoteAddress}`);

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true); // 关掉 Nagle，尽量即时发出

  let seq = 0;
  const timer = setInterval(() => {
    seq += 1;
    const serverTs = Date.now();
    res.write(JSON.stringify({ seq, total, serverTs, serverTime: fmt(serverTs) }) + '\n');
    if (seq >= total) {
      clearInterval(timer);
      res.end();
      console.log('[stream] done');
    }
  }, interval);

  res.on('close', () => clearInterval(timer)); // 响应关闭（含客户端提前断开）时停掉定时器
}

function boundedQueryInteger(u, names, fallback, min, max) {
  const name = names.find((candidate) => u.searchParams.has(candidate));
  if (!name) return fallback;
  const value = Number(u.searchParams.get(name));
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

// ============================================================================
// AG-UI 模拟会话（/ag-ui/agent）：回显 + HITL（按内容触发，走 interrupt 协议或 tool-call）
//   AG-UI 协议：POST RunAgentInput，SSE 回 `data: <event>\n\n`，事件带 type 字段。
//   文本：RUN_STARTED → TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT* / TEXT_MESSAGE_END → RUN_FINISHED
//   HITL（两种机制，按客户端能力自动选择，二者都支持）：
//     ① 客户端在 RunAgentInput.tools 里声明了工具 → 走 tool-call：TOOL_CALL_START/ARGS/END 后
//        RUN_FINISHED，前端补一条 ToolMessage(content=用户回复) 再发起新 run 即 resume；
//     ② 否则走 AG-UI interrupt 协议：RUN_FINISHED.outcome={type:'interrupt',interrupts:[{id,reason,message,…}]}，
//        前端用 RunAgentInput.resume=[{interruptId,status,payload}] 恢复，完成态回 outcome={type:'success'}。
// ============================================================================

/** content 支持 string 或 [{type:'text',text}]，统一抽成纯文本 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('');
  }
  return '';
}

/** 取最后一条 user 文本 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return contentToText(m.content);
  }
  return '';
}

/** 取最后一条 tool 结果消息（AG-UI resume 的载体） */
function lastToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'tool' && m.toolCallId) return { toolCallId: m.toolCallId, content: contentToText(m.content) };
  }
  return null;
}

/** 从 RunAgentInput.tools 提取客户端声明的工具名（支持 {name} 或 {function:{name}}） */
function declaredToolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.map((t) => t && (t.name || (t.function && t.function.name))).filter(Boolean);
}

/** 按 mode 在「客户端声明的工具」里挑一个 HITL 工具名；客户端没声明则返回 null（改走 interrupt 协议） */
function pickHitlTool(mode, names) {
  if (!names.length) return null;
  const want = { input: /input|ask|prompt/i, auth: /auth|approv|permis|confirm/i }[mode] || /confirm|approv/i;
  return names.find((n) => want.test(n)) || names[0];
}

/** HITL mode → interrupt.reason（核心取值：confirmation / input_required / tool_call） */
function hitlReason(mode) {
  return mode === 'input' ? 'input_required' : 'confirmation';
}

/** interrupt.responseSchema：声明期望的 resume.payload 结构 */
function hitlSchema(mode) {
  return mode === 'input'
    ? { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
    : { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] };
}

/** 仅当 payload 提供「具体取值/明确布尔」时返回文本，否则 ''（让 status:"resolved" 默认批准）。
 *  未知对象结构（如 super_agent 下发的 {action:"confirm"}）返回 '' 而非 JSON.stringify。 */
function resumeValueText(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  if (typeof p === 'boolean') return p ? '是' : '否';
  if (typeof p === 'object') {
    if (typeof p.approved === 'boolean') return p.approved ? '是' : '否';
    return p.value ?? p.answer ?? p.text ?? '';
  }
  return String(p);
}

/** 解析 interrupt 协议的 resume（RunAgentInput.resume）→ { id, text }；没有则 null。cancelled → 当作拒绝 */
function interruptResume(body) {
  const arr = Array.isArray(body?.resume) ? body.resume : [];
  const r = arr.find((x) => x && x.interruptId);
  if (!r) return null;
  if (r.status === 'cancelled') return { id: r.interruptId, text: '取消' };
  // status:"resolved" = AG-UI 标准「已批准/继续」信号。payload 带具体取值（input 取值类）则用之；
  // 否则（确认/授权类无 payload，或 {action:"confirm"} 这类非取值结构）**默认视为批准**——否则模型/用户
  // 已批准却因「文本非批准词」被判「回答不明确」再次挂起 → 死循环（修预发「授权/删库委派」）。
  const val = resumeValueText(r.payload);
  return { id: r.interruptId, text: val || '是' };
}

async function handleAgUi(req, res, { label, kind }) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'invalid JSON' }));
  }
  const threadId = body.threadId || `thread_${rand()}`;
  const runId = body.runId || `run_${rand()}`;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // 决策：echo 直接回显；hitl 走核心。resume 两种来源：interrupt 协议(body.resume) 优先，否则看最后一条 tool 结果
  let d;
  if (kind === 'hitl') {
    const ir = interruptResume(body);
    const tr = ir ? null : lastToolResult(messages);
    if (ir) d = hitlCore(ir.text, ir.id);
    else if (tr) d = hitlCore(tr.content, tr.toolCallId);
    else d = hitlCore(lastUserText(messages), '');
  } else {
    d = { kind: 'complete', text: buildReply(lastUserText(messages)) };
  }
  console.log(`[${label}] run=${runId} ${kind} -> ${d.kind}${d.mode ? `(${d.mode})` : ''}`);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true);
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  emit({ type: 'RUN_STARTED', threadId, runId });
  try {
    if (d.kind === 'suspend') {
      const tool = pickHitlTool(d.mode, declaredToolNames(body));
      if (tool) {
        // 机制①：客户端声明了工具 → 调用「客户端声明的」frontend tool，等前端补 ToolMessage 再 resume
        const toolCallId = d.id;
        emit({ type: 'TOOL_CALL_START', toolCallId, toolCallName: tool });
        emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify({ prompt: d.prompt, reason: hitlReason(d.mode) }) });
        emit({ type: 'TOOL_CALL_END', toolCallId });
        emit({ type: 'RUN_FINISHED', threadId, runId });
      } else {
        // 机制②：客户端没声明工具 → 走 AG-UI interrupt 协议，把中断装进 RUN_FINISHED.outcome
        emit({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          outcome: {
            type: 'interrupt',
            interrupts: [{ id: d.id, reason: hitlReason(d.mode), message: d.prompt, responseSchema: hitlSchema(d.mode) }],
          },
        });
      }
    } else {
      // 文本增量（完成）
      const messageId = `msg_${rand()}`;
      emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      for (const piece of streamPieces(d.text, 6)) {
        emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: piece });
        await sleep(A2A_CHUNK_MS);
      }
      emit({ type: 'TEXT_MESSAGE_END', messageId });
      // HITL 完成态按 interrupt 协议回 outcome:success；echo 保持普通 RUN_FINISHED
      emit(kind === 'hitl' ? { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } } : { type: 'RUN_FINISHED', threadId, runId });
    }
  } catch (err) {
    emit({ type: 'RUN_ERROR', message: String(err) });
  }
  res.end();
}

// ============================================================================
// 程序 5：OpenAI Chat Completions（/openai/v1/chat/completions）
//   回显最后一条 user 消息的摘要；stream=true 走 SSE chunk（chat.completion.chunk + [DONE]），
//   否则单次 JSON（chat.completion）。
// ============================================================================

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return contentToText(m.content);
  }
  const last = messages[messages.length - 1];
  return last ? contentToText(last.content) : '';
}

async function handleOpenAI(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { message: 'invalid JSON', type: 'invalid_request_error' } }));
  }
  const model = body.model || 'echo-model';
  const stream = !!body.stream;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userText = lastUserContent(messages);
  const reply = buildReply(userText);
  const id = `chatcmpl-${rand()}`;
  const created = Math.floor(Date.now() / 1000);
  console.log(`[openai] model=${model} stream=${stream} in="${userText.slice(0, 60)}"`);

  if (!stream) {
    return sendJSON(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true);
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const baseChunk = { id, object: 'chat.completion.chunk', created, model };

  send({ ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const piece of streamPieces(reply, 8)) {
    send({ ...baseChunk, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    await sleep(A2A_CHUNK_MS);
  }
  send({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

// ============================================================================
// 统一服务端：按 path 路由到各程序
// ============================================================================

function indexPage() {
  return [
    'multi-protocol test-agent OK',
    '',
    '── 服务端端点（按 path 路由，单进程单端口）──',
    'A2A        : POST ' + PUBLIC_URL + '/a2a     card: ' + PUBLIC_URL + '/a2a/.well-known/agent-card.json  （回显 + HITL，按内容触发）',
    'AG-UI      : POST ' + PUBLIC_URL + '/ag-ui/agent   （回显 + HITL，按内容触发）',
    'OpenAI     : POST ' + PUBLIC_URL + '/openai/v1/chat/completions   (stream=true|false)',
    'Stream     : ANY  ' + PUBLIC_URL + '/stream?count=100&interval=200',
    'Health     : GET  ' + PUBLIC_URL + '/health',
    '',
    'HITL 触发  : 无独立 path —— /a2a 与 /ag-ui/agent 按内容触发：关键词（删除/授权/请提供…）或前缀（' + MODES.join('/') + ': …）；无触发则回显',
    '',
    '── 命令行用法（同一个 agent.js 既是服务端，也内置客户端）──',
    '  node agent.js [server]                     启动统一服务端（默认）',
    '  node agent.js client [url] [body]          通用流式客户端，调用任意接口（NDJSON/SSE/纯文本）',
    '  node agent.js a2a    [url] [text] [answer]  A2A 客户端（自动跑完 HITL suspend→resume 循环）',
    '  node agent.js agui   [url] [text] [answer]  AG-UI 客户端（自动跑完 HITL tool-call→resume 循环）',
    '  node agent.js openai [url] [text]          OpenAI chat.completions 客户端（STREAM=0 非流式）',
    '  node agent.js demo                          本进程内启动 server 并依次冒烟全部程序',
    '',
    '── 环境变量 ──',
    '  FC_LISTEN_PORT / PORT  监听端口（优先 FC_LISTEN_PORT，再 PORT，都没有则默认 9000）',
    '  HOST                   监听地址（默认 0.0.0.0）',
    '  PUBLIC_URL             对外可达地址，写进各 AgentCard.url（默认 http://localhost:<PORT>）',
    '  TARGET_URL / A2A_URL / AGUI_URL / OPENAI_URL  各 client 模式目标地址（优先于位置参数）',
    '  METHOD / BODY / HEADERS  通用 client 模式的请求方法/请求体/额外头（JSON 字符串）',
    '  STREAM                 openai 模式设 0 走非流式（默认流式）',
    '',
  ].join('\n');
}

async function routeRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  // 访问日志：每个请求都打印一行，确保 agent.js 的每种使用都有对应的打印输出
  console.log(`[req] ${req.method} ${path}  from=${req.socket?.remoteAddress || '-'}`);

  // 健康检查 / 首页
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(indexPage());
  }

  // AgentCard（统一端点各一张，挂在各自子路径下的 well-known）
  if (req.method === 'GET' && path === '/a2a/.well-known/agent-card.json') return sendJSON(res, 200, echoCard());

  // 流式 chunk 端点：/stream 及其子路径，接受任意 method
  if (path === '/stream' || path.startsWith('/stream/')) return handleStreamChunks(req, res, u);

  // A2A 统一端点（POST JSON-RPC）：HITL 由内容（关键词/前缀）触发，无关键词则回显——不再有独立 /hitl path。
  if (path === '/a2a') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return handleA2A(req, res, { label: 'a2a', decide: hitlDecide });
  }

  // AG-UI 统一端点（POST RunAgentInput，SSE 回事件流）：同上，HITL 由内容触发——不再有独立 /ag-ui/hitl path。
  if (path === '/ag-ui/agent') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return handleAgUi(req, res, { label: 'ag-ui', kind: 'hitl' });
  }

  // OpenAI Chat Completions（POST，stream 由 body.stream 决定）
  if (path === '/openai/v1/chat/completions') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    return handleOpenAI(req, res);
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n\n' + indexPage());
}

function handleRequestError(err, res) {
  console.error('[server] request error:', err);
  if (res.headersSent) return res.end();
  if (err instanceof RequestBodyTooLargeError) {
    return sendJSON(res, 413, { error: err.message });
  }
  return sendJSON(res, 500, { error: 'Internal Server Error' });
}

function startServer() {
  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((err) => handleRequestError(err, res));
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err) => reject(err);
    server.once('error', onListenError);
    server.listen(PORT, HOST, () => {
      server.off('error', onListenError);
      server.on('error', (err) => console.error('[server] error:', err));
      console.log(`multi-protocol test-agent listening on ${HOST}:${PORT}  (port from ${PORT_SOURCE})`);
      console.log(indexPage());
      resolve(server);
    });
  });
}

function methodNotAllowed(res) {
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('Method Not Allowed');
}

// ============================================================================
// 客户端 A：通用流式客户端 —— 可调用任意接口（NDJSON / SSE / 纯文本）
// ============================================================================

/** 解析并打印一行响应：SSE data 字段 / 本 demo 的 serverTs（显示延迟）/ 其他 JSON / 纯文本 */
function printLine(line, clientTs) {
  const payload = line.startsWith('data: ') ? line.slice(6) : line;
  if (payload === '[DONE]') return console.log(`[client] ${fmt(clientTs)} <- [DONE]`);
  try {
    const c = JSON.parse(payload);
    if (c.serverTs !== undefined) {
      const latency = clientTs - c.serverTs;
      console.log(
        `[client] <- #${String(c.seq).padStart(3)}/${c.total}  server=${c.serverTime}  client=${fmt(clientTs)}  latency=${latency}ms`
      );
    } else {
      console.log(`[client] ${fmt(clientTs)} <- ${JSON.stringify(c)}`);
    }
  } catch {
    console.log(`[client] ${fmt(clientTs)} <- ${payload}`);
  }
}

async function runClient(targetUrl, { method, body, headers }) {
  console.log(`[client] ${method} ${targetUrl}`);
  if (body) console.log(`[client] body: ${body}`);

  const resp = await fetch(targetUrl, { method, headers, body: body || undefined });
  console.log(`[client] connected  status=${resp.status} ${resp.statusText}  content-type=${resp.headers.get('content-type') || ''}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) printLine(line, Date.now()); // SSE 空行（事件分隔符）跳过
    }
  }
  if (buf.trim()) printLine(buf.trim(), Date.now()); // 末尾无换行的残留
  console.log('[client] stream closed');
}

// ============================================================================
// 客户端 B：A2A 协议感知客户端 —— 自动跑完 HITL「首轮→暂停→resume→完成」循环
// 打 /a2a（回显或按内容触发 suspend/resume），或任意 A2A 端点。
// ============================================================================

function buildA2ABody(text, taskId) {
  const message = { role: 'user', parts: [{ kind: 'text', text }], messageId: rid('msg') };
  if (taskId) message.taskId = taskId;
  return { jsonrpc: '2.0', id: rid('req'), method: 'message/stream', params: { message } };
}

/** 发一次 message/stream，消费 SSE，返回 { state, text, taskId, prompt } */
async function a2aCallOnce(url, text, taskId) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(buildA2ABody(text, taskId)),
  });
  if (!resp.ok) {
    console.error('FAILED:', resp.status, await resp.text());
    process.exit(1);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';
  let state = 'working';
  let outTaskId = taskId || '';
  let prompt = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (data.error) {
        console.error(`RUN_ERROR: A2A error ${data.error.code}: ${data.error.message}`);
        process.exit(1);
      }
      const ev = data.result || data;
      if (ev.taskId) outTaskId = ev.taskId;
      else if (ev.id && ev.kind === 'task') outTaskId = ev.id;
      if (ev.status) {
        state = ev.status.state || state;
        const t = (ev.status.message?.parts || [])
          .filter((p) => p.kind === 'text' && p.text)
          .map((p) => p.text)
          .join('');
        if (['input-required', 'auth-required'].includes(state)) prompt = t;
        else if (t) {
          acc += t;
          process.stdout.write(t);
        }
      }
      if (ev.artifact?.parts) {
        const t = ev.artifact.parts.filter((p) => p.kind === 'text' && p.text).map((p) => p.text).join('');
        if (t) {
          acc += t;
          process.stdout.write(t);
        }
      }
    }
  }
  return { state, text: acc, taskId: outTaskId, prompt };
}

async function runA2AClient(url, input, answer) {
  const MAX_ROUNDS = 6;
  console.log(`→ POST ${url}\n  initial input: ${input}\n  answer (on suspend): ${answer}\n`);

  let r = await a2aCallOnce(url, input, undefined);
  let round = 0;
  while (['input-required', 'auth-required'].includes(r.state) && round < MAX_ROUNDS) {
    round += 1;
    console.log(`\n\n⏸  [暂停 #${round}] state=${r.state} taskId=${r.taskId}`);
    console.log(`   prompt: ${r.prompt}`);
    console.log(`   ↩ resume with: "${answer}"\n`);
    r = await a2aCallOnce(url, answer, r.taskId);
  }

  console.log('\n\n—— 终态 ——');
  console.log(`state = ${r.state}`);
  console.log(`result = ${r.text}`);
  if (r.state === 'completed') console.log('\n✅ A2A/HITL 链路兼容：暂停→resume→完成 全程正常终止');
  else console.log(`\n⚠ 未在 ${MAX_ROUNDS} 轮内完成（state=${r.state}）`);
}

// ============================================================================
// 客户端 C：AG-UI 协议感知客户端 —— 解析 AG-UI 事件，自动跑完 HITL resume 循环（两种机制都支持）
// 打 /ag-ui/agent（回显或按内容触发）：默认走 interrupt 协议（RUN_FINISHED.outcome），
// 设 AGUI_TOOL=<名> 声明一个 frontend tool 则走 tool-call 机制。或任意 AG-UI 端点。
// ============================================================================

/**
 * 发一次 run，消费 AG-UI SSE，返回 { text, toolCall:{id,name,args}|null, interrupt:{id,reason,message}|null }。
 * 默认 tools=[] → 服务端走 interrupt 协议；设 AGUI_TOOL=<名> 声明一个 frontend tool → 服务端走 tool-call。
 * resume（interrupt 协议恢复）作为 RunAgentInput.resume 传入。
 */
async function aguiCallOnce(url, messages, resume) {
  const toolName = process.env.AGUI_TOOL;
  const tools = toolName ? [{ name: toolName, description: 'HITL frontend tool', parameters: { type: 'object' } }] : [];
  const body = { threadId: 'thread_cli', runId: rid('run'), messages, tools, context: [], state: {} };
  if (resume) body.resume = resume;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error('FAILED:', resp.status, await resp.text());
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let toolCall = null;
  let interrupt = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const s = line.slice(5).trim();
      if (!s || s === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'TEXT_MESSAGE_CONTENT':
          text += ev.delta || '';
          process.stdout.write(ev.delta || '');
          break;
        case 'TOOL_CALL_START':
          toolCall = { id: ev.toolCallId, name: ev.toolCallName, args: '' };
          break;
        case 'TOOL_CALL_ARGS':
          if (toolCall) toolCall.args += ev.delta || '';
          break;
        case 'RUN_FINISHED':
          if (ev.outcome && ev.outcome.type === 'interrupt') interrupt = (ev.outcome.interrupts || [])[0] || null;
          break;
        case 'RUN_ERROR':
          console.error(`\nRUN_ERROR: ${ev.message}`);
          process.exit(1);
      }
    }
  }
  return { text, toolCall, interrupt };
}

async function runAgUiClient(url, input, answer) {
  const MAX_ROUNDS = 6;
  console.log(`→ POST ${url}  (AG-UI)\n  initial input: ${input}\n  answer (on tool call): ${answer}\n`);

  let messages = [{ id: rid('msg'), role: 'user', content: input }];
  let r = await aguiCallOnce(url, messages);
  let round = 0;
  while ((r.toolCall || r.interrupt) && round < MAX_ROUNDS) {
    round += 1;
    if (r.interrupt) {
      // 机制②：interrupt 协议 → 用 RunAgentInput.resume=[{interruptId,status,payload}] 恢复
      console.log(`\n\n⏸  [interrupt #${round}] reason=${r.interrupt.reason} id=${r.interrupt.id}`);
      console.log(`   message: ${r.interrupt.message}`);
      console.log(`   ↩ resume(payload) with: "${answer}"\n`);
      r = await aguiCallOnce(url, messages, [{ interruptId: r.interrupt.id, status: 'resolved', payload: answer }]);
    } else {
      // 机制①：tool-call → 补 assistant(toolCall)+ToolMessage(content=回复) 再发起新 run（resume）
      let prompt = r.toolCall.args;
      try {
        prompt = JSON.parse(r.toolCall.args).prompt || r.toolCall.args;
      } catch {}
      console.log(`\n\n⏸  [tool call #${round}] ${r.toolCall.name} id=${r.toolCall.id}`);
      console.log(`   prompt: ${prompt}`);
      console.log(`   ↩ resume with: "${answer}"\n`);
      messages = messages.concat([
        {
          id: rid('msg'),
          role: 'assistant',
          content: '',
          toolCalls: [{ id: r.toolCall.id, type: 'function', function: { name: r.toolCall.name, arguments: r.toolCall.args } }],
        },
        { id: rid('msg'), role: 'tool', toolCallId: r.toolCall.id, content: answer },
      ]);
      r = await aguiCallOnce(url, messages);
    }
  }

  console.log('\n\n—— 终态 ——');
  console.log(`result = ${r.text}`);
  if (!r.toolCall && !r.interrupt) console.log('\n✅ AG-UI/HITL 链路兼容：暂停→resume→完成 全程正常终止');
  else console.log(`\n⚠ 未在 ${MAX_ROUNDS} 轮内完成`);
}

// ============================================================================
// 客户端 D：OpenAI Chat Completions 客户端（stream / 非 stream）
// ============================================================================

async function runOpenAIClient(url, input, stream) {
  console.log(`→ POST ${url}  (chat.completions, stream=${stream})\n  input: ${input}\n`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo-model', stream, messages: [{ role: 'user', content: input }] }),
  });
  if (!resp.ok) {
    console.error('FAILED:', resp.status, await resp.text());
    process.exit(1);
  }

  if (!stream) {
    const j = await resp.json();
    console.log(j.choices?.[0]?.message?.content ?? JSON.stringify(j));
    console.log('\n✅ chat.completions（非流式）OK');
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const s = line.slice(5).trim();
      if (!s || s === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        continue;
      }
      const delta = j.choices?.[0]?.delta?.content || '';
      if (delta) process.stdout.write(delta);
    }
  }
  console.log('\n\n✅ chat.completions（流式）OK');
}

// ============================================================================
// demo：本进程内启动 server，依次冒烟所有程序
// ============================================================================

async function runDemo() {
  const server = await startServer();
  const base = `http://127.0.0.1:${PORT}`;
  console.log('\n========== [1/6] 流式 chunk（/stream?count=5&interval=150）==========');
  await runClient(`${base}/stream?count=5&interval=150`, { method: 'GET', headers: {}, body: '' });
  console.log('\n========== [2/6] A2A echo（/a2a，无触发）==========');
  await runA2AClient(`${base}/a2a`, '你好 A2A，帮我总结并回显这句话。', '好的');
  console.log('\n========== [3/6] A2A HITL（/a2a，关键词「删除」触发）==========');
  await runA2AClient(`${base}/a2a`, '删除生产数据库', '好的');
  console.log('\n========== [4/6] AG-UI echo（/ag-ui/agent，无触发）==========');
  await runAgUiClient(`${base}/ag-ui/agent`, '你好 AG-UI，帮我总结并回显这句话。', '好的');
  console.log('\n========== [5/6] AG-UI HITL（/ag-ui/agent，关键词「删除」触发）==========');
  await runAgUiClient(`${base}/ag-ui/agent`, '删除生产数据库', '好的');
  console.log('\n========== [6/6] OpenAI Chat Completions（/openai/v1/chat/completions，stream）==========');
  await runOpenAIClient(`${base}/openai/v1/chat/completions`, '你好 OpenAI，帮我总结并回显这句话。', true);
  server.close();
  console.log('\n✅ demo 完成：全部程序均已冒烟通过');
  process.exit(0);
}

// ============================================================================
// 入口
// ============================================================================

async function main() {
  const argv = process.argv;
  const mode = argv[2] || 'server';

  if (mode === 'server') {
    await startServer();
    return;
  }

  if (mode === 'client') {
    // 通用流式客户端：可调用任意接口。位置参数 [url] [body]，env 覆盖。
    const rest = argv.slice(3);
    const url = process.env.TARGET_URL || rest[0] || `http://127.0.0.1:${PORT}/stream`;
    const body = process.env.BODY || rest[1] || '';
    const method = (process.env.METHOD || (body ? 'POST' : 'GET')).toUpperCase();
    const headers = process.env.HEADERS ? JSON.parse(process.env.HEADERS) : {};
    if (body && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    await runClient(url, { method, body, headers });
    process.exit(0);
  }

  if (mode === 'a2a') {
    // A2A 客户端：a2a [url] [text] [answer]，自动跑完 HITL resume 循环。
    const rest = argv.slice(3);
    let url, text, answer;
    if (rest[0] && /^https?:\/\//.test(rest[0])) {
      [url, text, answer] = rest;
    } else {
      url = process.env.A2A_URL || `http://127.0.0.1:${PORT}/a2a`;
      [text, answer] = rest;
    }
    await runA2AClient(url, text || '删除生产数据库', answer || '好的');
    process.exit(0);
  }

  if (mode === 'agui') {
    // AG-UI 客户端：agui [url] [text] [answer]，自动跑完 HITL（tool call）resume 循环。
    const rest = argv.slice(3);
    let url, text, answer;
    if (rest[0] && /^https?:\/\//.test(rest[0])) {
      [url, text, answer] = rest;
    } else {
      url = process.env.AGUI_URL || `http://127.0.0.1:${PORT}/ag-ui/agent`;
      [text, answer] = rest;
    }
    await runAgUiClient(url, text || '删除生产数据库', answer || '好的');
    process.exit(0);
  }

  if (mode === 'openai') {
    // OpenAI 客户端：openai [url] [text]，STREAM=0 走非流式。
    const rest = argv.slice(3);
    let url, text;
    if (rest[0] && /^https?:\/\//.test(rest[0])) {
      [url, text] = rest;
    } else {
      url = process.env.OPENAI_URL || `http://127.0.0.1:${PORT}/openai/v1/chat/completions`;
      text = rest[0];
    }
    await runOpenAIClient(url, text || '你好，帮我总结并回显这句话。', process.env.STREAM !== '0');
    process.exit(0);
  }

  if (mode === 'demo') {
    await runDemo();
    return;
  }

  console.error(
    [
      `unknown mode: ${mode}`,
      'usage:',
      '  node agent.js [server]                   启动统一服务端',
      '  node agent.js client [url] [body]        通用流式客户端，调用任意接口',
      '  node agent.js a2a   [url] [text] [answer] A2A 客户端（自动 HITL resume）',
      '  node agent.js agui  [url] [text] [answer] AG-UI 客户端（自动 HITL resume）',
      '  node agent.js openai [url] [text]        OpenAI chat.completions 客户端（STREAM=0 非流式）',
      '  node agent.js demo                       本进程内冒烟全部程序',
    ].join('\n')
  );
  process.exit(1);
}

// 直接 `node agent.js` 运行才启动 server/client；被 require()（单测）则只导出纯函数，不跑 main。
if (require.main === module) {
  main().catch((err) => {
    console.error('error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

// 供单测验证「无状态 HITL 核心」（跨 FC 实例恢复）：pendingHitl 可被清空以模拟换实例。
module.exports = { hitlCore, parseTaskId, makeTaskId, createPendingHitl, takePendingHitl, pendingHitl, interruptResume };
