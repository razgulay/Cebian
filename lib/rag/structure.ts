//
// 越南法律文书的结构探测 — 纯函数，不感知尺寸。
//
// 语料以 `Phần > Chương > Mục > Điều > Khoản > Điểm` 组织。按字符窗口切分
// 会把 `Điều 4. …` 的标题与正文拆到相邻两个 chunk，丢掉法律检索最重要的信号。
// 这个模块只回答「哪些行是 heading、它们如何嵌套」，切分尺寸的决策留给
// `chunker.ts`。
//

/** 层级数字越小越外层：`Phần > Chương > Mục > Tiểu mục > Điều`。
 *  `Tiểu mục` 是 `Mục` 的子级（不是同级），所以必须占独立层级——否则祖先栈
 *  会在遇到 `Tiểu mục` 时把 `Mục` 弹掉，路径里丢掉父级。
 *
 *  key 一律小写：正则带 `i` 后捕获到的是**原文**（可能是 `PHẦN`），查表前统一
 *  小写。注意 `'PHẦN'.toLowerCase()` 是 `'phần'`（p 也变常小写），所以 key 必须
 *  全小写，不能写成 `'Phần'`。 */
const LEVEL: Record<string, number> = {
  'phần': 1,
  'chương': 2,
  'mục': 3,
  'tiểu mục': 4,
  'điều': 5,
};

/** `Điều` 是叶子型：它必须有正文。其余（Phần/Chương/Mục/Tiểu mục）是容器型，
 *  其内容就是子 heading，本身可以没有正文——见 `detectHeadings` 的空正文规则。 */
const LEAF_LEVEL = 5;

/** 越南法律 heading。行首锚定 + 必须紧跟数字/罗马数字 + 必须跟 `[.:]` 或行尾，
 *  三条合起来把 `…theo Điều 5 của Luật…`（句中）与 `Điều 4 quy định rằng`
 *  （无标点且非行尾）都挡在外面。
 *
 *  带 `i` 标志：越南法律文书常把 `PHẦN` / `CHƯƠNG` / `MỤC` / `ĐIỀU` 全大写，
 *  不匹配就等于漏掉最外层结构。捕获组保留原文大小写，`headingPath` 因此输出
 *  `PHẦN I` 而不是被改写成 `Phần I`。
 *
 *  尾部用 `[\s\S]*` 而非 `.*`：`.` 不匹配行终止符，用 `.*` 时 `Điều 1. X\r`
 *  （CRLF 未归一化的输入）会整行失配。调用方通常会先归一化，但这里多一层
 *  防御不花成本。 */
const VN_HEADING =
  /^\s*(Tiểu mục|Chương|Mục|Điều|Phần)(?:\s+thứ)?\s+([0-9]+[a-zA-Z]?|[IVXLCDM]+|nhất|hai|ba|bốn|tư|năm|sáu|bảy|tám|chín|mười)\s*(?:[.:]\s*|\s*$)([\s\S]*)$/iu;

/** Markdown ATX heading。要求 `#` 后有空格，且（在 `detectHeadings` 里）整行
 *  位于行首并在空行之后——用来把 Python/shell 的 `# 注释` 区分开。 */
const RE_ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** 代码围栏。围栏内的一切都不参与探测——直接消掉「代码块里有 `#`」这类误判。 */
const RE_FENCE = /^\s*(```|~~~)/;

/** `Khoản` 起始行：`1. 内容`。这是全宇宙误报率最高的模式（任何有序列表都长
 *  这样），所以**只**在所属 section 的最内层 heading 是 `Điều` 时才启用。 */
const RE_CLAUSE = /^\s*\d{1,3}\.\s+\S/;

/** 低于此数就不认为文档有结构，整篇作为单个无 heading 的 section。
 *
 *  1–2 个 heading 最多切出 2–3 段，而判错的代价是**整篇**切分方式改变——只因
 *  一次正则命中（例如正文里引用了一句 `Điều 1.`）。3 是「规律」还能压过
 *  「巧合」的最小值。语料是法律文书（几十到几百个 `Điều`），远高于此。 */
export const MIN_HEADINGS = 3;

export type HeadingKind = 'container' | 'leaf';

export interface Heading {
  /** 行号，0 起。 */
  lineIndex: number;
  level: number;
  kind: HeadingKind;
  /** 原始行（已 trim），保持原文形式——NFD 输入不会被转成 NFC。 */
  text: string;
}

export interface Section {
  text: string;
  /** 祖先 heading，最外层在前。无结构时为 `[]`。 */
  headingPath: string[];
  /** 最内层 heading 的类型。`null` 表示无结构（序言段）。
   *
   *  用 `kind` 而不是层级数字来做 `Khoản` 门控：markdown 的 `####` 会拿到
   *  level 4，与 `Điều` 的数字撞车，仅凭 level 判断会把普通有序列表当成
   *  `Khoản` 切开。 */
  innermostKind: HeadingKind | null;
}

