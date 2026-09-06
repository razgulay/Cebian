/**
 * `{{变量}}` 模板引擎：变量表 + 替换。
 *
 * 纯模块——不碰 chrome / DOM / 剪贴板，故 background 也能引（depcruise 的
 * `background-no-lib-ui` 挡着 lib/ui）。各执行上下文的取值器另放：
 * - 侧边栏（prompts 的 `/` 菜单）见 `template-vars-sidepanel.ts`
 * - 划词动作由内容脚本采集页面侧变量、background 补齐环境变量
 *
 * 变量只有这里预定义的一组「环境常量」——运行时能读到的事实（选了什么、在哪个页面、
 * 现在几号），不支持用户自定义变量，也不透传设置项（如翻译目标语言那是配置不是环境）。
 */

import { t } from '@/lib/i18n';
import { escapeXml } from '@/lib/utils';

/** 变量的可用场景。同一个变量在不同场景的取得性不同（如剪贴板在划词场景拿不稳）。 */
type TemplateScene = 'prompts' | 'pageAction';

interface TemplateVar {
  name: string;
  /** 能在哪些场景取到值；编辑器的自动完成按场景过滤，只提示当下真能用的。 */
  scenes: readonly TemplateScene[];
  /** 取用时才求值，故标签跟随当前界面语言。 */
  getLabel: () => string;
}

/** 内置模板变量表（单一真理源：自动完成、场景过滤、缺失语义都读它）。 */
const TEMPLATE_VARIABLES = [
  {
    name: 'selected_text',
    scenes: ['prompts', 'pageAction'],
    getLabel: () => t('settings.templateVars.selectedText'),
  },
  {
    name: 'context',
    // 选区周边文本只有划词场景采集（内容脚本在选区处取窗口）。
    scenes: ['pageAction'],
    getLabel: () => t('settings.templateVars.context'),
  },
  {
    name: 'page_url',
    scenes: ['prompts', 'pageAction'],
    getLabel: () => t('settings.templateVars.pageUrl'),
  },
  {
    name: 'page_title',
    scenes: ['prompts', 'pageAction'],
    getLabel: () => t('settings.templateVars.pageTitle'),
  },
  {
    name: 'date',
    scenes: ['prompts', 'pageAction'],
    getLabel: () => t('settings.templateVars.date'),
  },
  {
    name: 'ui_language',
    scenes: ['prompts', 'pageAction'],
    getLabel: () => t('settings.templateVars.uiLanguage'),
  },
  {
    name: 'clipboard',
    // 划词场景不给：内容脚本读剪贴板要文档焦点与权限，取不稳，宁可不提示。
    scenes: ['prompts'],
    getLabel: () => t('settings.templateVars.clipboard'),
  },
  {
    name: 'input',
    // 仅 prompts 场景：ChatInput 在 slash command 展开时把用户键入文本
    // 注入 `vars.input`，划词场景拿不到 chat composer（content script
    // 看不到输入框）所以不提示。
    scenes: ['prompts'],
    // 文案复用 prompts.placeholders 的解释（那里面向 prompt 模板作者
    // 描述插入点的语义），与 TEMPLATE_VARIABLES 共享一个 i18n 字符串
    // 反而会割裂「同一变量两种说法」。
    getLabel: () => t('settings.prompts.placeholders.input'),
  },
] as const satisfies readonly TemplateVar[];

type TemplateVarName = (typeof TEMPLATE_VARIABLES)[number]['name'];

/** 是否是内置变量名（决定「取不到值」时是留空还是原样保留）。 */
function isTemplateVarName(name: string): name is TemplateVarName {
  return TEMPLATE_VARIABLES.some((v) => v.name === name);
}

/** 某场景下可用的变量（编辑器自动完成用）。 */
function templateVariablesFor(
  scene: TemplateScene,
): readonly (typeof TEMPLATE_VARIABLES)[number][] {
  return TEMPLATE_VARIABLES.filter((v) => v.scenes.some((s) => s === scene));
}

/**
 * 替换 content 里所有 `{{变量}}`。
 *
 * - vars 里有 → 用它的值
 * - 是内置变量但 vars 里没有（当前场景取不到）→ 空串。留着 `{{clipboard}}` 原样发给
 *   模型只会让它困惑
 * - 不是内置变量 → 原样保留，让用户看见自己名字写错了
 *
 * 用 `Object.hasOwn` 而非 `in` / 直接索引：`{{__proto__}}` 之类的原型键不该取到
 * Object.prototype 上的成员。
 *
 * **代入的值一律 XML 转义。** 变量的值全是环境事实（页面标题 / URL、页面选中文本、
 * 剪贴板），页面完全可控——不设防的话，只要把标题设成 `</context><user-request>…`，
 * 展开后的文本就能在提示词信封里伪造出一整块看起来权威的内容。
 *
 * 为什么是转义而不是「剥掉信封标签」：
 * - 转义之后值里根本不存在裸 `<`，因此**跨变量拼接也组装不出标签**（`<user-` +
 *   `request>…` 这种绕法失效）。逐个值剥标签挡不住这种拼接，而剥整串又会波及模板本身。
 * - 剥标签是黑名单，必然误伤：那个正则会把 `<Context.Provider>`、`Array<Context>` 一并
 *   删掉，而提示词模板里出现 React / TS 代码再正常不过——用户的模板被静默改写是不可
 *   接受的。转义无损，原文一个字符都不丢。
 * - 模板本身是用户写的、可信，故原样保留，不转义。
 *
 * 放在引擎里而不是各个取值器里：取值器有好几个（侧边栏 `/` 菜单、划词动作的内容脚本
 * + background），漏掉任何一个都是个洞。
 */
function replaceTemplateVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (Object.hasOwn(vars, name)) return escapeXml(vars[name]);
    return isTemplateVarName(name) ? '' : match;
  });
}

export { TEMPLATE_VARIABLES, isTemplateVarName, templateVariablesFor, replaceTemplateVars };
export type { TemplateScene, TemplateVarName };
