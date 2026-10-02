//
// Embedding provider — wraps an OpenAI-compatible `/embeddings` HTTP
// endpoint. Default target is CLIProxyAPI on `http://localhost:8317/v1`
// (which proxies BGE / OpenAI / Cohere embeddings), but any OpenAI-
// compatible server can be substituted via `EmbedderConfig`.
//

import { abortableSleep, retryAsync, withTimeout } from '@/lib/utils';

export interface Embedder {
  /** Model id used for embedding. */
  readonly model: string;
  /** Output dimension. Validated against the actual response length on
   *  first call — a mismatch surfaces a clear error instead of silently
   *  poisoning the collection with wrong-dim vectors. */
  readonly dim: number;
  /** Embed one or more strings. Returns one vector per input string,
   *  same order. Empty input → empty output. Pass `signal` to abort
   *  mid-flight (e.g. when the indexer is cancelled). */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseUrl: string;       // e.g. http://localhost:8317/v1
  apiKey: string;
  model: string;
  dim: number;
}

/** 单次嵌入请求的超时上限。索引时每批最多 32 条文本，15s 对本地/托管端点都够。 */
const EMBED_TIMEOUT_MS = 15_000;

/** `Retry-After` 的封顶。服务端可以要求等待，但不能要求无限等。 */
const MAX_RETRY_AFTER_MS = 30_000;

/** 从响应头解析 `Retry-After`，得到应等待的毫秒数；没有或无法解析则返回
 *  `null`。支持秒数（`Retry-After: 5`）与 HTTP 日期两种形式。
 *
 *  不限于 429——任何非 2xx 响应带上它都会被采纳，这对 503 同样有意义。 */
function parseRetryAfter(resp: Response): number | null {
  const raw = resp.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** 该不该重试这次嵌入调用。
 *
 *  - 网络层错误（fetch reject）→ 重试；
 *  - 5xx / 429 → 重试（服务端瞬时问题、限流）；
 *  - 其余 4xx → 不重试。400（请求体不合法）、401（密钥错）、404（模型名错）
 *    用同样的输入再试一次只会得到同样的结果，重试纯属拖延。 */
function isRetryableEmbedError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  // 没有 status 的是网络层错误。
  if (typeof status !== 'number') return true;
  return status >= 500 || status === 429;
}

/** 原始 OpenAI 兼容 `/embeddings` POST，**不做维度校验**。
 *
 *  由两条路径共用：索引路径（在拿到结果后自行校验）与设置页的探测路径
 *  （绝不能校验——「测出真实宽度」正是它的职责）。抽出来是为了让 HTTP 实现
 *  只有一份。
 *
 *  带超时与重试：没有超时的话，本地端点进程挂住会让整轮索引无限等待；没有
 *  重试的话，一次瞬时抖动就废掉整批。 */
async function postEmbeddings(
  config: { baseUrl: string; apiKey: string; model: string },
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = `${base}/embeddings`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return retryAsync(
    async () => {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: withTimeout(EMBED_TIMEOUT_MS, signal),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        // 把状态码挂到错误上，供 `isRetryableEmbedError` 分类；同时优先使用
        // `Retry-After`——服务端明确说了等多久，比退避猜测准。
        const err = new Error(`Embed API ${resp.status}: ${text.slice(0, 200)}`) as Error & {
          status: number;
          retryAfterMs?: number;
        };
        err.status = resp.status;
        const retryAfterMs = parseRetryAfter(resp);
        if (retryAfterMs !== null) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      const data = await resp.json() as {
        data?: { embedding: number[]; index?: number }[];
        error?: { message?: string };
      };
      if (data.error?.message) {
        throw new Error(`Embed API error: ${data.error.message}`);
      }
      if (!data.data || data.data.length !== texts.length) {
        throw new Error(
          `Embed API returned ${data.data?.length ?? 0} vectors for ${texts.length} inputs`,
        );
      }
      // Sort by `index` if present; fall back to input order.
      const items = [...data.data];
      if (items.every((it) => typeof it.index === 'number')) {
        items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      }
      const out: number[][] = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        out[i] = items[i]!.embedding;
      }
      return out;
    },
    {
      attempts: 3,
      baseDelayMs: 500,
      shouldRetry: isRetryableEmbedError,
      signal,
      // 服务端给了 `Retry-After` 就听它的——它知道自己的限流窗口，比退避猜测准。
      // 但仍要封顶：`Retry-After: 3600` 会让整轮索引静默卡住一小时，用户只能
      // 看到进度条不动。取消信号依然生效，只是不该由服务端随意决定等多久。
      sleep: async (ms, sig, err) => {
        const retryAfterMs = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
        const wait =
          typeof retryAfterMs === 'number' ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : ms;
        await abortableSleep(wait, sig);
      },
    },
  );
}

/** Standard OpenAI-compatible `/embeddings` POST.
 *  Response shape: `{ data: [{ embedding: number[], index: number }, ...] }`.
 *  We re-order by `index` so the output matches the input order even if
 *  the server returns them shuffled (OpenAI does, some clones don't). */
export class OpenAICompatEmbedder implements Embedder {
  constructor(private readonly config: EmbedderConfig) {}

  get model(): string { return this.config.model; }
  get dim(): number { return this.config.dim; }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out = await postEmbeddings(this.config, texts, signal);
    // Validate dim on first call. If a wrong model is configured, surface
    // the mismatch loudly so the user can fix it instead of writing bad
    // vectors that fail every retrieval later.
    if (out.length > 0 && out[0]!.length !== this.config.dim) {
      throw new Error(
        `Embedding dim mismatch: model ${this.config.model} returned ${out[0]!.length}, ` +
          `expected ${this.config.dim}. Update RagSettings.embedderDim to match.`,
      );
    }
    return out;
  }
}

export interface EmbedderProbeResult {
  ok: boolean;
  /** 端点实际返回的向量宽度。`ok === false` 时为 0。 */
  dim: number;
  model: string;
  error?: string;
}

/** 探测端点真实返回的向量宽度：embed 一个短字符串，读回它的长度。
 *
 *  与索引路径的关键差别是**永不抛错**——宽度不符正是它要产出的答案，不是
 *  故障。返回 `ok: false` 表示端点本身不可用（网络 / HTTP / 响应格式）。
 *
 *  存在的理由：`settings.embedderDim` 是用户手填的数字，可能与其模型实际
 *  输出不符（Cebian 的默认值是 1536，而不少本地模型是 1024）。列宽必须由
 *  模型决定，不能由默认值决定。 */
export async function probeEmbeddingDim(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}): Promise<EmbedderProbeResult> {
  try {
    const [vec] = await postEmbeddings(opts, ['dimension probe'], opts.signal);
    if (!vec) {
      return { ok: false, dim: 0, model: opts.model, error: 'Endpoint returned no vector' };
    }
    return { ok: true, dim: vec.length, model: opts.model };
  } catch (err) {
    return { ok: false, dim: 0, model: opts.model, error: (err as Error).message };
  }
}
