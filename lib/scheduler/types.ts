// Scheduled Task 域 — 类型模型。
//
// 这是「Background Automation Scheduler」(Phase B) 的类型基座。BG 通过
// `chrome.alarms` 周期 tick（详见 ST-B3），lib 层 cron-parser + runner 算
// 何时该跑（ST-B2），UI 层 `SchedulerSection` 给用户做 CRUD（ST-B5）。
//
// 类型组织：域内类型按概念拆分（Schedule / Action / RunResult / Notify / Task），
// 都从本文件出 export。Storage wrapper 与 backup 注册两条分别在
// `lib/persistence/storage.ts` 与 `lib/backup/registry.ts`，不在这里重新定义。
//
// 命名约定：每段最后的 segment 是「thing」不是 element type。`Schedule` 不叫
// `ScheduleConfig`、`RunResult` 不叫 `RunResultType`——按 AGENTS.md。

// ─── Schedule 判别联合 ───

/** Schedule 形态判别。`interval` 由 chrome.alarms native 支持（分钟粒度，≥1）；
 *  `cron` 由 lib 层 cron-parser 求 next fire time（精度到分钟）。 */
export type ScheduleKind = 'interval' | 'cron';

export type Schedule =
  /** chrome.alarms `periodInMinutes` 兼容——分钟粒度，>= 1。写入时由上层校验
   *  （ST-B5 Settings UI），存储层不做强制。重启浏览器会重新 align chrome.alarms，
   *  所以 periodInMinutes 的语义由 chrome 自己保证，不依赖本地时钟漂移。 */
  | { kind: 'interval'; minutes: number }
  /** 5-field cron 表达式（`m h dom mon dow`，语义见 cron-parser 包）。
   *  UI 层在保存前用 cron-parser 预解析 + 报「next fire」，避免用户写错不知道。 */
  | { kind: 'cron'; expr: string };

// ─── Action 判别联合 ───

/** Action 形态判别。`fetch` 拉 URL body；`webcheck` 是 fetch 子集（只关心 status /
 *  body 包含特定字符串）。两个 action 共用同一个 fetch 实现（ST-B2），区别只
 * 在于「要解读 body 还是只检查布尔」。 */
export type ActionKind = 'fetch' | 'webcheck';

/** `webcheck` action 的判定条件——`status_200` 只看 HTTP 200；`contains_text` 还要
 *  body 里包含 `expected` 字符串。 */
export type WebCheckCondition = 'status_200' | 'contains_text';

/** 一个任务只跑一种动作。`fetch` + `extract` 走 jsonpath 抽取字段塞进 result.data；
 *  当前 v1 jsonpath 由 ST-B2 runner 用简单正则 / 字符串 split 实现（不要为 jsonpath
 *  拉一个 full parser，bundle 成本不划算）。 */
export type Action =
  | {
      kind: 'fetch';
      url: string;
      extract?: string;
    }
  | {
      kind: 'webcheck';
      url: string;
      condition: WebCheckCondition;
      /** `contains_text` 必填；`status_200` 不用。 */
      expected?: string;
    };

// ─── Notify 与 RunResult ───

/** 任务运行时的桌面通知策略——`onSuccess` / `onFailure` 各自独立。`chrome.notifications`
 *  在 BG（`chrome.notifications.create`）调用，UI 层 in-app toast 在 ST-B6 加。
 *  失败通知的语义：「任务能跑 + 但 fetch 报错 / body 不含 expected」都算 failure
 *  （runner 自己的 VFS / 解析失败不计——那是 BG bug，不是用户应被告警的事）。 */
export interface NotifyConfig {
  onSuccess: boolean;
  onFailure: boolean;
}

/** 单次跑出来的结果。`ok: false` 不代表「任务失败」、只代表「条件不满足」（如 status
 *  非 200、body 不含 expected）——用户的语义是「期望没有命中」。`at` 毫秒时间戳；
 *  `summary` 是人类可读的一句话（≤ 80 字符），用于通知与 UI 历史卡片；
 *  `data` 只在 `fetch + extract` 命中时存在（抽取出的字段值）；
 *  `error` 只在 `ok: false` 时存在（CORS / DNS / timeout / 业务条件不满足的原始 reason，
 *  不泄漏 token）。 */
export type RunResult =
  | { ok: true; summary: string; at: number; data?: unknown }
  | { ok: false; summary: string; at: number; error: string };

// ─── Task 顶层 ───

/** 一个被调度任务的全部持久化形态。所有字段必须在写入前校验（cron 表达式 / URL
 *  scheme / interval minutes ≥ 1 / name 非空）。`lastResult` 由 ST-B3 BG manager 在
 * 每次跑完更新；`lastRunAt` 同理。用户在 Settings 里删 / 禁用任务不动这两个字段
 *  ——历史保留，UI 列表里直接展示。 */
export interface ScheduledTask {
  /** UUID v4。BG 用它作为 chrome.alarms name（`<task-name>::<id>` 后缀避免与
   *  别的闹钟冲突），也是去重主键。 */
  id: string;
  /** 用户给的展示名（≤ 60 字符），用于 chrome.notifications title 与 Settings 列表。 */
  name: string;
  /** cron / interval。二选一。cron 在 ST-B2 由 cron-parser 算 next。 */
  schedule: Schedule;
  /** fetch / webcheck。 */
  action: Action;
  /** 通知开关。 */
  notify: NotifyConfig;
  /** 用户临时禁用任务而不删除——BG tick 跳过 disabled 任务，但 lastResult 仍展示
   *  最近一次跑出的状态供用户参考。 */
  enabled: boolean;
  /** 任务创建的毫秒时间戳（`Date.now()`），UI 用「Created 2 days ago」展示。 */
  createdAt: number;
  /** 最近一次跑完的毫秒时间戳；从未跑过则 null。 */
  lastRunAt: number | null;
  /** 最近一次的 RunResult；从未跑过则 null。 */
  lastResult: RunResult | null;
}

/** 持久化形态：任务数组（直接用 `ScheduledTask[]`，不另起 type alias）。
 *  空数组视为「用户没配过任何任务」。BG 与 UI 都只读这一份；写入由
 *  SettingsSection 的 CRUD handler 走（ST-B5），BG 不直接 mutate。 */
