import Dexie, { type EntityTable } from 'dexie';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { asString, isValidSessionId } from '@/lib/utils';
import { debugLog, withSession } from '@/lib/debug/log';

// ─── Schema ───

/** `SessionRecord` 的「弱化形态」：只保证身份 / 时间合法、`messages` 是数组（元素形态
 *  未确认）。命名仿 `PromiseLike`——完整的 `SessionRecord` 是它的子类型（`extends`）。
 *  用作 IPC 边界校验（`isValidSessionLike`）后、规整（`toSessionRecord`）前的中间形态：
 *  关键字段已验，描述性字段仍未知。`messages` 故意放宽成 `unknown[]`，不耦合第三方
 *  `AgentMessage` 的内部结构。 */
export interface SessionRecordLike {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

// 新增字段时：同步更新下方 `toSessionRecord`（它逐字段构造完整记录）。必填字段漏补会被
// 返回类型 tsc 拦住；但可选字段漏补不会报错、会被静默丢弃，仍需在此显式决定默认值 /
// 透传 / 丢弃。
export interface SessionRecord extends SessionRecordLike {
  title: string;
  model: string;
  provider: string;
  userInstructions: string;
  thinkingLevel: string;
  messageCount: number;
  messages: AgentMessage[];
  /** Set by `agentManager.forkSession` — points to the conversation this
   *  branch was forked from. Optional: brand-new sessions and pre-fork-feature
   *  sessions never have this. Rendered as a Header badge with a "back to
   *  original" link. Title is snapshotted at fork time so the link label
   *  survives even if the source's title is later edited or the source is
   *  deleted. */
  forkedFrom?: { sessionId: string; title: string };
  /** Index of the assistant bubble in the SOURCE session that was forked.
   *  Optional: only set on the new (forked) session, never on the source
   *  itself. Used by ChatPage to scroll the source back to the forked
   *  message when the user clicks "Go to original" from the badge —
   *  otherwise the source jumps to the bottom on re-entry and hides the
   *  message the user just forked. Survives across reloads because it
   *  lives on the SessionRecord.
   *
   *  CAVEAT: this is a snapshot of the source's `messages` array index at
   *  fork time. If the user later inserts or deletes messages in the
   *  source BEFORE `forkedAtIndex`, the scroll target becomes stale. The
   *  typical flow (continue the source chat, append at the end) doesn't
   *  shift indexes, so this stays correct in practice; edge cases
   *  (prepending, deleting earlier messages) may scroll to a different
   *  bubble. Acceptable trade-off vs. a heavier message-id based mapping. */
  forkedAtIndex?: number;
}

/**
 * 把通过关键字段校验的不可信输入规整成完整 `SessionRecord`。与 `SessionRecord` 同源
 * 维护——加字段时在此逐字段补默认。描述性字段（title / model / provider /
 * userInstructions / thinkingLevel）缺失或类型不对时补安全默认，而非拒绝整条记录。
 * `messageCount` 不信输入、直接重算 `= messages.length`（它本是 messages 的派生缓存，
 * 见 `updateSessionMessages`）。`messages` 原样透传，不碰其内部结构（第三方
 * `AgentMessage`，形态会随库演进）。
 */
export function toSessionRecord(input: SessionRecordLike): SessionRecord {
  const s = input as unknown as Record<string, unknown>;
  // Optional metadata field — preserve through the IPC boundary so the
  // sidepanel can render the fork badge. Drop silently when missing or
  // malformed; do NOT promote a half-valid entry to a session without
  // sessionId (the link would be a no-op otherwise).
  let forkedFrom: SessionRecord['forkedFrom'];
  const rawFf = s.forkedFrom;
  if (rawFf && typeof rawFf === 'object') {
    const ff = rawFf as Record<string, unknown>;
    const sid = asString(ff.sessionId, '');
    if (sid) {
      forkedFrom = { sessionId: sid, title: asString(ff.title, '') };
    }
  }
  return {
    id: input.id,
    title: asString(s.title, ''),
    model: asString(s.model, ''),
    provider: asString(s.provider, ''),
    userInstructions: asString(s.userInstructions, ''),
    thinkingLevel: asString(s.thinkingLevel, 'medium'),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    messages: input.messages as AgentMessage[],
    messageCount: input.messages.length,
    ...(forkedFrom ? { forkedFrom } : {}),
    // `forkedAtIndex` is optional + numeric; preserve if a finite non-negative
    // number so callers can scroll the source back to the forked message.
    // Drop silently on malformed input (negative, NaN, Infinity, undefined).
    ...(typeof s.forkedAtIndex === 'number' && Number.isFinite(s.forkedAtIndex) && s.forkedAtIndex >= 0
      ? { forkedAtIndex: s.forkedAtIndex as number }
      : {}),
  };
}

/** 校验一个不可信值是否是合法的 `SessionRecordLike`——身份 / 安全关键字段，错了就说明
 *  来源（备份包 / IPC payload）是坏的，必须拒绝。`id` 要求 UUID 形态（它会成为备份文件名
 *  / 工作区目录段，畸形 id 会污染路径）；时间戳要求有限数字；`messages` 要求数组、且每个
 *  元素是非 null 对象。描述性字段不在此校验，留给 `toSessionRecord` 补默认。
 *
 *  注意：不深入校验 `messages` 内部字段——其元素是第三方 `pi-agent-core` 的 `AgentMessage`，
 *  结构会随库演进，只验「是非 null 对象」以解耦（但这一层守卫必要：`null` / 原始值元素会让
 *  渲染器解引用 msg.role 时整页崩，必须挡在写库前）。
 *
 *  恢复链路两处共用此守卫：page 侧（restore.ts）校验后把畸形记录归为 corruptBackup；
 *  background 侧（backup-handler）作为 IPC 边界的纵深防御。 */
export function isValidSessionLike(r: unknown): r is SessionRecordLike {
  if (!r || typeof r !== 'object') return false;
  const s = r as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    isValidSessionId(s.id) &&
    typeof s.createdAt === 'number' &&
    Number.isFinite(s.createdAt) &&
    typeof s.updatedAt === 'number' &&
    Number.isFinite(s.updatedAt) &&
    Array.isArray(s.messages) &&
    s.messages.every((m) => m !== null && typeof m === 'object')
  );
}

