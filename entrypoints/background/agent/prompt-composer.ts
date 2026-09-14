// 组装喂给 agent 的两类文本输入：会话的 systemPrompt（base + skills + 用户指令），
// 以及每轮的结构化 user 消息（附件前缀 + 页面上下文 + 记忆 + 用户原文）。
//
// 分两层，同处本文件让分层在视觉上相邻：
//   build*   —— 给定零件拼字符串，纯同步，不认识 session / VFS / scanner；
//   compose* —— 先读 async 上下文（存储 / skills 扫描 / 页面状态），再委托 build*。
//
// 造 Agent 实例本身在同目录的 `factory.ts` —— 它只接收本文件产出的成形字符串。

import { compilePersonaBlock, personaBindingLine } from '@/lib/agent/persona-types';
import { userInstructions as userInstructionsStorage, memorySettings, workerTeamEnabled, personaSoul, personaIdentity, personaEnabled } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt';
import { gatherPageContext } from './page-context';
import { buildTextPrefix, type Attachment } from '@/lib/agent/attachments';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { buildAvailableWorkersBlock } from '@/lib/agent/worker-roles';
import { buildSlashPromptBlock, SLASH_PROMPT_ONLY_REQUEST, type SlashPrompt } from '@/lib/ai-config/slash-prompt';
import { wrapUserRequest, wrapReminderInstructions, wrapPersonaReminder } from '@/lib/agent/prompt-envelope';
import { MEMORY_INSTRUCTIONS, memoryLimitationLine } from '@/lib/memory/prompt';
import { scanMemoryIndex, buildMemoriesBlock, buildUserProfileBlock } from '@/lib/memory/index-scan';
import { ragSettings } from '@/lib/rag';

// ─── build 层（纯拼接） ───

/**
 * 构造 agent 的 systemPrompt：基础提示词（按 `variables` 替换其中的 `{{KEY}}`
 * 占位符）+ 可选的 `<skills>`（skills 索引）段 + `<available-workers>`
 * （worker L1 索引）段 + 可选的 `<user-instructions>` 段。
 * 作为 systemPrompt 拼接的单一真理来源，由同文件的 `composeSystemPrompt` 在会话
 * 创建 / 切模型 / retry / 每轮派发前刷新时调用。
 *
 * 保持纯/同步：变量值（如会话工作目录）、skills、instructions、workers 的获取都留在
 * `composeSystemPrompt`；本函数只负责拼接 + 文本替换，不认识具体变量名、不依赖
 * VFS / scanner / session 等概念。
 *
 * 各 L1 块顺序：
 *   1. base  —— 占据缓存前缀，statics 永远在前。
 *   2. <skills> —— domain-specific instruction packs；与 base 同寿命（命中缓存）。
 *   3. <available-workers> —— 4 种 worker role 菜单 + 最小示例；registry 不变
 *      即字节不变（命中缓存）。置于 skills 之后让"先 domain 再 capability"的
 *      阅读顺序自然：skills 是「具体场景下的规则」，workers 是「通用工具集」。
 *   4. <user-instructions> —— 用户最后写的偏好，每次编辑会击穿一次缓存。
 *
 * skills / workers 块都放在 system 顶部贴近 base prompt，整段一同进入缓存
 * 前缀——任一块变才击穿一次。末尾只有 user-instructions 一个断点。
 */
/**
 * Compose the two conditional RAG-search placeholders in the system
 * prompt. Both are empty strings when `settings.ragSearchEnabled` is
 * false (the default) so the prompt stays byte-identical to pre-
 * Subtask-4. When the user has the toggle on, we surface the tool
 * in the Tools roster AND add a step-5 to the RAG Workflow so the
 * LLM knows when to reach for `rag_search` instead of fabricating
 * answers from stale pre-injected chunks.
 *
 * The two must agree with `lib/tools/index.ts` which only pushes the
 * tool into the session's tool array when the same flag is on. If
 * the prompt mentions `rag_search` but the tool isn't in the tool
 * list, the LLM hallucinates a call; if the tool exists but the
 * prompt never explains when to use it, the LLM never picks it.
 * Reading the same `ragSettings` blob here keeps the two sides in
 * sync within a single `composeSystemPrompt` call.
 */
