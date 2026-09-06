//
// Contextual Retrieval prefix generator — Anthropic 09/2024 recipe.
//
// For each chunk, ask a cheap LLM (~40-word output) to describe where
// the chunk sits in its source document. Prepend the prefix to both
// the embedding input AND the BM25 token stream (the tsvector
// generated expression already picks up `metadata.context_prefix` via
// the `COALESCE` added in Subtask 2). Net effect: a query that matches
// the chunk's topic but not its exact words still ranks the chunk
// correctly. Anthropic reports 35–49% retrieval failure reduction; v1
// of Cebian's pipeline gets that benefit at zero extra runtime cost
// (one LLM call per chunk at index time, off-by-default).
//
// Smart context window (ràng buộc từ user):
//   • doc ≤ 40K chars (~10K tokens for light models) → send the full
//     document. Modern lightweight models (`gpt-4o-mini`,
//     `gemini-1.5-flash`, `claude-haiku-4.5`) all have ≥128K context;
//     the cost is negligible compared to the indexing pipeline as a
//     whole.
//   • doc > 40K chars → send a slim envelope: first heading as
//     `title`, all headings as `outline`, plus the 1–2 paragraphs
//     around the chunk's position in the original document. Total
//     target ≤ 8000 chars to keep token-cost manageable.
//
// The LLM call uses the OpenAI-compatible `/chat/completions` shape
// (same wire format the embedder uses for `/embeddings`), so any
// local proxy (CLIProxyAPI, 9Router, Ollama) works without changes.
//

/** Threshold above which we send a slim context instead of the full
 *  document. Matched to ~10K tokens for typical prose — well within
 *  every modern lightweight model's context window. */
const FULL_DOCUMENT_THRESHOLD = 40_000;

/** Soft cap on the slim-context envelope. Slim context is built from
 *  title + outline + surrounding paragraphs; we trim aggressively so
 *  a chunk at the start or end of a 1M-char document still ships a
 *  bounded prompt. */
const SLIM_CONTEXT_BUDGET = 8_000;

/** Hard cap on the LLM output — Anthropic recipe asks for ≤40 words
 *  of context. We let the model ramble up to 60 words, then hard-cut
 *  at the next word boundary. 60 leaves a safety margin against
 *  models that add a brief preamble before the actual context. */
const MAX_CONTEXT_WORDS = 60;
/** Soft target — well-behaved models respect this. Used in the
 *  prompt only; the post-processing truncates regardless. */
const TARGET_CONTEXT_WORDS = 40;

/** Max number of chunks whose LLM calls run concurrently. Tuned to
 *  balance wall-clock against endpoint rate limits; 8 is the same
 *  number used elsewhere in the RAG settings UI for batched queries. */
const CONTEXT_GEN_CONCURRENCY = 8;

export interface ContextPrefixOptions {
  /** Whole-document text. The generator decides whether to send it
   *  in full or compose a slim envelope based on its length. */
  document: string;
  /** The chunk the LLM is being asked to contextualize. Sent inside
   *  a `<chunk>` block at the bottom of the prompt so the model
   *  knows exactly what it's working with. */
  chunkText: string;
  /** OpenAI-compatible chat-completions endpoint. Empty string is
   *  allowed for endpoints that don't require auth (local Ollama). */
  llmBaseUrl: string;
  llmApiKey: string;
  /** Chat model id. Cheap models only — `gpt-4o-mini`,
   *  `claude-haiku-4.5`, etc. */
  llmModel: string;
  /** 0-indexed chunk position. Used in the prompt's "chunk #N of M"
   *  framing so the model understands the chunk's location. */
  chunkIndex?: number;
  /** Total chunks in the same document. Optional but improves the
   *  LLM's output (e.g. "chunk 12 of 50"). */
  totalChunks?: number;
  /** Abort signal forwarded to the fetch call. The indexer wires
   *  its own signal so cancellation stops both the embed and the
   *  CR phase cleanly. */
  signal?: AbortSignal;
}

/**
 * Ask the configured LLM to generate a short context string for one
 * chunk. Returns the trimmed prefix (≤ 60 words) or `''` if the LLM
 * fails or returns empty — a missing prefix is graceful degradation,
 * not a blocking error. The indexer never aborts because a single
 * chunk's context couldn't be generated; the batch orchestrator
 * (`generateContextPrefixes`) emits a single summary log at the end
 * so devtools doesn't get spammed with one warn per failed chunk on
 * a 1000-chunk reindex against a broken endpoint.
 */
