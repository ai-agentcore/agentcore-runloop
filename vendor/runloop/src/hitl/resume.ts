import {
  EventType,
  type RunloopEvent,
  type ToolcallSuspendEvent,
  type ToolcallStartEvent,
  type ToolcallEndEvent,
  type ToolresultEndEvent,
  type UserCommandEvent,
  type UserMessageEvent,
} from "../types/events.js";
import { nanoid } from "nanoid";
import { createEvent } from "../events/factory.js";
import type { Credentials } from "../types/resources.js";
import { REQUEST_CONFIRMATION_TOOL, REQUEST_USER_INPUT_TOOL, type SidecarServer } from "../sidecar/server.js";
import { matchReplyToOption } from "./match.js";

/** NL 通道连续未匹配的上限：达到即主动拒绝（AD-026 增补，用户定调 5 次）。 */
export const MAX_NL_RETRIES = 5;

/** 嵌套审批向下转发的入参/出参（由 sidecar 对 runloop 子 agent 实现 resume 调用） */
export interface ForwardNestedInput {
  delegationToolCallId: string;
  delegationToolName?: string;
  childHistory: RunloopEvent[];
  suspendToolCallId: string;
  selectedOptionId: string;
  payload?: Record<string, unknown>;
  /**
   * 原始委派任务（委派 toolcall.end 的 args.task）。无状态子 agent（serverManagesHistory=false）resume
   * 时需要据此重建**完整 messages**——父历史里子帧切片只有冒泡上来的 suspend，缺原始任务，故由此显式透传。
   */
  delegationTask?: string;
}
export interface ForwardNestedResult {
  /** 嵌套 suspend 自身 toolresult 的 result（子帧投影） */
  nestedResult?: unknown;
  /** 委派 toolcall 的最终 toolresult（子 agent 恢复后的输出） */
  delegationResult?: unknown;
  isError?: boolean;
  /**
   * 多轮嵌套（P3）：子 agent resume 后又抛出**新** suspend（连续多轮 HITL）。委派**未完成**——
   * 不产委派 toolresult；childEvents 携带新子 suspend（已带 parentToolCallId=委派 id），由 resolvePendingHitl
   * 透传进父流并以 hitl_pending 收尾，等下一轮 resolve（放松 AD-026 #1 的「每 run ≤1 suspend」假设）。
   */
  reSuspended?: boolean;
  childEvents?: RunloopEvent[];
}

export interface ResolveHitlContext {
  conversationId: string;
  runId: string;
  sidecar: SidecarServer | null;
  credentials?: Credentials;
  /** 嵌套审批向下转发器（父层永不代执行子层 op；沿委派链转发给子 agent）。 */
  forwardNested?: (input: ForwardNestedInput) => Promise<ForwardNestedResult>;
}

export interface ResolveHitlResult {
  /** 注入 SSE 并折进压缩 transcript 的 toolresult 事件（execute-on-resume 的外部投影 + 模型输入） */
  events: RunloopEvent[];
  /** HITL_UNRESOLVED / 畸形 resolve → 整个 run 转 run.error */
  error?: string;
  /**
   * NL 通道（AD-026 增补）：用户回复未匹配且未达上限 → 重问。runner 据此**跳过 codex**、
   * 注入 events（一条 assistant 提示消息）后以 hitl_pending 结束本轮，suspend 仍挂起待下次回复。
   */
  reask?: boolean;
}

/** NL 通道：根据 suspend 之后的 user.message 判定结果（确定性、replay 安全）。 */
type NlOutcome =
  | { kind: "none" }
  | { kind: "matched"; optionId: string }
  | { kind: "input"; value: string }
  | { kind: "reask" }
  | { kind: "auto_reject" };

/** 取值类 suspend（input_required，G3/G4）：用户回复就是值，不靠选项匹配。 */
function isInputSuspend(suspend: ToolcallSuspendEvent): boolean {
  const s = suspend as { interactionKind?: string; responseSchema?: unknown };
  return s.interactionKind === "input_required"
    || ((suspend.options?.length ?? 0) === 0 && s.responseSchema != null);
}