// ─── Database ───

const db = new Dexie('cebian') as Dexie & {
  sessions: EntityTable<SessionRecord, 'id'>;
};

db.version(1).stores({
  sessions: 'id, updatedAt',
});

// ─── Session CRUD ───

export async function createSession(session: SessionRecord): Promise<void> {
  debugLog.info('db', 'db:session:create', withSession({ id: session.id }, session.id));
  await db.sessions.add(session);
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return db.sessions.get(id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

/** {@link getSessionLabels} 返回的轻量投影：只含把工作区 UUID 翻译成人类标签所需的
 *  字段（标题 + 时间），不带 messages，调用方拿去渲染目录列表 / 头部信息条即可。 */
export interface SessionLabelRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 按 id 批量取会话的标签字段（标题 + 时间）。供 VFS 浏览器把 `/workspaces/<uuid>/`
 * 目录翻译成「会话标题 · 日期」用——一次查询解析一屏 UUID，避免逐目录查库。
 *
 * 注意：Dexie 会先把命中的整行（含 messages）载入内存再投影，这是一次性的 browse
 * 动作、非热路径，故可接受。查不到的 id 不出现在结果里，由调用方回落为「未知会话」。
 */
export async function getSessionLabels(ids: string[]): Promise<SessionLabelRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.sessions.where('id').anyOf(ids).toArray();
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function updateSessionMessages(
  id: string,
  messages: AgentMessage[],
): Promise<void> {
  // Token / cost totals are derived on-demand from each AssistantMessage.usage
  // in the UI; we deliberately do not persist aggregates to keep a single
  // source of truth (see entrypoints/sidepanel/pages/chat/index.tsx).
  try {
    await db.sessions.update(id, {
      messages,
      messageCount: messages.length,
      updatedAt: Date.now(),
    });
  } catch (err) {
    // Dexie's `update` resolves silently even when nothing matched, but quota
    // errors and schema mismatches reject — both are real production failure
    // modes that should show up in the debug log so a stale-tail bug
    // (e.g. silent rollback) is observable.
    const name = (err as { name?: string } | null)?.name ?? 'unknown';
    debugLog.error('db', 'db:writer:quota_error', withSession({
      messagesLen: messages.length,
      errorName: name,
    }, id));
    throw err;
  }
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  debugLog.info('db', 'db:session:update_title', withSession({ titleLen: title.length }, id));
  await db.sessions.update(id, { title, updatedAt: Date.now() });
}

/**
 * 更新会话的模型 / 思考档。这是「每个对话各记一个模型」的落库点——用户在某会话切换
 * 模型并发送时，后台据此把选择写进该会话行（运行时再从会话行回读，不再读全局）。
 * 只补传入的字段，未传字段保持原值；全空 patch 不动 updatedAt（避免无谓把会话顶到
 * 历史列表前面，它按 updatedAt 排序）。`provider` 是 provider key（含 custom: 前缀），
 * `model` 是 modelId，与建行时的快照字段同形。
 */
export async function updateSessionSettings(
  id: string,
  settings: { provider?: string; model?: string; thinkingLevel?: string },
): Promise<void> {
  const patch: Partial<SessionRecord> = {};
  if (settings.provider !== undefined) patch.provider = settings.provider;
  if (settings.model !== undefined) patch.model = settings.model;
  if (settings.thinkingLevel !== undefined) patch.thinkingLevel = settings.thinkingLevel;
  if (Object.keys(patch).length === 0) return;
  patch.updatedAt = Date.now();
  debugLog.info('db', 'db:session:update_settings', withSession({ patch }, id));
  await db.sessions.update(id, patch);
}

export async function deleteSession(id: string): Promise<void> {
  debugLog.info('db', 'db:session:delete', withSession({}, id));
  await db.sessions.delete(id);
}

// ─── Backup restore (transactional) ───

/**
 * 在单个 Dexie rw 事务内完成「读 existing → 决策 → (可选清空) → 批量写入」，保证
 * 恢复要么整体生效、要么整体回滚——避免「清空后写入失败」导致本地会话丢失，也让
 * 读取与写入在 IndexedDB 层原子隔离，杜绝中途被其它写事务穿插。
 *
 * 决策逻辑由调用方以纯函数 `decide` 注入（见 lib/backup/sources/sessions.ts），db 层
 * 只负责存储，不引入备份业务知识（保持分层）。
 */
export async function applySessionsTransactional(
  decide: (existing: SessionRecord[]) => { clearAll: boolean; toPut: SessionRecord[] },
): Promise<void> {
  await db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.toArray();
    const { clearAll, toPut } = decide(existing);
    if (clearAll) await db.sessions.clear();
    if (toPut.length > 0) await db.sessions.bulkPut(toPut);
  });
}

