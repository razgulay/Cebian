import { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';
import { Send, Square, MousePointer2, Camera, Paperclip, Smartphone, Crosshair, FileText, X, FileType, Film, HardDrive, Quote as QuoteIcon, Crop, Sparkles, Folder, Pin, Database, AlertTriangle } from 'lucide-react';
import { showDialog } from '@/lib/ui/dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { ThinkingLevelSelector } from '@/components/chat/ThinkingLevelSelector';
import { RecordButton } from '@/components/chat/RecordButton';
import { MicButton } from '@/components/chat/MicButton';
import { MentionPopover } from '@/components/chat/MentionPopover';
import { useStorageItem } from '@/hooks/useStorageItem';
import { providerCredentials, customProviders as customProvidersStorage, expandPromptsInline, type ThinkingLevel, type ModelIdentity } from '@/lib/persistence/storage';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai';
import { resolveModel } from '@/lib/providers/resolve-model';
import { startElementPicker, cancelElementPicker } from '@/lib/browser/element-picker';
import { scanPrompts, type PromptMeta } from '@/lib/ai-config/scanner';
import { replaceTemplateVars, gatherTemplateVars } from '@/lib/ai-config/template';
import { vfs } from '@/lib/persistence/vfs';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import {
  MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE, MAX_PDF_SIZE,
  RECORDING_MIME,
  isImageFile, isTextFile, isPdfFile,
  type Attachment,
} from '@/lib/agent/attachments';
import { ragSettings as ragSettingsStorage } from '@/lib/rag';
import { resolveMentions, resolveMentionToAttachment, PIN_AUTO_UNPIN_THRESHOLD, type MentionChip, type PinnedMention, type ResolvedMentionAttachment } from '@/lib/agent/mention-resolver';
import { recordingToAttachment } from '@/lib/recorder/to-attachment';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { useRecorder } from '@/hooks/useRecorder';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { appendTranscript, cleanTranscript } from '@/lib/speech/transcript';
import { queryMicPermission, openMicPermissionPage, openSystemMicSettings } from '@/lib/speech/mic-permission';
import { useMobileEmulation } from '@/hooks/useMobileEmulation';
import { downloadFile, formatDuration, formatCompactCount, formatBytes } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { PromptDispatchResult } from '@/hooks/useBackgroundAgent';
import { debugLog } from '@/lib/debug/log';

// Pick a stable human label per chip kind for debug logs, toasts, and
// auto-unpin notifications. Module-level so togglePin and the pin
// resolve loop share one implementation.
function pinLabel(item: PinnedMention): string {
  switch (item.kind) {
    case 'prompt':         return item.name;
    case 'skill':          return item.name;
    case 'rag-collection': return item.collection;
    case 'vfs-dir':        return item.label;
    case 'vfs-file':       return item.label;
  }
}

/** 在窄 chip 里显示不下时，把名字截成 "开头…末尾"（保留扩展名/末尾识别符）。
 *  短名原样返回；否则取首 3 + "…" + 末 4。chip 已经塞了图标 + meta，不缩写
 *  的话单条附件就能把整行输入区挤满——sidebar 看不到其他附件。 */
function abbreviateName(name: string): string {
  if (!name) return '';
  if (name.length <= 8) return name;
  return name.slice(0, 3) + '…' + name.slice(-4);
}

interface ChatInputProps {
  onSend: (
    message: string,
    attachments: Attachment[] | undefined,
    expectedSessionId: string | null,
    options?: { displayText?: string },
  ) => Promise<PromptDispatchResult>;
  onOpenSettings?: () => void;
  /** 跳转到「文件系统」设置页（独立的快捷入口 — 放在工具栏左侧、靠近 pick element，
   *  因为用户访问频次比一般设置项高）。 */
  onOpenStorage?: () => void;
  isAgentRunning?: boolean;
  onCancel?: () => void;
  /** User-message texts already sent in this session, oldest first. */
  userHistory?: string[];
  /** Conversation id; changing it resets history navigation state. */
  sessionId?: string | null;
  /** 本轮选中的模型 / 思考档（受控）。由 ChatPage 持有：新对话从全局种子 seed、
   *  已有会话从会话行 seed；切换走 onModelChange / onThinkingChange。 */
  model: ModelIdentity | null;
  thinkingLevel: ThinkingLevel;
  onModelChange: (model: ModelIdentity) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
  /** When set, the textarea pre-fills with this value on mount (used by
   *  the edit flow to seed the composer with the previous user message).
   *  Lazy initializer — only read on first render, subsequent prop
   *  changes don't clobber the user's edits. */
  initialValue?: string;
  /** When provided, pressing Escape inside the textarea calls this
   *  callback. Used by the edit flow to cancel without committing. */
  onCancelEdit?: () => void;
}

/** 暴露给父组件的 imperative handle：允许欢迎页等外部入口填入文本并聚焦输入框，
 *  同时仍由 ChatInput 持有 value 状态。 */
export interface ChatInputHandle {
  fill: (text: string) => void;
  /** Insert text at the current cursor position (or append if caret is at end).
   *  Used by the "Quote" feature when the user selects text in an assistant
   *  message and clicks the floating Quote button. */
  insertText?: (text: string) => void;
  /** Same as `insertText` but ALSO surfaces the inserted text as a small
   *  styled chip above the textarea. Used by the Quote feature: the chip
   *  gives the user a visual preview of the quoted excerpt in a smaller
   *  font than the main input (a plain `<textarea>` can't render mixed
   *  font sizes — see QuoteChip for the rationale). The chip itself does
   *  not affect what gets submitted; the raw `quote <text> quote` text
   *  is also inserted into the textarea and ships with the message. */
  insertQuote?: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    onOpenSettings,
    onOpenStorage,
    isAgentRunning,
    onCancel,
    userHistory,
    sessionId,
    model: currentModel,
    thinkingLevel: currentThinkingLevel,
    onModelChange,
    onThinkingChange,
    initialValue,
    onCancelEdit,
  },
  ref,
) {
  const [value, setValue] = useState(() => initialValue ?? '');
  const [showSlash, setShowSlash] = useState(false);
  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [selectedPromptIndex, setSelectedPromptIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Quote chips: preview pills rendered above the textarea when the user
  // clicks the floating Quote button. The textarea itself is plain text and
  // can't render mixed font sizes, so the chip gives the user the smaller
  // visual hierarchy they asked for without forcing a contentEditable
  // refactor. Each chip is removed individually via its X button.
  const [quoteChips, setQuoteChips] = useState<{ id: string; text: string }[]>([]);
  // Mention chips: prompt/skill/VFS-directory references attached via the
  // [+] button. Like Quote chips, the chip is the source of truth — the
  // textarea stays clean and the chip's content ships to the LLM at send
  // time via the mention resolver (see handleSend). Each chip is removed
  // individually via its X button.
  const [mentions, setMentions] = useState<MentionChip[]>([]);
  // Mirror of `attachments` for synchronous reads after an await. The
  // recorder's `subscribeSession` callback fires synchronously when the
  // BG delivers a session, but React state isn't flushed by the time
  // `await recorder.stop()` resumes — so we keep this ref so handleSend
  // can read the post-stop attachment list without waiting for a render.
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const [isPicking, setIsPicking] = useState(false);
  // Region-pick mode is mutually exclusive with click-pick — the toggle
  // buttons in the toolbar cancel the other when activated.
  const [isPickingRegion, setIsPickingRegion] = useState(false);
  // History navigation: null = editing the current draft; otherwise points
  // into `userHistory`. `draft` stashes whatever the user had typed before
  // entering history mode so we can restore it on ↓-past-end.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const { isActiveTabMobile, toggle: toggleMobile } = useMobileEmulation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  sessionIdRef.current = sessionId ?? null;
  // Mirror of `quoteChips` for synchronous reads from handleSend.
  // The chips list drives the outgoing message at send-time, so we need to
  // read the post-update value without waiting for a React flush.
  const quoteChipsRef = useRef<{ id: string; text: string }[]>([]);
  // Mirror of `mentions` for the same reason — handleSend reads from the
  // ref to avoid a stale state read after async attachment building.
  const mentionsRef = useRef<MentionChip[]>(mentions);

  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [isExpandInline] = useStorageItem(expandPromptsInline, false);
  // RAG settings: read fresh inside handleSend via `ragSettings.getValue()`
  // rather than the hook, so a settings change between renders and the
  // send click is picked up (handleSend isn't a render-bound function).

  // 当前模型解析成 pi-ai Model（内置 + 自定义统一走 resolveModel）。是否支持图片 /
  // 支持哪些思考档 等能力派生共用这一次解析，避免多份内联解析各自漂移
  const resolvedModel = useMemo(
    () => (currentModel ? resolveModel(currentModel, providers, customProviderList) : null),
    [currentModel, providers, customProviderList],
  );

  // 当前模型支持的思考档：pi 按模型 thinkingLevelMap 推导（非推理模型只返回 ['off']），
  // 多于一档可选时才显示选择器。存的档位可能超出当前模型上限（切到弱模型）→ 夹进支持集
  // 仅供高亮显示、不改全局偏好（切回强模型仍恢复）；后台派发时对同一模型做同样的 clamp，
  // 故显示与实际发出一致
  const thinkingLevels = useMemo(
    () => (resolvedModel ? getSupportedThinkingLevels(resolvedModel) : []),
    [resolvedModel],
  );
  const displayThinkingLevel = resolvedModel
    ? clampThinkingLevel(resolvedModel, currentThinkingLevel)
    : currentThinkingLevel;

  // 当前模型是否支持图片（多模态/VLM）输入：读 pi-ai Model.input 是否含 'image'
  const supportsImage = resolvedModel?.input?.includes('image') ?? false;

  // 异步图片生产者（截图 await、FileReader.onload）可能在用户切换到纯文本
  // 模型之后才回调，用 ref 同步读取最新的 supportsImage，避免迟到的图片被追加。
  const supportsImageRef = useRef(supportsImage);
  supportsImageRef.current = supportsImage;

  // 切换到不支持图片的模型时，自动剥离已有的图片附件（保留文件附件），
  // 避免把图片发给纯文本模型导致请求异常。
  useEffect(() => {
    if (supportsImage) return;
    setAttachments((prev) => {
      if (!prev.some((a) => a.type === 'image')) return prev;
      toast.info(t('chat.composer.imageStripped'));
      return prev.filter((a) => a.type !== 'image');
    });
  }, [supportsImage]);

  const handleModelSelect = useCallback((provider: string, modelId: string) => {
    onModelChange({ provider, modelId });
  }, [onModelChange]);

  const handleThinkingSelect = (level: ThinkingLevel) => {
    onThinkingChange(level);
  };

  // ─── 语音输入（本地优先、云端兜底的语音识别）──────────────────────
  // hook 持有在 ChatInput 这一层（而非 MicButton 内），因为识别结果要写进本
  // 输入框。
  //
  // 设计（「直接改 input」）：interim 直接作为 value 末尾的「未定稿后缀」写进
  // 真实 value——输入框始终可编辑（不 readOnly、不屏蔽键盘）。
  //
  // 两个 ref 保证正确：
  //  - interimSuffixRef：当前挂在 value 末尾的未定稿后缀（含补的空格），下一段
  //    interim/final 到来时按其长度精确剥掉再追加。
  //  - lastSpeechValueRef：上次由语音写入的完整 value。若当前 value 与之不等，
  //    说明用户/历史/斜杠菜单等外部路径改了 value——此时不剥旧后缀，直接以当前
  //    value 为新 base 往后追加，绝不删用户内容（符合「编辑时说话是用户自己的
  //    事」，且保证无数据丢失）。
  const valueRef = useRef(value);
  valueRef.current = value;
  const interimSuffixRef = useRef('');
  const lastSpeechValueRef = useRef(value);

  // 计算本次语音写入的 base：value 自上次语音写入后被外部改动 → 以当前 value 为
  // base（不剥后缀）；否则按已知后缀长度精确剥掉。
  const speechBase = (): string => {
    const cur = valueRef.current;
    // 外部改过 value（用户/历史/斜杠菜单），丢弃旧后缀跟踪，以当前 value 为 base。
    if (cur !== lastSpeechValueRef.current) return cur;
    const suffixLen = interimSuffixRef.current.length;
    return suffixLen > 0 ? cur.slice(0, cur.length - suffixLen) : cur;
  };

  const writeSpeechValue = (next: string, suffix: string) => {
    interimSuffixRef.current = suffix;
    lastSpeechValueRef.current = next;
    valueRef.current = next;
    setValue(next);
    setHistoryIndex(null);
  };

  // 实时中间结果：以当前 base 追加最新 interim 预览。
  const handleInterim = useCallback((interimRaw: string) => {
    const base = speechBase();
    const next = appendTranscript(base, interimRaw);
    writeSpeechValue(next, next.slice(base.length));
  }, []);

  // 每段 final（已清洗 + 经 correctTranscript）：以当前 base 追加正式文本，清空后缀。
  const commitTranscript = useCallback((text: string) => {
    const base = speechBase();
    const next = appendTranscript(base, text);
    writeSpeechValue(next, '');
  }, []);

  // 把当前未定稿的 interim 后缀就地清洗定稿，返回定稿后的文本。用于停止 / 发送
  // 前，确保「正在说的那句」不丢、且 CJK 空格被清掉。
  const finalizePendingInterim = useCallback((): string => {
    if (!interimSuffixRef.current) return valueRef.current;
    const base = speechBase();
    const finalized = appendTranscript(base, cleanTranscript(interimSuffixRef.current));
    writeSpeechValue(finalized, '');
    return finalized;
  }, []);

  // 归一化错误 → toast / 引导。`not-allowed` 兜底处理「query 返回 unknown 后
  // 实际未授权」的情况：打开授权页。
  const handleSpeechError = useCallback((kind: string) => {
    switch (kind) {
      case 'not-allowed':
        toast.info(t('chat.composer.voiceNeedPermission'));
        openMicPermissionPage();
        break;
      case 'language-unavailable':
        toast.error(t('chat.composer.voiceLanguageUnavailable'));
        break;
      case 'no-speech':
        toast.info(t('chat.composer.voiceNoSpeech'));
        break;
      case 'audio-capture':
        toast.error(t('chat.composer.voiceAudioCapture'));
        break;
      // network：云端识别连不上（如国内云端被墙 / 断网）——给网络专属提示。
      case 'network':
        toast.error(t('chat.composer.voiceNetworkFailed'));
        break;
      // unknown：无法归类，通用失败提示。
      case 'unknown':
        toast.error(t('chat.composer.voiceFailed'));
        break;
      // aborted 不会经此上报；其余忽略。
      default:
        break;
    }
  }, []);

  const speech = useSpeechRecognition({
    onInterim: handleInterim,
    onFinal: commitTranscript,
    onError: handleSpeechError,
  });

  const speechActive = speech.state === 'listening' || speech.state === 'preparing';

  // 点击麦克风：听写中→定稿当前 interim 并停止；否则按授权态决定直接听写 /
  // 开授权页 / 开设置页。
  const handleMicClick = useCallback(async () => {
    if (speechActive) {
      finalizePendingInterim();
      speech.stop();
      return;
    }
    const perm = await queryMicPermission();
    if (perm === 'granted' || perm === 'unknown') {
      // unknown：无法探测，乐观尝试；若实际未授权，识别会回 not-allowed 走引导。
      void speech.start();
      return;
    }
    if (perm === 'denied') {
      toast.error(t('chat.composer.voiceDenied'));
      openSystemMicSettings();
      return;
    }
    // prompt：尚未授权，打开授权页让用户在普通标签页完成一次授权。
    toast.info(t('chat.composer.voiceNeedPermission'));
    openMicPermissionPage();
  }, [speechActive, finalizePendingInterim, speech]);

  // Auto-resize textarea. When the value is empty (initial mount, after
  // send) we clear the inline height entirely and let CSS `min-h-13 /
  // max-h-37.5` drive sizing. This avoids a first-paint race in the
  // sidepanel where `scrollHeight` is read before fonts / Tailwind / the
  // first layout pass have stabilized — in that window the textarea is
  // measured against browser defaults and can report a height >= 150,
  // which then gets clamped to 150px and frozen as inline style until the
  // user types the first character.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!value) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, [value]);

  // Cancel picker on unmount
  useEffect(() => {
    return () => { cancelElementPicker(); };
  }, []);

  // Cancel picker on Esc key (sidepanel has focus, not the page)
  useEffect(() => {
    if (!isPicking) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelElementPicker();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isPicking]);

  // 点空白处关闭 slash 菜单：mousedown 在菜单外且不在 textarea 内 → 关闭。
  // 用 mousedown 而非 click：1) 响应更早；2) 避免依赖 textarea 的 focus/blur
  // 事件（输入框已经在用 onFocus 决定上下文，光标事件流不一致）。点击菜单
  // 内部或文本框都保留菜单——用户继续打字时菜单也应当保留。
  //
  // 依赖 `showSlash` 而非 `isSlashMenuVisible`：后者定义在下方。`showSlash` 为
  // true 时挂监听、false 时卸载——handler 内部还会再校验菜单 DOM 是否在屏
  // （避免 filter 空时 listener 仍然挂着的歧义路径）。
  useEffect(() => {
    if (!showSlash) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!slashMenuRef.current) return;
      if (slashMenuRef.current.contains(target)) return;
      if (textareaRef.current?.contains(target)) return;
      setShowSlash(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSlash]);

  const canSend = value.trim().length > 0 || quoteChips.length > 0 || mentions.length > 0;

  // Recorder integration. The captured session lands in attachments via
  // the channel subscription below — NOT via `recorder.stop()`'s return
  // value. handleSend just needs to await stop() so any in-flight session
  // delivery completes before we read attachments.
  const recorder = useRecorder();
  // Guard the short dispatch window: recorder finalization plus prompt
  // delivery / one fast reconnect retry. Once the prompt is dispatched,
  // the composer becomes editable again while the agent replies.
  const isDispatchingRef = useRef(false);
  const [isDispatching, setIsDispatching] = useState(false);

  // Keep the ref in sync with state so any post-await reader sees the
  // most-recent attachments without depending on a re-render.
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Subscribe to recorder sessions delivered by the background. Fires for
  // every finished recording (manual stop button, send-time auto-stop,
  // cap-trigger), so this is the single sink for recording attachments.
  //
  // We compute the next list from `attachmentsRef.current` and write
  // BOTH the ref and the state SYNCHRONOUSLY — NOT inside a
  // `setAttachments(prev => ...)` updater. React 18 defers the updater's
  // execution until the next flush, but `useRecorder.stop()`'s await
  // resumption is a microtask scheduled at the same publishSession call,
  // so by the time handleSend reads `attachmentsRef.current` the updater
  // hasn't run yet. Writing the ref outside the updater ensures handleSend
  // sees the new chip before dispatching `onSend`.
  useEffect(() => {
    return recorderChannel.subscribeSession((session) => {
      const current = attachmentsRef.current;
      if (current.length >= MAX_ATTACHMENT_COUNT) {
        toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
        return;
      }
      const next = [...current, recordingToAttachment(session)];
      debugLog.info('ui', 'attachment:add', {
        kind: 'recording',
        eventsCount: session.events.length,
        durationMs: session.durationMs,
      });
      attachmentsRef.current = next;
      setAttachments(next);
    });
  }, []);

  const handleSend = async () => {
    if (!canSend) {
      debugLog.info('ui', 'send:rejected', { reason: 'empty' });
      return;
    }
    if (isDispatchingRef.current) {
      debugLog.info('ui', 'send:rejected', { reason: 'busy' });
      return;
    }
    if (!currentModel) {
      debugLog.info('ui', 'send:rejected', { reason: 'no_model' });
      toast.error(t('chat.composer.needModel'), {
        action: onOpenSettings ? { label: t('chat.composer.goToSettings'), onClick: onOpenSettings } : undefined,
      });
      return;
    }

    // 发送前停止听写并把当前未定稿的 interim 就地清洗定稿，确保「正在说的那句」
    // 一并发出、且 CJK 空格被清掉。
    let outgoingText = value;
    if (speechActive) {
      outgoingText = finalizePendingInterim();
      speech.stop();
    }

    // Snapshot the text BEFORE any await so a fast follow-up edit doesn't
    // leak into the outgoing message. Use the raw user draft (NOT a
    // chip-prepended version) as the slash-command candidate — see the
    // comment in the slash block below.
    let text = outgoingText.trim();
    // `displayText` is what shows in the user's bubble in chat history.
    // The chips already previewed the quoted text, so the bubble only
    // needs the user's own typed words — no need to echo the quote back.
    // Slash-command shortening (`/foo bar` → expanded body) is handled
    // later in this function and overwrites `text` while keeping
    // `displayText` short.
    const displayText = outgoingText.trim();
    const dispatchSessionId = sessionIdRef.current;

    isDispatchingRef.current = true;
    setIsDispatching(true);

    try {
      // Resolve prompt at send-time if inline expansion is disabled
      if (!isExpandInline && text.startsWith('/')) {
        const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
        if (match) {
          const name = match[1];
          const userInput = match[2] ?? '';

          const allPrompts = await scanPrompts();
          const foundPrompt = allPrompts.find((p) => p.name === name);
          if (foundPrompt) {
            try {
              const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${foundPrompt.fileName}`, 'utf8');
              const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
              const { body } = parseFrontmatter(content);
              const vars = await gatherTemplateVars();

              // Provide prompt user input to templates via {{input}}
              vars.input = userInput;

              let replaced = replaceTemplateVars(body.trim(), vars);
              // If the prompt template does not explicitly contain {{input}}, append user text at the end
              if (!body.includes('{{input}}') && userInput.trim()) {
                replaced = replaced + '\n\n' + userInput.trim();
              }
              debugLog.info('ui', 'slash_command:resolved', { name: foundPrompt.name });
              text = replaced;
            } catch {
              debugLog.info('ui', 'send:rejected', { reason: 'slash_read_failed', name });
              toast.error(t('chat.composer.readPromptFailed'));
              return;
            }
          }
        }
      }

      // Prepend any quote chips above the textarea so the LLM actually
      // receives the quoted content. The chips are the source of truth
      // (textarea stays clean), so we splice them in here at the last
      // possible moment — AFTER slash-command resolution so a `/foo` text
      // becomes its expanded prompt body before the chip is added. Newline-
      // separated; if there's nothing else, the chip text is the entire
      // outgoing message.
      const chipTexts = quoteChipsRef.current.map((c) => c.text.trimEnd()).filter(Boolean);
      if (chipTexts.length > 0) {
        const quoted = chipTexts.join('\n');
        text = text.length > 0 ? `${quoted}\n\n${text}` : quoted;
      }

      // Resolve mention chips (prompt/skill/dir) into attachments. Each chip
      // is a self-contained reference; the resolver reads the VFS file (or
      // uses the built-in body for starter skills) and produces a typed
      // attachment. Chips whose file can't be read are silently dropped and
      // a single aggregated toast warns the user. The resolved attachments
      // ride along with image/file/element/recording attachments inside
      // `<attachments>…</attachments>`.
      const mentionChips = mentionsRef.current;
      debugLog.info('ui', 'mention:resolve:start', { count: mentionChips.length });
      const resolvedMentions: ResolvedMentionAttachment[] = [];
      const failedNames: string[] = [];
      if (mentionChips.length > 0) {
        const settled = await Promise.allSettled(
          // RAG chips need the outgoing user text as their retrieval query —
          // forward the post-slash-resolved `text` so the embedder sees what
          // the user actually wants, not the raw textarea draft.
          mentionChips.map((chip) => resolveMentions([chip], text).then((r) => ({ chip, r }))),
        );
        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i];
          if (outcome.status === 'rejected' || outcome.value.r.length === 0) {
            const chip = mentionChips[i];
            const failedName = chip.kind === 'vfs-dir' || chip.kind === 'vfs-file'
              ? chip.label
              : chip.kind === 'rag-collection'
                ? chip.collection
                : chip.name;
            failedNames.push(failedName);
          } else {
            resolvedMentions.push(outcome.value.r[0]);
          }
        }
        if (failedNames.length > 0) {
          toast.warning(
            t('chat.composer.mentionReadFailed', [failedNames.join(', ')]),
          );
        }
      }
      debugLog.info('ui', 'mention:resolve:done', {
        requested: mentionChips.length,
        resolved: resolvedMentions.length,
        failed: failedNames,
      });

      // Resolve pinned items — same resolver path as mention chips. Pinned
      // items share the prompt/skill variants, so resolveMentionToAttachment
      // accepts them directly (PinnedMention is a subset of MentionChip).
      // Failures here are SILENT (no toast): pinned content is auto-loaded,
      // not user-curated per message, so a missing file isn't user-facing
      // and shouldn't block the send. The pin remains in place so a later
      // message can succeed once the VFS re-hydrates.
      //
      // PINNED RAG ONLY: when settings.pinMinScore > 0, the resolver drops
      // the RAG attachment when every retrieved chunk scores below the
      // threshold (off-topic question). The LLM still gets the user's
      // outgoing text, just without RAG context for this turn — a soft
      // "skip the pin if irrelevant" behavior. One-shot mention chips
      // always attach regardless of the gate (the user explicitly opted
      // in for that message).
      //
      // `pinned: true` opts out of that silent-drop behavior — the user
      // has explicitly pinned this collection for the chat, so we always
      // emit the envelope (with `count="0" reason="no_match|empty"` when
      // nothing matched). Without this, the LLM has no signal that the
      // collection was queried and falls back to fs_* tools to look up
      // "what files are in phaply?" — fs_* only sees VFS, so it returns
      // unrelated content and the LLM mislabels it as RAG.
      const pinnedItems = pinnedRef.current;
      const resolvedPinned: ResolvedMentionAttachment[] = [];
      if (pinnedItems.length > 0) {
        const pinRagSettings = await ragSettingsStorage.getValue();
        const pinRagMinScore = pinRagSettings.pinMinScore > 0 ? pinRagSettings.pinMinScore : undefined;
        const settledPinned = await Promise.allSettled(
          pinnedItems.map((p) =>
            resolveMentionToAttachment(
              p,
              text,
              p.kind === 'rag-collection'
                ? { minScore: pinRagMinScore, pinned: true }
                : undefined,
            ),
          ),
        );

        // Track resolution outcomes per pin id so we can update the
        // strip chip's "broken" indicator and drive auto-unpin. RAG pins
        // can legitimately resolve to an empty envelope — that's not a
        // failure, it's the contract documented at the resolver. We
        // count a pin as failed only when the resolver outright returns
        // null or throws (file missing, read error, etc.).
        const failedIds = new Set<string>();
        const failedNames: string[] = [];
        const recoveredIds: string[] = [];
        const autoUnpinned: { item: PinnedMention; count: number }[] = [];

        for (let i = 0; i < settledPinned.length; i++) {
          const pin = pinnedItems[i];
          const outcome = settledPinned[i];
          const ok = outcome.status === 'fulfilled' && outcome.value !== null;
          if (ok) {
            resolvedPinned.push(outcome.value as ResolvedMentionAttachment);
            // Any success resets the consecutive-failure counter — a
            // once-deleted file that came back should not auto-unpin.
            pinFailCountsRef.current.delete(pin.id);
            if (failedPins.has(pin.id)) recoveredIds.push(pin.id);
            continue;
          }
          failedIds.add(pin.id);
          const label = pinLabel(pin);
          failedNames.push(label);
          const prevCount = pinFailCountsRef.current.get(pin.id) ?? 0;
          const nextCount = prevCount + 1;
          pinFailCountsRef.current.set(pin.id, nextCount);
          if (nextCount >= PIN_AUTO_UNPIN_THRESHOLD) {
            autoUnpinned.push({ item: pin, count: nextCount });
            pinFailCountsRef.current.delete(pin.id);
          }
        }

        // Apply state updates in one batch to avoid two re-renders.
        setFailedPins((prev) => {
          const next = new Set(prev);
          for (const id of recoveredIds) next.delete(id);
          for (const id of failedIds) {
            // Don't overwrite if we're about to auto-unpin — the chip
            // will disappear, so the ⚠ indicator is moot.
            if (autoUnpinned.some((u) => u.item.id === id)) continue;
            next.add(id);
          }
          return next;
        });

        // Toast only the *new* failures (pins not already in failedPins).
        // The ⚠ chip is the persistent signal for repeats — repeated
        // toasts would just spam the user.
        const newFailureNames = pinnedItems
          .filter((p) => failedIds.has(p.id) && !failedPins.has(p.id) && !autoUnpinned.some((u) => u.item.id === p.id))
          .map((p) => pinLabel(p));
        if (newFailureNames.length > 0) {
          toast.warning(t('chat.composer.pinReadFailed', [newFailureNames.join(', ')]));
        }

        // Auto-unpin pins that have hit the threshold. We collect them
        // first so a single togglePin call handles removal cleanly.
        for (const { item, count } of autoUnpinned) {
          toast.warning(t('chat.composer.pinAutoRemoved', [pinLabel(item), String(count)]));
          togglePin(item);
        }

        debugLog.info('ui', 'pin:resolve:done', {
          requested: pinnedItems.length,
          resolved: resolvedPinned.length,
          failed: failedNames,
          autoUnpinned: autoUnpinned.map((u) => pinLabel(u.item)),
        });
      }

      if (recorder.isOwner) {
        // Pre-flight cap check: refuse to send if attachments are already
        // full — otherwise the about-to-be-delivered recording would be
        // silently dropped by the session subscription's overflow guard.
        // Count mentions AND pins toward the same cap — both are
        // attachments too. Folder/file/RAG stay as structured
        // attachments; prompt/skill directives are pulled out for inline
        // injection (see filterInlineable below), so they no longer count.
        const totalAttachmentCount =
          attachmentsRef.current.length + resolvedMentions.length + resolvedPinned.length;
        if (totalAttachmentCount > MAX_ATTACHMENT_COUNT) {
          debugLog.info('ui', 'send:rejected', { reason: 'max_attachments' });
          toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
          return;
        }
        // Wait for the BG to finalize. The session is delivered (and
        // appended to `attachmentsRef`) synchronously by the channel
        // subscription above before this await resolves.
        await recorder.stop();
      }
      if (dispatchSessionId !== null && sessionIdRef.current !== dispatchSessionId) return;

      // Hybrid injection: pull prompt/skill bodies OUT of the structured
      // attachments and inline them as `[DIRECTIVE — <name>]` blocks in
      // the user text. Reason: inside `<attachments>...</attachments>`,
      // the LLM weights `<attached-prompt>` and `<attached-skill>` as
      // reference data (lower priority than user text and far below
      // system rules). Inlining as text puts them in the user-message
      // region where the model actually follows instructions, with the
      // same weight as slash command expansion (which overwrites `text`
      // directly). Folder/file/RAG stay as structured attachments —
      // they're data references, not directives, so attachment framing
      // is the right channel for them.
      const inlineDirectiveParts: string[] = [];
      const isInlineableDirective = (att: ResolvedMentionAttachment) =>
        att.type === 'mention-prompt' || att.type === 'mention-skill';
      const formatDirective = (att: ResolvedMentionAttachment, pinned: boolean): string | null => {
        // `pinned="true"` is appended to the opening tag for pin chips. The
        // bubble parser walks the message text looking for this exact shape
        // and skips rendering a chip when the flag is set — the pin is
        // already visible in the composer strip, repeating it on every
        // bubble just clutters the chat history. Mention chips omit the
        // attribute so the bubble renders them as confirmation. The LLM
        // doesn't care about the attribute; it only sees the body.
        const pinAttr = pinned ? ' pinned="true"' : '';
        if (att.type === 'mention-prompt') {
          return `[DIRECTIVE — ATTACHED PROMPT: "${att.name}"${pinAttr}]\n\n${att.body}\n\n[END DIRECTIVE]`;
        }
        if (att.type === 'mention-skill') {
          return `[DIRECTIVE — ATTACHED SKILL: "${att.name}"${pinAttr}]\n\n${att.body}\n\n[END DIRECTIVE]`;
        }
        return null;
      };
      const filteredResolvedMentions: ResolvedMentionAttachment[] = [];
      for (const att of resolvedMentions) {
        if (isInlineableDirective(att)) {
          const directive = formatDirective(att, false);
          if (directive) inlineDirectiveParts.push(directive);
        } else {
          // Mention folder/file/RAG stay as structured envelopes — the
          // bubble renders them as confirmation chips, and the LLM gets
          // the data. `pinned` is intentionally left unset / false.
          filteredResolvedMentions.push(att);
        }
      }
      const filteredResolvedPinned: ResolvedMentionAttachment[] = [];
      for (const att of resolvedPinned) {
        if (isInlineableDirective(att)) {
          const directive = formatDirective(att, true);
          if (directive) inlineDirectiveParts.push(directive);
        } else {
          // Pin folder/file/RAG still go as structured envelopes so the
          // LLM receives the data every send (pins are persistent context),
          // but we mark them `pinned: true` so the bubble renderer can
          // suppress the visual chip — the composer strip is already
          // showing the pin, repeating it on every bubble just clutters
          // the chat history. The envelope itself is identical content-
          // wise; only the `pinned="true"` attribute changes.
          filteredResolvedPinned.push({ ...att, pinned: true } as ResolvedMentionAttachment);
        }
      }
      if (inlineDirectiveParts.length > 0) {
        const directives = inlineDirectiveParts.join('\n\n---\n\n');
        // Pin/mention directives precede slash/quote/user text so the
        // LLM sees them as the framing for the request, with the user's
        // own words as the actual ask.
        text = `${directives}\n\n---\n\n${text}`;
      }

      const outgoing: Attachment[] = [
        ...attachmentsRef.current,
        ...filteredResolvedMentions,
        ...filteredResolvedPinned,
      ];
      const result = await onSend(
        text,
        outgoing.length > 0 ? outgoing : undefined,
        dispatchSessionId,
        { displayText },
      );
      if (result.status !== 'dispatched') return;
      if (dispatchSessionId !== null && sessionIdRef.current !== dispatchSessionId) return;

      setValue('');
      setAttachments([]);
      attachmentsRef.current = [];
      setShowSlash(false);
      setHistoryIndex(null);
      setDraft('');
      setQuoteChips([]);
      quoteChipsRef.current = [];
      setMentions([]);
      mentionsRef.current = [];
    } finally {
      isDispatchingRef.current = false;
      setIsDispatching(false);
      // Ensure the textarea regains focus after being re-enabled
      requestAnimationFrame(() => {
        if (!isActiveTabMobile) {
          textareaRef.current?.focus();
        }
      });
    }
  };

  // Reset history navigation when switching sessions. Also stop any active
  // dictation and drop the pending interim tracking so a late final from the
  // previous session can't append into the new session's composer
  // （speech.stop 在空闲时是无副作用的 no-op）。
  //
  // Pin-clearing policy: pins are tied to the chat the user is IN, not to
  // the lifecycle of the sessionId React prop. The sessionId prop goes
  // from `null` → real id on the very first send of a chat that was
  // opened with an empty composer — that's NOT a chat switch, it's the
  // moment the chat gets born. We must not wipe the user's pins at that
  // moment or they "vanish after the first send" (the bug that
  // motivated this branch). The clearing rule is asymmetric:
  //   - prev === null (we weren't in a chat): never clear, even if
  //     `next` is non-null. This covers the "first send" case above
  //     and also preserves any in-memory pins across a fresh page load
  //     before the user has opened any chat.
  //   - prev !== null (we WERE in a chat) and prev !== next: always
  //     clear. This covers both "user clicked New Chat" (prev → null)
  //     and "user switched to a different chat" (prev → other id).
  //     Leaving a chat means the pins belong to a context that's gone.
  const previousSessionIdRef = useRef<string | null>(sessionId ?? null);
  useEffect(() => {
    setHistoryIndex(null);
    setDraft('');
    setQuoteChips([]);
    quoteChipsRef.current = [];
    setMentions([]);
    mentionsRef.current = [];
    const prev = previousSessionIdRef.current;
    const next = sessionId ?? null;
    if (prev !== null && prev !== next) {
      // Genuine exit from a chat (either to null, or to a different
      // chat id) — drop the pins that belonged to the previous chat.
      setPinned([]);
      pinnedRef.current = [];
      setFailedPins(new Set());
      pinFailCountsRef.current.clear();
    }
    previousSessionIdRef.current = next;
    interimSuffixRef.current = '';
    speech.stop();
  }, [sessionId, speech.stop]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Don't intercept anything while the IME is composing (e.g. Chinese pinyin).
    if (e.nativeEvent.isComposing) return;

    // Slash menu keyboard navigation. Only active while the menu is actually
    // rendered with at least one selectable item — when it's hidden (no
    // match) all keys fall through to the default textarea behaviour
    // (history nav, send, etc.).
    if (isSlashMenuVisible && filteredPrompts.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedPromptIndex((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedPromptIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const target = filteredPrompts[selectedPromptIndex] ?? filteredPrompts[0];
        if (target) handlePromptSelect(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
    }

    // ↑ / ↓ navigate previously sent user messages, but only when the caret
    // is at the absolute start (↑) or end (↓) of the textarea, so multi-line
    // editing is never disturbed. The slash command menu (when visible)
    // reserves these keys for its own use; once it's hidden — including the
    // "no match" case — history navigation resumes.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isSlashMenuVisible && userHistory && userHistory.length > 0) {
      const ta = textareaRef.current;
      if (ta) {
        // After history navigation, place the caret to keep further presses
        // ergonomic: ↑ leaves caret at start so the next ↑ keeps walking back;
        // ↓ leaves caret at end so the next ↓ keeps walking forward (and
        // typing continues from where the user is most likely to edit).
        const moveCursor = (where: 'start' | 'end') => {
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            const pos = where === 'end' ? el.value.length : 0;
            el.setSelectionRange(pos, pos);
          });
        };

        if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
          if (historyIndex === null) {
            e.preventDefault();
            setDraft(ta.value);
            const last = userHistory.length - 1;
            setHistoryIndex(last);
            setValue(userHistory[last]);
            moveCursor('start');
            return;
          }
          if (historyIndex > 0) {
            e.preventDefault();
            const next = historyIndex - 1;
            setHistoryIndex(next);
            setValue(userHistory[next]);
            moveCursor('start');
            return;
          }
          // Already at oldest entry — fall through.
        }

        if (
          e.key === 'ArrowDown'
          && historyIndex !== null
          && ta.selectionStart === ta.value.length
          && ta.selectionEnd === ta.value.length
        ) {
          e.preventDefault();
          if (historyIndex < userHistory.length - 1) {
            const next = historyIndex + 1;
            setHistoryIndex(next);
            setValue(userHistory[next]);
          } else {
            setHistoryIndex(null);
            setValue(draft);
          }
          moveCursor('end');
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isAgentRunning && !isDispatching) handleSend();
    }
  };

  const handleInput = (val: string) => {
    setValue(val);
    // Show the slash menu when the text starts with `/` (typical case) OR
    // when the last whitespace-separated token starts with `/` — this lets
    // users type a regular message and then `/writing` at the end to invoke
    // a command on top of what they already wrote.
    const lastToken = val.split(/\s/).at(-1) ?? '';
    setShowSlash(lastToken.startsWith('/'));
    // Manual edits exit history mode — the new content becomes the draft.
    if (historyIndex !== null) setHistoryIndex(null);
  };

  // 由外部（欢迎页示例卡片）填入文本并聚焦，不夺走输入框对 value 的所有权。
  const fill = useCallback((text: string) => {
    setValue(text);
    const lastToken = text.split(/\s/).at(-1) ?? '';
    setShowSlash(lastToken.startsWith('/'));
    setHistoryIndex(null);
    // 等 value 提交后再聚焦并把光标移到末尾，方便用户接着改。
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  // Insert text at the current caret position (or append if caret is at end).
  // Used by the "Quote" feature when the user selects text in an assistant
  // message and clicks the floating Quote button. Preserves caret position
  // so the user can keep typing right after the inserted block.
  const insertText = useCallback((text: string) => {
    setValue((prev) => {
      const el = textareaRef.current;
      if (!el) return prev + text;
      const start = el.selectionStart ?? prev.length;
      const end = el.selectionEnd ?? prev.length;
      const newValue = prev.slice(0, start) + text + prev.slice(end);
      // Restore caret right after the inserted text.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const caret = start + text.length;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
      return newValue;
    });
    setHistoryIndex(null);
  }, []);

  // ─── Pinned context (per-chat) ───
  // A pinned prompt or skill rides along on EVERY message of the current
  // chat — handy when the user wants the LLM to keep a long-running
  // instruction (e.g. "explain in character", "always respond in
  // Vietnamese", the translate prompt) without re-mentioning it on every
  // turn. Scope is intentionally per-chat: switching to a new session
  // clears the list (handled by the session-reset effect below), so the
  // user must re-pin if they want the same context in a fresh chat.
  const [pinned, setPinned] = useState<PinnedMention[]>([]);
  const pinnedRef = useRef<PinnedMention[]>([]);

  // Pin health tracking — surfaces failures in the strip chip and triggers
  // auto-cleanup. `failedPins` is the set of pin ids that failed to resolve
  // on the most recent send (the chip draws ⚠ while in this set). It is
  // cleared for any pin that resolves successfully on the next send, so a
  // transient VFS race heals automatically. `pinFailCounts` tracks
  // consecutive failures per id and drives auto-unpin at
  // PIN_AUTO_UNPIN_THRESHOLD — a single success resets the counter.
  const [failedPins, setFailedPins] = useState<Set<string>>(() => new Set());
  const pinFailCountsRef = useRef<Map<string, number>>(new Map());

  // Add a mention chip picked from the MentionPopover. The popover passes
  // the chip directly via onSelect; we dedupe by chip-id (the popover
  // stamps a unique id per pick so duplicates within one popover open are
  // impossible, but cross-open duplicates are valid — e.g. two copies of
  // the same prompt body).
  const addMention = useCallback((chip: MentionChip) => {
    setMentions((prev) => {
      const next = [...prev, chip];
      mentionsRef.current = next;
      debugLog.info('ui', 'mention:add', {
        kind: chip.kind,
        count: next.length,
      });
      return next;
    });
  }, []);

  const removeMention = useCallback((id: string) => {
    setMentions((prev) => {
      const next = prev.filter((m) => m.id !== id);
      mentionsRef.current = next;
      return next;
    });
  }, []);

  // Toggle a pin: if the item is already pinned, remove it; otherwise
  // append. The popover passes a fresh id per pick so toggling a single
  // item stays well-defined (each pick is a unique PinnedMention). The
  // id-based match means built-in skills can be pinned and unpinned
  // freely even though they share the same `name`/`filePath` (and the
  // same is true for folders/files keyed on path).
  const togglePin = useCallback((item: PinnedMention) => {
    setPinned((prev) => {
      const exists = prev.some((p) => p.id === item.id);
      const next = exists ? prev.filter((p) => p.id !== item.id) : [...prev, item];
      pinnedRef.current = next;
      // When a pin is removed (manually or via auto-unpin), drop its
      // failure bookkeeping so a re-pin starts with a clean slate.
      if (exists) {
        pinFailCountsRef.current.delete(item.id);
        setFailedPins((prevSet) => {
          if (!prevSet.has(item.id)) return prevSet;
          const nextSet = new Set(prevSet);
          nextSet.delete(item.id);
          return nextSet;
        });
      }
      debugLog.info('ui', 'pin:toggle', {
        kind: item.kind,
        label: pinLabel(item),
        action: exists ? 'unpin' : 'pin',
        total: next.length,
      });
      return next;
    });
  }, []);

  /** Cheap helper for the popover to know if an item is currently pinned.
   *  State-based (not ref-based) so the icon can re-render when pins
   *  toggle without needing a separate force-update. */
  const isPinned = useCallback((id: string) => pinned.some((p) => p.id === id), [pinned]);

  // Records a quote as a chip above the textarea (the chip becomes the
  // source of truth — the textarea stays clean). The chip text is what
  // actually ships to the LLM at send-time: handleSend concatenates the
  // chip texts with whatever the user typed in the textarea.
  const insertQuote = useCallback((text: string) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setQuoteChips((prev) => {
      const next = [...prev, { id, text }];
      quoteChipsRef.current = next;
      return next;
    });
  }, []);

  useImperativeHandle(ref, () => ({ fill, insertText, insertQuote }), [fill, insertText, insertQuote]);

  // Scan prompts when slash menu opens
  useEffect(() => {
    if (!showSlash) return;
    scanPrompts().then(setPrompts).catch(() => setPrompts([]));
  }, [showSlash]);

  // Filter prompts by typed search (after '/')
  // Slash menu filter: use the last whitespace-separated token so users can
  // type a regular message and then `/writing` at the end to filter commands.
  const slashFilter = useMemo(() => {
    const lastToken = value.split(/\s/).at(-1) ?? '';
    return lastToken.startsWith('/') ? lastToken.slice(1).toLowerCase() : '';
  }, [value]);
  const filteredPrompts = useMemo(() => {
    if (!slashFilter) return prompts;
    return prompts.filter(
      (p) =>
        p.name.toLowerCase().includes(slashFilter) ||
        p.description.toLowerCase().includes(slashFilter),
    );
  }, [slashFilter, prompts]);

  // Menu hides when the user has typed a search term that matches nothing —
  // in that case Enter falls through to send the literal `/xxx` text.
  // When the search is empty we keep the menu open even if there are no
  // prompts at all, so the user sees the "no prompts yet" empty state.
  const isSlashMenuVisible = showSlash && (slashFilter === '' || filteredPrompts.length > 0);

  // Clamp the highlighted index whenever the visible list changes.
  useEffect(() => {
    if (filteredPrompts.length === 0) {
      setSelectedPromptIndex(0);
      return;
    }
    setSelectedPromptIndex((i) => Math.min(Math.max(i, 0), filteredPrompts.length - 1));
  }, [filteredPrompts.length]);

  // Reset highlight to the top whenever the menu (re)opens.
  useEffect(() => {
    if (isSlashMenuVisible) setSelectedPromptIndex(0);
  }, [isSlashMenuVisible]);

  // Keep the highlighted item in view when navigating with the keyboard.
  useEffect(() => {
    if (!isSlashMenuVisible) return;
    const el = slashMenuRef.current?.querySelector<HTMLElement>(`[data-prompt-index="${selectedPromptIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedPromptIndex, isSlashMenuVisible]);

  // Handle prompt selection from slash menu
  const handlePromptSelect = async (prompt: PromptMeta) => {
    if (isDispatchingRef.current) return;
    if (isExpandInline) {
      try {
        const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${prompt.fileName}`, 'utf8');
        const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
        const { body } = parseFrontmatter(content);
        const vars = await gatherTemplateVars();
        const replaced = replaceTemplateVars(body.trim(), vars);
        if (isDispatchingRef.current) return;
        setValue(replaced);
        setShowSlash(false);
        textareaRef.current?.focus();
      } catch {
        toast.error(t('chat.composer.readPromptFailed'));
      }
    } else {
      // Replace only the last whitespace-separated token (the `/writing` part)
      // with the selected command, preserving any text the user typed before it.
      const lastTokenStart = value.search(/\S+$/);
      const next = lastTokenStart >= 0
        ? value.slice(0, lastTokenStart) + `/${prompt.name} `
        : `/${prompt.name} `;
      setValue(next);
      setShowSlash(false);
      textareaRef.current?.focus();
    }
  };

  const handlePickElement = async () => {
    if (isDispatchingRef.current) return;
    if (isPicking) {
      cancelElementPicker();
      return;
    }
    setIsPicking(true);
    try {
      const result = await startElementPicker();
      if (isDispatchingRef.current) return;
      switch (result.status) {
        case 'ok': {
          const att = result.attachment;
          // Click mode only ever returns ElementAttachment; defensive guard
          // keeps the narrower field access legal under the union return type.
          if (att.type !== 'element') break;
          // Deduplicate: same selector + same frameId
          const isDuplicate = attachments.some(
            (a) => a.type === 'element' && a.selector === att.selector && a.frameId === att.frameId,
          );
          if (isDuplicate) {
            toast.info(t('chat.composer.elementAdded'));
          } else if (attachments.length >= MAX_ATTACHMENT_COUNT) {
            toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
          } else {
            debugLog.info('ui', 'attachment:add', { kind: 'element', mime: 'text/html', size: (att.textContent ?? '').length });
            setAttachments((prev) => [...prev, att]);
          }
          break;
        }
        case 'cancelled':
          break;
        case 'error':
          if (result.reason === 'unsupported-page') {
            toast.warning(t('chat.composer.elementPickUnsupported'));
          } else if (result.reason === 'navigation') {
            toast.warning(t('chat.composer.elementPickNavigated'));
          } else {
            toast.error(t('chat.composer.elementPickFailed'));
            if (result.message) console.error('[Element Picker]', result.message);
          }
          break;
      }
    } catch (err) {
      toast.error(t('chat.composer.elementPickFailed'));
      console.error('[Element Picker]', err);
    } finally {
      setIsPicking(false);
      textareaRef.current?.focus();
    }
  };

  // Region-pick handler: drag a rectangle on the page; release fires a real
  // screenshot of the rectangle via the picker, returned as an ImageAttachment
  // with `source: 'region-select'`. Mutually exclusive with click-pick — if
  // the user has click-pick running, cancel it first.
  const handlePickRegion = async () => {
    if (isDispatchingRef.current) return;
    if (isPickingRegion) {
      cancelElementPicker();
      return;
    }
    if (isPicking) cancelElementPicker();
    if (!supportsImage) {
      toast.warning(t('chat.composer.modelNoImage'));
      return;
    }
    if (attachments.length >= MAX_ATTACHMENT_COUNT) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      return;
    }
    setIsPickingRegion(true);
    try {
      const result = await startElementPicker({ mode: 'region' });
      if (isDispatchingRef.current) return;
      switch (result.status) {
        case 'ok': {
          if (result.attachment.type !== 'image') {
            // Defensive — picker always returns an image in region mode.
            return;
          }
          debugLog.info('ui', 'attachment:add', {
            kind: 'region-select',
            mime: result.attachment.mimeType,
            size: result.attachment.data.length,
          });
          setAttachments((prev) => [...prev, result.attachment as Attachment]);
          break;
        }
        case 'cancelled':
          break;
        case 'error':
          if (result.reason === 'unsupported-page') {
            toast.warning(t('chat.composer.elementPickUnsupported'));
          } else if (result.reason === 'navigation') {
            toast.warning(t('chat.composer.elementPickNavigated'));
          } else {
            toast.error(t('chat.composer.regionPickFailed'));
            if (result.message) console.error('[Region Picker]', result.message);
          }
          break;
      }
    } catch (err) {
      toast.error(t('chat.composer.regionPickFailed'));
      console.error('[Region Picker]', err);
    } finally {
      setIsPickingRegion(false);
      textareaRef.current?.focus();
    }
  };

  const handleScreenshot = async () => {
    if (isDispatchingRef.current) return;
    // 纯文本模型不支持截图（图片）输入，按钮也会被禁用，这里再兜底一次。
    if (!supportsImage) {
      toast.warning(t('chat.composer.modelNoImage'));
      return;
    }
    if (attachments.length >= MAX_ATTACHMENT_COUNT) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      return;
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
      if (isDispatchingRef.current) return;
      if (!supportsImageRef.current) return;
      const base64 = dataUrl.split(',', 2)[1] ?? '';
      debugLog.info('ui', 'attachment:add', { kind: 'screenshot', mime: 'image/jpeg', size: base64.length });
      setAttachments((prev) => [
        ...prev,
        { type: 'image', source: 'screenshot', data: base64, mimeType: 'image/jpeg' },
      ]);
    } catch (err) {
      toast.error(t('chat.composer.screenshotFailed'));
      console.error('[Screenshot]', err);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isDispatchingRef.current) {
      e.target.value = '';
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      e.target.value = '';
      return;
    }

    const filesToProcess = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      toast.warning(t('chat.composer.truncatedFiles', [remaining]));
    }

    for (const file of filesToProcess) {
      if (isImageFile(file)) {
        // 当前模型不支持多模态时，跳过图片文件（文本文件仍照常处理）。
        if (!supportsImage) {
          toast.warning(t('chat.composer.modelNoImage'));
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatBytes(MAX_IMAGE_SIZE)]));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (isDispatchingRef.current) return;
          if (!supportsImageRef.current) return;
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',', 2)[1] ?? '';
          const mimeType = file.type || 'image/png';
          debugLog.info('ui', 'attachment:add', { kind: 'image-upload', mime: mimeType, size: file.size });
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'image', source: 'upload', data: base64, mimeType, name: file.name }];
          });
        };
        reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name]));
        reader.readAsDataURL(file);
      } else if (isTextFile(file.name)) {
        if (file.size > MAX_TEXT_FILE_SIZE) {
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatBytes(MAX_TEXT_FILE_SIZE)]));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (isDispatchingRef.current) return;
          const mime = file.type || 'text/plain';
          debugLog.info('ui', 'attachment:add', { kind: 'text-file', mime, size: file.size });
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'file', content: reader.result as string, name: file.name, mimeType: file.type || 'text/plain', size: file.size }];
          });
        };
        reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name]));
        reader.readAsText(file);
      } else if (isPdfFile(file)) {
        // PDF attachment: read into ArrayBuffer, send to the offscreen
        // document for text extraction (pdfjs-dist can't run from the SW
        // — needs DOM/OffscreenCanvas). The extracted text becomes a
        // `<attached-file type="application/pdf">` block the LLM can read.
        if (file.size > MAX_PDF_SIZE) {
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatBytes(MAX_PDF_SIZE)]));
          continue;
        }
        // Pre-flight: an empty PDF trips pdf.js's "file is empty" error
        // before our content-based checks run, and shows up as a noisy
        // toast. Bail early with a clearer message.
        if (file.size === 0) {
          toast.error(t('chat.composer.readFileFailed', [file.name]));
          continue;
        }
        // `file.arrayBuffer()` is the modern promise-based equivalent of
        // FileReader.readAsArrayBuffer. Returns a fresh, owned ArrayBuffer
        // we can safely structured-clone through `chrome.runtime.sendMessage`
        // — no detach races, no buffering into a string. Wrap in
        // `Uint8Array` at the call site so pdf.js (which v5 rejects raw
        // ArrayBuffers) sees the typed-array view it wants.
        let buf: ArrayBuffer;
        try {
          buf = await file.arrayBuffer();
        } catch (err) {
          toast.error(`${t('chat.composer.readFileFailed', [file.name])}: ${(err as Error).message ?? String(err)}`);
          continue;
        }
        try {
          // Lazy-create the offscreen document so the first PDF
          // attachment pays the setup cost (the offscreen page hosts
          // pdf.js's worker and runs the extraction).
          const { ensureOffscreen } = await import('@/lib/tools/offscreen');
          await ensureOffscreen();
          // We send the PDF bytes as base64 instead of a raw ArrayBuffer.
          // chrome.runtime.sendMessage's structured-clone path has been
          // observed to detach or zero the source buffer in some MV3
          // builds (offline / multi-MB / certain chromium releases),
          // which then makes pdf.js fail with "file is empty" — and a
          // base64 string sidesteps the issue entirely. The 4/3 size
          // overhead is acceptable for the 50 MB cap and only matters
          // on the IPC hop, not on disk.
          const bytes = new Uint8Array(buf);
          let binary = '';
          // Chunked to avoid call-stack overflow on multi-MB buffers
          // (String.fromCharCode.apply blows the stack past ~120 KB).
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(
              null,
              bytes.subarray(i, i + CHUNK) as unknown as number[],
            );
          }
          const base64 = btoa(binary);
          const resp = await chrome.runtime.sendMessage({
            type: 'pdf-extract-bytes',
            bytesBase64: base64,
          }) as { result?: { text: string; pageCount: number; pages: number[]; truncated: boolean }; error?: string };
          if (resp.error) throw new Error(resp.error);
          const result = resp.result;
          if (!result) throw new Error('PDF extraction returned no result');
          debugLog.info('ui', 'attachment:add', {
            kind: 'pdf',
            mime: 'application/pdf',
            size: file.size,
            pageCount: result.pageCount,
          });
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, {
              type: 'pdf',
              content: result.text,
              name: file.name,
              mimeType: 'application/pdf',
              size: file.size,
              pageCount: result.pageCount,
              extractedPageCount: result.pages.length,
              truncated: result.truncated,
            }];
          });
        } catch (err) {
          toast.error(`${t('chat.composer.readFileFailed', [file.name])}: ${(err as Error).message ?? String(err)}`);
        }
      } else {
        toast.error(t('chat.composer.unsupportedFileType', [file.name]));
      }
    }

    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isDispatchingRef.current) return;
    // 纯文本模型不接受粘贴的图片，直接放行默认粘贴行为。
    if (!supportsImage) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const imageFiles: File[] = [];
    let hasPlainText = false;
    for (const item of Array.from(items)) {
      if (item.kind === 'string' && item.type === 'text/plain') {
        hasPlainText = true;
      } else if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }

    if (imageFiles.length === 0) return;
    // Suppress default paste unless there's a real text/plain payload —
    // many screenshot tools also put text/html (filename / <img>) which we don't want in the textarea.
    if (!hasPlainText) e.preventDefault();

    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      return;
    }

    const filesToProcess = imageFiles.slice(0, remaining);
    if (imageFiles.length > remaining) {
      toast.warning(t('chat.composer.truncatedFiles', [remaining]));
    }

    for (const file of filesToProcess) {
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error(t('chat.composer.fileTooLarge', [file.name || 'image', formatBytes(MAX_IMAGE_SIZE)]));
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (isDispatchingRef.current) return;
        if (!supportsImageRef.current) return;
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',', 2)[1] ?? '';
        const mimeType = file.type || 'image/png';
        debugLog.info('ui', 'attachment:add', { kind: 'image-paste', mime: mimeType, size: file.size });
        setAttachments((prev) => {
          if (prev.some((a) => a.type === 'image' && a.data === base64)) {
            // When the user pasted text, the image is likely a side-effect of selecting
            // rich content — silently skip instead of nagging.
            if (!hasPlainText) toast.info(t('chat.composer.imageAlreadyAdded'));
            return prev;
          }
          if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
          return [...prev, { type: 'image', source: 'paste', data: base64, mimeType, name: file.name || undefined }];
        });
      };
      reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name || 'image']));
      reader.readAsDataURL(file);
    }
  };

  const removeAttachment = (index: number) => {
    if (isDispatchingRef.current) return;
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <footer className="px-1.5 py-1.5 bg-background relative">
      {/* Slash menu — dynamic VFS prompts */}
      {isSlashMenuVisible && (
        <div
          ref={slashMenuRef}
          className="absolute bottom-full left-4 right-4 mb-3 bg-popover border border-border rounded-lg shadow-xl z-50 animate-in slide-in-from-bottom-1 fade-in duration-150 overflow-y-auto max-h-60"
        >
          {filteredPrompts.length === 0 ? (
            <p className="text-[0.65rem] text-muted-foreground text-center py-2 px-2.5">
              {t('chat.composer.noPrompts')}
            </p>
          ) : (
            <div className="py-0.5">
              {filteredPrompts.map((p, idx) => {
                const selected = idx === selectedPromptIndex;
                return (
                  <button
                    key={p.fileName}
                    data-prompt-index={idx}
                    disabled={isDispatching}
                    onClick={() => handlePromptSelect(p)}
                    onMouseMove={() => { if (!isDispatching) setSelectedPromptIndex(idx); }}
                    className={`w-full flex items-start gap-2 px-2.5 py-1.5 text-left transition-colors ${selected ? 'bg-accent' : 'hover:bg-accent/50'}`}
                  >
                    <FileType className="size-3.5 mt-px shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[0.78rem] font-medium truncate">/{p.name}</p>
                      {p.description && (
                        <p className="text-[0.66rem] text-muted-foreground truncate">{p.description}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="border border-border rounded-xl bg-card focus-within:border-border/80 focus-within:ring-1 focus-within:ring-primary/10 transition-all [border-width:0.5px]">
        {/* Chip strips — sit at the very top of the composer, right under
            the rounded border, so the chips are the first thing the eye
            lands on when reading the input area. Both quote and mention
            strips share the same `justify-end` alignment as the bubble
            below to mirror the chat-history chip strip above the user
            message. No border-b — they flow into the toolbar visually. */}

        {/* Quote chips — preview pills rendered in a smaller font above the
            textarea. Each chip represents one Quote click. Removing a chip
            (X button) does NOT remove the corresponding text from the
            textarea; the chip is purely a visual aid. */}
        {quoteChips.length > 0 && (
          <div
            role="list"
            aria-label={t('chat.composer.quoteChips')}
            className="flex flex-col gap-1 px-1.5 pt-1.5 pb-1 justify-end"
          >
            {quoteChips.map((chip) => (
              <div
                key={chip.id}
                role="listitem"
                className="group flex items-start gap-1.5 rounded-md bg-muted/60 px-1.5 py-1 text-[0.72rem] leading-snug text-muted-foreground"
              >
                <QuoteIcon size={11} className="shrink-0 mt-px opacity-60" />
                <pre className="flex-1 min-w-0 whitespace-pre-wrap break-words font-sans m-0 p-0">
                  {chip.text.trimEnd()}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    setQuoteChips((prev) => {
                      const next = prev.filter((c) => c.id !== chip.id);
                      quoteChipsRef.current = next;
                      return next;
                    });
                  }}
                  title={t('chat.composer.removeQuoteChip')}
                  aria-label={t('chat.composer.removeQuoteChip')}
                  className="shrink-0 -mr-0.5 -mt-0.5 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-background/60 transition-colors"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Pinned chips — persistent chat-scope context. Items in this strip
            ride along on every send in the current chat (resolved to
            attachments in handleSend). They clear automatically when the
            user switches to a different chat — see the session-reset effect.
            Pinned chip strip sits at the very top so the user always sees
            what's currently auto-included in the conversation, even when
            no per-message mention chips are present. Distinct from mention
            chips below by the persistent Pin icon prefix. */}
        {pinned.length > 0 && (
          <div
            role="list"
            aria-label={t('chat.composer.pinnedChips')}
            className="flex flex-wrap gap-1 px-1.5 pt-1.5 pb-1 justify-end"
          >
            {pinned.map((p) => {
              // Color matches the corresponding chip below (mention strip)
              // and the bubble badge in the chat history so a pinned
              // directory listing reads as the same "kind" as a one-shot
              // mention of the same directory. Pin icon prefix is amber
              // regardless of kind — that signals "persistent" as a
              // separate visual layer from the kind indicator.
              //
              // When this pin failed to resolve on the most recent send,
              // desaturate the kind color and add a ⚠ prefix so the user
              // can tell at a glance that this pin's content is NOT being
              // attached to outgoing messages. The pin stays in the strip
              // so a transient VFS race can heal on the next send (and
              // auto-unpin kicks in at PIN_AUTO_UNPIN_THRESHOLD failures).
              const isFailed = failedPins.has(p.id);
              const kindClass = p.kind === 'skill'
                ? 'bg-amber-400/10 border-amber-400/30 text-amber-400'
                : p.kind === 'vfs-dir' || p.kind === 'vfs-file'
                  ? 'bg-emerald-400/10 border-emerald-400/30 text-emerald-400'
                  : p.kind === 'rag-collection'
                    ? 'bg-violet-400/10 border-violet-400/30 text-violet-400'
                    : 'bg-blue-400/10 border-blue-400/30 text-blue-400';
              const failedClass = 'bg-zinc-500/10 border-zinc-500/40 text-zinc-500 dark:text-zinc-400';
              const chipClass = isFailed ? failedClass : kindClass;
              const label =
                p.kind === 'prompt' ? `/${p.name}` :
                p.kind === 'vfs-dir' || p.kind === 'vfs-file' ? p.label :
                p.kind === 'rag-collection' ? p.collection :
                p.name;
              const failTooltip = isFailed
                ? t('chat.composer.pinReadFailed', [label])
                : t('chat.composer.unpin');
              return (
                <div
                  key={p.id}
                  role="listitem"
                  title={failTooltip}
                  aria-label={failTooltip}
                  className={
                    'group flex items-center gap-1 rounded-md border h-5 pl-1 pr-0.5 text-[0.65rem] font-mono leading-snug ' +
                    chipClass +
                    (isFailed ? ' cursor-help' : '')
                  }
                >
                  {isFailed
                    ? <AlertTriangle size={10} className="shrink-0 opacity-90" aria-hidden />
                    : <Pin size={10} className="shrink-0 opacity-80" aria-hidden />}
                  <span className="truncate max-w-32">{label}</span>
                  <button
                    type="button"
                    onClick={() => togglePin(p)}
                    title={t('chat.composer.unpin')}
                    aria-label={t('chat.composer.unpin')}
                    className="shrink-0 -mr-0.5 p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-foreground/10 cursor-pointer transition-opacity"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Mention chips — compact pills for prompt/skill/VFS-directory
            references attached via the [+] button. Each chip shows only the
            reference name (the content lives in VFS / locales and is shipped
            to the LLM at send-time by the resolver). Removing a chip is
            purely visual; it just deletes the chip and prevents the content
            from being sent. Color matches the corresponding bubble badge in
            the chat history so the user sees the same kind of chip above
            the bubble and below it. */}
        {mentions.length > 0 && (
          <div
            role="list"
            aria-label={t('chat.composer.mentionChips')}
            className="flex flex-wrap gap-1 px-1.5 pt-1.5 pb-1 justify-end"
          >
            {mentions.map((m) => (
              <div
                key={m.id}
                role="listitem"
                className={
                  'group flex items-center gap-1 rounded-md border h-5 pl-1.5 pr-0.5 text-[0.65rem] font-mono leading-snug ' +
                  (m.kind === 'skill'
                    ? 'bg-amber-400/5 border-amber-400/20 text-amber-400'
                    : m.kind === 'vfs-dir'
                      ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-400'
                      : m.kind === 'vfs-file'
                        ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-400'
                        : m.kind === 'rag-collection'
                          ? 'bg-violet-400/5 border-violet-400/20 text-violet-400'
                          : 'bg-blue-400/5 border-blue-400/20 text-blue-400')
                }
              >
                {m.kind === 'prompt' && <FileText size={11} className="shrink-0 opacity-70" />}
                {m.kind === 'skill' && <Sparkles size={11} className="shrink-0 opacity-70" />}
                {m.kind === 'vfs-dir' && <Folder size={11} className="shrink-0 opacity-70" />}
                {m.kind === 'vfs-file' && <FileText size={11} className="shrink-0 opacity-70" />}
                {m.kind === 'rag-collection' && <Database size={11} className="shrink-0 opacity-70" />}
                <span className="truncate max-w-32">
                  {m.kind === 'prompt' ? `/${m.name}` : m.kind === 'vfs-file' ? m.label : m.kind === 'vfs-dir' ? m.label : m.kind === 'rag-collection' ? m.collection : m.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeMention(m.id)}
                  title={t('chat.composer.removeMentionChip')}
                  aria-label={t('chat.composer.removeMentionChip')}
                  className="shrink-0 -mr-0.5 p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-foreground/10 cursor-pointer transition-opacity"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Top row: tools + attachments. Item order is the user-facing
            mental model: act on the page (pick / drag), attach stuff
            (upload / store / screenshot / record), then meta toggles
            (mobile mode). The storage shortcut is moved into the middle
            of the row so it stays high-traffic without dominating the
            leading edge — it lives one click away from the other
            attach-type buttons (file, screenshot, recording).
        */}
        <div className="flex items-center gap-0.5 px-1.5 pt-0.5 pb-0 justify-end">
          {/* 1. Pick element */}
          <Button
            variant="ghost"
            size="icon-xs"
            title={isPicking ? t('chat.composer.cancelPick') : t('chat.composer.pickElement')}
            onClick={handlePickElement}
            disabled={isDispatching}
            className={`size-7 ${isPicking ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}`}
          >
            <MousePointer2 className="size-3.5" />
          </Button>

          {/* 2. Drag to select a region */}
          <Button
            variant="ghost"
            size="icon-xs"
            title={isPickingRegion ? t('chat.composer.cancelRegionPick') : t('chat.composer.pickRegion')}
            onClick={handlePickRegion}
            disabled={isDispatching || !supportsImage}
            className={`size-7 ${isPickingRegion ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}`}
          >
            <Crop className="size-3.5" />
          </Button>

          {/* 3. Attach file (paperclip) */}
          <Button variant="ghost" size="icon-xs" title={t('chat.composer.uploadFile')} onClick={() => fileInputRef.current?.click()} disabled={isDispatching} className="size-7">
            <Paperclip className="size-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={`${supportsImage ? 'image/*,' : ''}.pdf,application/pdf,.txt,.md,.csv,.tsv,.log,.js,.ts,.jsx,.tsx,.mjs,.cjs,.py,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.json,.xml,.html,.htm,.css,.scss,.less,.env,.gitignore,.editorconfig`}
            className="hidden"
            disabled={isDispatching}
            onChange={handleFileUpload}
          />

          {/* 4. Storage shortcut — pulled out of Settings nav (high-traffic entry).
              Same row as the other attach-type buttons. Clicking during an
              active picker is safe: ChatInput's unmount cleanup calls
              cancelElementPicker(). */}
          {onOpenStorage && (
            <Button
              variant="ghost"
              size="icon-xs"
              title={t('chat.composer.openStorage')}
              onClick={onOpenStorage}
              disabled={isDispatching}
              className="size-7"
            >
              <HardDrive className="size-3.5" />
            </Button>
          )}

          {/* 5. Screenshot — gated on supportsImage. Tooltip explains why it's
              disabled when the model can't see images. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                // span 包裹：按钮 disabled 时本身不接收指针事件，靠外层 span 触发 tooltip。
                className="inline-flex"
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleScreenshot}
                  disabled={isDispatching || !supportsImage}
                  className="size-7"
                >
                  <Camera className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {supportsImage ? t('chat.composer.screenshot') : t('chat.composer.modelNoImage')}
            </TooltipContent>
          </Tooltip>

          {/* 6. Recorded (DOM session capture) */}
          <RecordButton disabled={isDispatching} />

          {/* 7. Mobile mode toggle */}
          <Button
            variant="ghost"
            size="icon-xs"
            title={t('chat.composer.mobileMode')}
            className={`size-7 ${isActiveTabMobile ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}`}
            onClick={toggleMobile}
            disabled={isDispatching}
          >
            <Smartphone className="size-3.5" />
          </Button>

          {attachments.length > 0 && (
            <>
              <Separator orientation="vertical" className="h-4! mx-1 bg-border" />

              {/* Attachment chips */}
              <div className="flex gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-none items-center">
                {attachments.map((att, i) => (
                  att.type === 'image' ? (
                    // Image attachment: thumbnail + label badge
                    <Badge
                      key={i}
                      variant="outline"
                      className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-0.5 pr-0.5 text-purple-400 border-purple-400/20 bg-purple-400/5 group"
                    >
                      <img
                        src={`data:${att.mimeType};base64,${att.data}`}
                        alt={att.name || (att.source === 'region-select' ? t('chat.attachments.region') : t('chat.attachments.screenshot'))}
                        className="h-3.5 w-5 rounded-sm object-cover cursor-pointer"
                        onClick={() => showDialog('image-preview', {
                          src: `data:${att.mimeType};base64,${att.data}`,
                          alt: att.name || (att.source === 'region-select' ? t('chat.attachments.region') : t('chat.attachments.screenshot')),
                        })}
                      />
                      <span className="truncate max-w-16">
                        {abbreviateName(att.name || (att.source === 'screenshot'
                          ? t('chat.attachments.screenshot')
                          : att.source === 'region-select'
                          ? t('chat.attachments.region')
                          : t('chat.attachments.image')))}
                      </span>
                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        disabled={isDispatching}
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  ) : att.type === 'recording' ? (
                    // Recording attachment: amber chip mirroring Message.tsx;
                    // chip body downloads the JSON, X removes from the list.
                    <Badge
                      key={i}
                      variant="outline"
                      className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-0.5 text-amber-400 border-amber-400/20 bg-amber-400/5 hover:bg-amber-400/10"
                      title={`${t('chat.attachments.recordingDownload')}\n${t('chat.attachments.recordingHover', [String(att.eventCount), formatCompactCount(att.json.length)])}`}
                    >
                      <button
                        className="flex items-center gap-1 cursor-pointer"
                        onClick={() => downloadFile(att.name, att.json, RECORDING_MIME)}
                      >
                        <Film className="size-2.5 shrink-0" />
                        <span className="truncate max-w-32">
                          {abbreviateName(att.name)} · {t('chat.attachments.recordingMeta', [String(att.eventCount), formatDuration(att.durationMs)])}
                        </span>
                      </button>
                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        disabled={isDispatching}
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  ) : (
                    // Element / file / pdf attachment: badge chip. PDF 走单独分支
                    // 显示文件名 + 页数；颜色用 orange 区别于 file 的 emerald，又不会
                    // 像之前的 red 那样被误判为错误态。所有 chip 用 abbreviateName
                    // 把长名截成 "开头…末尾" 形式，免得挤满整行 sidebar。
                    <Badge
                      key={i}
                      variant="outline"
                      className={`shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-0.5 ${
                        att.type === 'element'
                          ? 'text-info border-info/20 bg-info/5'
                          : att.type === 'pdf'
                            ? 'text-orange-400 border-orange-400/20 bg-orange-400/5'
                            : 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5'
                      }`}
                    >
                      {att.type === 'element' && <Crosshair className="size-2.5 shrink-0" />}
                      {(att.type === 'file' || att.type === 'pdf') && <FileText className="size-2.5 shrink-0" />}

                      <span className="truncate max-w-16">
                        {att.type === 'element' && abbreviateName(att.selector)}
                        {att.type === 'file' && abbreviateName(att.name)}
                        {att.type === 'pdf' && abbreviateName(att.name)}
                      </span>

                      {att.type === 'pdf' && (
                        <span className="shrink-0 text-[0.6rem] text-orange-400/70">
                          · {t('chat.attachments.pdfPageCount', [String(att.pageCount)])}
                        </span>
                      )}

                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        disabled={isDispatching}
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  )
                ))}
              </div>
            </>
          )}
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={(e) => { handleKeyDown(e); if (e.key === 'Escape' && onCancelEdit) { e.preventDefault(); onCancelEdit(); } }}
          onPaste={handlePaste}
          placeholder={t('chat.composer.placeholder')}
          disabled={isDispatching}
          className="w-full bg-transparent border-none outline-none resize-none text-foreground text-[length:var(--chat-font-size)] font-normal px-1.5 py-0.5 min-h-6 max-h-37.5 leading-tight placeholder:text-muted-foreground/50"
        />

        {/* Bottom row: actions */}
        <div className="flex items-center justify-between px-1.5 pb-0.5">
          <div className={`flex items-center gap-0.5 ${isDispatching ? 'pointer-events-none opacity-60' : ''}`}>
            <ModelSelector
              activeModel={currentModel}
              configuredProviders={providers}
              customProviders={customProviderList}
              onSelect={handleModelSelect}
              showAddModels
            />
            {thinkingLevels.length > 1 && (
              <ThinkingLevelSelector
                level={displayThinkingLevel}
                levels={thinkingLevels}
                onSelect={handleThinkingSelect}
              />
            )}
          </div>

          <div className="flex items-center gap-1">
            <MentionPopover
              disabled={isDispatching}
              onSelect={addMention}
              pinned={pinned}
              isPinned={isPinned}
              onTogglePin={togglePin}
            />
            {speech.supported && (
              <MicButton
                state={speech.state}
                onClick={() => { void handleMicClick(); }}
                disabled={isDispatching}
              />
            )}
            {isAgentRunning ? (
              <Button
                variant="destructive"
                size="icon-xs"
                onClick={() => onCancel?.()}
                className="size-7 hover:shadow-xs"
              >
                <Square className="size-3.5" fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleSend}
                disabled={!canSend || isDispatching}
                aria-label={t('common.send')}
                className="size-7 bg-foreground text-background hover:bg-primary hover:text-primary-foreground hover:shadow-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
});
