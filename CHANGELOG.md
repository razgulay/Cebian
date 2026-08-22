# 更新日志 / Changelog

本文件记录 Cebian 的所有重要变更。
All notable changes to Cebian are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

约定 / Conventions

- 所有新条目先写入 `## [Unreleased]`，发版时再整体落成版本节。
- 已发布的版本节不可修改。
- 每个小节正文先列中文、后列英文；来自 issue 的变更附 `(#编号)`。

- New entries go under `## [Unreleased]` first; they are promoted to a version section at release time.
- Released version sections are immutable.
- Each section lists Chinese bullets first, then English bullets; issue-driven changes link `(#number)`.

## [Unreleased]

### 新增 / Added

- 聊天渲染支持 LaTeX 公式：MarkdownRenderer 接入 `remark-math` + KaTeX（`katex/dist/katex-swap.min.css`），`$…$` 行内公式直接渲染为 KaTeX HTML（不破坏文本基线，带 `math math-inline align-middle` 包装），`$$…$$` 块级公式进入新的 `MathBlock` 容器（与 `CodeBlock` 同款边框 / header 风格，header 标签为 i18n `common.math` 「Math / 公式 / 公式」，复制按钮按源码 LaTeX 文本复制而非渲染后的字符，长公式在窄视口横向滚动）；KaTeX 配置 `throwOnError: false` + `strict: 'ignore'`，单条错误公式降级为 KaTeX 自带的 `katex-error` 红色 span 而不抛错（避免坏公式把整条 AI 回复气泡炸掉）。KaTeX woff2 字体通过 CSS `@font-face` 由 Vite 自动搬到输出 bundle（`katex-swap` 用 `font-display: swap`，字体下载期间用 fallback 字体可见，不会出现 FOIT 空白）。不再使用 `rehype-katex`（其渲染后 LaTeX 源码已丢失，没法支持复制源码），改成自定义渲染路径以保留源码
- Chat rendering now supports LaTeX formulas: `MarkdownRenderer` wires in `remark-math` + KaTeX (via `katex/dist/katex-swap.min.css`). Inline `$…$` math renders directly as KaTeX HTML (wrapped in `math math-inline align-middle` so the surrounding text baseline stays stable), and block `$$…$$` math routes to a new `MathBlock` container (same border / header pattern as `CodeBlock`, header label is the i18n `common.math` key — "Math" / "公式" / "公式", copy button copies the original LaTeX source, not the rendered glyphs, and wide equations horizontally scroll on narrow viewports). KaTeX is configured with `throwOnError: false` + `strict: 'ignore'` so a single malformed expression degrades to KaTeX's built-in `katex-error` red span instead of throwing — one bad formula no longer blows up the whole AI bubble. KaTeX woff2 fonts travel with the CSS via Vite's automatic asset handling; the `swap` variant uses `font-display: swap` so a fallback font shows during the brief font download window (no FOIT flash). `rehype-katex` is no longer used (its renderer discards the LaTeX source, which we need for the copy button) and was removed from `package.json` — we render KaTeX ourselves in a custom path that preserves the source string

- MCP 服务器卡片支持拖动排序：Settings → MCP 和 sidebar drawer 两处的卡片都新增了 grip 拖把手（仅把手接收 `useSortable` 的 pointer/keyboard 监听器，开关 / 编辑 / 删除按钮不会误触发拖动）；按住把手拖动即可调整顺序，松手后写入持久化存储并通过 `useStorageItem` 的 watch 回调推回 UI，刷新页面后顺序保持；同样支持键盘操作（Tab 聚焦把手 → Space 抓起 → 方向键移动 → Space 落下 / Escape 取消），reorder 不修改 `updatedAt`，因为记录本身没变

- 新增跨 context phase tracer 用于 send→reply 流水线的临时性能诊断：新增 `lib/debug/trace.ts` 暴露 `startTrace(source, sessionId, initialT0?)`，所有 marker 形状统一为 `{ t0, deltaMs, ...extra, sessionId }`，按 `t0`+`deltaMs` 即可重建 timeline。`performance.now()` 跨 renderer ↔ SW 的 origin 不同，因此 renderer 在 `chat:t0` 时捕获锚点并通过 IPC `prompt.t0` 透传给 BG，BG 与 hook 各自以同锚点建 handle 让 Δt 跨 context 可比。`initialT0 === undefined` 严格区分「未传」与「传 0」，mark() 内部从 `extra` 里剥掉 `t0`/`deltaMs` 防止 caller 误覆盖。覆盖阶段：`ui:chat:t0`（按下 Enter）/ `hook:recv_agent_start` / `hook:first_token`（用户感知 TTFB）/ `bg:prompt_received` / `bg:agent_ready` / `bg:prompt_composed` / `bg:system_prompt` / `bg:compaction` / `bg:agent_dispatched` / `bg:agent_start` / `bg:first_token`（模型 TTFB）/ `bg:token_n`（每 10 token 一次）/ `bg:message_end` / `bg:agent_end_pre_sync` / `bg:agent_end_post_sync` / `bg:title_gen_start` / `bg:title_gen_done`。每条 teardown 路径（`agent_end` / `cancel()` running-idle / `destroySession` / `commitCompactionCancel` / compaction-cancelled / 双 liveness guard）都通过 `releaseTrace(sessionId)` 主动释放 `pendingTraces` / `firstTokenSeen` / `tokenCounts` 三个临时表，避免 per-session Map/Set 永久占位。开关：Settings → About → Debug log 开启后才会落 IDB，UI 端可开 Live log 实时查看

- MCP server cards now support drag-to-reorder: both Settings → MCP and the sidebar drawer render each card with a new grip handle on the left as the drag activator (only the handle receives `useSortable` pointer/keyboard listeners, so the toggle / edit / delete buttons never accidentally start a drag); press and drag the grip to reorder, drop writes to persistent storage and the change flows back through `useStorageItem`'s watch callback, order survives reload; keyboard reorder works too (Tab to grip → Space to pick up → Arrow keys to move → Space to drop / Escape to cancel), reorder does NOT bump `updatedAt` since the records themselves are unchanged
- Added a cross-context phase tracer for temporary performance diagnosis of the send→reply pipeline: new `lib/debug/trace.ts` exposes `startTrace(source, sessionId, initialT0?)`; every marker has the uniform shape `{ t0, deltaMs, ...extra, sessionId }`, sortable on `t0`+`deltaMs` to reconstruct the timeline. Because `performance.now()` has different origins across renderer ↔ SW, the renderer captures the anchor at `chat:t0` and ships it through the IPC `prompt.t0` field, then BG and hook each create their own handle with that same anchor so Δt is comparable across contexts. `initialT0 === undefined` strictly distinguishes "not passed" from "passed 0"; `mark()` strips `t0`/`deltaMs` from `extra` to prevent caller tampering. Phases covered: `ui:chat:t0` (Enter pressed) / `hook:recv_agent_start` / `hook:first_token` (user-perceived TTFB) / `bg:prompt_received` / `bg:agent_ready` / `bg:prompt_composed` / `bg:system_prompt` / `bg:compaction` / `bg:agent_dispatched` / `bg:agent_start` / `bg:first_token` (model TTFB) / `bg:token_n` (every 10 tokens) / `bg:message_end` / `bg:agent_end_pre_sync` / `bg:agent_end_post_sync` / `bg:title_gen_start` / `bg:title_gen_done`. Every teardown path (`agent_end` / `cancel()` running-idle / `destroySession` / `commitCompactionCancel` / compaction-cancelled / both liveness guards) calls `releaseTrace(sessionId)` to actively evict the per-session `pendingTraces` / `firstTokenSeen` / `tokenCounts` and prevent permanent placeholder growth. Toggled by Settings → About → Debug log; the Live log view streams markers in real time when the dialog is open

### 变更 / Changed

- 顶部 Header 中打开侧边栏的按钮图标由 `History`（时钟）改为 `PanelLeft`，tooltip 从「History」改为「Sidebar」/「侧边栏」/「側邊欄」，与实际包含 Collections / MCP / Memory / History 的抽屉面板语义一致
- 侧边栏 History 默认只展开「Pinned」与「Today」两个分组，「Previous 7 days / 30 days / 更早」保持折叠，需要时点 header 才展开；默认列表缩短，避免一打开就一长串
- 修复「输入消息后用户气泡不锁定在视口顶部、AI 回复滚动把人问题顶走」的 bug：`useStickToBottom.scrollToUserPrompt` 一直通过 `[data-user-message="last"]` 选 DOM 节点，但 `UserMessageBubble` 从未给最后一个 user 消息挂这个属性，导致 snap 静默 no-op；现在 chat 页传 `isLast={idx === lastUserMsgIndex}` 给 `UserMessageBubble`，仅最新一条 user 消息节点带这个标记，hook 重新生效——Enter 后气泡立刻位于视口顶部 16px 处，AI 流式输出在其下方生成，用户按自己节奏手动滚动
- MCP 设置页的 server card 进一步瘦身：badge transport 只保留协议后缀（`STREAMABLE-HTTP` → `HTTP`，`STDIO` / `SSE` 不变），去掉 disabled 时多出来的「Disabled」小 badge，去掉 server URL 那行（要看 / 改 URL 点编辑按钮进表单即可），同时直接干掉 transport badge——`streamable-http` / `stdio` / `sse` 这一列在 dashboard / history 等场景通常由 agent 状态点 + 协议本身推断，对 setting 列表是冗余信息
- 聊天区消息字重从 normal (400) 提到 medium (500)：user 气泡 (UserMessageBubble) 和 AI 回复正文 (AgentMessage) 的 `text-[0.9rem]` 都加上 `font-medium`，Geist 500 比 Geist 400 厚重一档，长消息读起来不再发"mỏng"，更接近 Copilot / Claude.ai 的字感
- 斜杠命令（如 `/english`）的展开内容不再在气泡里铺满整段文本：气泡上方现在渲染一个紧凑 chip（Zap 图标 + `/{name}` 标签 + 琥珀色描边），气泡本身只显示用户在命令后实际输入的文字；mention chip（`@prompt` / `@skill`）在 one-shot 提及时走同一套路径。**Pin 指令（`pinned="true"`）跳过气泡上的 chip**——pin 已经在底部的 composer chip 条可见，每条气泡再重复一次只是污染聊天历史；模型仍按原样接收完整的展开指令块
- 会话列表里的标题不再只是首条消息的前 50 个字符（slash 命令展开后那一行经常是 `[DIRECTIVE — ...]` 字面块，做标题很难看）：第一个 assistant 消息落地后 background 会异步调一次 LLM（用当前会话正在用的模型 + 凭证），按 GPT/Claude 风格生成 ≤40 字符的 topic-name 标题；标题生成失败 / 取消 / 用户在中途手动改过名，原 heuristic 标题保留不动（不会被 LLM 覆盖）；pre-feature / 备份恢复的会话不重命名
- 聊天输入框（ChatInput 的 `<textarea>`）加上 `spellCheck={false}`：之前用户用浏览器默认字典里没有的语言（如越南语）打字，每个字都被画上红色波浪线（拼写错误标记），看起来像出错；chat composer 是 prompt 容器，浏览器原生的拼写检查在这里没有意义，关掉之后非英文输入也不再被误标记
- Knowledge (RAG) 设置纳入备份体系：`ragSettings`（连接串 / embedder / rerank 配置）已注册到 `BACKUP_REGISTRY`，敏感字段（`neonConnectionString` / `embedderApiKey` / `rerankApiKey`）走 `splitSecret` 抽到 credentials.json（非加密导出时也只放在加密层），safe 副本里把对应字段清空再写回 config.json；`ragCollections` 同样以 settings 分类纳入备份，merge 恢复时按 collection 名补缺（本地全保留、备份里本地没有的补入），safe 部分不含密钥所以两种模式都不会泄露
- AI 流式输出末尾的等待指示器从橙色脉冲方块改成 Copilot 风格双圆点轨道旋转 spinner：两个直径 9px（`r=4.5`，比最初 3px 草案大 3 倍）的填充圆点（`fill=currentColor`，无 stroke）对称放在 24×24 SVG 中心左右各 6.5px 处（`cx=5.5` / `cx=18.5`，`cy=12`），整组 `<g>` 施加 `animate-spin`（1.2s/圈）做 **orbital rotation**——两个圆点保持自身朝向不变、围绕 SVG 中心做轨道运动，而不是各自绕轴自转。轨道直径 13px > disc 直径 9px 所以无论转到哪个角度两个圆点都互不遮挡。DOM wrapper 从 `w-4 h-4` 升到 `w-6 h-6`（24×24）以容纳大圆点，`align-middle` 与正文 x-height 对齐不变；wrapper 加 `opacity-70` 让圆点比纯 `text-primary` 柔和一档，避免在长流式输出中过于抢眼。pulse 节奏对不齐 token 落地速度的问题也顺带解决