/** input_required 的 payload 字段名：responseSchema 单属性用其名，否则默认 "value"。 */
function inputPayloadKey(suspend: ToolcallSuspendEvent): string {
  const schema = (suspend as { responseSchema?: { properties?: Record<string, unknown> } }).responseSchema;
  const props = schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  return props.length === 1 ? props[0] : "value";
}

function resolveNlReply(history: RunloopEvent[], suspend: ToolcallSuspendEvent): NlOutcome {
  const sIdx = history.findIndex((e) => e.id === suspend.id);
  // 回复窗口止于下一个 suspend（若有）：避免把后续针对**其它** suspend 的 user.message 计入本 suspend 的
  // 重试计数（Phase 2 嵌套/多挂起下会误算 → 早期未决 suspend 提前 auto_reject 误拒，L4）。
  const nextSuspendIdx = history.findIndex((e, i) => i > sIdx && e.type === EventType.ToolcallSuspend);
  const windowEnd = nextSuspendIdx === -1 ? history.length : nextSuspendIdx;
  const replies = history.filter(
    (e, i): e is UserMessageEvent => i > sIdx && i < windowEnd && e.type === EventType.UserMessage,
  );
  if (replies.length === 0) return { kind: "none" };
  // 走到这里说明该 suspend 尚未被解决（否则 resolvedToolCallIds 命中、上层已 continue）——
  // 故历史里没有任何回复匹配过；只需看最新一条回复。
  const last = replies[replies.length - 1];
  // 取值类（input_required）：用户回复**就是值**，不靠选项匹配；非空即视为提供了输入，空回复才重问。
  if (isInputSuspend(suspend)) {
    const value = (last.content ?? "").trim();
    return value ? { kind: "input", value } : { kind: "reask" };
  }
  const optionId = matchReplyToOption(last.content ?? "", suspend.options ?? []);
  if (optionId) return { kind: "matched", optionId };
  if (replies.length >= MAX_NL_RETRIES) return { kind: "auto_reject" };
  return { kind: "reask" };
}

/** 找 suspend 的拒绝选项 id（auto-reject 合成 resolve 时引用）。 */
function rejectOptionId(suspend: ToolcallSuspendEvent): string {
  return (suspend.options ?? []).find((o) => o.kind === "reject_once" || o.kind === "reject_always")?.optionId ?? "reject";
}

/**
 * execute-on-resume 在 resume run 里**重发 toolcall.start+end**，使本 run 的 SSE 流自洽：
 * toolresult.* 的前置 toolcall.start 原本在 suspend 那个 run（run-1），跨 run 引用对单 run 校验是孤儿
 * （assertBaseInvariants）。语义上 resume run（run-2）才是工具**真正被执行**处，重发完整生命周期更准确，
 * 且让任何按单 run 流消费的上游（agui-bridge 等）拿到自洽的 toolcall→toolresult 序列。
 */
function reopenToolcall(
  conversationId: string,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  parentToolCallId?: string,
): RunloopEvent[] {
  return [
    createEvent(EventType.ToolcallStart, conversationId, { toolCallId, toolName, parentToolCallId }),
    createEvent(EventType.ToolcallEnd, conversationId, { toolCallId, args, parentToolCallId }),
  ];
}

/** 重问时给用户的一条 assistant 提示消息（含原 prompt + 示例触发词）。 */
function buildReaskMessage(suspend: ToolcallSuspendEvent, conversationId: string): RunloopEvent[] {
  const hints = (suspend.options ?? []).flatMap((o) => (o.matchWords ?? []).slice(0, 3));
  const text = `未能识别你的回复。${suspend.prompt ?? "请确认是否继续"}${hints.length ? `（请明确回复，例如：${hints.join(" / ")}）` : ""}`;
  // 这条 reask message 由 runner 直接 yield、不经 MergeNormalizer（HITL 重问发生在归一化器建立之前），
  // 故在此本地盖一份 messageId（自洽三件套共享同一 id），与归一化器对其它 message 的盖法语义一致。
  const messageId = `msg-${nanoid()}`;
  return [
    createEvent(EventType.MessageStart, conversationId, { messageId, role: "assistant" }),
    createEvent(EventType.MessageDelta, conversationId, { messageId, content: text }),
    createEvent(EventType.MessageEnd, conversationId, { messageId }),
  ];
}

