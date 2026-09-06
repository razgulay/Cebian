/**
 * 斜杠提示词：用户在输入框里用 `/` 挑中的那条提示词模板。
 *
 * 它是「本轮携带的一段指令」，不是用户自己敲的话——所以在 user 消息的信封里自成一块
 * `<slash-prompt>`，而不是拼进 `<user-request>`。两个直接好处：
 * - transcript 里的用户气泡只显示 `/名字` 加用户真正打的字，不展开正文（`extractUserText`
 *   只读 `<user-request>`）；
 * - 编辑一条已发送的消息不会把这段指令一起改掉（`replaceUserText` 同样只动 `<user-request>`）。
 */

import { escapeXml } from '@/lib/utils';

export interface SlashPrompt {
  /** 提示词名（frontmatter 的 `name`，缺省为文件名），即菜单里 `/` 后面那截。 */
  name: string;
  /** 模板变量**已展开**的正文。展开发生在选中的那一刻，所以这里就是最终发给模型的
   *  文本（气泡里不展开它）。 */
  body: string;
}

/** 用户只挂了提示词、一个字没打时，`<user-request>` 里放的话。
 *
 *  信封的不变式是「请求块永远在最后、且非空」；留一个空块会让模型以为这一轮没有请求。
 *  这句话是模型可见的提示词文本，因此固定英文，与信封里其余各块一致。
 *
 *  刻意不带尖括号：它被放进 `<user-request>` 里，写成 `<slash-prompt>` 会在信封里留下
 *  一个没有闭合的嵌套元素。 */
export const SLASH_PROMPT_ONLY_REQUEST = 'Follow the instructions in the slash-prompt block above.';

/**
 * 把一条斜杠提示词拼成信封里的 `<slash-prompt>` 块。
 *
 * `name` 进属性，按属性规则转义。正文**不转义**：提示词模板是用户自己写的，而模板里
 * 出现 XML / HTML 片段是家常便饭，转义会篡改其本意——与 `<user-request>` 对用户文本
 * 的处理一致。
 *
 * 正文里页面可控的那部分（模板变量的值）已在 `replaceTemplateVars` 转义过，因此这里
 * 剩下的尖括号都出自用户自己写的模板。不再对正文做任何剥离——那会连 `<Context.Provider>`
 * 这类正常代码一起删掉，把用户的提示词静默改写，代价远大于收益。
 *
 * 残余风险是用户自己在模板里写了字面量 `</slash-prompt>`：块会被提前截断。与用户直接
 * 在输入框里打出信封标签同级，属于可信内容的自伤，不为它牺牲正文保真。
 */
export function buildSlashPromptBlock(prompt: SlashPrompt): string {
  const name = escapeXml(prompt.name, { forAttribute: true });
  return `<slash-prompt name="${name}">\n${prompt.body.trim()}\n</slash-prompt>`;
}