function buildRagSearchToolLine(enabled: boolean): string {
  // OFF: substitute to empty string. The Subtask-4 placeholder sits
  // on its own source line between the rag_inspect bullet and the
  // blank line that precedes "User & skills:". With empty substitution
  // the surrounding text would render three consecutive newlines,
  // which trips the prompt-composer test that asserts no `\n{3,}` runs
  // — and breaks the byte-identical-to-pre-Subtask-4 promise that
  // Anthropic prompt caching depends on. `composeSystemPrompt` calls
  // `collapseTripleNewlines()` after substitution to compensate.
  if (!enabled) return '';
  return (
    '- **rag_search** — query a RAG collection with hybrid (vector + keyword) ' +
    'search. Use for deeper lookups beyond the pre-injected `<attached-rag-context>` ' +
    'chunks (specific section numbers, function names, code identifiers).'
  );
}

function buildRagSearchWorkflowStep(enabled: boolean): string {
  // OFF: substitute to empty string. See `buildRagSearchToolLine`
  // above for why; `composeSystemPrompt` collapses the resulting
  // triple-newline runs so the prompt stays byte-identical to
  // pre-Subtask-4 when the toggle is off (and Anthropic prompt caching
  // is preserved).
  if (!enabled) return '';
  return (
    '5. **For deeper lookups beyond the pre-injected chunks, call `rag_search`.** ' +
    'The pre-injected `<attached-rag-context>` envelope contains the top-5 chunks ' +
    'at send time. If the user asks a follow-up that requires different chunks ' +
    '(specific section number, function name, code identifier), call ' +
    '`rag_search({ collection, query, limit })`. It runs hybrid search ' +
    '(vector + keyword) and returns a fresh envelope. Do NOT use it for the ' +
    'initial turn — the pre-injected chunks already cover it.'
  );
}

/**
 * Subtask 4 introduced two `{{KEY}}` placeholders in `DEFAULT_SYSTEM_PROMPT`
 * (`{{RAG_SEARCH_TOOL_LINE}}`, `{{RAG_SEARCH_WORKFLOW_STEP}}`) that, when
 * the user hasn't enabled `ragSearchEnabled`, resolve to empty strings.
 * Their source-line layout then renders as three consecutive newlines
 * (`\n\n\n`) in the assembled prompt. The pre-Subtask-4 prompt never
 * contained `\n{3,}` runs, so collapsing them to `\n\n` is a no-op for
 * that baseline and brings the OFF state back to byte-identical —
 * preserving Anthropic prompt caching.
 *
 * Scope: this runs against the **entire assembled prompt** (not just the
 * Subtask-4 branches) so a future contributor adding a multi-line block
 * elsewhere that happens to contain `\n\n\n` would also see it normalized.
 * Today neither `MEMORY_INSTRUCTIONS` nor `DEFAULT_SYSTEM_PROMPT` contain
 * such runs; the prompt-composer test `段间不出现三连以上换行` enforces
 * the invariant that keeps this collapse a no-op in practice.
 */
function collapseTripleNewlines(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}