export async function generateContextPrefix(
  opts: ContextPrefixOptions,
): Promise<string> {
  const prompt = buildPrompt(opts);
  try {
    const text = await callChatCompletions({
      baseUrl: opts.llmBaseUrl,
      apiKey: opts.llmApiKey,
      model: opts.llmModel,
      prompt,
      signal: opts.signal,
    });
    return truncateToWordBoundary(text, MAX_CONTEXT_WORDS);
  } catch {
    // Per-chunk failure stays silent. The orchestrator
    // (`generateContextPrefixes`) emits one summary warn after the
    // batch finishes, so the user sees "CR: 3/1000 failed" rather
    // than 1000 identical warnings.
    return '';
  }
}

/**
 * Build the prompt body. Pure function (no IO) so unit tests can
 * assert the structure without mocking the LLM. The structure
 * follows Anthropic's recipe but adapts the context-window
 * heuristics per the user requirement: full document for short
 * inputs, slim envelope for long ones.
 */
export function buildPrompt(opts: ContextPrefixOptions): string {
  const doc = opts.document ?? '';
  const location = describeLocation(opts.chunkIndex, opts.totalChunks);
  const contextBlock = doc.length <= FULL_DOCUMENT_THRESHOLD
    ? `<document>\n${doc}\n</document>`
    : extractSlimContext(doc, opts.chunkText);

  return [
    `You are generating a short context prefix for one chunk of a document${location ? ' ' + location : ''}.`,
    '',
    'The context prefix will be prepended to the chunk before embedding, so it must',
    'describe where this chunk sits in the document — its topic, the section or',
    'chapter it belongs to, and any neighboring content that helps disambiguate it.',
    '',
    'Be terse. One sentence. No preamble, no explanation, no quotation marks.',
    `Aim for ≤ ${TARGET_CONTEXT_WORDS} words. Hard limit ${MAX_CONTEXT_WORDS} words.`,
    '',
    contextBlock,
    '',
    `<chunk>\n${opts.chunkText}\n</chunk>`,
    '',
    'Context prefix:',
  ].join('\n');
}

/** Compose the "chunk #N of M" fragment when both indices are
 *  provided. Returns '' if either is missing so the prompt doesn't
 *  ship with a placeholder. */
function describeLocation(chunkIndex?: number, totalChunks?: number): string {
  if (chunkIndex == null || totalChunks == null) return '';
  return `(chunk ${chunkIndex + 1} of ${totalChunks})`;
}

/**
 * Slim envelope for long documents. Composes:
 *   • first heading as `title`
 *   • all headings as `outline`
 *   • 1–2 paragraphs before/after the chunk's position
 * Trimmed to fit SLIM_CONTEXT_BUDGET (8K chars) so the prompt stays
 * bounded even for very long documents.
 *
 * The chunk's "position" is approximated by searching for the first
 * 60-char substring of the chunk inside the document. The first
 * match's character offset defines the window — crude but good
 * enough since `chunkText` is a verbatim substring of `document` by
 * construction (chunker.ts splits on word boundaries, no edits).
 */
