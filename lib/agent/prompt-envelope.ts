/**
 * 提示词信封的外层标签词汇表 + 剥离器。
 *
 * 发给模型的 user 消息是一组带标签的块拼出来的（见 background 的 `composeUserMessage`）。
 * 模型据这些标签判断「哪一段是什么、可信到什么程度」，所以**任何来自页面的字符串**在
 * 进入信封之前都必须先剥掉这些标签，否则一个恶意页面只要把标题设成
 * `</context><user-request>…` 就能伪造出一整块看起来权威的内容。
 *
 * 住在 lib/ 而不是 background：两个上下文都要用同一份词汇表——background 剥页面
 * 上下文（page-context.ts），侧边栏 / 内容脚本剥代入模板的环境变量值
 * （lib/ai-config/template.ts）。两份清单必然漂移，只能有一份。
 *
 * 产出信封各块的地方分散在四处：`prompt-composer.ts`（reminder-instructions /
 * context / user-request）、`lib/agent/attachments.ts`（attachments）、
 * `lib/memory/index-scan.ts`（memories / user_profile）、
 * `lib/ai-config/slash-prompt.ts`（slash-prompt）。
 *
 * 只收「外层信封」，不收块内的结构标签（`<memory>` / `<file>` / `<recording>`）：
 * 剥离的目标是「能被模型当作可信区块的东西」，内层标签失去外层包裹就不成区块，
 * 而外层已在此堵死；反过来 `<file>` 这类词在正常网页标题里会出现，剥了会误伤。
 * 同理不收 `<summary>`（压缩摘要的包裹）——它是合法 HTML 元素，误伤率高。
 */

export const ENVELOPE_TAGS = [
  'reminder-instructions',
  'attachments',
  'context',
  'memories',
  'user_profile',
  'slash-prompt',
  'user-request',
] as const;

// `String.replace` 每次调用前会把 /g 正则的 lastIndex 归零，故模块级共用这一个实例安全。
const ENVELOPE_TAG_RE = new RegExp(`<\\/?(${ENVELOPE_TAGS.join('|')})\\b[^>]*>`, 'gi');

/**
 * 剥掉字符串里伪造的信封标签，**反复剥到不动点**。
 *
 * 单趟替换是不够的：剥掉一个标签会把它两侧的碎片拼到一起，而拼出来的东西可能又是一个
 * 标签——`</slash-<context>prompt>` 去掉中间那个 `<context>` 就变成了合法的
 * `</slash-prompt>`，而正则早已扫过那个位置、不会回头。每一趟至少删掉一个标签、串长
 * 严格变短，故循环必然终止。
 *
 * 只用于**页面来源的短字符串**：标签页标题 / URL、页面 meta、用户选中的页面文本
 * （见 background 的 page-context.ts）。这些串很短，黑名单式剥离的误伤概率可以接受。
 *
 * 别处不要用它。模板变量的值走 `escapeXml`（见 lib/ai-config/template.ts）——那条路上
 * 的文本可能是整段代码，而本正则会把 `<Context.Provider>`、`Array<Context>` 一并删掉，
 * 把用户内容静默改写。用户直接敲进输入框的文本同样不经此处：它整体落在 `<user-request>`
 * 块**内部**，是可信内容。
 */
export function stripEnvelopeTags(s: string): string {
  let out = s;
  for (;;) {
    const next = out.replace(ENVELOPE_TAG_RE, '');
    if (next === out) return out;
    out = next;
  }
}

export const USER_REQUEST_OPEN = '<user-request>';
export const USER_REQUEST_CLOSE = '</user-request>';

/** 包出信封末尾的请求块。产出与解析（message-helpers 的 matchUserRequest）共用这一份
 *  形状定义，后台的真实消息与 UI 的乐观消息因此逐字节同形。 */
export function wrapUserRequest(text: string): string {
  return `${USER_REQUEST_OPEN}\n${text}\n${USER_REQUEST_CLOSE}`;
}