function buildSystemPrompt(
  userInstructions: string,
  skillsBlock?: string,
  variables: Record<string, string> = {},
): string {
  const basePrompt = DEFAULT_SYSTEM_PROMPT.replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => (Object.hasOwn(variables, name) ? variables[name] : match),
  );
  const parts: string[] = [basePrompt];

  const trimmedSkills = skillsBlock?.trim();
  if (trimmedSkills) {
    parts.push(trimmedSkills);
  }

  // Worker L1 索引：registry 是 4 个固定 role，buildAvailableWorkersBlock 在
  // OFF 时返回空串（Worker Team 总开关关闭），ON 时返回非空。OFF 时整段
  // 不注入主代理 system prompt——它既看不到 `<available-workers>` 也拿不到
  // `delegate_task` 工具，故不必给菜单。两侧必须由同一个 storage flag
  // (`workerTeamEnabled`) 同步驱动：tool 一侧见 `lib/tools/index.ts` 的
  // 条件 push，prompt 一侧见此处的 `workerTeamEnabled === 'true'` 判断。
  // 与 `rag_search` 在 prompt + tool 两边 gate 的模式一致。
  if (variables.workerTeamEnabled === 'true') {
    parts.push(buildAvailableWorkersBlock(true));
  }

  // Persona (Subtask 2): 1-line binding sentence 注入到 Output & Communication
  // 段下方（紧邻 "Always respond in the same language..." 那行）。`personaBindingLine`
  // 返回 '' 当 persona 缺 name，所以 cache-stable byte-shape 保留：仅在 ON + name
  // 设置时多 1 行（开头是连字符缩进，保持 markdown bullet 视觉一致）。
  if (variables.personaBinding) {
    parts.push(`- ${variables.personaBinding}`);
  }

  // Persona (Subtask 2): inject the SOUL copy + identity block between
  // workers and user-instructions. `compilePersonaBlock` returns '' when
  // the user has not set any persona field, so the cache prefix stays
  // byte-identical to the pre-persona baseline (no extra `\n\n` artifact).
  if (variables.personaBinding) {
    const soul = String(variables.personaSoul ?? '');
    const identity = JSON.parse(String(variables.personaIdentityJson ?? '{}')) as Parameters<
      typeof compilePersonaBlock
    >[0];
    const personaBlock = compilePersonaBlock(identity, soul, t);
    if (personaBlock) parts.push(personaBlock);
  }

  const trimmedInstructions = userInstructions.trim();
  if (trimmedInstructions) {
    parts.push(`<user-instructions>\n${trimmedInstructions}\n</user-instructions>`);
  }

  return parts.join('\n\n');
}

/**
 * 组装本轮 user 消息里的记忆区：记忆关闭则空串；开启则拼常驻 <user_profile>
 * 全文 + <memories> 索引。两段都可能为空（无 profile / 无其他记忆），由 composeUserMessage 守卫不注入。
 * 每轮调用：scanMemoryIndex 命中缓存、开销≈0；记忆 / 日期不变则逐字节一致（缓存友好）。
 */
async function buildMemoriesContext(memoryEnabled: boolean): Promise<string> {
  if (!memoryEnabled) return '';
  // 常驻 <user_profile> 全文 + <memories> 索引（其余各类）。两段都可能为空，空串过滤。
  const [profile, metas] = await Promise.all([buildUserProfileBlock(), scanMemoryIndex()]);
  return [profile, buildMemoriesBlock(metas)].filter(Boolean).join('\n\n');
}

// ─── compose 层（取数据后委托 build） ───

/**
 * 组装本轮要发给 agent 的「结构化用户消息」：reminder 占位段 + 附件文本前缀 +
 * `<context>`（日期 + 页面上下文）+ `<slash-prompt>`（可选）+ `<user-request>`（始终
 * 置末）。读 page context 是 async，故本函数 async。
 */