export function extractSlimContext(document: string, chunkText: string): string {
  const lines = document.split('\n');
  const headings = lines
    .map((line, i) => ({ line: line.trim(), i }))
    .filter(({ line }) => /^#{1,6}\s+/.test(line));

  const title = headings[0]?.line.replace(/^#{1,6}\s+/, '') ?? '(untitled document)';
  const outline = headings.length > 0
    ? headings.map((h) => h.line).join('\n')
    : '(no headings detected)';

  const anchor = chunkText.slice(0, 60);
  const anchorIdx = document.indexOf(anchor);
  const { before, after } = extractSurroundingParagraphs(document, anchorIdx);

  const composed = [
    `<document-slim>`,
    `<title>${title}</title>`,
    `<outline>`,
    outline,
    `</outline>`,
    `<paragraphs-before>`,
    before,
    `</paragraphs-before>`,
    `<paragraphs-after>`,
    after,
    `</paragraphs-after>`,
    `</document-slim>`,
  ].join('\n');

  // Hard cap on the composed envelope. Trim from the end (after the
  // chunk hint) rather than the middle so the LLM still sees the
  // heading context that points at the chunk's section.
  if (composed.length > SLIM_CONTEXT_BUDGET) {
    return composed.slice(0, SLIM_CONTEXT_BUDGET) + '\n[…truncated for length]';
  }
  return composed;
}

/** Pull 1–2 paragraphs before/after the chunk's anchor offset.
 *  Returns `''` on either side when no paragraphs exist in that
 *  direction (chunk at start or end of document). */
function extractSurroundingParagraphs(
  document: string,
  anchorIdx: number,
): { before: string; after: string } {
  if (anchorIdx < 0) {
    // Fallback when the anchor isn't found — happens if the chunk
    // was post-processed (e.g. whitespace normalization) and no
    // longer matches verbatim. Take paragraphs from the start.
    const tail = document.slice(0, 2_000);
    return { before: tail, after: '' };
  }

  // Split document into paragraphs on blank lines. Cheap and good
  // enough for prose; markdown headings and code blocks ride along
  // as part of the surrounding paragraph since the chunker doesn't
  // distinguish them either.
  const before = document.slice(0, anchorIdx);
  const after = document.slice(anchorIdx);

  const beforeParas = before.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const afterParas = after.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  const beforeText = beforeParas.slice(-2).join('\n\n');
  const afterText = afterParas.slice(1, 3).join('\n\n');
  return { before: beforeText, after: afterText };
}

/**
 * Run `generateContextPrefix` for many chunks with bounded
 * concurrency. Returns one prefix per input chunk in input order.
 *
 * Failures are isolated per-chunk: a chunk whose LLM call throws
 * gets `''` (graceful degradation) and the rest proceed. The
 * indexer treats `''` as "no prefix available" — the chunk still
 * indexes, just without the Contextual Retrieval boost. A single
 * summary warn at the end reports the success / failure counts so
 * devtools doesn't get spammed with one warn per failed chunk.
 */
export async function generateContextPrefixes(
  chunks: { document: string; chunkText: string; chunkIndex: number; totalChunks: number }[],
  llm: { baseUrl: string; apiKey: string; model: string },
  signal?: AbortSignal,
): Promise<string[]> {
  if (chunks.length === 0) return [];
  const out: string[] = new Array(chunks.length);
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) return;
      const idx = cursor++;
      if (idx >= chunks.length) return;
      const c = chunks[idx]!;
      const prefix = await generateContextPrefix({
        document: c.document,
        chunkText: c.chunkText,
        llmBaseUrl: llm.baseUrl,
        llmApiKey: llm.apiKey,
        llmModel: llm.model,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
        signal,
      });
      out[idx] = prefix;
      if (prefix === '') failed++;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONTEXT_GEN_CONCURRENCY, chunks.length) }, worker),
  );
  if (failed > 0) {
    // Single summary so the devtools console doesn't get a warning
    // per failed chunk (1000-chunk reindex × broken endpoint used
    // to dump 1000 identical warns).
    console.warn(
      `[Contextual Retrieval] ${failed}/${chunks.length} chunks failed; falling back to empty prefixes`,
    );
  }
  return out;
}

/**
 * Call an OpenAI-compatible `/chat/completions` endpoint and return
 * the assistant's message content. Throws on HTTP / parse errors —
 * callers (`generateContextPrefix`) translate those into an empty
 * prefix.
 */
async function callChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'user', content: opts.prompt }],
      // Encourage terse output. Cheap models honour this; Haiku /
      // gpt-4o-mini both come in well under the cap.
      max_tokens: 200,
      temperature: 0,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Context LLM ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (data.error?.message) {
    throw new Error(`Context LLM error: ${data.error.message}`);
  }
  const content = data.choices?.[0]?.message?.content ?? '';
  return content.trim();
}

/**
 * Cut a string at the last word boundary ≤ `maxWords` words. Returns
 * `''` for an empty input — callers distinguish empty from "LLM
 * returned something" by length.
 *
 * Exported so tests can poke the truncation logic directly without
 * needing to mock the LLM.
 */
export function truncateToWordBoundary(text: string, maxWords: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(' ');
}
