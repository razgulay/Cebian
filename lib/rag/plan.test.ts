import { describe, expect, it } from 'vitest';
import { planIndex, type ExistingChunk, type IncomingChunk } from './plan';

/** `planIndex` 决定删什么。判错就是静默删数据，所以这里覆盖的是**安全边界**
 *  而不是happy path。 */
describe('planIndex — prune 安全边界', () => {
  const existingRow = (
    sourcePath: string,
    chunkIndex: number,
    over: Partial<ExistingChunk> = {},
  ): ExistingChunk => ({
    sourcePath,
    chunkIndex,
    contentHash: `h${chunkIndex}`,
    model: 'm',
    dim: 4,
    headingPath: '',
    llmPrefix: '',
    docHash: 'd',
    ...over,
  });

  const incomingRow = (
    sourcePath: string,
    chunkIndex: number,
    over: Partial<IncomingChunk> = {},
  ): IncomingChunk => ({
    sourcePath,
    chunkIndex,
    contentHash: `h${chunkIndex}`,
    headingPath: '',
    llmPrefix: '',
    docHash: 'd',
    ...over,
  });

  const rowsFor = (path: string, n: number): ExistingChunk[] =>
    Array.from({ length: n }, (_, i) => existingRow(path, i));

  it('activePaths 为空 → 绝不产生任何 prune', () => {
    // 最便宜也最重要的一条：绝不基于空集合删数据。
    const r = planIndex({
      existing: [...rowsFor('a.txt', 3), ...rowsFor('b.txt', 2)],
      incoming: [],
      syncMode: true, // 即使显式要求同步
      activePaths: [],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.prune).toEqual([]);
  });

  it('默认模式（syncMode=false）→ prune 恒为空，即使有文件不在本次选择里', () => {
    const r = planIndex({
      existing: [...rowsFor('a.txt', 3), ...rowsFor('b.txt', 2)],
      incoming: [incomingRow('c.txt', 0)],
      syncMode: false,
      activePaths: ['c.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.prune).toEqual([]);
    // 但用户应当被提示这两个文件不在本次选择里。
    expect(r.notInLastRun.map((x) => x.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('往 {A,B} 里加 C：A、B 完整保留', () => {
    const r = planIndex({
      existing: [...rowsFor('a.txt', 3), ...rowsFor('b.txt', 2)],
      incoming: [incomingRow('c.txt', 0)],
      syncMode: false,
      activePaths: ['c.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.prune).toEqual([]);
    expect(r.tailPrune).toEqual([]);
  });

  it('同步模式 → prune 列出不在本次选择里的文件', () => {
    const r = planIndex({
      existing: [...rowsFor('a.txt', 3), ...rowsFor('b.txt', 2), ...rowsFor('c.txt', 1)],
      incoming: [incomingRow('b.txt', 0), incomingRow('c.txt', 0)],
      syncMode: true,
      activePaths: ['b.txt', 'c.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.prune).toEqual(['a.txt']);
  });

  it('同步模式下若全部文件都在选择里 → prune 为空', () => {
    const r = planIndex({
      existing: rowsFor('a.txt', 3),
      incoming: rowsFor('a.txt', 3).map((e) => incomingRow('a.txt', e.chunkIndex)),
      syncMode: true,
      activePaths: ['a.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.prune).toEqual([]);
  });

  it('notInLastRun 报告每个文件的行数', () => {
    const r = planIndex({
      existing: [...rowsFor('a.txt', 3), ...rowsFor('b.txt', 7)],
      incoming: [],
      syncMode: false,
      activePaths: [],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.notInLastRun).toEqual([
      { path: 'a.txt', chunks: 3 },
      { path: 'b.txt', chunks: 7 },
    ]);
  });
});

describe('planIndex — 尾部裁剪', () => {
  const existingRow = (
    sourcePath: string,
    chunkIndex: number,
    over: Partial<ExistingChunk> = {},
  ): ExistingChunk => ({
    sourcePath,
    chunkIndex,
    contentHash: `h${chunkIndex}`,
    model: 'm',
    dim: 4,
    headingPath: '',
    llmPrefix: '',
    docHash: 'd',
    ...over,
  });
  const incomingRow = (
    sourcePath: string,
    chunkIndex: number,
    over: Partial<IncomingChunk> = {},
  ): IncomingChunk => ({
    sourcePath,
    chunkIndex,
    contentHash: `h${chunkIndex}`,
    headingPath: '',
    llmPrefix: '',
    docHash: 'd',
    ...over,
  });
  const rowsFor = (path: string, n: number): ExistingChunk[] =>
    Array.from({ length: n }, (_, i) => existingRow(path, i));

  it('文件变短 → 裁掉 chunk_index >= 新长度', () => {
    const r = planIndex({
      existing: rowsFor('a.txt', 10),
      incoming: Array.from({ length: 7 }, (_, i) => incomingRow('a.txt', i)),
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([{ sourcePath: 'a.txt', fromIndex: 7 }]);
  });

  it('文件变长 → 不裁剪', () => {
    const r = planIndex({
      existing: rowsFor('a.txt', 3),
      incoming: Array.from({ length: 9 }, (_, i) => incomingRow('a.txt', i)),
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([]);
  });

  it('长度不变 → 不裁剪', () => {
    const r = planIndex({
      existing: rowsFor('a.txt', 4),
      incoming: Array.from({ length: 4 }, (_, i) => incomingRow('a.txt', i)),
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([]);
  });

  it('新文件（collection 里没有）→ 不裁剪', () => {
    const r = planIndex({
      existing: [],
      incoming: [incomingRow('new.txt', 0)],
      syncMode: false,
      activePaths: ['new.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([]);
  });

  it('本次产出 0 chunk → 不裁剪（提取失败不该误删旧数据）', () => {
    // 扫描版 PDF 没有文字层时 chunkDocument 返回 []。这不是「文件变空了」，
    // 而是提取失败——删掉旧 chunk 不可逆。
    const r = planIndex({
      existing: rowsFor('scan.pdf', 12),
      incoming: [],
      syncMode: false,
      activePaths: ['scan.pdf'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([]);
  });

  it('多个文件各自独立裁剪', () => {
    const r = planIndex({
      existing: [...rowsFor('a.txt', 10), ...rowsFor('b.txt', 5)],
      incoming: [
        ...Array.from({ length: 7 }, (_, i) => incomingRow('a.txt', i)),
        ...Array.from({ length: 5 }, (_, i) => incomingRow('b.txt', i)),
      ],
      syncMode: false,
      activePaths: ['a.txt', 'b.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([{ sourcePath: 'a.txt', fromIndex: 7 }]);
  });

  it('尾部裁剪在两种模式下都执行（它是逐文件操作，不是集合删除）', () => {
    const withSync = planIndex({
      existing: rowsFor('a.txt', 10),
      incoming: Array.from({ length: 7 }, (_, i) => incomingRow('a.txt', i)),
      syncMode: true,
      activePaths: ['a.txt'],
      current: { model: 'm', dim: 4 },
      contextualEnabled: false,
    });
    expect(withSync.tailPrune).toEqual([{ sourcePath: 'a.txt', fromIndex: 7 }]);
  });
});

describe('planIndex — 复用谓词', () => {
  const base = {
    sourcePath: 'a.txt',
    chunkIndex: 0,
    contentHash: 'c1',
    headingPath: 'Điều 1',
    llmPrefix: 'p1',
    docHash: 'd1',
  };
  const ex = (over: Partial<ExistingChunk> = {}): ExistingChunk => ({
    ...base, model: 'm', dim: 4, ...over,
  });
  const inc = (over: Partial<IncomingChunk> = {}): IncomingChunk => ({ ...base, ...over });
  const input = (over: Partial<Parameters<typeof planIndex>[0]> = {}) => ({
    existing: [ex()],
    incoming: [inc()],
    syncMode: false,
    activePaths: ['a.txt'],
    current: { model: 'm', dim: 4 },
    contextualEnabled: true,
    ...over,
  });

  it('四项全同 → 复用向量与前缀', () => {
    const r = planIndex(input());
    expect(r.reuse.size).toBe(1);
    expect(r.reusePrefix.size).toBe(1);
  });

  it('content 变了 → 不复用', () => {
    expect(planIndex(input({ incoming: [inc({ contentHash: 'c2' })] })).reuse.size).toBe(0);
  });

  it('heading_path 变了 → 不复用', () => {
    expect(planIndex(input({ incoming: [inc({ headingPath: 'Điều 2' })] })).reuse.size).toBe(0);
  });

  it('模型变了 → 不复用（向量属于生成它的空间）', () => {
    const r = planIndex(input({ current: { model: 'other', dim: 4 } }));
    expect(r.reuse.size).toBe(0);
  });

  it('宽度变了 → 不复用', () => {
    expect(planIndex(input({ current: { model: 'm', dim: 8 } })).reuse.size).toBe(0);
  });

  it('doc_hash 变了 → 前缀不复用，向量也不复用', () => {
    // 前缀描述的是「chunk 在文档中的位置」，文档一变就过期。
    const r = planIndex(input({ incoming: [inc({ docHash: 'd2' })] }));
    expect(r.reusePrefix.size).toBe(0);
    expect(r.reuse.size).toBe(0);
  });

  it('CR 关闭 → 最终前缀为 ""，旧前缀非空则不复用向量', () => {
    // 旧行有 llm_prefix（上次 CR 开着），这次 CR 关掉 → 送入端点的串变了。
    const r = planIndex(input({ contextualEnabled: false }));
    expect(r.reuse.size).toBe(0);
    expect(r.reusePrefix.size).toBe(0);
  });

  it('CR 关闭且旧行本来就没有前缀 → 复用', () => {
    const r = planIndex(input({ contextualEnabled: false, existing: [ex({ llmPrefix: '' })] }));
    expect(r.reuse.size).toBe(1);
  });

  it('新 chunk（数据库里没有）→ 不复用', () => {
    expect(planIndex(input({ existing: [] })).reuse.size).toBe(0);
  });

  it('chunk_index 变了 → 键对不上，不复用', () => {
    expect(planIndex(input({ incoming: [inc({ chunkIndex: 5 })] })).reuse.size).toBe(0);
  });
});

describe('planIndex — 模型混用守卫', () => {
  const mk = (path: string, model: string, dim = 4): ExistingChunk => ({
    sourcePath: path, chunkIndex: 0, contentHash: 'c', model, dim,
    headingPath: '', llmPrefix: '', docHash: 'd',
  });
  const incFor = (path: string): IncomingChunk => ({
    sourcePath: path, chunkIndex: 0, contentHash: 'c',
    headingPath: '', llmPrefix: '', docHash: 'd',
  });

  it('只增模式下有异模型的行 → 报警', () => {
    const r = planIndex({
      existing: [mk('a.txt', 'old')],
      incoming: [incFor('b.txt')],
      syncMode: false,
      activePaths: ['b.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('mixed-model');
  });

  it('只增模式下异模型的行正好会被覆盖 → 不报警', () => {
    const r = planIndex({
      existing: [mk('a.txt', 'old')],
      incoming: [incFor('a.txt')],
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('ok');
  });

  it('同步模式下异模型的行会被删掉 → 不报警（否则换模型无路可走）', () => {
    const r = planIndex({
      existing: [mk('a.txt', 'old')],
      incoming: [incFor('b.txt')],
      syncMode: true,
      activePaths: ['b.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('ok');
  });

  it('宽度不同也算混用', () => {
    const r = planIndex({
      existing: [mk('a.txt', 'new', 8)],
      incoming: [incFor('b.txt')],
      syncMode: false,
      activePaths: ['b.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('mixed-model');
  });

  it('旧数据没有 model 记录 → 不当作混用（否则引入字段当天所有旧 collection 全废）', () => {
    const r = planIndex({
      existing: [mk('a.txt', '')],
      incoming: [incFor('b.txt')],
      syncMode: false,
      activePaths: ['b.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('ok');
  });
});

describe('planIndex — 守卫不得挡住合法的换模型', () => {
  const mk = (path: string, i: number, model: string): ExistingChunk => ({
    sourcePath: path, chunkIndex: i, contentHash: `c${i}`, model, dim: 4,
    headingPath: '', llmPrefix: '', docHash: 'd',
  });
  const inc = (path: string, i: number): IncomingChunk => ({
    sourcePath: path, chunkIndex: i, contentHash: `c${i}`,
    headingPath: '', llmPrefix: '', docHash: 'd',
  });

  it('文件变短 + 换模型（只增模式）→ ok，因为多余尾部会被裁掉', () => {
    // 回归：曾经把「会被尾部裁剪删掉的行」也算作幸存者，导致这条正路被守卫挡住，
    // 而提示里的「改用同步模式」也救不了（同步模式下 prune 为空、守卫照样 fire）。
    const r = planIndex({
      existing: Array.from({ length: 10 }, (_, i) => mk('a.txt', i, 'old')),
      incoming: Array.from({ length: 7 }, (_, i) => inc('a.txt', i)),
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.tailPrune).toEqual([{ sourcePath: 'a.txt', fromIndex: 7 }]);
    expect(r.verdict).toBe('ok');
  });

  it('文件变长 + 换模型 → ok（所有旧行都会被覆盖）', () => {
    const r = planIndex({
      existing: Array.from({ length: 3 }, (_, i) => mk('a.txt', i, 'old')),
      incoming: Array.from({ length: 9 }, (_, i) => inc('a.txt', i)),
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('ok');
  });

  it('选齐整个 collection + 换模型 → ok', () => {
    const r = planIndex({
      existing: [mk('a.txt', 0, 'old'), mk('b.txt', 0, 'old')],
      incoming: [inc('a.txt', 0), inc('b.txt', 0)],
      syncMode: false,
      activePaths: ['a.txt', 'b.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('ok');
  });

  it('漏选一个文件 + 换模型 → 仍然报警（那才是真的会留下混用）', () => {
    const r = planIndex({
      existing: [mk('a.txt', 0, 'old'), mk('b.txt', 0, 'old')],
      incoming: [inc('a.txt', 0)],
      syncMode: false,
      activePaths: ['a.txt'],
      current: { model: 'new', dim: 4 },
      contextualEnabled: false,
    });
    expect(r.verdict).toBe('mixed-model');
  });
});
