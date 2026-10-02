//
// 索引决策 — 纯函数，不碰 IO。
//
// `indexCollection` 里最纠结的几件事（该删哪些、该不该删、哪些 chunk 尾部多余、
// 哪些向量能复用、模型是否混用）全在这里算完。抽出来的理由很实际：这些判断依赖
// `File[]` + embedder + DB，留在 `indexCollection` 里就只能靠手工验证，而它们
// 恰恰是最不能出错的部分——判错要么静默删数据，要么静默把两种模型的向量混进
// 同一个空间。
//

/** 已存在于 Neon 的一行。只取判断所需字段——**不含向量**（见 `neon-client`）。 */
export interface ExistingChunk {
  sourcePath: string;
  chunkIndex: number;
  contentHash: string;
  /** 写入时用的嵌入模型。`''` 表示该行没有记录（旧数据）。 */
  model: string;
  /** 写入时的向量宽度。`0` 表示没有记录。 */
  dim: number;
  /** 结构化 heading 路径（空串表示无结构）。 */
  headingPath: string;
  /** LLM 生成的上下文前缀（空串表示 CR 关闭或生成失败）。 */
  llmPrefix: string;
  /** 源文档全文的哈希。决定旧前缀是否仍然适用——前缀由 LLM 依据**整篇文档**
   *  与 chunk 位置生成，文档变了旧前缀描述的就不是这个位置了。 */
  docHash: string;
}

/** 本次将要写入的 chunk（切分后、嵌入前）。 */
export interface IncomingChunk {
  sourcePath: string;
  chunkIndex: number;
  contentHash: string;
  headingPath: string;
  llmPrefix: string;
  docHash: string;
}

export interface PlanInput {
  existing: ExistingChunk[];
  incoming: IncomingChunk[];
  /** 用户是否显式要求「让 collection 与本次选择一致」。默认 `false` =
   *  只增不删。 */
  syncMode: boolean;
  /** 本次选中的文件名。用于区分「没选任何东西」与「选了但都是空文件」。 */
  activePaths: string[];
  /** 本次使用的嵌入模型与宽度。 */
  current: { model: string; dim: number };
  /** 本次是否开启 Contextual Retrieval。关闭时最终前缀恒为 `''`，据此判断
   *  旧前缀是否还有效。 */
  contextualEnabled: boolean;
}

export interface PlanResult {
  /** `'mixed-model'` 表示 collection 里存有另一种模型的向量、且它们**会活过**
   *  本次运行——继续写就会让两种空间混在同一个 collection 里。调用方应中止并
   *  给出两条出路（选齐文件 / 改用同步模式）。 */
  verdict: 'ok' | 'mixed-model';
  /** 需要整份删除的 `source_path`。**只在 `syncMode` 下可能非空。** */
  prune: string[];
  /** 存在于 collection、但不在本次选择里的文件——用于提示用户。**不等于
   *  「已从磁盘删除」**：我们不追踪磁盘状态，分不出「文件删了」与「这次没选」。 */
  notInLastRun: { path: string; chunks: number }[];
  /** 需要裁掉尾部的文件：`chunk_index >= fromIndex` 的行是上一次留下的多余
   *  部分（文件变短了）。 */
  tailPrune: { sourcePath: string; fromIndex: number }[];
  /** 可以沿用旧向量的 chunk，键为 `reuseKey()` 的返回值。
   *  未列入的都要重新嵌入。 */
  reuse: Set<string>;
  /** 可以沿用旧 LLM 前缀的 chunk（键同上），从而省掉一次 LLM 调用。
   *
   *  条件比复用向量**更严**：前缀由 LLM 依据整篇文档与 chunk 位置生成，所以
   *  文档内容变了（`doc_hash` 不同）或文件内 chunk 总数变了，旧前缀描述的就不再
   *  是当前位置——必须重生成。 */
  reusePrefix: Set<string>;
}

/** 复用键。`source_path` 可能含 `#`（文件名允许），所以用最后一个 `#` 分隔是
 *  不够的——这里改成 `\u0000` 分隔符，任何合法文件名都不会包含它。 */
