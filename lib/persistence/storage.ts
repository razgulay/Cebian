import { storage } from '#imports';
import type { WxtStorageItem } from 'wxt/utils/storage';
// 合法档位由 pi 定义（运行时消费方），Cebian 只持久化其中一个值 → 直接复用其类型，
// 避免与 pi-agent-core 的定义漂移（compaction / agent state 早已用其 7 档 off~max）
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { debugLog, withSession } from '@/lib/debug/log';

// ─── Debug-log chokepoint ───

/** Wrap `storage.defineItem` so every `setValue(...)` emits a debug log entry.
 *
 *  Why a single chokepoint: 14+ `defineItem` consumers exist (provider creds,
 *  model, prompt, compaction, memory, theme, font size, MCP, backup config,
 *  ...) and each one's setter is a one-liner. Logging at each call site would
 *  scatter `debugLog.*` calls across all settings sections; wrapping once here
 *  covers them all uniformly with no per-section maintenance.
 *
 *  What we log: storage key, presence of a value, value's shape (null /
 *  array / object / primitive). We never log the value itself — several
 *  storage items carry secrets (apiKey, password, OAuth tokens), and
 *  exporting the JSON debug log should not leak them.
 *
 *  Why re-return a typed handle instead of mutating in place: `setValue` on
 *  the underlying WxtStorageItem is a bound method; reassigning it would
 *  leave the original bound reference intact in callers that captured it
 *  (e.g. `useStorageItem`). Returning a fresh wrapper keeps the substitution
 *  invisible at every call site.
 *
 *  Exported so other modules (e.g. `lib/rag/settings.ts`) can define their
 *  own storage items with the same logging behavior — not just the items
 *  declared in this file. */
export function defineLoggedItem<T>(
  key: `local:${string}` | `session:${string}` | `sync:${string}` | `managed:${string}`,
  opts: { fallback: T },
): WxtStorageItem<T, Record<string, unknown>> {
  const item = storage.defineItem<T>(key, opts);
  const baseSet = item.setValue.bind(item);
  const wrapped = (value: T): Promise<void> => {
    const shape =
      value === null || value === undefined
        ? (value === null ? 'null' : 'undefined')
        : Array.isArray(value)
          ? `array(len=${value.length})`
          : typeof value === 'object'
            ? `object(keys=${Object.keys(value as object).length})`
            : typeof value;
    // Promote a top-level sessionId if the new value happens to carry one
    // (e.g. when settings are scoped to a session in future code paths).
    const candidateSid =
      value && typeof value === 'object'
        ? (value as { sessionId?: unknown }).sessionId
        : undefined;
    const sessionId = typeof candidateSid === 'string' ? candidateSid : '';
    debugLog.info('settings', 'settings:change',
      withSession({ key, shape }, sessionId));
    return baseSet(value);
  };
  // Spread preserves the rest of the WxtStorageItem shape (getValue, watch,
  // meta, migrate, etc.) and only replaces `setValue` with the logging wrap.
  // The generic pair is widened to `<T, Record<string, unknown>>` to satisfy
  // WxtStorageItem's two-param signature without losing the value type.
  return { ...item, setValue: wrapped };
}

// ─── Provider credential types ───

export interface ApiKeyCredential {
  authType: 'apiKey';
  apiKey: string;
  verified: boolean;
}

export interface OAuthCredential {
  authType: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  verified: boolean;
  extra?: Record<string, unknown>;
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderCredentials = Record<string, ProviderCredential>;

// ─── Model identity ───

/** 一个模型的轻量身份标识（provider key + modelId），可解析成 pi-ai 的运行时
 *  `Model`。既用于全局「新对话默认模型」存储项 `lastSelectedModel`，也用于会话行 /
 *  prompt 携带的「本次所用模型」。 */
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

// ─── Custom providers (OpenAI-compatible) ───

export interface CustomModelDef {
  modelId: string;
  name: string;
  reasoning: boolean;
  /** 模型是否支持图片输入（多模态/VLM）。缺省视为 false（纯文本）。 */
  image?: boolean;
  /**
   * 是否在聊天 UI 的模型下拉中显示。`false` = 隐藏，但模型配置仍保留在 settings
   * 里（用户可重新打开）。`undefined` 视为 `true`（保持向后兼容，旧装机数据没有
   * 这个字段时仍要显示在列表里）。
   */
  enabled?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelDef[];
  /** 用户自定义请求头（可能含密钥，如 Authorization / api-key）；备份时整体视为密钥 */
  headers?: Record<string, string>;
}

// ─── MCP servers ───

/**
 * Authentication strategy for an MCP server.
 * v1 only ships `none` and `bearer`. The discriminated union leaves room for
 * `oauth2` (using lib/providers/oauth/ + entrypoints/background/providers/oauth-refresh.ts) and
 * `custom` without breaking existing records.
 */
export type MCPAuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string };