async function composeUserMessage(
  text: string,
  attachments: Attachment[],
  memoryEnabled: boolean,
  slashPrompt?: SlashPrompt,
  workerTeamOn?: boolean,
  personaIdentity?: Parameters<typeof wrapPersonaReminder>[0],
): Promise<string> {
  const parts: string[] = [];

  // ① Tool/behavior reminders：贴近本轮用户请求，降低“先 native 写再被 gate 拦”的额外往返。
  // wrapper 形状由 prompt-envelope 的 wrapReminderInstructions 单一来源决定，
  // retry/edit 路径下的 rewriteReminderInstructions 复用同一 helper，确保
  // prompt-cache prefix 字节稳定。
  // Persona (Subtask 2) 1-line recap 拼到同一 reminder 块里：worker_team 提醒在前，
  // persona 提醒在后；两者 OFF 时 body 为空，wrapper 仍按旧 byte shape 输出。
  const reminders = [
    workerTeamOn ? TEAM_REMINDER_COPY : '',
    personaIdentity ? wrapPersonaReminder(personaIdentity) : '',
  ].filter(Boolean).join('\n');
  parts.push(wrapReminderInstructions(reminders));

  // ② Attachments (elements + files; images go via multimodal content blocks)
  const attachmentBlock = buildTextPrefix(attachments);
  if (attachmentBlock) parts.push(attachmentBlock);

  // ③ Context: date + page state
  const ctxLines: string[] = [];
  ctxLines.push(`The current date is ${new Date().toLocaleDateString('en-CA')}.`);
  const pageCtx = await gatherPageContext();
  if (pageCtx) {
    ctxLines.push('');
    ctxLines.push(pageCtx);
  }
  parts.push(`<context>\n${ctxLines.join('\n')}\n</context>`);

  // ④ Memories: 记忆开启且非空时注入 <user_profile>常驻 + <memories>索引（数据，权威性低于 Critical Rules）。
  const memoriesBlock = await buildMemoriesContext(memoryEnabled);
  if (memoriesBlock) parts.push(memoriesBlock);

  // ⑤ 斜杠提示词：用户挑中的提示词模板自成一块，不与用户自己敲的话混在一起
  //（理由见 lib/ai-config/slash-prompt.ts）。
  if (slashPrompt) parts.push(buildSlashPromptBlock(slashPrompt));

  // ⑥ User request (always last)
  // TODO: user text is NOT sanitized — users are trusted; stripping structural tags would alter their intent.
  // 只挂了提示词、一个字没打时放一句指向上面那块的话——空的请求块会让模型以为这轮没有请求。
  const request = text.trim() || (slashPrompt ? SLASH_PROMPT_ONLY_REQUEST : '');
  parts.push(wrapUserRequest(request));

  return parts.join('\n\n');
}

/**
 * 组装会话的 systemPrompt——systemPrompt 的单一来源。读取用户指令 + 扫描 skills
 * 索引（命中缓存，开销≈ 0），交给纯函数 `buildSystemPrompt` 拼接。每轮派发前无
 * 条件调用：skills 不变则产出逐字节相同的字符串、命中 system 缓存；skills 变则产
 * 出变化、击穿缓存一次（= 装/卸 skill 的实时性代价）。因此无需写「skills 是否变
 * 化」的 diff 逻辑。
 */
