import { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';
import { Send, Square, MousePointer2, Camera, Paperclip, Smartphone, Crosshair, FileText, X, FileType, Film, ChevronDown, HardDrive, Quote as QuoteIcon, Crop } from 'lucide-react';
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
import { debugLog, withSession } from '@/lib/debug/log';

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
  { onSend, onOpenSettings, onOpenStorage, isAgentRunning, onCancel, userHistory, sessionId, model: currentModel, thinkingLevel: currentThinkingLevel, onModelChange, onThinkingChange },
  ref,
) {
  const [value, setValue] = useState('');
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
  // Mirror of `attachments` for synchronous reads after an await. The
  // recorder's `subscribeSession` callback fires synchronously when the
  // BG delivers a session, but React state isn't flushed by the time
  // `await recorder.stop()` resumes — so we keep this ref so handleSend
  // can read the post-stop attachment list without waiting for a render.
  const attachmentsRef = useRef<Attachment[]>([]);
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

  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [isExpandInline] = useStorageItem(expandPromptsInline, false);

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

  const canSend = value.trim().length > 0 || quoteChips.length > 0;

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

      if (recorder.isOwner) {
        // Pre-flight cap check: refuse to send if attachments are already
        // full — otherwise the about-to-be-delivered recording would be
        // silently dropped by the session subscription's overflow guard.
        if (attachmentsRef.current.length >= MAX_ATTACHMENT_COUNT) {
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

      const outgoing = attachmentsRef.current;
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
  useEffect(() => {
    setHistoryIndex(null);
    setDraft('');
    setQuoteChips([]);
    quoteChipsRef.current = [];
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

  // Mirror of `quoteChips` for synchronous reads from handleSend. The
  // chips list drives the outgoing message at send-time, so we need to
  // read the post-update value without waiting for a React flush.
  const quoteChipsRef = useRef<{ id: string; text: string }[]>([]);

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
  const slashFilter = (() => {
    const lastToken = value.split(/\s/).at(-1) ?? '';
    return lastToken.startsWith('/') ? lastToken.slice(1).toLowerCase() : '';
  })();
  const filteredPrompts = slashFilter
    ? prompts.filter((p) => p.name.toLowerCase().includes(slashFilter) || p.description.toLowerCase().includes(slashFilter))
    : prompts;

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
        {/* Top row: tools + attachments */}
        <div className="flex items-center gap-0.5 px-1.5 pt-0.5 pb-0 justify-end">
          {/* Storage shortcut — pulled out of Settings nav (high-traffic entry).
              Same row as pick/record tool icons, leading position. Clicking
              during an active picker is safe: ChatInput's unmount cleanup
              calls cancelElementPicker(). */}
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
          {/* Tool icons */}
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
          <RecordButton disabled={isDispatching} />
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

        {/* Quote chips — preview pills rendered in a smaller font above the
            textarea. Each chip represents one Quote click. Removing a chip
            (X button) does NOT remove the corresponding text from the
            textarea; the chip is purely a visual aid. */}
        {quoteChips.length > 0 && (
          <div
            role="list"
            aria-label={t('chat.composer.quoteChips')}
            className="flex flex-col gap-1 px-1.5 pt-1.5 pb-0 border-b border-border/40"
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

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
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