/**
 * Transport descriptor. v1 supports Streamable HTTP and SSE only —
 * stdio is intentionally excluded (Chrome extension cannot spawn processes).
 *
 * Names match the MCP spec / SDK class names (`StreamableHTTPClientTransport`,
 * `SSEClientTransport`) so users / docs / code share one vocabulary.
 */
export interface MCPTransportConfig {
  type: 'streamable-http' | 'sse';
  url: string;
  /** Static request headers. Dynamic auth tokens belong in `auth`, not here. */
  headers?: Record<string, string>;
}

/**
 * Persistent user-facing configuration for one MCP server.
 *
 * Runtime state (active connection, tool-list cache, rate-limiter counters,
 * circuit-breaker state) lives in background SW memory, NOT in this record.
 * Sensitive runtime tokens (e.g. OAuth refresh) will live in a separate
 * `mcpServerRuntime` storage item when we add OAuth.
 */
export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: MCPTransportConfig;
  auth: MCPAuthConfig;
  /** Schema version for forward-compatible migrations. */
  schemaVersion: 1;
  createdAt: number;
  updatedAt: number;
}

export const mcpServers = defineLoggedItem<MCPServerConfig[]>(
  'local:mcpServers',
  { fallback: [] },
);

// ─── Thinking level ───

export type { ThinkingLevel };

// ─── Storage items (WXT defineItem) ───

export const providerCredentials = defineLoggedItem<ProviderCredentials>(
  'local:providerCredentials',
  { fallback: {} },
);

export const lastSelectedModel = defineLoggedItem<ModelIdentity | null>(
  'local:activeModel',
  { fallback: null },
);

/** 上下文压缩（摘要）专用模型。`null` = 跟随对话主模型（默认）。配置一个更小更省
 *  的模型，可让后台压缩调用不必动用昂贵的主模型；解析失败时后台静默回退主模型。 */
export const compactionModel = defineLoggedItem<ModelIdentity | null>(
  'local:compactionModel',
  { fallback: null },
);

/** DOM 子代理模型（专门给 main agent 委派「读网页/截取内容」这类重活）。
 *  `null` = 关闭此功能（main agent 看不到 `delegate_dom` 工具）。
 *  配置一个便宜模型后，main agent 可以调用 `delegate_dom({ task })` 委派读取
 *  任务给该模型，避免用昂贵的主模型 token 去处理大段网页文本。 */
export const domSubAgentModel = defineLoggedItem<ModelIdentity | null>(
  'local:domSubAgentModel',
  { fallback: null },
);

export const customProviders = defineLoggedItem<CustomProviderConfig[]>(
  'local:customProviders',
  { fallback: [] },
);

export const lastSelectedThinkingLevel = defineLoggedItem<ThinkingLevel>(
  'local:thinkingLevel',
  { fallback: 'medium' },
);

/**
 * 「最近打开过的会话 id」——给悬浮球 toggle 场景使用：关闭侧边栏后 Chrome 会销毁整个
 * sidepanel window；再次点开浮动球创建的是全新窗口 + 空 React 树（route 回到
 * /chat/new）。把当前会话路由持久化进 storage，新窗口 mount 时读回并 navigate，
 * 视觉上像是「折叠」而不是「重置成新对话」。
 *
 * 只在路由是 /chat/:id 时写入（/chat/new 不写，免得反复 toggle 后死循环在 new）；
 * 写入与读取都在同一窗口内同步 WXT storage，没有跨窗口一致性需求。
 */
export const lastOpenSessionId = defineLoggedItem<string | null>(
  'local:lastOpenSessionId',
  { fallback: null },
);