/**
 * HITL execute-on-resume（AD-026 · Phase 1）。
 *
 * 扫描历史中处于"挂起"相位的 toolcall（toolcall.suspend 且尚无匹配 toolresult），
 * 找到对应的 user.command{resolve}：
 *  - allow_*（主轨）→ 用历史 toolcall.end.args 经 sidecar **代执行真实 op**（绕过 ask 闸门），注入 toolresult；
 *  - allow_*（辅轨 ask 原语 request_user_input / 别名 request_confirmation，无真实 op）→ 回填"用户已确认/已选/已填"决策；
 *  - reject_* → 注入 isError=true 的 denied_by_user toolresult。
 *
 * 幂等不变量：toolCallId 已有匹配 toolresult ⇒ 已解决，后续 replay 不再执行（防二次 drop 表）。
 * no-partial-resume：存在未决 suspend 却无 resolve / 畸形 resolve ⇒ 返回 error（HITL_UNRESOLVED）。
 */
/**
 * 从历史派生会话级粘性授权（Phase 2 allow_always/reject_always）：
 * 扫描已 resolve 的 suspend，按其选中 option 的 kind 把 toolName 归入 allow/reject 集合。
 * sidecar maybeSuspend 据此对后续同名工具直接放行 / 拒绝，无需再次挂起。
 */
export function derivePolicies(history: RunloopEvent[]): { allow: Set<string>; reject: Set<string> } {
  const allow = new Set<string>();
  const reject = new Set<string>();
  const suspends = history.filter((e): e is ToolcallSuspendEvent => e.type === EventType.ToolcallSuspend);
  const resolves = history.filter(
    (e): e is UserCommandEvent => e.type === EventType.UserCommand && (e as UserCommandEvent).command === "resolve",
  );
  for (const s of suspends) {
    const r = resolves.find((x) => x.toolCallId === s.toolCallId || x.targetEventId === s.id);
    if (!r) continue;
    const opt = (s.options ?? []).find((o) => o.optionId === r.selectedOptionId);
    if (opt?.kind === "allow_always") allow.add(s.toolName);
    else if (opt?.kind === "reject_always") reject.add(s.toolName);
  }
  return { allow, reject };
}

/**
 * #11 畸形 resolve 结构校验（AD-026）：在 execute-on-resume 之前显式拒绝结构上不可信的历史，
 * 避免误执行 / 误路由（fail-closed）。命中任一 ⇒ 返回错误字符串（上层转 run.error HITL_UNRESOLVED）。
 * 覆盖：① 重复 HITL event id；② 同一 toolCallId 多个 suspend；③ resolve 引用不存在的 suspend；
 * ④ resolve 早于其 suspend；⑤ suspend.options 内重复 optionId；⑥/⑦ resolve 的 toolName/parentToolCallId
 * 与被引用 suspend 不一致（提供时才校验）。conflicting（同 suspend 多 resolve）由 resolvePendingHitl 主循环
 * 单独处理（已有用例）。无 suspend 时不校验（stray resolve 视为无操作，replay 友好）。
 */