async function composeSystemPrompt(
  sessionId: string,
  memoryEnabled?: boolean,
  workerTeamOn?: boolean,
  personaOn?: boolean,
): Promise<string> {
  // personaOn / workerTeamOn 是同源 snapshot：与 lib/tools/index.ts 的 buildSessionToolArray
  // 共享同一个 storage flag，但有「调用方预读 / 实时读」两种走法。per-subtask 1 模式：
  // 调用方传值时复用其快照，缺省时本函数自行 getValue（与 workerTeamOn 一致）。
  const personaOnSnapshot = personaOn ?? (await personaEnabled.getValue());
  const [
    instructions,
    skillMetas,
    currentRagSettings,
    storedTeamEnabled,
    personaSoulValue,
    personaIdentityValue,
  ] = await Promise.all([
    userInstructionsStorage.getValue(),
    scanSkillIndex(),
    ragSettings.getValue(),
    workerTeamOn === undefined ? workerTeamEnabled.getValue() : Promise.resolve(workerTeamOn),
    personaOnSnapshot ? personaSoul.getValue() : Promise.resolve(''),
    personaOnSnapshot ? personaIdentity.getValue() : Promise.resolve({ name: '', vibe: '', tone: '', emoji: '' }),
  ]);
  // memoryEnabled 由调用方传入时复用其快照（让同一轮的 system / user 注入读同一个值）；
  // 未传时（如初始建会话路径）自行读取。
  const enabled = memoryEnabled ?? (await memorySettings.getValue()).enabled;
  const skillsBlock = buildSkillsBlock(skillMetas);
  // 「会话域 → 模板变量」的翻译层：本函数是唯一认识 session 概念、并把它映射成
  // 纯装配器 buildSystemPrompt 所需的 `{{KEY}}` 变量表的地方。新增占位符只改这里。
  // 记忆开启时填入指引段（前后加空行作分隔），关闭时为空串（base 逐字节回到原样）。
  return collapseTripleNewlines(
    buildSystemPrompt(instructions || '', skillsBlock, {
      SESSION_ID: sessionId,
      MEMORY_LIMITATION: memoryLimitationLine(enabled),
      MEMORY_SECTION: enabled ? `\n${MEMORY_INSTRUCTIONS}\n` : '',
      // Subtask 4 — agentic `rag_search` tool. Both placeholders stay
      // empty when off (prompt byte-identical to pre-Subtask-4). The
      // gate flag is read here once per `composeSystemPrompt` call;
      // `buildRagSearchToolLine` / `buildRagSearchWorkflowStep` read
      // `currentRagSettings` so a flipped toggle is picked up on the
      // next prompt rebuild (every dispatch — see `factory.ts`).
      RAG_SEARCH_TOOL_LINE: buildRagSearchToolLine(currentRagSettings.ragSearchEnabled),
      RAG_SEARCH_WORKFLOW_STEP: buildRagSearchWorkflowStep(currentRagSettings.ragSearchEnabled),
      // Worker Team 总开关。true 时 buildSystemPrompt 才 push
      // `<available-workers>` L1 块（与 lib/tools/index.ts 是否 push
      // `delegate_task` 工具同源），false 时两边都撤，避免 LLM 看到
      // 工具但不知道何时用，或反之。字符串形态因为本文件用 `Record<string, string>`
      // ——这里把 boolean 显式 'true' / 'false' 字面化进变量表，buildSystemPrompt
      // 那边只比对 `=== 'true'` 即可，不引入新分支类型。
      workerTeamEnabled: String(storedTeamEnabled),
      // Persona (Subtask 2) 1-line binding 走 `{{PERSONA_BINDING}}` 占位符替换
      // （RAG 风格，inline 单行）。OFF 时 personaBindingLine 返回 '' → 占位符替换
      // 为空，prompt byte-shape 保持 pre-Subtask-2 字节稳定。ON 且 identity.name
      // 设置时输出 1 句人设摘要，注入到 Output & Communication section。
      personaBinding: personaOnSnapshot
        ? personaBindingLine(personaIdentityValue, t)
        : '',
      // personaSoul + personaIdentityJson 单独传：buildSystemPrompt 内
      // compilePersonaBlock parse identityJson → PersonaIdentity、读 soul → SOUL 副本。
      // OFF 时 buildSystemPrompt 不读这些字段（也不会 push persona block），
      // personaBinding='' + 占位符='' → 完全不影响 prompt。
      personaSoul: personaSoulValue,
      personaIdentityJson: JSON.stringify(personaIdentityValue),
    }),
  );
}

// ─── 公开 API ───

export { composeSystemPrompt, composeUserMessage };

// 模块级常量：把 reminder 文本放到模块级（不在 buildUserMessage 里 inline）
// 让 prompt-envelope 的 wrapReminderInstructions 与 retry 路径下的
// rewriteReminderInstructions 在同一份常量上对齐，避免一处改了一处没改。
/** LLM-facing reminder copy (English only — schema/contract text per project rule).
 *  Positioned next to <user-request> so it overrides the native-tool default the
 *  LLM learned from the system prompt. Don't i18n-ify without also reviewing
 *  what the reminder needs to say. */
export const TEAM_REMINDER_COPY =
  'Worker Team is ON for this turn. If the user asks you to create, build, generate, ' +
  'or substantially rewrite a non-trivial HTML page, dashboard, or interactive demo, ' +
  'call `delegate_task` first with `role: \'frontend_coder\'` and an `output_path`. ' +
  'Use native fs tools yourself only for brief answers, reads/searches, or small follow-up edits.';
