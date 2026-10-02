import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatEmbedder, probeEmbeddingDim } from './embedder';

/** `probeEmbeddingDim` 是 dim 的权威来源：它必须**永不抛错**，因为「宽度与
 *  预期不符」正是它要产出的答案，而不是故障。若它抛错，Settings 的连接测试
 *  会连带失败，用户就再也拿不到那条「你的模型其实是 1024 维」的提示。 */
describe('probeEmbeddingDim — 探测真实宽度', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(payload: unknown) {
    // 每次调用都新建 Response：重试会重新发起请求并重新读 body，复用同一个
    // Response 实例会报 "Body is already read"。
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify(payload)),
    ) as unknown as typeof fetch;
  }

  const CFG = { baseUrl: 'http://localhost:8317/v1', apiKey: '', model: 'bge-m3' };

  it('返回端点实际给出的宽度，而不是任何预期值', async () => {
    mockFetch({ data: [{ embedding: new Array(1024).fill(0.1), index: 0 }] });
    const r = await probeEmbeddingDim(CFG);
    expect(r.ok).toBe(true);
    expect(r.dim).toBe(1024);
    expect(r.model).toBe('bge-m3');
  });

  it('宽度与任何"预期"都无关——1024 维不会被当成错误', async () => {
    // 这正是那个真实故障的形态：设置写 1536，模型实际给 1024。
    // 探测必须把 1024 如实报出来，而不是按 1536 去校验后抛错。
    mockFetch({ data: [{ embedding: new Array(1024).fill(0) }] });
    const r = await probeEmbeddingDim(CFG);
    expect(r.dim).toBe(1024);
    expect(r.ok).toBe(true);
  });

  it('HTTP 错误 → ok:false 且带错误信息，不抛错', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response('model not found', { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await probeEmbeddingDim(CFG);
    expect(r.ok).toBe(false);
    expect(r.dim).toBe(0);
    expect(r.error).toContain('404');
  });

  it('网络异常 → ok:false，不抛错', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const r = await probeEmbeddingDim(CFG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('响应体里的 error.message → ok:false', async () => {
    mockFetch({ error: { message: 'invalid api key' } });
    const r = await probeEmbeddingDim(CFG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid api key');
  });

  it('返回空向量数组 → ok:false（拿不到宽度）', async () => {
    mockFetch({ data: [] });
    const r = await probeEmbeddingDim(CFG);
    expect(r.ok).toBe(false);
  });
});

/** 抽出 `postEmbeddings` 后，索引路径的校验行为必须一字不变——否则这次
 *  重构会把「写坏向量」的防线拆掉。 */
describe('OpenAICompatEmbedder — 维度校验保持不变', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('模型输出与配置不符时抛错（索引路径的防线）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] })),
    ) as unknown as typeof fetch;
    const emb = new OpenAICompatEmbedder({
      baseUrl: 'http://x/v1',
      apiKey: '',
      model: 'm',
      dim: 1536,
    });
    await expect(emb.embed(['a'])).rejects.toThrow(/dim mismatch.*1024.*expected 1536/s);
  });

  it('宽度相符时正常返回', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] })),
    ) as unknown as typeof fetch;
    const emb = new OpenAICompatEmbedder({
      baseUrl: 'http://x/v1',
      apiKey: '',
      model: 'm',
      dim: 1024,
    });
    const out = await emb.embed(['a']);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1024);
  });

  it('按 index 重排，保证输出顺序与输入一致', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { embedding: [2], index: 1 },
            { embedding: [1], index: 0 },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    const emb = new OpenAICompatEmbedder({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', dim: 1 });
    expect(await emb.embed(['a', 'b'])).toEqual([[1], [2]]);
  });

  it('空输入不发请求', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const emb = new OpenAICompatEmbedder({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', dim: 1 });
    expect(await emb.embed([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

/** GĐ6：嵌入调用现在带超时与重试。分类错了会让本该失败的错误被重试三次
 *  （拖延），或让瞬时抖动直接废掉整批索引。 */
describe('OpenAICompatEmbedder — 重试分类', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const emb = () =>
    new OpenAICompatEmbedder({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', dim: 1 });

  const okBody = () => new Response(JSON.stringify({ data: [{ embedding: [1] }] }));

  it('500 会重试', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(okBody());
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).resolves.toEqual([[1]]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('429 会重试', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(okBody());
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).resolves.toEqual([[1]]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('400 不重试（同样的输入只会再失败一次）', async () => {
    const f = vi.fn().mockResolvedValue(new Response('bad input', { status: 400 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).rejects.toThrow(/400/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('401 不重试', async () => {
    const f = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).rejects.toThrow(/401/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('404 不重试（模型名写错重试也没用）', async () => {
    const f = vi.fn().mockResolvedValue(new Response('no such model', { status: 404 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).rejects.toThrow(/404/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('网络错误会重试', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(okBody());
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).resolves.toEqual([[1]]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('重试用尽后抛出最后一次错误', async () => {
    const f = vi.fn().mockResolvedValue(new Response('still down', { status: 503 }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(emb().embed(['a'])).rejects.toThrow(/503/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('signal 已中止时不重试', async () => {
    const f = vi.fn().mockRejectedValue(new Error('aborted'));
    globalThis.fetch = f as unknown as typeof fetch;
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(emb().embed(['a'], ctrl.signal)).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