/**
 * 探测 heading，两遍扫描。
 *
 * **第一遍**只标记候选，不做任何取舍，候选集在此冻结。
 * **第二遍**应用空正文规则：容器型一律保留；叶子型若到下一个候选之间没有任何
 * 「非空且非候选」的行，就降级为正文。
 *
 * 之所以要两遍：如果边扫边判，降级会连锁——目录里 40 行 `Điều N.` 会因为
 * 「下一个是候选」被逐个降级，但降级本身又改变了后续判断的依据。冻结候选集
 * 之后每行都用同一套基准独立判定，40 行一起降级，而不是降到第 39 行就停。
 *
 * 已知边界：目录里每行**都有**正文时（罕见）仍会被当成 heading；纯文本无法
 * 区分目录中的 `Điều 4. Quy định` 与正文里的同名行。
 */
export function detectHeadings(text: string): Heading[] {
  const lines = text.split('\n');
  const candidates: Heading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (RE_FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // 只用 NFC 做**匹配**；`text` 始终取原串，绝不从归一化后的串上切片。
    // PDF 与 macOS 来源常产出 NFD（`Điều` = Đ + i + ê + ̂ 分解形式）。
    const line = raw.normalize('NFC');

    const vn = VN_HEADING.exec(line);
    if (vn) {
      // 正则带 `i`，捕获到的是原文（可能是 `PHẦN`）。查表前统一小写——
      // 表 key 也全是小写。`text` 仍取原串，保留原文大小写。
      const level = LEVEL[vn[1]!.toLowerCase()];
      if (level === undefined) {
        // 正则与 LEVEL 表不同步才会走到这里（加了新关键词却忘了加表项）。
        // 抛错而不是静默降级——静默会让整类 heading 无声消失。消息里点名要改
        // 的那张表，触发者才知道去哪里补。
        throw new Error(
          `Unmapped legal heading keyword "${vn[1]}" — add it to LEVEL in lib/rag/structure.ts`,
        );
      }
      candidates.push({
        lineIndex: i,
        level,
        kind: level === LEAF_LEVEL ? 'leaf' : 'container',
        text: raw.trim(),
      });
      continue;
    }

    // Markdown heading 视为容器型：它合法地可以只有子 heading 而没有正文，
    // 且 markdown 目录通常是链接列表（`- [x](#y)`）不会命中 ATX。
    const atx = RE_ATX.exec(line);
    if (atx && (i === 0 || lines[i - 1]!.trim() === '')) {
      candidates.push({
        lineIndex: i,
        level: atx[1]!.length,
        kind: 'container',
        text: raw.trim(),
      });
    }
  }

  const isCandidate = new Set(candidates.map((c) => c.lineIndex));
  return candidates.filter((c) => {
    if (c.kind === 'container') return true;
    for (let k = c.lineIndex + 1; k < lines.length; k++) {
      // 遇到下一个 heading：本段没有正文。
      if (isCandidate.has(k)) break;
      if (lines[k]!.trim() !== '') return true;
    }
    return false;
  });
}

/**
 * 按 heading 切段。每个 section 从自己的 heading 行开始，到下一个 heading 行
 * 之前结束；第一个 heading 之前的内容作为 `headingPath: []` 的序言段。
 *
 * 不变式：`splitHeadingSections(t).map(s => s.text).join('\n') === t`。
 * section 是连续的行区间且完整覆盖全文，所以拼接可还原。
 */
export function splitHeadingSections(text: string): Section[] {
  const headings = detectHeadings(text);
  if (headings.length < MIN_HEADINGS) {
    return [{ text, headingPath: [], innermostKind: null }];
  }

  const lines = text.split('\n');
  const sections: Section[] = [];

  const firstLine = headings[0]!.lineIndex;
  if (firstLine > 0) {
    // `text` 已 trim 过（调用方保证），所以序言非空——否则首个 heading 会在第 0 行。
    sections.push({
      text: lines.slice(0, firstLine).join('\n'),
      headingPath: [],
      innermostKind: null,
    });
  }

  const stack: Heading[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= cur.level) stack.pop();
    stack.push(cur);

    const start = cur.lineIndex;
    const end = h + 1 < headings.length ? headings[h + 1]!.lineIndex : lines.length;
    sections.push({
      text: lines.slice(start, end).join('\n'),
      headingPath: stack.map((s) => s.text),
      innermostKind: cur.kind,
    });
  }

  return sections;
}

/**
 * 把过长 section 按 `Khoản`（`1. …`）拆开。首个分片保留 heading 行。
 * 无 `Khoản` 边界时原样返回单元素数组。
 */
export function splitByClause(text: string): string[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (RE_CLAUSE.test(lines[i]!)) starts.push(i);
  }
  if (starts.length === 0) return [text];

  const out: string[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = s === 0 ? 0 : starts[s]!;
    const to = s + 1 < starts.length ? starts[s + 1]! : lines.length;
    out.push(lines.slice(from, to).join('\n'));
  }
  return out;
}

/** 是否应在这个 section 内启用 `Khoản` 切分——只有最内层是叶子型（`Điều`）
 *  时。用 `kind` 判定，不用层级数字：markdown `####` 的 level 也是 4，
 *  仅凭数字会把普通有序列表误当 `Khoản` 切开。 */
export function canSplitByClause(section: Section): boolean {
  return section.innermostKind === 'leaf';
}