export function validateHitlResolves(history: RunloopEvent[]): string | undefined {
  const suspends = history.filter(
    (e): e is ToolcallSuspendEvent => e.type === EventType.ToolcallSuspend,
  );
  if (suspends.length === 0) return undefined;
  const resolves = history.filter(
    (e): e is UserCommandEvent => e.type === EventType.UserCommand && (e as UserCommandEvent).command === "resolve",
  );

  // 事件→索引 Map（一次 O(n) 预建，取代循环里反复 history.indexOf 的 O(n²)——长对话 HITL resume
  // 性能退化，评审 P1-4）。只记首次出现，与 indexOf 语义一致（正常无重复引用，此守卫仅防退化）。
  const idxOf = new Map<RunloopEvent, number>();
  history.forEach((e, i) => {
    if (!idxOf.has(e)) idxOf.set(e, i);
  });

  // ① 重复 event id（HITL 相关事件间）：复用 id 会让位置/幂等判定全部失真。
  const hitlEvents = [...suspends, ...resolves];
  const seenIds = new Set<string>();
  for (const e of hitlEvents) {
    if (seenIds.has(e.id)) return `duplicate HITL event id "${e.id}"`;
    seenIds.add(e.id);
  }

  // ⑤ suspend.options 内重复 optionId：selectedOptionId 引用将不唯一（find 取首个 → 静默歧义）。
  for (const s of suspends) {
    const optIds = new Set<string>();
    for (const o of s.options ?? []) {
      if (optIds.has(o.optionId)) return `duplicate optionId "${o.optionId}" in suspend "${s.id}"`;
      optIds.add(o.optionId);
    }
  }

  // ② 同一 toolCallId 的多个 suspend只在「重叠未决」时畸形：前一个 suspend 必须在下一个出现前已解决
  // （其后有匹配 toolresult.end）。toolCallId 跨 run/CLI/子 agent 合法复用（H5/AD-026 #5），故不能见重就拒。
  const toolresultIdx = history
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === EventType.ToolresultEnd)
    .map(({ e, i }) => ({ tcId: (e as ToolresultEndEvent).toolCallId, i }));
  const suspendByTc = new Map<string, ToolcallSuspendEvent>(); // 最近一个（用于 resolve 引用 + 重叠检测）
  const suspendById = new Map<string, ToolcallSuspendEvent>();
  const lastSuspendIdxByTc = new Map<string, number>();
  for (const s of suspends) {
    const sIdx = idxOf.get(s)!;
    const prevIdx = lastSuspendIdxByTc.get(s.toolCallId);
    if (prevIdx !== undefined) {
      const resolvedBetween = toolresultIdx.some((t) => t.tcId === s.toolCallId && t.i > prevIdx && t.i < sIdx);
      if (!resolvedBetween) return `multiple suspends for toolCallId "${s.toolCallId}"`;
    }
    lastSuspendIdxByTc.set(s.toolCallId, sIdx);
    suspendByTc.set(s.toolCallId, s);
    suspendById.set(s.id, s);
  }

  // ③/④ resolve 必须引用存在的 suspend，且不得早于其 suspend。
  // **绑定按全局唯一 targetEventId（suspend.id）优先**（AD-026 #5）：toolCallId 跨 run/CLI/子 agent 合法复用，
  // suspendByTc 只存「最后一个」同名 suspend，若 toolCallId 优先则带 targetEventId 的历史 resolve 会被绑到后一个
  // run 的 suspend → 误报 precedes。toolCallId 仅在 targetEventId 缺省时兜底（此时若复用仍歧义，但契约要求带 id）。
  for (const r of resolves) {
    const s =
      (r.targetEventId && suspendById.get(r.targetEventId)) ||
      (r.toolCallId && suspendByTc.get(r.toolCallId)) ||
      undefined;
    if (!s) {
      return `resolve references unknown suspend (toolCallId="${r.toolCallId ?? ""}", targetEventId="${r.targetEventId ?? ""}")`;
    }
    if (idxOf.get(r)! < idxOf.get(s)!) {
      return `resolve precedes its suspend for toolCallId "${s.toolCallId}"`;
    }
    // ⑥/⑦ 一致性断言（提供时才校验，防解决错对象 / 嵌套层级错配）：resolve 显式带的 toolName /
    // parentToolCallId 必须与被引用 suspend 相符。缺省（未带）则跳过，向后兼容旧客户端。
    if (r.toolName !== undefined && r.toolName !== s.toolName) {
      return `resolve toolName "${r.toolName}" mismatches suspend toolName "${s.toolName}" (toolCallId "${s.toolCallId}")`;
    }
    if (r.parentToolCallId !== undefined && r.parentToolCallId !== s.parentToolCallId) {
      return `resolve parentToolCallId "${r.parentToolCallId}" mismatches suspend parentToolCallId "${s.parentToolCallId ?? ""}" (toolCallId "${s.toolCallId}")`;
    }
  }
  return undefined;
}

