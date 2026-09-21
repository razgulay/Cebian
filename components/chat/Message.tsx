import { Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Lightbulb, CheckCircle, Crosshair, FileText, Film, Pencil, Quote, ShieldAlert, Sparkles, Zap } from 'lucide-react';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CopyButton } from '@/components/common/CopyButton';
import { useTypewriterText } from '@/hooks/useTypewriterText';
import { MarkdownRenderer } from '@/components/common/MarkdownRenderer';
import { MessageMetaRow, type MessageMetaProps } from '@/components/chat/MessageMetaRow';
import { StreamingCursor } from '@/components/chat/StreamingCursor';
import { extractUserText, extractUserAttachments, extractSlashPrompt, extractInlineDirectivesFromMessage } from '@/lib/agent/message-helpers';
import { showDialog } from '@/lib/ui/dialog';
import { RECORDING_MIME } from '@/lib/agent/attachments';
import { t } from '@/lib/i18n';
import { describePermission } from '@/lib/agent/tool-permissions';
import { downloadFile, formatDuration, formatCompactCount } from '@/lib/utils';
import type { Message } from '@earendil-works/pi-ai';

/* ─── Branch switcher ─── */

interface BranchSwitcherProps {
  index: number;
  count: number;
  onPrev?: () => void;
  onNext?: () => void;
  disabled?: boolean;
}

/**
 * 分支切换器「‹ n/m ›」：一条消息存在并列版本（重试产生的并列回复 / 编辑产生的
 * 并列提问）时渲染在其下方。onPrev / onNext 缺省表示已到边界（按钮禁用）；
 * disabled 在 agent 运行中整体禁用（后台切分支只在空闲时受理）。
 */
export function BranchSwitcher({
  index,
  count,
  onPrev,
  onNext,
  disabled,
}: BranchSwitcherProps) {
  return (
    <div className="flex items-center gap-0.5 text-[0.7rem] text-muted-foreground/70">
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={onPrev}
        disabled={disabled || !onPrev}
        aria-label={t('chat.message.prevBranch')}
        title={t('chat.message.prevBranch')}
      >
        <ChevronLeft className="size-3" />
      </Button>
      <span className="font-mono tabular-nums select-none">{index + 1}/{count}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-5"
        onClick={onNext}
        disabled={disabled || !onNext}
        aria-label={t('chat.message.nextBranch')}
        title={t('chat.message.nextBranch')}
      >
        <ChevronRight className="size-3" />
      </Button>
    </div>
  );
}

/* ─── Long user message collapse ─── */

/** 折叠阈值（px）：user 气泡自然高度超过该值才给 Show more 入口。刻意是绝对
 *  px 而非行数——字号 slider 改变后由 ResizeObserver 重新判定是否溢出。 */
const COLLAPSED_BUBBLE_MAX_H = 240;

/**
 * 测量 user 气泡自然高度是否超过折叠阈值，并给出折叠态所需的 wrapper 属性。
 * `ResizeObserver` 挂在**内层**（不被 max-height 截断的）节点上，故字号 slider、
 * sidepanel 宽度变化引起的重排都会重新判定；而折叠 cap 本身不会反馈进测量
 * （内层 scrollHeight 始终是全文高度），不会自我锁死。
 */
function useCollapsibleBubble(enabled: boolean) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!enabled || !el) {
      setOverflowing(false);
      // 禁用（编辑态 / 无气泡）时一并复位展开态，避免从编辑返回后气泡默认展开。
      setExpanded(false);
      return;
    }
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSED_BUBBLE_MAX_H);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // enabled 翻转（进入 / 退出内联编辑）时气泡节点重新挂载，需重新接 observer。
  }, [enabled]);

  const collapsed = enabled && overflowing && !expanded;
  return {
    innerRef,
    collapsed,
    overflowing,
    expanded,
    setExpanded,
    // 仅折叠态才下发 cap；展开 / 未溢出时 wrapper 无内联样式。
    collapseStyle: collapsed ? { maxHeight: COLLAPSED_BUBBLE_MAX_H } : undefined,
  };
}