export function reuseKey(sourcePath: string, chunkIndex: number): string {
  return `${sourcePath}\u0000${chunkIndex}`;
}

/** 按 `source_path` 分组并计数。 */
function groupByPath<T extends { sourcePath: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const arr = out.get(it.sourcePath);
    if (arr) arr.push(it);
    else out.set(it.sourcePath, [it]);
  }
  return out;
}

/**
 * 算出本次索引要做的删除与复用。
 *
 * ## 删除（按危险程度递增）
 *
 * 1. **尾部裁剪**（始终执行，安全）：文件从 10 个 chunk 变成 7 个时，删掉
 *    `chunk_index >= 7`。因为 `chunk_index` 永远是 `0..N-1` 的连续前缀（即使
 *    上次中途取消也一样），所以「删 `>= N`」恰好留下新的 `0..N-1`。作用域被
 *    `source_path` 锁死，不可能碰到别的文件。
 *
 * 2. **不同步就不删**（默认）：`prune` 为空。往 {A, B} 里加 C 时，A、B 原样
 *    保留——这正是「只增不删」的意义。
 *
 * 3. **同步才删，且需用户确认**：`prune` 列出不在本次选择里的文件，由调用方
 *    弹确认框。用户看到的是**确切的文件名**。
 *
 * `activePaths` 为空时 `prune` 恒为空：绝不基于空集合做删除。
 *
 * ## 复用向量
 *
 * 复用条件是「**送进嵌入端点的那个串逐字节相同，且模型没变**」——不是逐个字段
 * 罗列。输入是 `buildContextLine(headingPath, llmPrefix) + '\n\n' + content`，
 * 所以四项都要对上：`content_hash`（content）、`heading_path`、`llm_prefix`、
 * 以及 `(model, dim)`。
 *
 * 最后一条常被漏掉：向量属于**生成它的那个模型的空间**。模型换了而其余都相同，
 * 复用旧向量会把两个空间混在一起，cosine 从此没有意义，而且不会报任何错。
 *
 * ## 模型混用
 *
 * 判据是「**会不会有异模型的行活过本次运行**」，而不是「collection 里有没有」：
 *
 * - 同步模式：`activePaths` 之外的行都会被删，最终状态必然干净 → **永不报警**。
 * - 只增模式：所有已存在的行都会留下 → 只要有异模型的行就报警。
 *
 * 用「幸存者」而不是「现有」来判，是为了让「重跑一遍换模型」这条正路走得通——
 * 按「现有」判的话，那条路会被自己的守卫挡住。
 */
