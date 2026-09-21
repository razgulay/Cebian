// lib/telegram-gateway/message-split.ts — Telegram 回复的 finalize 切分器
// （首段锚点模型：agent 运行期间聊天窗只有 reaction / typing，完整回复在
// agent_end 一次性落位——Block 1 是**完整的第一段**，语义优先、不做字符截断；
// 其余段落按 ≤2000 字符分组补发）。
//
// 两层结构：
//   splitReply   — 主入口。fence-aware 段落化（空行 = 段落边界；``` 围栏整块
//                  原子——fence 内的空行不产生边界）→ Block 1 = 第一段 → 其余
//                  段落贪心分组 → 超过 Bot API 硬上限的超长单段用 splitMessage
//                  按句子兜底再切。
//   splitMessage — 通用窗口切分器（段落 → 换行 → 句末 → 空格 → 硬切 +
//                  fence 守卫），在这里只承担「单段超长」的兜底角色。
//
// 块边界处的首尾空白由组装侧裁剪（块与块之间是独立消息，段落间隔由消息边界
// 本身表达，首尾空行不携带信息）。

/** Bot API 单条消息的安全硬上限（实际 4096，留 Markdown 实体余量）。 */
export const TELEGRAM_HARD_LIMIT = 4_000;
/** Block 2+ 的段落分组上限（需求区间 1500–2000 取上界）。 */
const PARAGRAPH_BLOCK_LIMIT = 2_000;

// ─── 通用窗口切分（超长单段的兜底）───

/** 数 ``` 围栏标记数量（奇数 = 切点落在未闭合围栏内）。 */
function fenceMarkerCount(text: string): number {
  return text.split('```').length - 1;
}

/** 围栏守卫：`end` 落在未闭合围栏内 → 回退到围栏开始处；否则原样返回。 */
function fenceSafeCut(rest: string, end: number): number {
  if (fenceMarkerCount(rest.slice(0, end)) % 2 === 0) return end;
  const open = rest.lastIndexOf('```', end - 1);
  return open;
}

/**
 * 在 `rest` 的前 `limit` 个字符里找下一个切点。候选按优先级排列（段落 →
 * 换行 → 句末标点 → 空格 → 硬切），逐个过围栏守卫，全败则硬切（内容完整优先）。
 */
function findCutPoint(rest: string, limit: number): number {
  const candidates: number[] = [];
  const para = rest.lastIndexOf('\n\n', limit);
  if (para > 0) candidates.push(para);
  const line = rest.lastIndexOf('\n', limit);
  if (line > 0) candidates.push(line);
  // 越窗即停（后续匹配只会更远）——保证块 ≤ limit
  let sentence = -1;
  const re = /[.!?。！？…]["'”’)]*\s/g;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    if (m.index + m[0].length > limit) break;
    sentence = m.index + m[0].length;
  }
  if (sentence > 0) candidates.push(sentence);
  const space = rest.lastIndexOf(' ', limit);
  if (space > 0) candidates.push(space);
  candidates.push(limit);
  for (const end of candidates) {
    const safe = fenceSafeCut(rest, end);
    if (safe > 0) return safe;
  }
  return limit;
}

/**
 * 通用窗口切分器：把文本切成每块 ≤ limit 的消息块。块边界优先落在段落 /
 * 句子边界上，块首尾空白裁剪掉。
 */
export function splitMessage(text: string, limit = TELEGRAM_HARD_LIMIT): string[] {
  // 防御：非法 limit 会让 findCutPoint 返回 0、循环永不终止
  if (limit < 1) return [text];
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = findCutPoint(rest, limit);
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// ─── fence-aware 段落化 + 首段锚点 ───

/**
 * 段落化：fence 外的空行 = 段落边界；``` 围栏整块原子（fence 内的空行不产生
 * 边界）。返回非空段落 / fence 块的有序列表。
 */
function toSegments(text: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    if (!inFence && line.trim() === '' && current.length > 0) {
      const seg = current.join('\n').trim();
      if (seg) segments.push(seg);
      current = [];
      continue;
    }
    current.push(line);
  }
  const tail = current.join('\n').trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * 主入口：Block 1 = 完整的第一段（语义优先，不做字符截断）；其余段落贪心
 * 分组成 ≤ PARAGRAPH_BLOCK_LIMIT 的块（多个小段并作一条，少刷屏）；任何块
 * 超过 Bot API 硬上限（超长单段）→ splitMessage 按句子兜底再切。
 */
export function splitReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const segments = toSegments(trimmed);
  if (segments.length === 0) return [trimmed];
  const blocks: string[] = [segments[0]!];
  let buf = '';
  for (const seg of segments.slice(1)) {
    if (!buf) {
      buf = seg;
    } else if (buf.length + 2 + seg.length > PARAGRAPH_BLOCK_LIMIT) {
      blocks.push(buf);
      buf = seg;
    } else {
      buf = `${buf}\n\n${seg}`;
    }
  }
  if (buf) blocks.push(buf);
  return blocks.flatMap((b) => (b.length > TELEGRAM_HARD_LIMIT ? splitMessage(b, TELEGRAM_HARD_LIMIT) : [b]));
}