/* ─── User Message ─── */
export function UserMessageBubble({
  msg,
  children,
  onEdit,
  branch,
  isLast,
}: {
  msg?: Message;
  children?: ReactNode;
  /** 编辑已发送消息（issue #44）：以新文案从此消息重新生成。仅当消息已落树
   *  （广播带 entryId）且 agent 空闲时由上层传入；缺省不显示编辑入口。 */
  onEdit?: (text: string) => void;
  /** 当前消息存在并列版本时，在固定操作区展示分支导航。 */
  branch?: BranchSwitcherProps;
  /** true when this is the most recent user message in the session. Hooks
   *  like `useStickToBottom.scrollToUserPrompt` query the DOM for
   *  `[data-user-message="last"]` to snap the latest prompt to the top of
   *  the viewport on send — without this marker the snap silently no-ops
   *  and the bubble ends up scrolled off-screen. */
  isLast?: boolean;
}) {
  const text = msg ? extractUserText(msg) : null;
  const slashPrompt = useMemo(() => msg ? extractSlashPrompt(msg) : null, [msg]);
  const attachments = useMemo(() => msg ? extractUserAttachments(msg) : null, [msg]);
  // 内联指令块（PROMPT / SKILL / COMMAND）抽自 `<user-request>` 内文——
  // 来自与 `extractUserText` 同一段原始 inner，但跳过 stripDirectives 步骤，
  // 因为 `text` 已经被剥过指令了；这里要的是「指令头行长什么样」。
  const inlineDirectives = useMemo(() => msg ? extractInlineDirectivesFromMessage(msg) : [], [msg]);
  const hasAttachments = attachments && (attachments.images.length > 0 || attachments.elements.length > 0 || attachments.files.length > 0 || attachments.recordings.length > 0);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);
  // 编辑入口在编辑途中被收回（如另一窗口开始了新一轮）：退出编辑态，
  // 避免「点发送却静默丢弃草稿」的假成功
  const canEdit = onEdit !== undefined;
  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  // 携带的提示词就写成气泡里的第一段普通文字 `/名字`，与用户自己敲的话同一个样式——
  // 它本来就是这一轮消息的一部分，不值得为它单开一块 UI。正文（模板展开后的那一大段）
  // 不在气泡里露出：气泡只显示用户看得懂、也确实「打过」的那几个字。
  const slashText = slashPrompt ? `/${slashPrompt.name}` : null;
  const bubbleText = slashText ? (text ? `${slashText} ${text}` : slashText) : text;
  const bubble = bubbleText ?? children;
  // 一个字没打、也没挂提示词的空消息不渲染气泡框，免得留一个空壳。
  const hasBubble = typeof bubble === 'string' ? bubble.length > 0 : bubble != null;

  // 超长消息折叠：编辑态不折叠（textarea 自己有 rows 上限）；无气泡时不测量。
  // children 形态（interactive tool result 等）同样参与——它们也可能很高。
  const collapse = useCollapsibleBubble(!editing && hasBubble);

  const commitEdit = () => {
    const next = draft.trim();
    setEditing(false);
    // 空文案或没改不发——避免误触把消息清空 / 空跑一轮
    if (next && next !== text) onEdit?.(next);
  };

  if (editing) {
    return (
      <div className="self-end w-[95%]">
        <div className="bg-card border border-border rounded-2xl p-2 flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // IME 组词中的 Enter 是「选字确认」，不能触发发送（对齐 ChatInput）
              if (e.nativeEvent.isComposing) return;
              // Enter 发送（Shift+Enter 换行），Esc 取消——对齐 ChatInput 的习惯
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            aria-label={t('common.edit')}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="w-full resize-y bg-transparent text-[0.9rem] leading-relaxed outline-none px-2 py-1"
          />
          <div className="flex items-center justify-end gap-2 px-1">
            <span className="text-[0.7rem] text-muted-foreground mr-auto">
              {t('chat.message.editHint')}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="h-6 px-2 text-xs" onClick={commitEdit} disabled={!draft.trim()}>
              {t('common.send')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-end justify-end gap-1.5 group/user"
      {...(isLast ? { 'data-user-message': 'last' as const } : {})}
    >
      {/* Action bar (Copy / Edit / BranchSwitcher) — sits immediately to the LEFT
          of the bubble (no extra horizontal gap). `justify-end` on the outer
          flex pushes both children toward the right edge; with `gap-1.5`
          the buttons are 6px away from the bubble, hugging it. Visibility is
          hover-only via `group-hover/user:opacity-100`. */}
      {text != null && (
        <div className="flex h-8 items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover/user:opacity-100 group-hover/user:pointer-events-auto group-focus-within/user:opacity-100 group-focus-within/user:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
          {hasBubble && <CopyButton text={bubbleText ?? ''} />}
          {onEdit && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  aria-label={t('common.edit')}
                  onClick={() => {
                    setDraft(text);
                    setEditing(true);
                  }}
                >
                  <Pencil />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('common.edit')}</TooltipContent>
            </Tooltip>
          )}
          {branch && <BranchSwitcher {...branch} />}
        </div>
      )}
      {/* Right column: directives + attachments + bubble + collapse button.
          `flex flex-col items-end` right-aligns each row inside the column
          (so the bubble + directive chips stay right-flush). No `ml-auto` —
          the outer flex's `justify-end` already handles right-alignment. */}
      <div className="flex flex-col items-end max-w-[95%]">
      {/* Inline directive chip strip: slash commands (COMMAND), mention
          chips (PROMPT/SKILL), and quote chips (QUOTE) render above the
          bubble so the bubble only shows the user's typed words. Pinned
          directives (carrying `pinned="true"`) are skipped — the pin is
          already visible in the composer strip at the bottom of every send,
          so repeating it on every bubble would just clutter chat history.
          The LLM still receives the full directive body via the agent
          runtime. Quote chips use a neutral zinc tone so they read as a
          distinct fourth kind without colliding with the slash-command
          amber or the prompt/skill blues. The QUOTE chip's `name` slot
          carries the first quote chip's body preview plus, when multiple
          chips were merged at send time, a `· N excerpts` count suffix —
          the count is rendered in a separate non-truncating span so it
          stays visible even when the preview itself is truncated. */}
      {inlineDirectives.some((d) => !d.pinned) && (
        <div className="flex gap-1.5 flex-wrap items-center justify-end mb-1.5 px-1">
          {inlineDirectives.map((d, i) => {
            // Skip pinned directives here — see comment above.
            if (d.pinned) return null;
            const isCommand = d.kind === 'command';
            const isPrompt = d.kind === 'prompt';
            const isQuote = d.kind === 'quote';
            // command: Zap + amber (same tone as recorder chip — "action triggered" feel)
            // prompt:  FileText + purple (same tone as image attachment chip — "reference" feel)
            // skill:   Sparkles + blue (reserved — d8cd54a implementation used blue)
            // quote:   Quote + zinc (neutral fourth kind — distinguishes from the
            //          other three without competing with slash-command amber)
            const className = isCommand
              ? 'shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-amber-400 border-amber-400/20 bg-amber-400/5'
              : isPrompt
                ? 'shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-purple-400 border-purple-400/20 bg-purple-400/5'
                : isQuote
                  ? 'shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-zinc-400 border-zinc-400/20 bg-zinc-400/5'
                  : 'shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-blue-400 border-blue-400/20 bg-blue-400/5';
            const Icon = isCommand ? Zap : isPrompt ? FileText : isQuote ? Quote : Sparkles;
            // 多 chip 合并时 ChatInput 把 `· N excerpts` 后缀塞进 name。把它从
            // 预览里拆出来渲染成一个独立的、不会 truncate 的 span，让 count
            // 在 preview 被截断时仍可见（之前 `· N excerpts` 整段进了
            // `truncate max-w-24`，长 preview 会把 count 一起截掉，只能在
            // tooltip 里看到）。tooltip (title) 仍保留完整的 wire 文本。
            let chipLabel: string;
            let quoteCount: string | null = null;
            if (isCommand) {
              chipLabel = `/${d.name}`;
            } else if (isQuote) {
              const m = d.name.match(/^(.+) · (\d+) excerpts$/);
              if (m) {
                chipLabel = m[1];
                quoteCount = ` · ${m[2]}`;
              } else {
                chipLabel = d.name;
              }
            } else {
              chipLabel = d.name;
            }
            return (
              <Badge
                key={`${d.kind}-${d.name}-${i}`}
                variant="outline"
                title={d.name}
                className={className}
              >
                <Icon className="size-2.5 shrink-0" />
                <span className="truncate max-w-24">{chipLabel}</span>
                {quoteCount && (
                  <span className="shrink-0 tabular-nums opacity-70">{quoteCount}</span>
                )}
              </Badge>
            );
          })}
        </div>
      )}

      {hasBubble && (
        <>
          {/*
            * 折叠态：外层 cap 高度并裁切（overflow-clip 而非 overflow-hidden——
            * 后者会造出 scroll container，拖选文字越过裁切线时 Chrome 会程序性
            * 滚动它，让 fade 底下露出正文）；内层保持自然高度供测量（见
            * useCollapsibleBubble）。w-fit ml-auto 在外层，让渐隐只盖气泡自身
            * 宽度（气泡右对齐，行内左侧是空白）。展开 / 未溢出时外层无内联
            * 样式，气泡与原先完全同形。
            */}
          <div
            className="relative overflow-clip rounded-2xl w-fit ml-auto"
            style={collapse.collapseStyle}
          >
            <div
              ref={collapse.innerRef}
              className="bg-card border border-border px-4 py-3 rounded-2xl text-[length:var(--chat-font-size)] font-medium leading-relaxed w-full whitespace-pre-wrap break-all"
            >
              {bubble}
            </div>
            {collapse.collapsed && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-2xl bg-gradient-to-t from-card to-transparent" />
            )}
          </div>
          {collapse.overflowing && (
            <div className="flex justify-end mt-1 pr-1">
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                aria-expanded={collapse.expanded}
                onClick={() => collapse.setExpanded(!collapse.expanded)}
              >
                {collapse.expanded ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDown className="size-3" />
                )}
                {collapse.expanded
                  ? t('chat.message.collapseLong')
                  : t('chat.message.expandLong')}
              </Button>
            </div>
          )}
        </>
      )}

      {hasAttachments && (
        <div className="flex gap-1.5 flex-wrap items-center justify-end mt-1.5 px-1">
          {attachments.images.map((img, i) => (
            <Badge
              key={`img-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-0.5 pr-1 text-purple-400 border-purple-400/20 bg-purple-400/5"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={t('chat.attachments.imageAlt')}
                className="h-3.5 w-auto rounded-sm object-cover cursor-pointer"
                onClick={() => showDialog('image-preview', {
                  src: `data:${img.mimeType};base64,${img.data}`,
                })}
              />
              {t('chat.attachments.image')}
            </Badge>
          ))}
          {attachments.elements.map((el, i) => (
            <Badge
              key={`el-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-info border-info/20 bg-info/5"
            >
              <Crosshair className="size-2.5 shrink-0" />
              <span className="truncate max-w-24">{el.selector}</span>
            </Badge>
          ))}
          {attachments.files.map((f, i) => (
            <Badge
              key={`file-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-emerald-400 border-emerald-400/20 bg-emerald-400/5"
            >
              <FileText className="size-2.5 shrink-0" />
              <span className="truncate max-w-24">{f.name}</span>
            </Badge>
          ))}
          {attachments.recordings.map((r, i) => (
            <Badge
              key={`rec-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-amber-400 border-amber-400/20 bg-amber-400/5 cursor-pointer hover:bg-amber-400/10"
              title={`${t('chat.attachments.recordingDownload')}\n${t('chat.attachments.recordingHover', [String(r.eventCount), formatCompactCount(r.json.length)])}`}
              onClick={() => downloadFile(r.name, r.json, RECORDING_MIME)}
            >
              <Film className="size-2.5 shrink-0" />
              <span className="truncate max-w-40">
                {r.name} · {t('chat.attachments.recordingMeta', [String(r.eventCount), formatDuration(r.durationMs)])}
                {r.truncated ? ` · ${t('chat.attachments.recordingTruncated')}` : ''}
              </span>
            </Badge>
          ))}
        </div>
      )}

      </div>{/* end right column */}
    </div>
  );
}