export async function resolvePendingHitl(
  history: RunloopEvent[],
  ctx: ResolveHitlContext,
): Promise<ResolveHitlResult> {
  const malformed = validateHitlResolves(history);
  if (malformed) return { events: [], error: malformed };

  const suspends = history.filter(
    (e): e is ToolcallSuspendEvent => e.type === EventType.ToolcallSuspend,
  );
  if (suspends.length === 0) return { events: [] };

  // 幂等判定按**位置 + 全局 suspendEventId（suspend.id）**，不用裸 toolCallId 扁平集——CLI/子 agent/跨 run
  // 会复用 tc-1/item_0，扁平集会把**另一次调用**误判已解决（已批准的 op 被静默跳过，或 replay 重复执行，
  // AD-026 #5）。一个 suspend 已解决 ⟺ 其 toolCallId 在**该 suspend 自身索引之后**出现匹配 toolresult.end。
  const toolresultPositions = history
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === EventType.ToolresultEnd)
    .map(({ e, i }) => ({ tcId: (e as ToolresultEndEvent).toolCallId, i }));
  const suspendIndex = new Map<string, number>();
  const endArgs = new Map<string, Record<string, unknown>>();
  const startName = new Map<string, string>();
  history.forEach((e, i) => {
    if (e.type === EventType.ToolcallSuspend) suspendIndex.set(e.id, i);
    if (e.type === EventType.ToolcallEnd) endArgs.set((e as ToolcallEndEvent).toolCallId, (e as ToolcallEndEvent).args ?? {});
    if (e.type === EventType.ToolcallStart) startName.set((e as ToolcallStartEvent).toolCallId, (e as ToolcallStartEvent).toolName);
  });
  const resolves = history.filter(
    (e): e is UserCommandEvent => e.type === EventType.UserCommand && (e as UserCommandEvent).command === "resolve",
  );

  const out: RunloopEvent[] = [];

  for (const suspend of suspends) {
    const tcId = suspend.toolCallId;
    const sIdx = suspendIndex.get(suspend.id) ?? -1;
    // 幂等：本 suspend 自身索引之后已有匹配 toolresult ⇒ 已解决，replay 不再执行（按 suspendEventId 位置判定）。
    if (toolresultPositions.some((t) => t.tcId === tcId && t.i > sIdx)) continue;

    // 绑定按全局唯一 targetEventId 优先（AD-026 #5）：resolve 显式带 targetEventId 时**只**匹配该 suspend，
    // 不再用复用的 toolCallId 兜底——否则跨 run 复用 tc 时一条带 id 的 resolve 会同时匹配多个同名 suspend、误判 conflicting。
    const matches = resolves.filter((r) => (r.targetEventId ? r.targetEventId === suspend.id : r.toolCallId === tcId));
    if (matches.length > 1) {
      return { events: out, error: `conflicting HITL resolutions for toolCallId "${tcId}"` };
    }

    // 结构化 user.command{resolve} 优先；缺失则走 NL 通道（matchWords 确定性匹配 / 重问 / 上限自动拒绝）。
    let optionId: string | undefined;
    let cmdReason: string | undefined;
    let cmdPayload: Record<string, unknown> | undefined;
    // 取值类（input_required，G3/G4）：用户提供的是**值**而非选项 → 直接 allow、值进 payload，无 option 可查。
    let inputAllow = false;
    const isInput = isInputSuspend(suspend);
    if (matches.length === 1) {
      optionId = matches[0].selectedOptionId;
      cmdReason = matches[0].reason;
      cmdPayload = matches[0].payload as Record<string, unknown> | undefined;
      // 取值类的结构化 resolve 只带 payload（无 selectedOptionId）→ 视为已提供值、allow。
      if (isInput && !optionId) inputAllow = true;
    } else {
      const nl = resolveNlReply(history, suspend);
      if (nl.kind === "none") {
        return { events: out, error: `unresolved HITL suspend for toolCallId "${tcId}"` };
      }
      if (nl.kind === "reask") {
        // 仍挂起、不产 toolresult；发提示消息，runner 据 reask 以 hitl_pending 结束本轮。
        out.push(...buildReaskMessage(suspend, ctx.conversationId));
        return { events: out, reask: true };
      }
      if (nl.kind === "input") {
        // 取值类：NL 回复就是值，按 responseSchema 单属性名进 payload，allow。
        inputAllow = true;
        cmdPayload = { [inputPayloadKey(suspend)]: nl.value };
        cmdReason = "input provided by NL reply";
      } else if (nl.kind === "matched") {
        optionId = nl.optionId;
        cmdReason = "matched by NL reply";
      } else {
        optionId = rejectOptionId(suspend);
        cmdReason = "多次未匹配成功，自动拒绝";
      }
    }

    // 取值类无 option（直接 allow）；其余按 selectedOptionId 查 option，查不到即畸形 resolve。
    const option = inputAllow ? undefined : (suspend.options ?? []).find((o) => o.optionId === optionId);
    if (!inputAllow && !option) {
      return { events: out, error: `invalid selectedOptionId "${optionId}" for toolCallId "${tcId}"` };
    }

    const allow = inputAllow
      || option!.kind === "allow_once" || option!.kind === "allow_always" || option!.kind === "allow_modified";
    const parentToolCallId = suspend.parentToolCallId;
    // resume run 自洽：先重发该 toolcall 的 start+end（原 start 在 suspend run），再 toolresult.*。
    out.push(...reopenToolcall(
      ctx.conversationId,
      tcId,
      startName.get(tcId) ?? suspend.toolName,
      endArgs.get(tcId) ?? suspend.args ?? {},
      parentToolCallId,
    ));
    out.push(createEvent(EventType.ToolresultStart, ctx.conversationId, { toolCallId: tcId, parentToolCallId }));

    if (!allow) {
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: {
          status: "denied_by_user",
          reason: cmdReason ?? "user rejected",
          hint: "操作未执行；用户拒绝；不要重试同一调用，换方案或回问用户",
        },
        isError: true,
      }));
      continue;
    }

    // 嵌套（子 agent 触发的 HITL）：suspend 带 parentToolCallId。**父层永不代执行子层 op**（AD-026 不变量）——
    // 沿 parentToolCallId 链把审批向下转发给对应子 agent，由子 agent 在自己帧里 execute-on-resume；
    // 子 agent 的最终输出回填为该委派（parentToolCallId）的 toolresult。
    if (parentToolCallId) {
      const delegationName = startName.get(parentToolCallId);
      const childResult = ctx.forwardNested
        ? await ctx.forwardNested({
            delegationToolCallId: parentToolCallId,
            delegationToolName: delegationName,
            // 子 agent 帧的历史切片：父扁平流里 parentToolCallId === 本委派 的事件
            childHistory: history.filter((e) => (e as { parentToolCallId?: string }).parentToolCallId === parentToolCallId),
            suspendToolCallId: tcId,
            selectedOptionId: optionId ?? "",
            payload: cmdPayload,
            // 原始委派任务（委派 toolcall.end 的 args.task）——无状态子 agent 重建完整 messages 用。
            delegationTask: (endArgs.get(parentToolCallId) as { task?: string } | undefined)?.task,
          })
        : null;
      // 嵌套 suspend 自身的 toolresult（子帧产出的投影）——本轮 suspend（tc-x）已转发/解决。
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: childResult?.nestedResult ?? { status: "forwarded_to_child", note: "resolution forwarded down the delegation chain" },
        isError: false,
      }));
      // 多轮嵌套（P3）：子 agent resume 后又抛出**新** suspend → 委派**未完成**：不产委派 toolresult，
      // 把新子 suspend（已带 parentToolCallId=委派 id）透传进父流，以 hitl_pending 收尾等下一轮 resolve。
      if (childResult?.reSuspended) {
        out.push(...(childResult.childEvents ?? []));
        return { events: out, reask: true };
      }
      // 委派本身的 toolresult（子 agent 恢复后的最终输出），复用委派 toolCallId。
      // 同样先重发委派 toolcall 的 start+end（原 start 在更早的 run），避免孤儿 toolresult.start。
      out.push(...reopenToolcall(
        ctx.conversationId,
        parentToolCallId,
        startName.get(parentToolCallId) ?? "delegate",
        endArgs.get(parentToolCallId) ?? {},
      ));
      out.push(createEvent(EventType.ToolresultStart, ctx.conversationId, { toolCallId: parentToolCallId }));
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: parentToolCallId,
        result: childResult?.delegationResult ?? { status: "forwarded_to_child" },
        isError: childResult?.isError ?? false,
      }));
      continue;
    }

    // 辅轨（ask 原语 request_user_input / 别名 request_confirmation，背后无真实 op）：回填审批决策本身。
    // ask 原语三形态都走这里——确认/多选回填 selectedOptionId（多选时即用户选中的枚举值）、取值回填 payload，
    // 让模型在 resume 轮拿到「用户选了什么/填了什么」。
    const isAuxTrack = suspend.reason === "model_request"
      || suspend.toolName === REQUEST_USER_INPUT_TOOL
      || suspend.toolName === REQUEST_CONFIRMATION_TOOL;
    if (isAuxTrack) {
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: {
          status: "confirmed_by_user",
          reason: cmdReason,
          ...(optionId ? { selectedOptionId: optionId } : {}),
          ...(cmdPayload ? { payload: cmdPayload } : {}),
        },
        isError: false,
      }));
      continue;
    }

    // 主轨：用历史 toolcall.end.args 代执行真实 op（绕过 ask 闸门）。
    // approve_with_changes（option.kind=allow_modified）：用 user.command.payload.args 改写执行参数。
    const name = startName.get(tcId) ?? suspend.toolName;
    const payloadArgs = (cmdPayload as { args?: Record<string, unknown> } | undefined)?.args;
    const args = option?.kind === "allow_modified" && payloadArgs
      ? payloadArgs
      : (endArgs.get(tcId) ?? suspend.args ?? {});
    // 审批绑定校验（H5/AD-026 #6）：suspend 记录了批准时的执行端点签名；resume 前重算当前 resources 的
    // 同款哈希，不符 ⇒ 同名工具被指向了不同 endpoint/实现（resources 在批准后被改）⇒ 拒绝执行（防『批 A
    // 执行 B』）、需重新审批。bindingHash 缺失（旧事件/无端点工具）则跳过（向后兼容）。
    if (suspend.bindingHash && ctx.sidecar && ctx.sidecar.bindingHashFor(name) !== suspend.bindingHash) {
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: {
          status: "binding_mismatch",
          reason: "工具执行端点在批准后发生变化（resources 已变），未执行；需重新审批",
          hint: "不要重试同一调用；请用户重新确认",
        },
        isError: true,
      }));
      continue;
    }
    if (ctx.sidecar) {
      // 下游幂等键（H5）：conversationId:suspendEventId，让支持的下游按 key 去重（at-least-once → exactly-once）。
      const r = await ctx.sidecar.executeTool(name, args as Record<string, unknown>, {
        idempotencyKey: `${ctx.conversationId}:${suspend.id}`,
      });
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: r.content[0]?.text ?? "",
        isError: r.isError ?? false,
      }));
    } else {
      out.push(createEvent(EventType.ToolresultEnd, ctx.conversationId, {
        toolCallId: tcId,
        parentToolCallId,
        result: { status: "approved_no_executor", message: "approved but no sidecar available to execute the op" },
        isError: true,
      }));
    }
  }

  return { events: out };
}