export const themePreference = defineLoggedItem<'dark' | 'light' | 'system'>(
  'local:theme',
  { fallback: 'system' },
);

export type VfsOpenPreference = 'smart' | 'preview' | 'source';

/** Versioned independently because document renderer capabilities will grow
 * over time and may need a migration without disturbing general settings. */
export const vfsOpenPreferenceV1 = defineLoggedItem<VfsOpenPreference>(
  'local:vfsOpenPreference:v1',
  { fallback: 'smart' },
);

export const userInstructions = defineLoggedItem<string>(
  'local:userInstructions',
  { fallback: '' },
);

export const expandPromptsInline = defineLoggedItem<boolean>(
  'local:expandPromptsInline',
  { fallback: false },
);

/** Width of the file-tree panel inside FileWorkspace (Prompts / Skills sections). */
export const settingsFilePanelWidth = defineLoggedItem<number>(
  'local:settingsFilePanelWidth',
  { fallback: 280 },
);

/**
 * Remembers the last-visited Settings section so reopening /settings lands where the user left off.
 * Stores a relative section path such as 'prompts' | 'providers' | 'skills' | ...
 */
export const lastSettingsSection = defineLoggedItem<string>(
  'local:lastSettingsSection',
  { fallback: 'providers' },
);

// ─── Update notice (in-app "new version available" dialog) ───

/**
 * 控制「发现新版本」弹窗的提醒频率与版本跳过状态。
 * - `skippedVersion`：用户点「跳过此版本」后记录的版本号，等于最新版时不再弹窗。
 * - `lastPromptedAt`：上次弹窗的时间戳，用于 24h 节流（关闭/立即更新后写入）。
 */
export interface UpdateNoticeState {
  skippedVersion: string | null;
  lastPromptedAt: number;
}

export const updateNoticeState = defineLoggedItem<UpdateNoticeState>(
  'local:updateNoticeState',
  { fallback: { skippedVersion: null, lastPromptedAt: 0 } },
);

/**
 * 扩展刚更新到的版本号，待侧边栏下次打开时消费：背景 SW 在
 * `chrome.runtime.onInstalled`（reason=update）时写入当前版本，侧边栏启动后读取
 * 并打开对应版本的更新日志页，随即清空。`null` 表示无待展示更新。
 * 之所以经持久标记而非更新时直接开标签，是为了保证只在用户主动打开侧边栏后才弹页。
 */
export const pendingChangelogVersion = defineLoggedItem<string | null>(
  'local:pendingChangelogVersion',
  { fallback: null },
);

// ─── WebDAV 备份连接配置 ───

/**
 * WebDAV 远程备份的连接配置。归入备份的「密钥信息」分类（含明文密码），
 * 因此默认不备份、备份时单独警告并可加密。`null` 表示尚未配置。
 */
export interface WebDavConfig {
  /** WebDAV 服务端点 URL。 */
  url: string;
  username: string;
  password: string;
  /** 远程目录路径，如 '/cebian'。 */
  directory: string;
}

export const webdavConfig = defineLoggedItem<WebDavConfig | null>(
  'local:webdavConfig',
  { fallback: null },
);

// ─── 跨对话记忆（cross-conversation memory） ───

/** 记忆整理（organize）的「用户配置」。运行结果（上次时间）分到 memoryOrganizeState，
 *  避免后台写结果时读改写覆盖用户在设置页改的配置。`auto/intervalDays/minNewMemories`
 *  驱动自动整理调度（旧装机缺这些字段时由 `resolveOrganizeSettings` 补默认）。 */
export interface MemoryOrganizeSettings {
  /** 整理用模型；缺省回退当前活跃模型。 */
  model?: ModelIdentity;
  /** 自动整理开关。默认 false。 */
  auto: boolean;
  /** 自动整理最小间隔天数。默认 14。 */
  intervalDays: number;
  /** 距上次成功整理、新增/改动记忆达到此数才自动跑。默认 30。 */
  minNewMemories: number;
}

/** 记忆整理的「运行结果态」（派生、非用户配置）。只有 organize manager 写它，故读改写无竞态；
 *  备份无意义（exclude）。设置页响应式读取以展示「上次整理时间」。 */