- The Header's sidebar-toggle button icon changed from `History` (clock glyph) to `PanelLeft`, and its tooltip changed from "History" to "Sidebar" / "侧边栏" / "側邊欄", matching the drawer panel that actually contains Collections / MCP / Memory / History
- Sidebar History now expands only the "Pinned" and "Today" groups by default; "Previous 7 days / 30 days / Older" stay collapsed and only reveal on header click — the list opens to a tighter, more glanceable view
- Fixed the "user bubble not pinned at viewport top on send" regression — `useStickToBottom.scrollToUserPrompt` queries `[data-user-message="last"]` to snap the latest prompt to the top, but `UserMessageBubble` never attached that attribute, so the snap silently no-op'd and the AI stream scrolled the question off-screen. The chat page now passes `isLast={idx === lastUserMsgIndex}`, only the newest user message carries the marker, and the snap works as designed: on Enter the bubble jumps to 16px from the viewport top, AI text streams below, and the user scrolls at their own pace
- MCP server cards in Settings are leaner: the transport badge now only shows the protocol suffix (`STREAMABLE-HTTP` → `HTTP`; `STDIO` / `SSE` unchanged), the redundant "Disabled" pill next to the toggle is gone, and the per-card URL line is removed (the Edit form still surfaces the URL for inspection and changes). The transport badge itself is then dropped entirely — the connection state is already surfaced by the status dot and toggle, so the protocol label was just noise in a Settings list
- Chat message weight bumped from normal (400) to medium (500): both the user bubble (`UserMessageBubble`) and the agent body (`AgentMessage`) add `font-medium` to their `text-[0.9rem]` container. Geist 500 reads visibly heavier than 400, so longer replies no longer feel thin — closer to the body weight in Copilot / Claude.ai
- Slash commands (e.g. `/english`) no longer dump the full expanded body into the message bubble; the directive now renders as a compact chip above the bubble (Zap icon + `/{name}` label + amber outline), while the bubble itself shows only the words the user actually typed after the command. Mention chips (`@prompt` / `@skill`) follow the same path on one-shot mentions. **Pinned directives (`pinned="true"`) skip the bubble chip** — the pin is already visible in the composer strip at the bottom of the panel and would just clutter chat history if repeated on every bubble. The model still receives the full expanded directive block as before
- Sidebar session titles no longer come from `text.slice(0, 50)` on the first user message — that line is often a literal `[DIRECTIVE — ATTACHED COMMAND: "..."]` block after slash-command expansion, which makes for an unreadable title. After the first assistant message lands, the background fires a one-shot LLM call (using the session's active model + credentials, no new setting) to produce a topic-name title (≤40 chars, ChatGPT/Claude style) and broadcasts `session_changed` so the row updates live. On LLM failure / abort / mid-flight manual rename the original heuristic title is kept (the LLM result is never written). Pre-feature / restored-from-backup sessions aren't renamed — only brand-new sessions created in this SW lifetime
- Chat composer textarea (`<textarea>` in ChatInput) now sets `spellCheck={false}`: previously, typing in a language not covered by the browser's default dictionary (e.g. Vietnamese) painted a red wavy underline under every word as a misspelling marker, which read as an error. The chat composer is a prompt container — browser-native spell-check has no role here — so disabling it stops the misleading underlines on non-English input
- Knowledge (RAG) settings are now part of the backup: `ragSettings` (connection string / embedder / rerank config) is registered in `BACKUP_REGISTRY`, sensitive fields (`neonConnectionString` / `embedderApiKey` / `rerankApiKey`) flow through `splitSecret` into `credentials.json` (only the encrypted tier carries them in unencrypted exports), the safe copy clears those fields before writing to `config.json`. `ragCollections` is similarly covered under the settings class; merge restore applies `fillMissingById` (keep every local collection, add anything from the backup that is missing locally) and no keys are involved, so neither mode ever leaks secrets
- The trailing "still streaming" indicator at the end of an AI reply changed from an orange pulsing square to a Copilot-style two-disc orbital spinner: two 9px filled discs (`r=4.5`, 3× the initial 3px draft; `fill=currentColor`, no stroke) symmetrically placed 6.5px to either side of the 24×24 SVG center (`cx=5.5` / `cx=18.5`, `cy=12`), wrapped in a single `<g>` that applies `animate-spin` (1.2s per cycle) for **orbital rotation** — the discs keep their orientation and travel around the SVG center together, rather than each self-rotating around its own axis. The 13px orbit diameter exceeds the 9px disc diameter, so the two never occlude each other at any angle. DOM wrapper grew from `w-4 h-4` (16×16) to `w-6 h-6` (24×24) to fit the larger discs; `align-middle` baseline alignment to body x-height is unchanged; wrapper carries `opacity-70` to soften the discs against long streams. The previous `animate-pulse` opacity rhythm also no longer competes visually with the token-by-token landing rate
- Header 左侧两个按钮调换顺序：先 `PanelLeft`（打开侧边栏），再 `SquarePen`（新建会话）；原顺序为「新建会话 → 打开侧边栏」，与常用工具栏「先导航、再新建」的阅读顺序相反
- Reordered the two leading buttons in the header: `PanelLeft` (open sidebar) now comes first, followed by `SquarePen` (new chat). The previous order (new chat → open sidebar) ran against the natural "navigate first, create second" reading order of most toolbars
- 思考块（`ThinkingBlock`）不再随流式状态自动展开：之前 `isOpen = isLive || manualOpen`，agent 还在 thinking 时强制展开、流结束后再自动收起；改为 `isOpen = manualOpen` 后块默认折叠，header 只显示 `Thinking...` / `Thinking Process` 标签与未旋转的 chevron，用户点击 header 才展开；流结束时 `useEffect` 仍会把 `manualOpen` 拉回 `false`，避免用户中途手动展开后留下打开状态
- The thinking block (`ThinkingBlock`) no longer auto-expands with streaming state: it used to compute `isOpen = isLive || manualOpen`, forcing the body open while the model was thinking and auto-collapsing it on completion. It now computes `isOpen = manualOpen`, so the body stays collapsed by default and only the header (label + non-rotated chevron) is visible — clicking the header opens it. The post-stream `useEffect` still resets `manualOpen` to `false` so a mid-stream manual expand does not survive into the finished message
- 聊天字号滑块范围从 14–15 px（步长 0.1）调整为 15–18 px（步长 0.5）：slider 现在停靠 7 档（15 / 15.5 / 16 / 16.5 / 17 / 17.5 / 18），默认值 15 px。已有用户的旧 `local:chatFontSize` 数值会通过 `clampChatFontSize` 截到新范围下限 15；旧的离散 `xs` / `sm` / `md` / `lg` / `xl` 字符串键通过 `LEGACY_FONT_SIZE_PX` 表按相对大小映射到新范围（15 / 15.5 / 16 / 16.5 / 17），保留用户原本「小字号 / 大字号」偏好，不会全部压到下限
- 固定 Prompt / Skill 现在跨会话全局生效：固定后新开对话仍保持固定，取消后所有对话同步取消；文件夹 / 文件 / RAG 固定仍仅限当前会话。状态写入 `local:composerPinnedContexts`（备份以 `settings` 分类纳入），通过 `useStorageItem` 的 `watch` 实时跨侧边栏同步
- 引用（Quote）现在改成跟 mention chip 同款 inline directive 形状：bubble 上方渲染 quote chip（Quote icon + 第一段引用预览截断 48 字符，zinc 中性色调区别于 slash 琥珀 / prompt 紫 / skill 蓝），bubble body 跟 mention / slash 一样只显示用户敲的字（通过 `stripDirectives` 自动剥掉 quote directive 块）；LLM 仍然通过 directive body 收到完整引用文本。引用统一走 directive 解析路径后，原本的「slash + quote 重复」、「mention + quote 重复」两个 bug 在结构上就消失了：quote 块被 `rewriteLastUserMessage` 的 `beforeUser` 段保留为单次出现，`stripDirectives` 再从 bubble body 里干净地剥掉。`rewriteLastUserMessage.DIRECTIVE_OPEN_RE` 也加上 `QUOTE` 进 alternation，避免 quote-only 路径下 bubble 把整段 quote 文本 wipe 掉。`name` 字段塞的是引用预览（不是空串），但 directive 的 `"..."` delimiter 不允许嵌入 `"`，ChatInput 在塞 name 前把 `"` 替换成全角引号 `＂`，wire format 仍可解析、bubble chip 标签读起来也仍像引用。多 chip 合并时 name 字段追加 `· N excerpts` count 后缀（preview 长度按 48 - 后缀长度预算）；count 在 Message.tsx 里拆出来渲染成独立的非 truncate span，确保 preview 被截断时 count 仍 visible。Quote / 附件按钮（pick element、pick region、screenshot、file upload、record）点击后通过 commit 后 `useEffect` 把键盘焦点送回输入框（attachments 数量增长 / quoteChips 数量增长时 trigger，commit 后 DOM 已稳定、不会与其他 focus trap 赛跑；同步路径上的 focus 经常被后续 commit 偷走）；stream 开始时 attachments 被清零（count 减少）不会误触发，mention chip 走 setMentions 不受影响，popover「连选多个」流程保持原有行为
- Chat font-size slider range moved from 14–15 px (step 0.1) to 15–18 px (step 0.5): the slider now snaps to seven discrete stops (15 / 15.5 / 16 / 16.5 / 17 / 17.5 / 18), default 15 px. Existing users with a numeric `local:chatFontSize` in the old range are clamped to the new minimum (15) by `clampChatFontSize`; legacy string keys (`xs` / `sm` / `md` / `lg` / `xl`) are remapped through `LEGACY_FONT_SIZE_PX` to 15 / 15.5 / 16 / 16.5 / 17 in the new range so the user's relative "smaller / larger" intent survives the migration rather than everyone landing on the minimum
- Pinned Prompt / Skill chips are now global across all chats: pinning one in any session keeps it pinned in every other / future session; unpinning drops it everywhere at once. Folder / file / RAG pins remain session-scoped. The pin membership is persisted in `local:composerPinnedContexts` (registered in `BACKUP_REGISTRY` under the `settings` class), and the change syncs in real time across already-open sidepanels via `useStorageItem`'s `watch` subscription
- Quoted text now follows the same inline-directive shape as mention chips: the bubble renders a quote chip above (Quote icon + 48-char preview of the first quote's body, neutral zinc tone distinct from slash-command amber / prompt purple / skill blue), and the bubble body shows only the user's typed words — `stripDirectives` peels the quote directive block off the same way it handles PROMPT / SKILL / COMMAND. The LLM still receives the full quote verbatim via the directive body. Unifying quote with the directive pipeline erases two prior bugs structurally — the "slash + quote duplicates" and "mention + quote duplicates" regressions both stop existing because there is no longer a raw-prefix splice path to diverge from the directive path. `rewriteLastUserMessage.DIRECTIVE_OPEN_RE` now also matches `QUOTE` so quote-only sends preserve the directive on the bubble (without that, `DIRECTIVE_OPEN_RE.test(text)` would miss it and the whole quote block would get clobbered to `displayText`). The directive `name` slot holds the quote preview (not an empty string); since the header regex uses `"..."` with a `[^"]*` capture, ChatInput substitutes raw `"` for the fullwidth variant `＂` so the wire format always parses while the chip label still reads as a quote. When multiple quote chips are stacked, the name field appends a `· N excerpts` count suffix and the preview budget shrinks accordingly. The count is split out in `Message.tsx` into a separate non-truncating span so it stays visible even when the preview is truncated to the chip's `truncate max-w-24` slot. After clicking the Quote / attach buttons (pick element, pick region, screenshot, file upload, record), keyboard focus is restored to the textarea via a post-commit `useEffect` that triggers when the `attachments` array length increases or the `quoteChips` array length increases. The post-commit timing avoids the race against the focus traps and React commits that used to steal a synchronous `textareaRef.focus()` call. The clearing of `attachments` on stream start (count decrease) does not re-trigger, mention chips use `setMentions` so the popover "select multiple" flow is untouched

### 修复 / Fixed

- 自定义 OpenAI-compatible provider 的 Base URL 指向 `http://localhost:<port>` 时发请求被浏览器拦截：`wxt.config.ts` 中 sandbox 与 extension_pages 的 `connect-src` 都只放行 `'self' https: wss: data: blob:`，没有 `http:` 也没有 loopback；任何发到本地代理（如 9router、LM Studio、Ollama）都会被报「Refused to connect because it violates the document's Content Security Policy」。在两条 `connect-src` 末尾追加 `http://localhost:* http://127.0.0.1:*`，仅放行 loopback，不扩大到任意 `http://*`；`http://api.vilao.ai/v1` 等公网 https 端点行为不变
- Fixed custom OpenAI-compatible providers whose Base URL points at `http://localhost:<port>` (e.g. 9router, LM Studio, Ollama) failing with "Refused to connect because it violates the document's Content Security Policy": the `connect-src` directives in both `sandbox` and `extension_pages` policies in `wxt.config.ts` only allowed `'self' https: wss: data: blob:` — no `http:` and no loopback. Appended `http://localhost:* http://127.0.0.1:*` to both `connect-src` directives; the widening is loopback-only (not `http://*`), so public https endpoints like `https://api.vilao.ai/v1` are unaffected
- 修复使用 Exa（或其他 tool）导致聊天气泡上的 Edit 按钮在后续对话中永久消失的 bug：pi-agent-core 的 `Durable payload contains undefined` 断言会递归拦截含有 `undefined` 字段的树操作（如 tool_result 块内某些可选状态）；此时 `syncTail` 会静默失败并卡住 `committedCount` 水位线，后续发送的 user 消息无法落树（无 `entryId`），UI 因此隐藏了编辑入口。现在在消息存盘前通过新增的一道 `omitUndefinedFields` 清理所有内嵌块，确保 `syncTail` 顺畅入库
- 聊天区消息字号原本写死 `text-[0.9rem]`，与 settings 里的字号 slider 失联（`useChatFontSize` 写入 `--chat-font-size`，但消息容器不消费它）；UserMessageBubble 和 AgentMessage 改成 `text-[length:var(--chat-font-size)]`，字号现在随用户偏好变化（与 MarkdownRenderer / ChatInput 已有的用法对齐）
- MarkdownRenderer 中 `<p>` 和 `<li>` 强制 `font-normal` 把外层 AgentMessage 的 `font-medium` 覆盖掉，AI 回复读起来仍像 400；移除该 override，让正文继承父级 medium weight
- Crop region 模式下把选择框拖出视口后再松手，只截到视口内可见那一块（滚下去的部分全丢）：picker 在 mousedown / move / up 里给扩展侧的是文档坐标的 rect，但 `chrome.tabs.captureVisibleTab` 只能拍视口，超出视口的部分被 offscreen canvas 在 `img.width / height` 处 clamp 掉，最终得到的就是「带 visible 字样的一块图」；改成 scroll-and-stitch：扩展侧按视口高度把 rect 切成 N 条，按顺序在 tab 里 `window.scrollTo` 到每条的文档 y、`captureVisibleTab` 拍当前视口、`crop-image` 裁出对应矩形，再通过新的 `composite-vertical` IPC 在 offscreen 里纵向粘成一张图，最后把 tab 滚回原位；这样既不依赖 `captureBeyondViewport`（Chrome 在 clip 越过 `documentElement.scrollHeight` 时会用当前视口重复填充缺失区域，导致截图里首屏被叠 2-3 次），也不需要 CDP attach/detach，调试器 banner 不会出现
- Crop region 模式下把拖出的矩形 clamp 到 `document.documentElement.scrollWidth/scrollHeight` 内再送给截图管线：scroll-and-stitch 的每条 strip 的 CSS 起点和高度都不能超过文档边界，否则 `window.scrollTo` 会顶到 maxScrollY、`captureVisibleTab` 拿到的是边界外的视口内容
- Crop region 模式下把鼠标贴近视口边缘时的自动滚动太慢（之前是固定 ±10px / RAF，约 600 px/s，900 高的视口得拖 1.5 秒才能滚一屏）：EDGE 缓冲带从 30 加宽到 50，并把单帧位移从常数改成随深度线性 ramp（贴边时 MAX 60 px/帧 ≈ 3600 px/s，刚进缓冲带时 MIN 14 px/帧 ≈ 840 px/s），既能甩手快速滚到目标段落，也能控制一下慢慢选
- Crop region picker 的 `edgeSpeed` 在视口死区（鼠标不在任何边缘缓冲带内）仍然返回非零值——`ramp = MIN + (MAX-MIN)*factor` 永远 ≥ MIN，所以 `if (ramp === 0) return 0` 永远不成立，结果死区里以约 840 px/s 持续漂向视口右下；改成先看 `factor === 0`（真死区）就立即返回 0，否则才走 ramp + sign 计算
- Crop region picker 的 `edgeSpeed` 在所有边缘都返回正数，导致左/上边缘自动滚根本滚不动（顶/左缓冲带里的鼠标被「钉死」在该位置）：`window.scrollBy(dx, dy)` 的正方向是下/右，左/上边缘必须返回负值才行。现在分两个分支分别设 `sign = -1`（顶/左）和 `+1`（底/右），最后 `return sign * Math.min(MAX, ramp)`
- Crop region picker 撞上 Chrome 的 `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota（同一 tab 限速 2 次/秒）：scroll-and-stitch 每条 strip 调一次 `chrome.tabs.captureVisibleTab`，3+ 条的高 rect 不节流就会爆 quota。在循环开头加 550ms 最小间隔节流（`lastCaptureAt > 0` 时若 `Date.now() - lastCaptureAt < 550` 则 await 到满再继续），第一条不延迟；5 条 strip 现在大约 5-6 秒完成
- Crop region picker 的 `chrome.tabs.captureVisibleTab(tabId, ...)` 之前传错了参数：MV3 signature 是 `(windowId?, options?)` 不是 `(tabId?, options?)`，传 tabId 进去 Chrome 当成 windowId 去找一个不存在的 window → silent failure → 弹「Failed to capture region」。改成不传第一个参数（picker 在用户当前 active tab 里，默认就是 current window 的 active tab）
- Crop region picker 出错时 toast 现在直接显示根因：把 picker 上抛的 `message`（限 200 字）放进 toast 的 `description`，用户能看到具体原因——「No strips produced for region capture」「Crop failed: ...」之类——而不是笼统的「Failed to capture region」；完整信息仍落到 console 方便 debug
- AI 回复气泡在 LLM 流式输出结束时仍会小抖一下（cursor ~16px）：之前 `isStreaming: true → false` 那一帧，光标 `<span>`（16px 高）从 DOM 卸载，同时 `<MessageMetaRow>` 挂载到下方，两个独立的 reflow 同时发生在同一帧，叠加后看上去是 body chat 闪一下。曾尝试把光标与 meta-row 都改成「always-render + 可见性由 `isStreaming` 决定」彻底消 dựt，但流结束后尾部光标槽（16px）+ `space-y-3` 间距（0.75rem）+ meta-row `mt-2`（0.5rem）会在内容与元信息之间留下约 36px 空行，视觉上更糟。最终方案：meta-row 槽始终渲染 + `isStreaming` 时整块 `invisible`，消除 ~20-24px 的元信息挂载抖动；cursor 退回 `{isStreaming && <span .../>}` 条件挂载，流结束时会留下 ~16px 的小抖动，但比原始 ~36-40px 复合 dựt 小 ~60%，且不再引入空行
- AI 回复光标在流结束后继续闪橙点（CSS cascade 冲突）：cursor `<span>` 同时挂 `animate-pulse`（keyframes 把 opacity 拉到 1/0.5）和 `opacity-0`（要把它藏掉），CSS 动画声明在 cascade 里高于普通 author declarations，keyframes 的 opacity:1 一直盖住类的 opacity:0，光标在流结束后仍然可见且继续脉冲。最终方案：整个 cursor `<span>` 按 `{isStreaming && <span .../>}` 条件挂载——流结束就把 span 从 DOM 卸载，根本不会有 `animate-pulse` 与 `opacity-0` 共存的状态，cascade 冲突无从发生；也不需要 `transition-opacity` 做平滑淡出，cursor 直接消失

- 修复部分 provider/model（如 MiniMax M3、DeepSeek distill 等）把 reasoning 以原始 `<think>...</think>` inline 文本塞进 text content block 而非走 provider-channel 的 `{type:'thinking'}` 结构，导致 chat bubble 直接看到 `<think>...` 字面 + 推理 body 被铺在正文里：现在 `getAssistantText` 跑一遍 `stripThinkTags` 把 inline tag 与 body 从文本里剥掉，新增 `getLeakedThinking` 把被剥掉的 reasoning 抽出来，chat 页按序先渲染 provider-channel thinking、再渲染 leaked reasoning（每个一段独立的 `<ThinkingBlock>`），最后才渲染清洗后的正文；`getAssistantText` 复用了 title-generation 已经在用的同一个 `stripThinkTags`（fast-path idempotent，clean text 第二次调用直接 short-circuit），session-manager 路径与 DOM sub-agent 路径无回归——后者反而把「只 emit thinking 不 emit answer」从误判成功改成正确重试
- Fixed a chat-bubble rendering leak where providers/models that emit reasoning as raw inline `<think>...</think>` text (instead of a structured `{type:'thinking'}` content block — affects MiniMax M3, DeepSeek-distill, and similar) dumped the literal tag plus reasoning body into the visible bubble. `getAssistantText` now runs the joined text through `stripThinkTags` (already used by title generation, idempotent via fast-path on clean text) so the visible bubble is always clean, and a new `getLeakedThinking` returns the stripped-out reasoning bodies in source order. The chat page renders provider-channel thinking blocks first, then one `<ThinkingBlock>` per leaked reasoning entry, then the cleaned text — so leaked reasoning is collapsible just like structured thinking. No regression at the other two `getAssistantText` call sites: title generation already strips internally (now strips twice on already-clean text but the parser short-circuits); the DOM sub-agent runner now correctly treats "only thinking emitted, no answer" as a retry-worthy failure rather than a successful empty result
- Chat message size was hardcoded to `text-[0.9rem]`, ignoring the size slider in settings (`useChatFontSize` writes `--chat-font-size` but the message containers never consumed it). `UserMessageBubble` and `AgentMessage` now use `text-[length:var(--chat-font-size)]`, so message text scales with the user's preference — matching how MarkdownRenderer and ChatInput already worked
- `MarkdownRenderer`'s `<p>` and `<li>` set `font-normal` unconditionally, overriding the agent body's `font-medium`. Removed the override so reply text inherits medium weight from the parent (otherwise the previous weight bump only affected the user bubble)
- Crop-region picker used `chrome.tabs.captureVisibleTab` after dragging outside the viewport, so anything past the fold got clamped at `img.width / height` in the offscreen canvas and the cropped image was just the visible portion. Now does scroll-and-stitch: the extension splits the document-coordinate rect into viewport-sized strips, calls `window.scrollTo` + `captureVisibleTab` for each strip in turn, crops the strip via the existing `crop-image` offscreen helper, and glues the strips together with a new `composite-vertical` IPC handler in the offscreen document — final tab scroll position is restored in `finally`. No CDP, no `captureBeyondViewport` quirks (which padded beyond-`scrollHeight` areas with repeated viewport content — a tall capture of a short page would show the page top stacked two or three times)
- Crop-region picker clamped the dragged rectangle to `document.documentElement.scrollWidth/scrollHeight` before sending it to the capture pipeline. Each strip in the scroll-and-stitch loop is anchored to its CSS `y` and the strip's `height` must fit within the document; clamping at the picker level keeps `window.scrollTo` from hitting `maxScrollY` and feeding the next `captureVisibleTab` viewport content from outside the document
- Crop-region auto-scroll at viewport edges was too slow. Widened the edge zone from 30 to 50 px and replaced the constant ±10 px/frame (~600 px/s) with a linear ramp over cursor depth: 14 px/frame at the zone boundary (~840 px/s) up to 60 px/frame right at the edge (~3600 px/s). Flicking past the edge rapidly scrolls large stretches; easing in from the inside still gives precise control
- Crop-region picker's `edgeSpeed` kept returning a non-zero value inside the viewport dead zone (cursor not in any edge buffer). The previous `ramp = MIN + (MAX-MIN)*factor` is always ≥ MIN, so `if (ramp === 0) return 0` never fired — the dead zone kept drifting toward bottom-right at ~840 px/s. Now checks `factor === 0` first (the real dead-zone predicate) and returns 0 immediately when the cursor is well inside the viewport
- Crop-region picker's `edgeSpeed` returned a positive value for every edge, so dragging toward the top/left edge scrolled the page in the *wrong* direction (down/right) and the cursor kept getting pushed out of the buffer zone — auto-scroll on those edges was effectively dead. Now branches `sign = -1` (top/left) and `+1` (bottom/right) and returns `sign * Math.min(MAX, ramp)` so each edge scrolls toward the page content
- Crop-region picker was hitting Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota (same tab capped at 2 captures/sec): scroll-and-stitch calls `chrome.tabs.captureVisibleTab` once per strip, so a 3+ strip rect blew the quota. Added a 550ms minimum interval at the top of each loop iteration (`await 550 - (Date.now() - lastCaptureAt)` when `lastCaptureAt > 0`); the first strip fires immediately. A 5-strip region now takes ~5-6 seconds end-to-end
- Crop-region picker was calling `chrome.tabs.captureVisibleTab(tabId, …)` with the tab id as the first argument — Chrome's MV3 signature is `(windowId?, options?)`, so passing `tabId` made it look for a window that didn't exist and silently failed (toast: "Failed to capture region"). Drop the first argument; the picker runs in the user's active tab, so omitting it captures the right viewport
- Crop-region picker error toasts now surface the underlying cause in the description: the picker's `message` (clamped to 200 chars) lands in the toast's `description`, so the user sees *why* it failed ("No strips produced for region capture", "Crop failed: …", etc.) instead of a bare "Failed to capture region". The full text still lands in the console for debug
- Streaming assistant bubble still has a small jump on stream end (cursor ~16px): on the `isStreaming: true → false` frame, the cursor `<span>` (16px tall) unmounted at the same instant `<MessageMetaRow>` mounted below — two unrelated reflows firing in the same frame read as a body jump. An earlier attempt tried making both unconditional (cursor always in the trailing slot via `opacity-0`, meta-row wrapper always rendered via `invisible`) to eliminate the jump entirely, but post-stream the cursor slot (16px) + `space-y-3` margin (0.75rem) + `mt-2` on the meta-row (0.5rem) left ~36px of empty space between the content and the action row — visually worse than the original jump. Final fix: meta-row wrapper stays always-rendered with `invisible` during streaming (eliminating the ~20-24px action-row jump), but the cursor reverts to `{isStreaming && <span .../>}` — stream end still produces a ~16px reflow, but it's ~60% smaller than the original ~36-40px combined jump and no longer leaves any empty space
- Streaming cursor left a permanently visible pulsing orange dot after the stream ended: the cursor `<span>` carried both `animate-pulse` (keyframes set opacity to 1/0.5) and `opacity-0` (intended to hide it). CSS animation declarations outrank normal author declarations in the cascade, so the keyframe opacity kept overriding the class opacity and the cursor stayed visible (and pulsing) after the stream. The cursor `<span>` is now conditionally mounted via `{isStreaming && <span .../>}` — there is no longer any state where `animate-pulse` and `opacity-0` coexist, so the cascade conflict can't fire; the cursor simply unmounts on stream end, and no `transition-opacity` fade is needed
- 在 sidepanel 焦点下按 ESC 现在也能取消 Crop region（裁剪区）picker，与 click-pick 行为对齐：`ChatInput` 中负责 keydown 的 `useEffect` 之前只在 `isPicking` 为 true 时挂 document keydown 监听，`isPickingRegion` 未覆盖，导致用户在 sidepanel 里按 ESC 关不掉裁剪；early-return 改为 `!isPicking && !isPickingRegion` 时直接返回，两个状态都加进依赖数组，共用同一个 `cancelElementPicker()` 收尾（`cancelElementPicker` 内部 `currentCleanup?.()` 是幂等 no-op，快速连按 ESC 也不会重复触发）
- Pressing ESC while the sidepanel has focus now also cancels the crop-region picker, matching the existing click-pick behavior: the `useEffect` in `ChatInput` that listens for document keydown was previously gated only on `isPicking`, leaving `isPickingRegion` uncovered, so ESC inside the sidepanel had no effect on an active crop picker. The early-return now checks both `isPicking` and `isPickingRegion`, both states are added to the dependency array, and both modes share the same `cancelElementPicker()` teardown (`cancelElementPicker` is `currentCleanup?.()` — an idempotent no-op, so rapid ESC presses don't double-fire). The page-side capture-phase handler in `lib/browser/element-picker.ts` still handles ESC when the page has focus; this change only covers the sidepanel-focus case that previously fell through
- 修复 `pnpm dev` 控制台报 `Refused to connect to ws://localhost:3210/` 及 `[wxt] Failed to connect to dev server`：sandbox 与 extension_pages 的 `connect-src` 只放了 `wss:` 没放 `ws:`，Vite HMR 用的是明文 `ws://`，CSP scheme matcher 按协议逐项匹配，`http://localhost:*` 不覆盖 `ws://`。在两条 `connect-src` 的 loopback 段后追加 `ws://localhost:* ws://127.0.0.1:*`（scheme token `ws:` 同步加上，与 `wss:` 同形状），与现有 `http://localhost:* http://127.0.0.1:*` 同形状、仍仅放行 loopback
- Fixed `pnpm dev` console errors `Refused to connect to ws://localhost:3210/` and `[wxt] Failed to connect to dev server`: the `connect-src` directives in both `sandbox` and `extension_pages` policies in `wxt.config.ts` listed `wss:` but not `ws:`. Vite HMR uses plaintext `ws://`; CSP scheme matchers are protocol-specific, so `http://localhost:*` did not cover `ws://`. Appended `ws://localhost:* ws://127.0.0.1:*` after the existing loopback widening in both `connect-src` directives (the `ws:` scheme token was added next to `wss:`, matching shape) — same loopback-only scope as the existing `http://localhost:* http://127.0.0.1:*`
- 修复 dev 控制台刷屏 60 条 `Loading the font violates "font-src https: data:"`：KaTeX 的 woff2 在 `katex-swap` CSS 里通过 `url(/assets/KaTeX_*.woff2)` 引用，dev 模式下 Vite 把它从 `http://localhost:3210/assets/...` 提供（不在 `https:` 白名单），prod 模式下解析到 `chrome-extension://<id>/assets/...`（扩展自身 origin 也不在 `https:` 白名单，且 `font-src` 没 `'self'`）。`katex-swap` 用 `font-display: swap`，下载期间用 fallback 字体可见，错误未引起用户注意但已经在 prod 静默失败。在 `extension_pages font-src` 末尾追加 `'self' http://localhost:* http://127.0.0.1:*`，dev / prod 同时覆盖；sandbox 页面 `font-src` 已包含 `'self'`，且 sandbox 不加载 bundled tailwind CSS，无需改动
- Fixed 60× console errors `Loading the font violates "font-src https: data:"`: KaTeX's `katex-swap` CSS references woff2 files via `url(/assets/KaTeX_*.woff2)`; in dev Vite serves them from `http://localhost:3210/assets/...` (not in the `https:` allowlist), in prod they resolve to `chrome-extension://<id>/assets/...` (the extension's own origin, also not covered by `https:` and `font-src` had no `'self'`). `katex-swap` uses `font-display: swap` so the fallback font masked the error and users didn't notice, but prod was silently failing. Appended `'self' http://localhost:* http://127.0.0.1:*` to `extension_pages font-src`; both dev and prod now covered. The sandbox `font-src` already includes `'self'` and sandbox pages don't import the bundled tailwind CSS, so no edit there
- 修复 dev / prod 加载 VFS / sidepanel / settings 时报 `Module "buffer" has been externalized for browser compatibility`：根因是 `lib/content/frontmatter.ts` 用的 `front-matter@4.0.2` 透传拉 `js-yaml@3.14.2`，后者 `lib/type/binary.js` 在模块初始化时 `require('buffer').Buffer`，Vite 把 Node `buffer` 在浏览器端 externalize 后整页直接挂掉。换成直接 `yaml@^2.9.0`：默认走 `parseYaml(text, { strict: false })`，遇到 `DUPLICATE_KEY` 这类 yaml@2 严格模式的报错时降级到 `parseDocument(...).toJS()`（last-wins），其它解析错误 / 未知 tag 仍按 front-matter@4 旧行为静默返回空 data；frontmatter 起始符正则同时支持 `---` 与 `= yaml =`，结束符支持 `---` 与 `...`，BOM / CRLF / 空 frontmatter 都覆盖。public API `parseFrontmatter(content): { data, body }` 不变，9 个调用点零改动；同步删除两个零引用的私有 helper `serializeFrontmatter` / `serializeYaml`（[Naming & module API]）。新增 `lib/content/frontmatter.test.ts` 共 11 个 case（BOM / CRLF / 空 / `= yaml =` 起始 / `...` 结束 / 坏 YAML / 重复键 / YAML 1.2 布尔字面量等）。注意 yaml@2 遵循 YAML 1.2：bare `yes` / `no` / `on` / `off` 与 bare ISO-8601 日期（如 `date: 2024-05-15`）都解析为字符串而非布尔 / `Date` 实例，只有显式 `!!timestamp` tag 才会得到 `Date`——全仓 grep 已确认无影响
- Fixed the `Module "buffer" has been externalized for browser compatibility` error that broke VFS / sidepanel / settings pages in dev and prod: root cause was `lib/content/frontmatter.ts` using `front-matter@4.0.2`, which transitively pulls `js-yaml@3.14.2` whose `lib/type/binary.js` does `require('buffer').Buffer` at module-init time — once Vite externalized Node `buffer` for the browser, the whole entry failed to load. Switched to `yaml@^2.9.0` directly: defaults to `parseYaml(text, { strict: false })`, and on `DUPLICATE_KEY`-class errors from yaml@2's strict mode falls back to `parseDocument(...).toJS()` (last-wins); other parse errors / unknown tags still degrade to empty data, matching the old front-matter@4 behavior. The frontmatter opener regex now matches both `---` and `= yaml =`; the closer matches `---` and `...`; BOM / CRLF / empty frontmatter are all covered. The public API `parseFrontmatter(content): { data, body }` is unchanged — all 9 call sites needed no edits. Two dead private helpers (`serializeFrontmatter` / `serializeYaml`, zero repo references — [Naming & module API]) were removed at the same time. Added `lib/content/frontmatter.test.ts` with 11 cases covering BOM / CRLF / empty / `= yaml =` opener / `...` closer / malformed YAML / duplicate keys / YAML 1.2 boolean literals. Note: yaml@2 follows YAML 1.2, so bare `yes` / `no` / `on` / `off` AND bare ISO-8601 dates (e.g. `date: 2024-05-15`) both parse as strings instead of booleans / `Date` instances — only an explicit `!!timestamp` tag yields a `Date`. grep confirmed no in-repo file is affected
- 修复选区 Quote 浮动按钮在侧边栏滚动时跳动 / 滞后的 bug：`SelectionQuoteButton` 在 `window` 的 `scroll` 事件触发时调用 `recompute()`，把选区当前的 viewport rect 写入 `pos`，但 Shadcn Button 默认带 `transition-all`（`transition-property: all; transition-duration: 150ms`），每个 scroll tick 改 `top`/`left` 都被 ease 化，又被下一个 scroll tick 打断，看上去 button 在追着 scroll 而不是贴在选区上。改为：在 `useEffect` 里给 `window` 的 `scroll` 注册 capture-phase listener、`resize` 用默认 phase listener，每个 tick 同步调 `recompute()`，并在 button 的 className 上加 `!transition-colors` override —— `transition-colors` 只 transition color / background-color / border-color 等颜色相关属性，`top` / `left` 不在其中，所以 `top` / `left` snap 在与 scroll 同一帧，无 150 ms ease。Button 渲染也从原本的 React 树内改成 `createPortal(<Button/>, document.body)`，确保 `position: fixed` 不会被 Radix ScrollArea viewport 或其它祖先的 `transform` / `will-change` / `contain` 拉成它的 containing block（之前若有这种 ancestor，button 会被一起滚走）。`onSelectionChange` 同时加 identity gate（`startContainer` / `endContainer` DOM node ref + offset）防 reflow 触发的二次重算。Hard-scroll 把 selection 清掉时 button 仍按旧逻辑隐藏
- Fixed the floating Quote button used to lag or jump while scrolling the sidepanel: every scroll tick re-anchored via `recompute()` and wrote the selection's new viewport rect into `pos`, but `Button`'s default `transition-all` (`transition-property: all; transition-duration: 150ms`) animated each `top`/`left` change, and the next scroll tick kept interrupting the in-flight ease — so the button appeared to chase the scroll rather than track the selection. Now `useEffect` registers a capture-phase `window` `scroll` listener and a default-phase `window` `resize` listener (resize is functionally identical either way — `window` sits at the top of the capture chain and resize doesn't bubble), each tick calls `recompute()` synchronously, and the button's className additionally carries `!transition-colors` (the `!` `important` prefix guarantees it overrides Shadcn's default). `transition-colors` only transitions color-related properties — `top` / `left` are not in the list, so they snap on the same frame as the scroll with no 150 ms ease to interrupt across rapid ticks. The button itself is rendered through `createPortal(..., document.body)` instead of staying inside the React tree, so `position: fixed` is unambiguously viewport-relative and cannot be captured into a containing block by any Radix ScrollArea / Tailwind `transform` / `will-change` / `contain` ancestor that would otherwise make the button scroll along with content. `onSelectionChange` keeps an identity gate (DOM node refs for `startContainer` / `endContainer` + their offsets) so reflow-induced `selectionchange` events short-circuit and don't double-recompute during a scroll burst. Hard scrolls that wipe the selection still hide the button as before
- 修复 `pnpm dev` 控制台报 `Refused to connect to ws://localhost:3210/` 及 `[wxt] Failed to connect to dev server`：sandbox 与 extension_pages 的 `connect-src` 只放了 `wss:` 没放 `ws:`，Vite HMR 用的是明文 `ws://`，CSP scheme matcher 按协议逐项匹配，`http://localhost:*` 不覆盖 `ws://`。在两条 `connect-src` 的 loopback 段后追加 `ws://localhost:* ws://127.0.0.1:*`（scheme token `ws:` 同步加上，与 `wss:` 同形状），与现有 `http://localhost:* http://127.0.0.1:*` 同形状、仍仅放行 loopback
- Fixed `pnpm dev` console errors `Refused to connect to ws://localhost:3210/` and `[wxt] Failed to connect to dev server`: the `connect-src` directives in both sandbox and extension_pages policies in `wxt.config.ts` listed `wss:` but not `ws:`. Vite HMR uses plaintext `ws://`; CSP scheme matchers are protocol-specific, so `http://localhost:*` did not cover `ws://`. Appended `ws://localhost:* ws://127.0.0.1:*` after the existing loopback widening in both `connect-src` directives (the `ws:` scheme token was added next to `wss:`, matching shape) — same loopback-only scope as the existing `http://localhost:* http://127.0.0.1:*`
- 修复 dev 控制台刷屏 60 条 `Loading the font violates "font-src https: data:"`：KaTeX 的 woff2 在 `katex-swap` CSS 里通过 `url(/assets/KaTeX_*.woff2)` 引用，dev 模式下 Vite 把它从 `http://localhost:3210/assets/...` 提供（不在 `https:` 白名单），prod 模式下解析到 `chrome-extension://<id>/assets/...`（扩展自身 origin 也不在 `https:` 白名单，且 `font-src` 没 `'self'`）。`katex-swap` 用 `font-display: swap`，下载期间用 fallback 字体可见，错误未引起用户注意但已经在 prod 静默失败。在 `extension_pages font-src` 末尾追加 `'self' http://localhost:* http://127.0.0.1:*`，dev / prod 同时覆盖；sandbox 页面 `font-src` 已包含 `'self'`，且 sandbox 不加载 bundled tailwind CSS，无需改动
- Fixed 60× console errors `Loading the font violates "font-src https: data:"`: KaTeX's `katex-swap` CSS references woff2 files via `url(/assets/KaTeX_*.woff2)`; in dev Vite serves them from `http://localhost:3210/assets/...` (not in the `https:` allowlist), in prod they resolve to `chrome-extension://<id>/assets/...` (the extension's own origin, also not covered by `https:` and `font-src` had no `'self'`). `katex-swap` uses `font-display: swap` so the fallback font masked the error and users didn't notice, but prod was silently failing. Appended `'self' http://localhost:* http://127.0.0.1:*` to `extension_pages font-src`; both dev and prod now covered. The sandbox `font-src` already includes `'self'` and sandbox pages don't import the bundled tailwind CSS, so no edit there

## 1.5.0 - 2026-08-15

### 新增 / Added

- 支持编辑已发送的消息：鼠标悬停在自己的消息气泡或下方操作区可复制、编辑文案，点击「发送」后 AI 会从这条消息重新生成回复（附件保持不变） ([#44](https://github.com/maotoumao/Cebian/issues/44))
- 消息支持分支切换：编辑或重试产生的历史版本不再被删除，存在并列版本的消息会在气泡下方操作区显示「‹ n/m ›」切换器，可在不同提问 / 回复版本间来回切换，切走的分支随时可以切回来
- 所有密码类输入框新增显示 / 隐藏切换（眼睛图标），方便核对填入的内容：自定义 Provider 的 API Key、MCP 服务器的 Bearer Token、WebDAV 密码、备份加密与恢复密码

- Edit sent messages: hover over your own message bubble or its action area to copy or revise the text; after you click “Send,” the assistant regenerates its response from that message (attachments are preserved) ([#44](https://github.com/maotoumao/Cebian/issues/44))
- Branch switching on messages: past versions produced by editing or retrying are no longer deleted — messages with sibling versions show a "‹ n/m ›" switcher in the action area below the bubble, letting you flip between alternative prompts/responses and return to any branch at any time
- All password-style inputs gain a show/hide toggle (eye icon), making it easy to double-check what was entered: a custom provider's API Key, an MCP server's Bearer Token, the WebDAV password, and backup encryption/restore passwords

### 变更 / Changed

- 会话历史底层迁移为树状存储（首次启动自动无损迁移，原数据保留作保险）：这是消息编辑与分支切换的基础。备份格式保持兼容——新备份会额外携带分支信息（旧版本导入时忽略、仅还原当前分支），旧备份照常导入
- 重试不再删除旧回复：任意已完成的回复都可以重试（不再限于最后一条），被替换的版本保留为分支、可随时切回
- 上下文压缩的摘要卡片现在显示在压缩发生的时间点（对话末尾），而非插在历史中间；历史列表的消息数统计口径同步调整（不再计入摘要与授权卡片，包含所有分支）
- 读取本地文件页面（file:// 打开的 PDF / 网页）而扩展的「允许访问文件网址」权限未开启时，不再报无指向性的 "Failed to fetch"：AI 现在会明确说明原因，并给出可直接点击跳转的扩展设置页链接，开启后重试即可 ([#49](https://github.com/maotoumao/Cebian/issues/49))
- AI 回复下方的操作按钮顺序调整为「复制、重试、朗读」，让常用操作排列更符合使用顺序

- Chat history now uses a tree-structured store under the hood (migrated losslessly and automatically on first launch, with the original data kept as a safety net) — the foundation for message editing and branch switching. The backup format stays compatible: new backups additionally carry branch data (older versions ignore it and restore the current branch), and old backups import as before
- Retry no longer deletes the previous response: any completed response can be retried (not just the latest one), and replaced versions are kept as branches you can switch back to
- The context-compaction summary card now appears at the point in time when compaction happened (end of the conversation) instead of being inserted mid-history; the history list's message count changes accordingly (summaries and permission cards are no longer counted; all branches are included)
- Reading a local file:// page (a PDF or web page opened from disk) without the extension's "Allow access to file URLs" permission no longer fails with an unhelpful "Failed to fetch": the assistant now explains the cause and provides a clickable link that jumps straight to the extension settings page, so you can flip the toggle and retry ([#49](https://github.com/maotoumao/Cebian/issues/49))
- Actions below AI responses are now ordered Copy, Retry, then Read aloud, placing common actions in a more natural sequence

### 修复 / Fixed

- 修复自定义 Provider 中勾选「推理模型」后，system prompt 以 `developer` 角色发送、导致通义千问等第三方 OpenAI 兼容 API 返回 400 的问题；现在自定义模型一律使用 `system` 角色（OpenAI 端点会自动为推理模型转换，行为不受影响） ([#46](https://github.com/maotoumao/Cebian/issues/46), [#57](https://github.com/maotoumao/Cebian/issues/57))
- 修复自定义 Provider 的「最大输出 tokens」设置对硅基流动等第三方端点不生效的问题：此前该值以 `max_completion_tokens` 字段发送、被只认 `max_tokens` 的第三方静默忽略，回复会被服务端默认上限截断（表现为思考型模型只输出思考过程、没有正文）；现在自定义模型一律使用 `max_tokens` 字段 ([#54](https://github.com/maotoumao/Cebian/issues/54))

- Fixed custom-provider models marked as "reasoning" sending the system prompt with the `developer` role, which made third-party OpenAI-compatible APIs such as Qwen return 400; custom models now always use the `system` role (OpenAI endpoints auto-convert it for reasoning models, so behavior there is unchanged) ([#46](https://github.com/maotoumao/Cebian/issues/46), [#57](https://github.com/maotoumao/Cebian/issues/57))
- Fixed a custom provider's "max output tokens" setting having no effect on third-party endpoints such as SiliconFlow: the value was sent as `max_completion_tokens`, which providers that only understand `max_tokens` silently ignore, so replies got truncated at the server's default cap (visible as thinking models emitting only their thinking process and no answer); custom models now always send `max_tokens` ([#54](https://github.com/maotoumao/Cebian/issues/54))

## 1.4.2 - 2026-08-11

### 变更 / Changed

- 升级核心 AI 引擎 pi-ai / pi-agent-core 至 0.84.1，跟进上游模型目录更新（新增 Claude Opus 5、Kimi K3 系列与 Qwen Token Plan Individual 等可选模型，调整 xAI/Grok 目录，思考档位收窄为服务商已验证支持的档位），并带来一批服务商健壮性修复：OAuth 登录与刷新现在能正确响应取消且不会因请求卡住而长期占用凭证锁，工具参数的可空联合类型不再把 `null` 错转成其它值，同时修复 Anthropic 首个内容块丢失、Google / Gemini 工具调用回放、OpenAI Codex 跨账号复用连接等问题
- 思考档选择器现在按当前模型动态显示它真正支持的档位：不支持的档位不再出现（如无法关闭思考的模型不再显示「关闭」），支持的模型会多出「极高 / 最大」两档；已选档位超过所换模型上限时会自动夹到该模型的可用档并按此发送，让显示与实际生效保持一致

- Upgraded the core AI engine (pi-ai / pi-agent-core) to 0.84.1, picking up upstream model-catalog refreshes (new selectable Claude Opus 5, Kimi K3, and Qwen Token Plan Individual models, an adjusted xAI/Grok catalog, and thinking levels narrowed to those the provider has verified) and a batch of provider robustness fixes: OAuth login and refresh now honor cancellation without stalled requests holding the credential lock indefinitely, nullable tool-argument unions no longer coerce `null` into another value, and Anthropic initial content blocks, Google/Gemini tool-call replay, and OpenAI Codex cross-account connection reuse are handled correctly
- The thinking-level selector now adapts to the current model, showing only the levels it actually supports — unsupported ones no longer appear (e.g. a model that can't turn thinking off no longer shows "Off"), and models that support them gain "Extra High" and "Max"; a chosen level that exceeds a newly selected model's ceiling is clamped to that model's available range and sent accordingly, so what you see matches what runs

### 修复 / Fixed

- 录制结束后不再把完整录制内容（含页面 URL、输入值与操作轨迹）打印到浏览器控制台，避免敏感信息进入日志
- 加固了页面内容注入提示词结构的防护：网页标题、URL、页面元信息与选中文本中伪造的 `<memories>`、`<user_profile>` 结构标签此前不会被清除，可能让 AI 把网页伪造的内容误当作你的记忆或个人档案；现在会一并剥除
- 修复 AI 在同一轮里连续弹出两个提问表单时、后一个会顶掉前一个的问题；现在这类提问会依次逐个进行
- 修复在设置的文件编辑器里切换文件时、上一个文件在自动保存间隔内的未保存改动会丢失的问题；现在切走前会先把待存内容落盘
- 修复部分对话反复报错「Cannot read properties of null (reading 'length')」、导致无法继续发送的问题：个别模型返回或旧版本遗留的历史消息可能带上非法的空字段，现在会在发送前自动规整，不再整轮崩溃 ([#43](https://github.com/maotoumao/Cebian/issues/43))
- 修复记忆整理在「指定了整理专用模型、但该模型或其服务商后来被删除」时永久不再运行的问题；由于自动整理是后台静默任务，此前这种情况没有任何提示。现在会退回使用当前对话模型
- 修复大型会话备份恢复期间后台休眠可能中断分块缓冲或数据库写入的问题；恢复过程现在会持续保活，并拒绝重复提交同一批恢复数据

- A finished recording no longer dumps its full contents (page URLs, typed values, and action traces) to the browser console, keeping sensitive data out of logs
- Hardened the defense against web pages injecting prompt structure: forged `<memories>` and `<user_profile>` tags in page titles, URLs, page metadata, and selected text were previously left intact, which could make the assistant treat page-supplied content as your memories or profile; they are now stripped as well
- Fixed a case where the assistant popping up two question forms in the same turn would cancel the first; such prompts now run one at a time
- Fixed unsaved edits to the previous file being lost when switching files in the settings file editor within the auto-save window; pending changes are now flushed before switching away
- Fixed conversations repeatedly failing to send with "Cannot read properties of null (reading 'length')": certain model responses or history left over from older versions could carry an invalid empty field on a message, which is now normalized before sending so the turn no longer crashes ([#43](https://github.com/maotoumao/Cebian/issues/43))
- Fixed memory organization silently never running again once its dedicated model — or that model's provider — had been deleted; because automatic organization is a background task, this failure was invisible. It now falls back to the current chat model
- Fixed background suspension interrupting chunk buffering or database writes during large session-backup restores; restore operations now stay alive until completion and reject duplicate submissions of the same restore batch

## 1.4.1 - 2026-07-14

### 新增 / Added

- 新增「页面交互」（设置 → 页面交互，默认开启）：在网页上注入一个贴边的悬浮球，单击即可打开 / 关闭侧边栏，还可拖拽移动、松手后吸附到最近一侧并记住位置；选中文本时弹出一个可拖拽的划词工具条，提供「复制 / 解释 / 翻译 / 总结」，解释、翻译、总结的结果就地流式显示，可一键复制、点击外部关闭，或「在侧边栏继续」把这次问答固化成正式对话接着深聊；AI 处理时会带上页面标题与选区周边的少量上下文以提高准确度；工具条用的 AI 可单独配置（默认跟随对话模型，方便换用更小更省的模型），翻译目标语言可选（默认跟随界面语言）；悬浮球与工具条都能分别关闭，取词 / 录制进行时自动隐藏以免干扰 ([#19](https://github.com/maotoumao/Cebian/issues/19))
- 自定义 Provider 现在可为每个模型单独设置上下文窗口与最大输出 token：上下文窗口用于更准确地触发历史压缩，最大输出可限制单次回复长度，留空则各走默认 ([#41](https://github.com/maotoumao/Cebian/issues/41))
- 自定义 Provider 新增「高级设置 → 自定义 Headers」，可为兼容 OpenAI 的接口附加任意请求头（如 Azure 的 `api-key`、各类网关的鉴权头）；用请求头鉴权时把 API Key 留空即可，且这些请求头会随备份加密保存、不写入明文配置 ([#41](https://github.com/maotoumao/Cebian/issues/41))

- Added "Page interaction" (Settings → Page interaction, on by default): injects an edge-docked floating ball on web pages that opens/closes the sidebar with a click and can be dragged around — it snaps to the nearest side and remembers where you put it; selecting text pops up a draggable mini toolbar with Copy / Explain / Translate / Summarize, where Explain, Translate and Summarize stream their result inline — you can copy it, click outside to dismiss, or "Continue in sidebar" to turn the exchange into a full conversation and keep going; a little surrounding context (page title and text around the selection) is sent along to improve accuracy; the toolbar's AI is separately configurable (defaults to the conversation model, handy for a smaller, cheaper one) and the translation target language is selectable (defaults to your interface language); the ball and toolbar can each be turned off and auto-hide while element-picking or recording is in progress ([#19](https://github.com/maotoumao/Cebian/issues/19))
- Custom (OpenAI-compatible) providers can now set a per-model context window and max output tokens: the context window drives when history gets compacted, and max output caps a single reply's length; leave either blank to use the defaults ([#41](https://github.com/maotoumao/Cebian/issues/41))
- Custom providers gain "Advanced → Custom headers": attach arbitrary request headers to an OpenAI-compatible endpoint (e.g. Azure's `api-key` or a gateway's auth header); to authenticate via a header just leave the API Key empty, and these headers are saved encrypted with a backup rather than written to the plaintext config ([#41](https://github.com/maotoumao/Cebian/issues/41))

### 变更 / Changed

- 把「压缩模型」设置重命名为「上下文压缩模型」，并优化说明文案，让它更明确是指「对话过长时用来自动压缩历史的模型」
- 升级核心 AI 引擎 pi-ai / pi-agent-core 至 0.80.6，跟进上游模型目录更新（新增 GPT-5.6、Claude Sonnet 5 等可选模型）与新增更高的 `max` 思考档（对支持的模型可用），并带来一批服务商健壮性修复（长请求 token 上限、推理内容重放、重试判定、更清晰的错误信息等）
- 优化自定义 Provider 的模型列表交互：手动添加模型改为「先点按钮再输入」，输入 Model ID 后回车或点「添加」即可（此前是常驻输入框，容易输入后忘记点加号而没保存）([#41](https://github.com/maotoumao/Cebian/issues/41))

- Renamed the "Compaction model" setting to "Context compaction model" and refined its description to make clear it's the model used to automatically compact overly long conversations
- Upgraded the core AI engine (pi-ai / pi-agent-core) to 0.80.6, picking up upstream model-catalog refreshes (new selectable models such as GPT-5.6 and Claude Sonnet 5), a new higher `max` thinking level (where the model supports it), and a batch of provider robustness fixes (context-aware max-token caps, reasoning replay, retry classification, clearer error messages, etc.)
- Refined the model-list interaction for custom providers: adding a model manually is now "click to reveal, then type" — enter a Model ID and press Enter or click "Add" (previously an always-present input that was easy to fill in and then forget to click the plus) ([#41](https://github.com/maotoumao/Cebian/issues/41))

### 修复 / Fixed

- 自定义 Provider 点「自动获取」刷新模型列表时，不再清空你已为各模型设置的推理 / 多模态 / 上下文窗口等配置：仍存在的模型保留原设置，新模型补入，已消失的移除 ([#41](https://github.com/maotoumao/Cebian/issues/41))
- 编辑已存在的 MCP Server 时，清空全部自定义请求头现在能正确保存为「无」（此前因浅合并会保留旧请求头）

- Fixed refreshing a custom provider's model list via "Auto-fetch" wiping the per-model settings you had configured (reasoning / multimodal / context window, etc.): models still present keep their settings, new ones are added, and removed ones drop off ([#41](https://github.com/maotoumao/Cebian/issues/41))
- Fixed clearing all custom request headers while editing an existing MCP server not taking effect — it now correctly saves as "no headers" (a shallow merge previously kept the old headers)

## 1.4.0 - 2026-06-30

### 新增 / Added

- 文件浏览器现在把会话工作区目录（原本是一串 UUID）显示成「会话标题 · 日期」，并在进入某个工作区时于顶部展示该会话的标题与创建时间，让 AI 生成的文档更好找；设置新增「文件系统」一节，显示虚拟文件系统已用空间，并可一键打开文件浏览器 ([#26](https://github.com/maotoumao/Cebian/pull/26))
- AI 现在可以用 ask_user 一次性弹出包含多道问题的表单：每题可设单选 / 多选 / 自由文本，并可把某个选项设为默认；用户左右翻页填写、在最后一题统一提交，替代以往多轮逐个提问 ([#28](https://github.com/maotoumao/Cebian/issues/28))
- 新增「压缩模型」设置（设置 → 高级）：可单独指定上下文压缩（自动摘要过长对话）所用的模型，默认与对话模型相同，方便改用更小更省的模型来跑后台摘要 ([#40](https://github.com/maotoumao/Cebian/issues/40))
- 新增跨对话记忆（设置 → 记忆，默认关闭）：开启后 AI 会在对话中自行把关于你的持久信息存成本地 Markdown 文件（如身份、长期偏好、常用资源），下次新对话自动带上相关记忆；核心档案（名字、职业、无障碍特征等）固定写入单个 `user_profile.md` 并每轮完整注入，其余按需读取；所有记忆在设置页完全可见、可编辑、可删除，并可单独纳入备份/恢复；设置页还提供「整理记忆」按钮，一键合并重复、清理过时、规整你的记忆文件，也可开启自动整理（按间隔与新增量在后台定期进行） ([#29](https://github.com/maotoumao/Cebian/issues/29))

- The file browser now shows session workspace folders (previously raw UUIDs) as "conversation title · date", and displays the conversation's title and creation time at the top when you open a workspace, making AI-generated documents easier to find; Settings gains a "Filesystem" section that shows used space and opens the file browser in one click ([#26](https://github.com/maotoumao/Cebian/pull/26))
- The AI can now use ask_user to present a single form containing multiple questions: each can be single-select, multi-select, and/or free text, with an option markable as the default; you page through them and submit on the last question, replacing the old one-question-at-a-time prompts ([#28](https://github.com/maotoumao/Cebian/issues/28))
- Added a "Compaction model" setting (Settings → Advanced): you can pick a separate model for context compaction (auto-summarizing overly long conversations), defaulting to the conversation model, so a smaller and cheaper model can handle background summaries ([#40](https://github.com/maotoumao/Cebian/issues/40))
- Added cross-conversation memory (Settings → Memory, off by default): once enabled, the AI saves durable facts about you as local Markdown files during chats (identity, long-term preferences, where your things live) and automatically brings the relevant ones into new conversations; core profile facts (name, role, accessibility, etc.) live in a single `user_profile.md` injected in full every turn, while the rest are read on demand; every memory is fully visible, editable, and deletable in Settings, and can be included separately in backup/restore; Settings also has an "Organize memory" button that consolidates duplicates, drops stale notes, and tidies your memory files in one pass, or you can enable auto-organize to run it periodically in the background based on a minimum interval and how many new memories have accumulated ([#29](https://github.com/maotoumao/Cebian/issues/29))

### 变更 / Changed

- 升级核心 AI 引擎 pi-ai / pi-agent-core 至 0.80，跟进上游的模型目录更新与服务商兼容性修复；同步升级构建工具链（WXT、CodeMirror）
- 优化 AI 的联网搜索：现在优先用通用搜索引擎（Bing / Brave / Google / DuckDuckGo，中文场景以百度兜底）并直接定位搜索结果区读取，不再默认在当前网站里搜、也不再靠猜域名乱开标签页，找网站和资料更快更准
- 统一并优化侧边栏对话区的图标按钮观感：输入框工具栏、发送/麦克风、复制/朗读/重试等按钮现在大小与内边距一致、点按更从容；模型名称、思考档文字略微加大，输入框最小高度也略有增加
- 设置页顶部导航显示「纯图标」的宽度上限由 640px 提高到 800px：更宽的窗口下才切换为带文字的标签页

- Upgraded the core AI engine (pi-ai / pi-agent-core) to 0.80, picking up upstream model-catalog refreshes and provider compatibility fixes; also bumped the build toolchain (WXT, CodeMirror)
- Improved the AI's web search: it now prefers a general search engine (Bing / Brave / Google / DuckDuckGo, with Baidu as a Chinese fallback) and reads the results region directly instead of searching within the current site or guessing domains and opening dead tabs — finding sites and information faster and more accurately
- Unified and refined the sidepanel chat icon buttons: the composer toolbar, send/mic, and copy/read-aloud/retry buttons now share a consistent size and padding for more comfortable tapping; the model name and thinking-level labels are a touch bigger, and the composer's minimum height was increased a little
- Raised the width below which the Settings top navigation shows icon-only tabs from 640px to 800px, so labeled tabs now require a wider window

### 修复 / Fixed

- 修复站点在移动端（≤820px）导航栏中"赞助"和语言标签文字因 flex 压缩折行的问题；移动端赞助按钮退化为纯图标，极窄屏（≤380px）同步隐藏语言标签文字
- 语音输入改为「本地优先、云端兜底」：本地语音引擎不可用的浏览器（如 Edge）现在自动改用云端识别，不再误报「本设备的本地语音识别不支持当前语言」；云端识别连接失败时给出明确的网络提示 ([#33](https://github.com/maotoumao/Cebian/pull/33))
- 修复从某个对话进入设置后点返回会落到新对话的问题：现在返回会回到进入设置前正在查看的对话
- 修复在进行中的对话里进入设置再返回后，左下角模型选择器被重置为「未选中」的问题：返回正在运行的对话现在会正确恢复该对话所用的模型与思考档
- 修复 skill 导入时错误拒绝合法的 `vfs.read`、`vfs.write`、`bgFetch`、`bgFetch:<pattern>` 权限声明；声明了这些权限的 skill 此前在导入预览时会报 `unsupportedPermission` 并拒绝安装 ([#37](https://github.com/maotoumao/Cebian/pull/37) by [@LinYanZhi](https://github.com/LinYanZhi))

- Fixed nav bar text wrapping on mobile (≤820px) where the sponsor label and language label were line-breaking due to flex shrink; the sponsor button now degrades to an icon-only style on mobile, and the language label is additionally hidden on extra-narrow screens (≤380px)
- Voice input now follows "local first, cloud fallback": browsers without an on-device speech engine (such as Edge) automatically switch to cloud recognition instead of wrongly reporting that the language isn't supported on-device; a clear network message is shown when the cloud service can't be reached ([#33](https://github.com/maotoumao/Cebian/pull/33))
- Fixed the Settings back button landing on a new chat: returning from Settings now restores the conversation you were viewing before opening it
- Fixed the bottom-left model selector resetting to "none selected" after opening Settings and returning during an active conversation: returning to a running conversation now correctly restores the model and thinking level it uses
- Fixed skill import incorrectly rejecting valid `vfs.read`, `vfs.write`, `bgFetch`, and `bgFetch:<pattern>` permission declarations; skills declaring these permissions previously failed at import time with an `unsupportedPermission` error ([#37](https://github.com/maotoumao/Cebian/pull/37) by [@LinYanZhi](https://github.com/LinYanZhi))

## 1.3.3 - 2026-06-21

### 新增 / Added

- 对话输入框支持语音输入：点击麦克风按钮即可把语音实时转写进输入框，离线本地识别（基于浏览器 on-device 语音引擎，音频不离开设备），首次使用会自动下载所选语言的语音模型 ([#20](https://github.com/maotoumao/Cebian/pull/20))
- 新增通用授权页用于在标签页中完成麦克风授权（侧边栏无法直接弹出授权框）
- 每个对话各自记住自己的模型与思考档：在某个对话里切换模型/思考档只影响该对话，新对话沿用你上一次选择的模型作为默认；适合多开标签分散使用、按对话把请求分摊到不同供应商 ([#11](https://github.com/maotoumao/Cebian/pull/11))
- 使用 OpenRouter 时，请求会附带应用标识请求头（`HTTP-Referer` / `X-Title`），让 Cebian 出现在 OpenRouter 的应用榜单中；不含任何用户数据，仅对 OpenRouter 发送
- WebDAV 备份新增「断开连接」：可移除已保存的连接配置（含密码），远程已上传的快照会保留，重新连接后仍可访问
- 扩展升级后，下次打开侧边栏会自动打开更新日志页并定位到新版本，方便查看本次更新内容

- Voice input in the chat composer: click the mic button to transcribe speech into the input in real time, recognized locally on-device (the browser's on-device speech engine — audio never leaves your device); the language model for your locale is downloaded automatically on first use ([#20](https://github.com/maotoumao/Cebian/pull/20))
- Added a generic permission page to grant microphone access from a tab (the side panel can't show the prompt directly)
- Each conversation now remembers its own model and thinking level: switching the model/thinking level inside one chat affects only that chat, and a new chat defaults to the model you last picked; handy for spreading work across multiple tabs and routing requests to different providers per conversation ([#11](https://github.com/maotoumao/Cebian/pull/11))
- When using OpenRouter, requests now carry app-identifying headers (`HTTP-Referer` / `X-Title`) so Cebian appears on OpenRouter's app rankings; they contain no user data and are sent to OpenRouter only
- WebDAV backup can now be disconnected: remove the saved connection (including the password); snapshots already uploaded to the server are kept and stay accessible after reconnecting
- After an extension upgrade, opening the side panel next time automatically opens the changelog page scrolled to the new version, so you can see what changed

### 修复 / Fixed

- 备份文件名使用用户填写的名称
- 规避会话备份/恢复时的 64 MiB runtime message 体积限制
- 工具执行中点击停止后，工具卡片不再一直显示加载图标，「已取消」提示也移到工具卡片下方 ([#21](https://github.com/maotoumao/Cebian/pull/21))
- 询问用户/权限确认卡片的文本现在保留换行，多行时图标与首行对齐 ([#23](https://github.com/maotoumao/Cebian/pull/23))
- 修复文件编辑页右键菜单删除时误打开文件的问题：修复窄屏布局下的误触场景 ([#22](https://github.com/maotoumao/Cebian/pull/22))，并从根本上阻止菜单点击事件冒泡到文件行 ([#25](https://github.com/maotoumao/Cebian/pull/25) by [@Matsuko97](https://github.com/Matsuko97))
- 修复 AI 偶尔不读取页面、凭记忆编造链接就跳转的问题：现在要求链接地址必须来自页面真实 \`href\`、用户输入或工具结果，仅允许基于页面上可见样本的推导（如可见的 \`?page=2\` 翻到 \`?page=3\`），并在跳转失败时回退到重新读取页面
- 修复「关于」页与更新提示里的安装指南链接指向失效旧地址的问题（现指向重构后的文档站安装页），并按界面语言正确区分简体 / 繁体 / 英文

- Use the user-provided name for backup filenames
- Avoid the 64 MiB runtime message limit on session backup and restore
- Stop the tool card from spinning forever after cancelling a running tool, and move the "Cancelled" marker below the tool card ([#21](https://github.com/maotoumao/Cebian/pull/21))
- Preserve line breaks in ask-user and permission-prompt card text, and align the icon to the first line for multi-line text ([#23](https://github.com/maotoumao/Cebian/pull/23))
- Fixed the AI occasionally navigating to a URL invented from memory instead of reading the page: link addresses must now come from a real page \`href\`, user input, or a tool result, with derivation allowed only from a sample visible on the page (e.g. bumping a visible \`?page=2\` to \`?page=3\`), and a fallback to re-read the page when navigation fails
- Fixed the file editor accidentally opening a file when deleting via right-click: addressed the narrow-layout case ([#22](https://github.com/maotoumao/Cebian/pull/22)) and fixed the root cause of click events bubbling from the menu to the file row ([#25](https://github.com/maotoumao/Cebian/pull/25) by [@Matsuko97](https://github.com/Matsuko97))
- Fixed the install-guide link in the About page and update notice pointing at a dead old URL (now points at the rebuilt docs site's installation page), and route it to the correct Simplified / Traditional Chinese / English variant per UI language

### 变更 / Changed

- 升级 pi-agent-core / pi-ai 至 0.79.9（含 GitHub Copilot OAuth 可用模型列表改用登录账号自身的模型目录等修复）
- Skills 技能索引迁入会话级 system prompt，充分命中浏览器 prompt cache，降低安装较多 skill 时的单次请求开销 ([#24](https://github.com/maotoumao/Cebian/pull/24) by [@Matsuko97](https://github.com/Matsuko97))

- Upgrade pi-agent-core and pi-ai to 0.79.9 (includes fixes such as GitHub Copilot OAuth model availability now using the signed-in account's own model catalog)
- Moved the skills index into the session-level system prompt to better hit the browser's prompt cache, reducing per-request overhead when many skills are installed ([#24](https://github.com/maotoumao/Cebian/pull/24) by [@Matsuko97](https://github.com/Matsuko97))

## 1.3.2 - 2026-06-14

### 新增 / Added

- 备份与恢复：本地 `.zip` + WebDAV，支持可选加密
- 历史记录按时间分组并支持折叠（今天 / 7 天内 / 30 天内 / 更早）
- 聊天消息朗读按钮
- 新会话空状态加入示例卡片与品牌回落
- 预提示阶段压缩（compaction），带可取消的交互
- 新增 Ant Ling 与 NVIDIA NIM 供应商
- 按模型多模态能力控制图片上传

- Backup and restore: local `.zip` + WebDAV, with optional encryption
- Group history by time with collapsible sections (today / last 7 days / last 30 days / older)
- Read-aloud button on chat messages
- New-session empty state with example cards and brand fallback
- Pre-prompt compaction with a cancellable UX
- Add Ant Ling and NVIDIA NIM providers
- Gate image upload by each model's multimodal capability

### 修复 / Fixed

- 改用 compaction 感知的 LLM 视图，替换 maxRounds 滑动窗口 ([#9](https://github.com/maotoumao/Cebian/pull/9))
- 连通性测试失败不再阻断 API key 保存
- 自定义供应商改用 uuid 作为内部 id
- 跟随系统主题时改用 SunMoon 图标
- read_page 选择器输入清理杂散引号
- 站点根路径不再出现可见的重定向页

- Use a compaction-aware LLM view to replace the maxRounds sliding window ([#9](https://github.com/maotoumao/Cebian/pull/9))
- Connectivity test failure no longer blocks saving the API key
- Custom providers use a uuid as their internal id
- Use the SunMoon icon when following the system theme
- Sanitize stray quotes in the read_page selector input
- Avoid a visible redirect page at the site root

### 变更 / Changed

- 退役设置中的「高级」标签页并移除未使用的 maxRounds
- run_skill 改由 beforeToolCall 门控授权，不再依赖 LLM 传递 nonce
- 升级 pi-agent-core / pi-ai 至 0.79.x

- Retire the Advanced settings tab and remove the unused maxRounds
- Authorize run_skill via a beforeToolCall gate instead of an LLM-relayed nonce
- Upgrade pi-agent-core and pi-ai to 0.79.x

## 1.3.1 - 2026-05-30

### 新增 / Added

- 应用打开时弹出更新提示对话框

- In-app update notice dialog on app open

### 修复 / Fixed

- 重构 API key 供应商注册表，修复两个设置项缺陷

- Rework the API-key provider registry and fix two settings bugs

### 变更 / Changed

- 迁移 pi-agent-core / pi-ai 至 @earendil-works 0.78.0
- 更新扩展名称

- Migrate pi-agent-core and pi-ai to @earendil-works 0.78.0
- Update the extension name

## 1.3.0 - 2026-05-30

### 新增 / Added

- PDF 工具：在标签页中读取 PDF
- 聊天 markdown 内联渲染 VFS 图片
- 技能沙箱权限：bgFetch、vfs.read / vfs.write

- PDF tool: read PDFs in tabs
- Inline VFS image rendering in chat markdown
- Skill sandbox permissions: bgFetch, vfs.read / vfs.write

### 修复 / Fixed

- 瞬时断连后重新派发重试
- 修复警告对话框文本换行

- Retry dispatch after a transient disconnect
- Fix alert dialog text wrapping

### 变更 / Changed

- 为 code-review 代理指定模型

- Set the model for the code-review agent

## 1.2.1 - 2026-05-24

### 新增 / Added

- execute_js 与 read_page 支持 outputPath，将大结果直接写入 VFS 以免撑爆上下文
- 模型选择器打开时滚动到当前模型

- execute_js and read_page support outputPath to offload large results into the VFS
- Scroll to the active model when opening the model picker

### 修复 / Fixed

- Web Store 审核：shim 掉 pi-ai 的 anthropic oauth 模块
- 流式订阅中途保持会话标题
- 为合成 keypress 补齐 legacy keyCode / which / code
- 守卫历史中重复选中当前会话

- Web Store review: shim out the pi-ai anthropic oauth module
- Preserve the session title when subscribing mid-stream
- Populate legacy keyCode / which / code on synthetic keypress
- Guard against re-selecting the current session in history

### 变更 / Changed

- 技能索引随 VFS 变更事件自动失效
- Settings 路由懒加载，缩小初始包体

- Auto-invalidate the skill index from VFS change events
- Lazy-load Settings routes to shrink the initial chunk

## 1.2.0 - 2026-05-20

### 新增 / Added

- VFS 文件 / 文件夹下载与文件复制
- VFS 媒体渲染：图片与 markdown 预览、frontmatter 表格
- fs_save_url 工具：抓取 URL 并写入 VFS，带文件名推导与大小上限
- 聊天消息重试按钮
- 按 SEP-1865 内联渲染 MCP Apps

- VFS file and folder download, plus file copy
- VFS media rendering: image and markdown preview, frontmatter table
- fs_save_url tool: fetch a URL into the VFS with filename derivation and a size cap
- Retry button on chat messages
- Inline MCP Apps rendering per SEP-1865

### 修复 / Fixed

- 首次发送立即显示标题与用户消息
- 重试后停止按钮卡住与中止标记不一致
- 内联重命名时防止误激活与拖拽
- 历史面板在 flex 列中可正常滚动
- 修复 sidepanel 首帧 150px 高度残留

- Show the title and user message immediately on first send
- Fix the stop button stuck after retry and aborted-marker inconsistency
- Prevent activation and drag during inline rename
- Allow the history panel to scroll in a flex column
- Avoid a stale 150px height on sidepanel first paint

### 变更 / Changed

- 技能的 matched-url 改为否决式过滤，去掉脚手架默认通配

- Make skill matched-url a veto-only filter and drop the wildcard default

## 1.1.0 - 2026-05-09

### 变更 / Changed

- 升级 pi-agent-core / pi-ai 至 0.73.0

- Upgrade pi-agent-core and pi-ai to 0.73.0

### 移除 / Removed

- 移除 Google Gemini CLI OAuth 供应商

- Drop the Google Gemini CLI OAuth provider

## 1.0.0 - 2026-04-26

### 新增 / Added

- 首个公开版本

- Initial public release