// ─── Throttled writer ───

export class ThrottledSessionWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { id: string; messages: AgentMessage[] } | null = null;

  constructor(private delayMs = 3000) {}

  schedule(id: string, messages: AgentMessage[]): void {
    this.pending = { id, messages: [...messages] };
    debugLog.info('db', 'db:writer:schedule',
      withSession({ messagesLen: messages.length, delayMs: this.delayMs }, id));
    if (this.timer) return; // Already scheduled
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const { id, messages } = this.pending;
    this.pending = null;
    const startedAt = performance.now();
    debugLog.info('db', 'db:writer:flush:start',
      withSession({ messagesLen: messages.length }, id));
    try {
      await updateSessionMessages(id, messages);
      debugLog.info('db', 'db:writer:flush:done',
        withSession({
          messagesLen: messages.length,
          durationMs: Math.round(performance.now() - startedAt),
          ok: true,
        }, id));
    } catch (err) {
      debugLog.error('db', 'db:writer:flush:failed',
        withSession({
          messagesLen: messages.length,
          durationMs: Math.round(performance.now() - startedAt),
          errorName: (err as { name?: string } | null)?.name ?? 'unknown',
        }, id));
      throw err;
    }
  }

  dispose(): void {
    const droppedSessionId = this.pending?.id ?? null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    if (droppedSessionId) {
      // Drop on shutdown is a silent data-loss surface — surface it.
      debugLog.warn('db', 'db:writer:dispose',
        withSession({ droppedSessionId, reason: 'shutdown' }, droppedSessionId));
    }
  }
}