export interface MemoryOrganizeState {
  /** 上次「成功」整理的时间（冲突/失败跳过不更新）。 */
  lastRunAt?: number;
  /** 上次「尝试」整理的时间（含冲突/失败跳过；退避调度用，避免反复烧 token）。 */
  lastAttemptAt?: number;
}

/**
 * 跨对话记忆系统的持久设置。`enabled` 是主开关；`organize` 是整理子结构。
 *
 * `organize` 故意可选：早期装机只存了 `{ enabled }`，WXT 的 fallback 仅在 key
 * 整体缺失时生效、不会给「已存在但缺字段」的旧值补子结构（实测 version 迁移在旧值
 * 无 version meta 时也不触发）。故读取整理设置一律走 `resolveOrganizeSettings`，由它
 * 补默认值——这是唯一可靠且可测的回填点。
 */
export interface MemorySettings {
  /** 记忆系统总开关。关闭时不注入记忆提示/索引、整理调度不运行；文件工具层不做硬拦截。默认 false（隐私优先）。 */
  enabled: boolean;
  /** 整理设置（旧装机可能缺；用 `resolveOrganizeSettings` 取规范值）。 */
  organize?: MemoryOrganizeSettings;
}

/** organize 子结构的默认值（新装机 fallback + 旧装机回填共用单一真理源）。默认偏保守：
 *  自动关、间隔 14 天、攒够 30 条新记忆才自动跑——基本不打扰、不意外烧 token。 */
const DEFAULT_ORGANIZE: MemoryOrganizeSettings = {
  auto: false,
  intervalDays: 14,
  minNewMemories: 30,
};

/** 取规范的整理设置：补齐旧装机缺失的 organize 子结构。所有整理逻辑读设置的唯一入口。 */
export function resolveOrganizeSettings(s: MemorySettings): MemoryOrganizeSettings {
  return { ...DEFAULT_ORGANIZE, ...s.organize };
}

export const memorySettings = defineLoggedItem<MemorySettings>(
  'local:memorySettings',
  { fallback: { enabled: false, organize: { ...DEFAULT_ORGANIZE } } },
);

/** 整理运行结果态（派生）。只有 organize manager 写；fallback 空对象。 */
export const memoryOrganizeState = defineLoggedItem<MemoryOrganizeState>(
  'local:memoryOrganizeState',
  { fallback: {} },
);

// ─── 页面交互（悬浮球 + 划词工具条） ───

/**
 * 注入页面的交互功能设置：贴边悬浮球（单击拉起侧边栏）与划词工具条（复制 / 解释 /
 * 翻译）。两块 UI 各有显示开关；工具条的 AI 单独配置，缺省回退对话主模型。
 *
 * `toolbarModel` 缺省（undefined）= 跟随主模型，语义同压缩模型的「跟随对话模型」。
 * `translateTarget` 是翻译目标语言的 BCP-47 代码；空串 = 跟随界面语言（读取时由调用
 * 方解析成具体语言），语义同「自动」。
 */
export interface PageInteractionSettings {
  /** 悬浮球显示开关。默认 true */
  showFloatingBall: boolean;
  /** 划词工具条显示开关。默认 true */
  showSelectionToolbar: boolean;
  /** 工具条专用模型；缺省回退主模型 */
  toolbarModel?: ModelIdentity;
  /** 翻译目标语言 BCP-47 代码；空串 = 跟随界面语言 */
  translateTarget: string;
}

/** 页面交互设置默认值（新装机 fallback + 旧装机字段回填共用单一真理源）。 */
const DEFAULT_PAGE_INTERACTION: PageInteractionSettings = {
  showFloatingBall: true,
  showSelectionToolbar: true,
  translateTarget: '',
};

/** 取规范的页面交互设置：补齐旧装机 / 部分写入缺失的字段。读设置的唯一入口。 */
export function resolvePageInteractionSettings(
  s: Partial<PageInteractionSettings> | undefined,
): PageInteractionSettings {
  return { ...DEFAULT_PAGE_INTERACTION, ...s };
}

export const pageInteractionSettings = defineLoggedItem<PageInteractionSettings>(
  'local:pageInteractionSettings',
  { fallback: { ...DEFAULT_PAGE_INTERACTION } },
);