/* ─── Compaction Divider ─── */
/** 历史压缩分割条：标记此处之前的上下文已被折叠成摘要——发送给模型时只保留
 *  摘要，但原始消息仍完整留在消息流里供用户向上翻阅。玻璃胶囊风格：
 *  amber 半透明边框 + 柔光阴影 + 可展开 / 折叠的摘要披露（chevron）。
 *  「压缩前 token 数」以小号徽章形式展现在分隔条右侧；披露框里渲染
 *  `compactionSummary.summary` 原文（不解析 Markdown——避免引入额外依赖，
 *  与 AGENTS.md §"Cohesion, coupling" 的「一文件一职责」一致）。 */
export interface CompactionDividerProps {
  /** Summary 内容 + tokensBefore。token 数缺失时省略右侧徽章。 */
  summary?: {
    summary: string;
    tokensBefore?: number;
  };
}

export function CompactionDivider({ summary }: CompactionDividerProps = {}) {
  // 披露展开状态——只在自身实例内持有，不与其他分隔条联动（多段压缩时
  // 各自独立展开 / 收起；如需「一次只展开一个」是后续迭代）。
  const [open, setOpen] = useState(false);
  const summaryText = summary?.summary ?? '';
  const hasTokens = typeof summary?.tokensBefore === 'number' && summary.tokensBefore > 0;

  return (
    // flex-wrap lets the disclosure block drop onto a new row beneath the
    // capsule; without it, basis-full would compete with flex-1 hairlines on
    // the same row and the disclosure would render to the right of the
    // capsule, never below it.
    <div className="flex flex-wrap items-stretch my-3 select-none" role="separator">
      {/* Left hairline: muted to avoid clashing with the amber capsule. */}
      <div className="h-px flex-1 bg-border self-center" />

      <button
        type="button"
        // 胶囊本体：amber 半透 + 柔光。点击整条胶囊就展开 / 收起——
        // 比单点 chevron 触控区域更大、移动端友好。
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? t('chat.compaction.dividerCollapse') : t('chat.compaction.dividerExpand')}
        className="group/divider mx-2 inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/5 px-2.5 py-0.5 text-[0.65rem] font-medium text-amber-600 dark:text-amber-300 backdrop-blur-sm shadow-[0_0_24px_-12px_rgba(245,158,11,0.4)] hover:border-amber-400/60 transition-colors"
      >
        <Sparkles className="size-2.5 shrink-0" />
        <span className="whitespace-nowrap">{t('chat.compaction.divider')}</span>
        {hasTokens && (
          <span className="text-[0.6rem] text-amber-700/70 dark:text-amber-300/70 font-mono tabular-nums border-l border-amber-400/30 pl-1.5">
            −{formatCompactCount(summary!.tokensBefore!)}
          </span>
        )}
        <ChevronDown
          className={`size-3 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <div className="h-px flex-1 bg-border self-center" />

      {/* Disclosure block: rendered only when expanded. Spans the full width
        * to give the summary its own reading area; dashed border + mono font
        * mirrors ThinkingBlock so users see this is an internal record, not
        * the actual conversation. */}
      {open && summaryText && (
        <div className="basis-full mt-2">
          <pre className="text-[0.7rem] font-mono text-muted-foreground/80 bg-amber-500/5 border border-dashed border-amber-400/30 rounded-md p-2 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
            {summaryText}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ─── Compaction Placeholder ─── */
/** 压缩进行中的占位消息：压缩是发送前的一次独立 LLM 调用，期间复用
 *  普通的 Cebian Agent 消息外壳 + 一行灰色斜体「正在压缩」，让它看起来就是
 *  agent 这一轮在忙。压缩结束后 isCompacting 转 false、本条消失，由真实输出顶上；
 *  压缩中点停止则与普通取消一致——用户气泡保留、其下显示「已取消」（后台
 *  commitCompactionCancel 补一条 aborted 标记），本占位随 isCompacting 转 false 消失。 */
export function CompactionPlaceholder() {
  return (
    <AgentMessage>
      <span className="text-xs italic text-muted-foreground/80">{t('chat.compaction.status')}</span>
    </AgentMessage>
  );
}

/* ─── Agent Message ─── */

/**
 * 把消息的「回复正文」转成「所见即所读」的纯文本，供朗读使用。内容容器里除了
 * 回复正文，还夹杂着 thinking 块、工具卡片、错误/取消提示等不该朝读的块；故采
 * 用 opt-in：只读打了 `data-speech-content` 标记的回复正文（AgentTextBlock）子树，
 * 新增的其它块默认不会被读。未找到标记时回退到整个容器（防御性）。
 *
 * react-markdown 渲染后的 DOM 已脱去 Markdown 语法，`textContent` 即用户看到的
 * 文字，无需正则反解。代码块（`<pre>` 及其外层容器，含语言标签 + 复制按钮）
 * 不逐字朗读——克隆节点后整体替换成一句「已略过」提示，含语言时报出语言名
 * （首字母大写）。
 */
function extractSpeakText(el: HTMLElement | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  // 只取回复正文子树；缺失时退回整个内容容器。
  const target = clone.querySelector<HTMLElement>('[data-speech-content]') ?? clone;
  for (const pre of Array.from(target.querySelectorAll('pre'))) {
    const langClass = Array.from(pre.querySelector('code')?.classList ?? [])
      .find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    const label = lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : '';
    const notice = label
      ? t('common.speakCodeSkipped', [label])
      : t('common.speakCodeSkippedPlain');
    // 代码块容器是 <pre> 的父节点（CodeBlock 的外层 div，含头部语言标签 + 复制
    // 按钮）；整体替换掉，避免把代码和「Code」标签也念出来。两端补句末标点，让这
    // 句提示成为独立、完整的一句——否则 speechSynthesis 会按内部逗号把它拆成「黏
    // 上文的前半句 + 黏下文的后半句」，听不出这里是跳过（标点是断句结构，归提取
    // 逻辑管，不放进 locale 文案）。
    const period = /[\u4e00-\u9fff]/.test(notice) ? '。' : '. ';
    const container = pre.parentElement ?? pre;
    container.replaceWith(document.createTextNode(`${period}${notice}${period}`));
  }
  // KaTeX 公式（MathML 输出）：textContent 会把 MathML 结构文本和 annotation
  // 里的 LaTeX 源码各读一遍，念出来是乱码般的重复符号。整体替换成 LaTeX
  // 源码——朗读出来至少是可理解的公式描述。
  for (const katex of Array.from(target.querySelectorAll('.katex'))) {
    const source =
      katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
    katex.replaceWith(document.createTextNode(source));
  }
  return (target.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function AgentMessage({
  children,
  isStreaming,
  showHeader = true,
  meta,
  copyText,
  onRetry,
  onFork,
  branch,
}: {
  children?: ReactNode;
  isStreaming?: boolean;
  showHeader?: boolean;
  /** Meta is rendered as soon as `!isStreaming`; the copy button inside the
   * row is gated on `copyText` (skipped for pure tool-call turns). */
  meta?: Omit<MessageMetaProps, 'text' | 'onRetry' | 'onFork' | 'branchSwitcher'>;
  copyText?: string;
  /** When provided, a retry button is shown in the meta row. Caller decides
   *  eligibility (last turn-closing assistant, agent idle). */
  onRetry?: () => void;
  /** 提供时在操作行显示「分叉」按钮（issue #60）。资格由调用方判定（收尾回复且已落树）。 */
  onFork?: () => void;
  /** 当前回复存在并列版本时，在操作行最左侧展示分支导航。 */
  branch?: BranchSwitcherProps;
}) {
  // 朗读按钮惰性读取这个容器的 DOM 文本（见 extractSpeakText），避免提前求值。
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div className={`self-start w-full ${showHeader ? '' : '-mt-1'}`}>
      {showHeader && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-medium">
          <Bot className="size-3.5 text-primary" />
          Cebian Agent
        </div>
      )}
      <div ref={contentRef} className="text-[length:var(--chat-font-size)] font-medium leading-relaxed space-y-3 animate-message-fade-in">
        {children}
        {isStreaming && <StreamingCursor />}
      </div>
      {/* Meta-row slot: rendered unconditionally so its ~20-24px height is
          reserved during streaming — when `isStreaming` flips false, the
          row materialises inside the same slot rather than pushing the
          bubble down. `invisible` (= visibility:hidden) keeps screen
          readers and pointer events from interacting with the row while
          it has no meaningful content (copyText / onRetry / branch are
          all undefined until the turn closes). Reservation only kicks in
          when at least one of `meta / copyText / onRetry / branch` is
          provided; otherwise the wrapper is a 0px empty div in both
          states.

          The cursor span below is intentionally left as
          `{isStreaming && <span .../>}` — an earlier attempt reserved
          the cursor slot with `opacity-0` to eliminate the 16px
          unmount jump, but post-stream the cursor slot (16px) +
          `space-y-3` margin (0.75rem) + `mt-2` (0.5rem) on the
          meta-row left ~36px of empty space between content and the
          action row. The meta-row reservation (above) stays because
          its ~20-24px jump is the larger of the two and is invisible
          during streaming; the cursor's residual ~16px reflow on
          stream end is ~60% smaller than the original combined
          ~36-40px jump and no longer leaves any empty space. */}
      <div className={isStreaming ? 'invisible' : ''}>
        {(meta || copyText || onRetry || onFork || branch) && (
          <MessageMetaRow
            {...(meta ?? {})}
            text={copyText}
            getSpeakText={() => extractSpeakText(contentRef.current)}
            onRetry={onRetry}
            onFork={onFork}
            branchSwitcher={branch ? <BranchSwitcher {...branch} /> : undefined}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Agent Text Block (Markdown) ───
 *  Renders the assistant's text through the standard markdown pipeline.
 *  During streaming the raw content goes through the Typewriter Buffer
 *  Queue (useTypewriterText): tokens accumulate in a buffer and are
 *  revealed at a steady ~30Hz pace instead of landing as discrete
 *  80ms-coalesced chunks. data-speech-content keeps extractSpeakText
 *  focused on the response body (skips thinking / tool cards in sibling
 *  blocks). streaming=true 走 MarkdownRenderer 的分块 memo 路径，末尾块
 *  单独重渲染，前面已定稿块全部跳过——长回复流式期间的 CPU 占用显著降低。 */
export function AgentTextBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  // Typewriter Buffer Queue：streaming 期间 content 经缓冲队列匀速上屏（把
  // 80ms coalesce 攒出的成块文本拉平成连续出字），结束后冲刷剩余 buffer 不吞字。
  // 非流式（历史消息）直接透传 content，零开销。
  const shown = useTypewriterText(content, !!streaming);
  // data-speech-content：标记「可朗读的回复正文」，供 extractSpeakText 只读此子树，
  // 从而跳过 thinking / 工具卡片 / 错误提示等同处一个容器下的其它块。
  return (
    <div data-speech-content>
      <MarkdownRenderer content={shown} normalizeMath streaming={streaming} />
    </div>
  );
}

/* ─── Thinking Block (renders pi-ai ThinkingContent) ─── */
export function ThinkingBlock({ content, isLive }: { content: string; isLive?: boolean }) {
  const [manualOpen, setManualOpen] = useState(false);
  const wasLive = useRef(false);

  // Auto-collapse when transitioning from live to done
  useEffect(() => {
    if (wasLive.current && !isLive) {
      setManualOpen(false);
    }
    wasLive.current = !!isLive;
  }, [isLive]);

  const isOpen = manualOpen;

  return (
    <div className="border border-border rounded-lg overflow-hidden text-xs bg-card/30">
      <button
        onClick={() => !isLive && setManualOpen(!manualOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground font-mono text-[0.75rem] hover:text-foreground hover:bg-card/40 transition-colors"
      >
        <ChevronRight
          className={`size-2.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
        />
        <Lightbulb className="size-3 text-primary" />
        {isLive ? 'Thinking...' : 'Thinking Process'}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
          isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-3 py-3 border-t border-dashed border-border text-muted-foreground font-mono text-[0.75rem] leading-relaxed bg-card/50">
            <MarkdownRenderer content={content} normalizeMath streaming={isLive} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Permission option button ─── */
// 权限卡片（PermissionRequestBlock）的小号选项按钮。`selected` 用 default 实心高亮
// 表达「这个选项被选中了」（权限卡片决策后高亮被选的那个）。
function PromptOptionButton({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant={selected ? 'default' : 'outline'}
      size="sm"
      className="text-xs h-7"
      disabled={disabled}
      onClick={onClick}
      title={description}
    >
      {label}
    </Button>
  );
}

/* ─── Permission Request Block (tool pre-execution authorization) ─── */
// 渲染一条 permissionRequest 自定义消息。三种态：
// - answerable（pending 且 isLive）：三按钮可点，卡片正常。
// - decided（once/always/denied/dismissed）：卡片置灰；被选中的按钮高亮，
//   dismissed（发消息隐式未授权）无任何按钮高亮。
// - expired（pending 但 !isLive，例如 SW 重启后无活 agent 在等）：卡片置灰，
//   按钮禁用，额外显示「已失效」。
export function PermissionRequestBlock({
  title,
  permissions,
  decision,
  isLive,
  onResolve,
}: {
  title: string;
  permissions: string[];
  decision: 'pending' | 'once' | 'always' | 'denied' | 'dismissed';
  isLive: boolean;
  onResolve?: (decision: 'once' | 'always' | 'denied') => void;
}) {
  const pending = decision === 'pending';
  const answerable = pending && isLive && !!onResolve;
  const expired = pending && !isLive;

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answerable ? '' : 'opacity-60'}`}>
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-1.5">
        <ShieldAlert className="size-4.5 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap">{title}</span>
      </div>

      {/* Requested permissions — omitted entirely when none declared */}
      {permissions.length > 0 && (
        <div className="text-[0.8rem] text-muted-foreground">
          {t('chat.permission.requests')}
          <ul className="mt-1 space-y-1">
            {permissions.map((perm, i) => (
              <li key={`${i}-${perm}`} className="flex items-start gap-1.5">
                <span className="text-primary/60 mt-0.5 shrink-0">•</span>
                <span>{describePermission(perm)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Expired notice — only when a persisted pending card has no live agent */}
      {expired && (
        <div className="text-xs text-muted-foreground/80 italic mt-2">
          {t('chat.permission.expired')}
        </div>
      )}

      {/* Decision buttons */}
      <div className="flex flex-wrap gap-2 mt-2.5">
        <PromptOptionButton
          label={t('chat.permission.deny')}
          selected={decision === 'denied'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('denied') : undefined}
        />
        <PromptOptionButton
          label={t('chat.permission.allowOnce')}
          selected={decision === 'once'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('once') : undefined}
        />
        <PromptOptionButton
          label={t('chat.permission.allowAlways')}
          selected={decision === 'always'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('always') : undefined}
        />
      </div>
    </div>
  );
}

/* ─── Execution Success ─── */
export function ExecutionResult({
  message,
  actions,
}: {
  message: string;
  actions?: { label: string; primary?: boolean; onClick?: () => void }[];
}) {
  return (
    <>
      <p className="text-success text-[0.85rem] flex items-center gap-1.5 mt-3">
        <CheckCircle className="size-3.5" />
        {message}
      </p>
      {actions && actions.length > 0 && (
        <div className="flex gap-2 mt-2">
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.primary ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7"
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}