export function planIndex(input: PlanInput): PlanResult {
  const { existing, incoming, syncMode, activePaths, current, contextualEnabled } = input;

  const existingByPath = groupByPath(existing);
  const incomingByPath = groupByPath(incoming);
  const active = new Set(activePaths);

  const notInLastRun = [...existingByPath.entries()]
    .filter(([path]) => !active.has(path))
    .map(([path, rows]) => ({ path, chunks: rows.length }))
    .sort((a, b) => a.path.localeCompare(b.path));

  // 空集合绝不触发删除——这是最后一道闸。
  const prune = syncMode && activePaths.length > 0 ? notInLastRun.map((r) => r.path) : [];

  // 尾部裁剪：文件从 10 个 chunk 变成 7 个时，删掉 `chunk_index >= 7`。因为
  // `chunk_index` 永远是 `0..N-1` 的连续前缀（即使上次中途取消也一样），所以
  // 「删 `>= N`」恰好留下新的 `0..N-1`。作用域被 `source_path` 锁死。
  //
  // 先算它，是因为模型守卫要用它来判断「哪些行活不过本次运行」。
  const tailPrune: { sourcePath: string; fromIndex: number }[] = [];
  for (const path of activePaths) {
    const incomingCount = incomingByPath.get(path)?.length ?? 0;
    // 本次一个 chunk 都没产出时不裁剪。产出为空更可能是**提取失败**（例如
    // 扫描版 PDF 没有文字层）而不是文件真的空了——此时静默删掉旧 chunk 是
    // 不可逆的误伤。保持既有行为：不动它。
    if (incomingCount === 0) continue;
    const existingCount = existingByPath.get(path)?.length ?? 0;
    if (existingCount > incomingCount) {
      tailPrune.push({ sourcePath: path, fromIndex: incomingCount });
    }
  }
  tailPrune.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

  // 幸存者 = 已存在的行里，**本次不会被重新写入、也不会被删掉**的那些。
  //
  // 三类会被排除：
  //  - 未选中 + 同步模式 → 会被 prune 删掉；
  //  - 已选中且本次会重写该行（键在 `incomingKeys` 里）→ 会被 upsert 覆盖；
  //  - 已选中但超出本次 chunk 数 → 会被尾部裁剪删掉。
  //
  // 用「幸存者」而不是「现有」来判，是为了让「重跑一遍换模型」这条正路走得通：
  // 把 collection 里的文件都选齐重跑、或改用同步模式，两种做法最终状态都是干净的。
  // 按「现有」判的话，这两条路都会被自己的守卫挡住。
  const incomingKeys = new Set(incoming.map((c) => reuseKey(c.sourcePath, c.chunkIndex)));
  const tailPrunedKeys = new Set<string>();
  for (const tp of tailPrune) {
    const existingCount = existingByPath.get(tp.sourcePath)?.length ?? 0;
    for (let i = tp.fromIndex; i < existingCount; i++) {
      tailPrunedKeys.add(reuseKey(tp.sourcePath, i));
    }
  }
  const survivors = existing.filter((r) => {
    const key = reuseKey(r.sourcePath, r.chunkIndex);
    // 未选中：同步模式会删，只增模式留下。
    if (!active.has(r.sourcePath)) return !syncMode;
    if (tailPrunedKeys.has(key)) return false;
    return !incomingKeys.has(key);
  });
  const verdict: PlanResult['verdict'] = survivors.some(
    // `model === ''` 是旧数据（没有记录）——当作「未知」而非「不同」，否则引入
    // 这个字段的那一刻就会把所有老 collection 判成混用。未知的行会被复用谓词
    // 拦下并重新嵌入，所以放它过去是安全的。
    (r) => r.model !== '' && (r.model !== current.model || r.dim !== current.dim),
  )
    ? 'mixed-model'
    : 'ok';

  const reuse = new Set<string>();
  const reusePrefix = new Set<string>();
  const incomingByKey = new Map<string, IncomingChunk>();
  for (const inc of incoming) incomingByKey.set(reuseKey(inc.sourcePath, inc.chunkIndex), inc);

  for (const ex of existing) {
    const key = reuseKey(ex.sourcePath, ex.chunkIndex);
    const inc = incomingByKey.get(key);
    if (!inc) continue;

    // ── 前缀是否还能用 ──
    // 开启 CR 时才谈复用前缀；关闭时最终前缀恒为 `''`（见下方 reuse 判定）。
    // `doc_hash` 里已经掺入了 chunkSize/chunkOverlap（见 `indexer.ts`），所以
    // 「哈希相同」同时蕴含「文档没变」与「切分参数没变」，文件内 chunk 总数自然
    // 也不变——不必单独比 M。
    if (contextualEnabled && ex.llmPrefix !== '' && ex.docHash !== '' && inc.docHash === ex.docHash) {
      reusePrefix.add(key);
    }

    // ── 向量是否还能用 ──
    // 最终前缀：CR 开启且能复用则沿用旧值，否则本次会重新生成（此时已知的
    // `inc.llmPrefix` 还是 `''` 占位，不能据此判等）。CR 关闭时最终恒为 `''`。
    const finalPrefix = contextualEnabled
      ? reusePrefix.has(key)
        ? ex.llmPrefix
        // 尚未生成 → 一定不复用。
        : null
      : '';
    if (finalPrefix === null) continue;

    if (ex.contentHash !== inc.contentHash) continue;
    if (ex.headingPath !== inc.headingPath) continue;
    if (ex.llmPrefix !== finalPrefix) continue;
    // 模型也必须对上：向量属于生成它的那个空间。
    if (ex.model !== current.model || ex.dim !== current.dim) continue;
    reuse.add(key);
  }

  return { verdict, prune, notInLastRun, tailPrune, reuse, reusePrefix };
}