/**
 * 悬浮球的位置（拖拽后记住）：贴哪侧边 + 垂直位置比例（0-1，相对视口高，跨
 * 分辨率 / 缩放稳定）。设备本地 UI 状态，备份无意义（exclude）。
 */
export interface FloatingBallPosition {
  side: 'left' | 'right';
  topRatio: number;
}

/** 悬浮球默认位置（存储 fallback 与组件初值共用单一真理源）。 */
export const DEFAULT_FLOATING_BALL_POSITION: FloatingBallPosition = {
  side: 'right',
  topRatio: 0.62,
};

export const floatingBallPosition = defineLoggedItem<FloatingBallPosition>(
  'local:floatingBallPosition',
  { fallback: { ...DEFAULT_FLOATING_BALL_POSITION } },
);

/**
 * 「在侧边栏继续」的交接标记：内容脚本点「继续」后，background 固化一条会话并把
 * sessionId + 目标 windowId 写在此处；对应窗口的侧边栏（可能刚被打开）监听到且
 * windowId 匹配时才跳转并清空——避免多窗口时其它面板误跳。派生一次性信号，
 * 备份无意义（exclude）。`null` 表示无待跳转。
 */
export interface SidePanelHandoff {
  sessionId: string;
  windowId: number;
}

export const pendingSidePanelHandoff = defineLoggedItem<SidePanelHandoff | null>(
  'local:pendingSidePanelHandoff',
  { fallback: null },
);

// ─── 调试日志（persistent ring buffer）───

/**
 * 调试日志设置：控制 `console.*` mirror 的写入行为。
 *
 * - `enabled` 总开关；关闭时既不写 IDB 也不通过 port 推送到侧边栏。
 * - `verbose` 高频事件（每条 token 的 `event:message_update`）开关；关闭时跳过
 *   写入/推送。`warn` / `error` 永远落盘（debug 这块的核心价值就是抓现场）。
 *
 * 设备本地偏好（用户什么时候想看日志），不进 config.json。`exclude`。
 */
export interface DebugLogSettings {
  enabled: boolean;
  verbose: boolean;
}

export const DEFAULT_DEBUG_LOG_SETTINGS: DebugLogSettings = {
  enabled: true,
  verbose: false,
};

export const debugLogSettings = defineLoggedItem<DebugLogSettings>(
  'local:debugLogSettings',
  { fallback: { ...DEFAULT_DEBUG_LOG_SETTINGS } },
);

// ─── Chat appearance (font size + font family) ───

/**
 * Chat font size in the sidepanel, stored as a CSS-pixel number so users can
 * pick any value the slider supports (14–15 px in 0.1 increments). The
 * renderer maps the px value to a CSS rem on the document root.
 *
 * Legacy installs stored a discrete key ('xs' | 'sm' | 'md' | 'lg' | 'xl');
 * the hook layer migrates those on read.
 */
export type ChatFontSize = number;

/** Slider bounds — kept in sync with the UI control in AppearanceSection. */
export const CHAT_FONT_SIZE_MIN = 14;
export const CHAT_FONT_SIZE_MAX = 15;
export const CHAT_FONT_SIZE_STEP = 0.1;

export const DEFAULT_CHAT_FONT_SIZE: ChatFontSize = 14;

export const chatFontSize = defineLoggedItem<ChatFontSize>(
  'local:chatFontSize',
  { fallback: DEFAULT_CHAT_FONT_SIZE },
);

/**
 * Chat font family in the sidepanel. Stored as a stable id (not raw CSS)
 * so the UI shows a friendly label and the CSS layer keeps the @font-face
 * mapping in one place. `data-chat-font="<id>"` on `:root` selects the
 * cascade.
 */
export type ChatFontFamilyId = 'geist' | 'inter' | 'roboto' | 'system';

export interface ChatFontFamilyOption {
  id: ChatFontFamilyId;
  /** Display label shown in the settings UI. */
  label: string;
  /** Human-readable sample text so users recognize the look. */
  sample: string;
}

export const DEFAULT_CHAT_FONT_FAMILY: ChatFontFamilyId = 'geist';

export const chatFontFamily = defineLoggedItem<ChatFontFamilyId>(
  'local:chatFontFamily',
  { fallback: DEFAULT_CHAT_FONT_FAMILY },
);
