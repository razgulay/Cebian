/**
 * Generic YAML frontmatter parser for Markdown files.
 *
 * Previously wrapped `front-matter@4`, but that package transitively pulls
 * `js-yaml@3` whose `lib/type/binary.js` does `require('buffer').Buffer` at
 * module-init time. Vite externalizes Node `buffer` for the browser and the
 * page fails to load. We never need binary YAML tags in frontmatter, so we
 * parse YAML directly with `yaml@2` and drop the `js-yaml` dependency.
 *
 * Strict-mode handling — `front-matter@4` was lenient about both of these, and
 * user-authored SKILL.md / agent-prompt frontmatter occasionally hits them:
 *   - duplicate keys → last wins (`parse` throws, `parseDocument(...).toJS()`
 *     returns the resolved object with the last value)
 *   - unknown tags / malformed structure → silently dropped (`parse` throws,
 *     we degrade to empty data)
 */
import { parse as parseYaml, parseDocument as parseYamlDoc } from 'yaml';

export interface ParsedFrontmatter {
  /** Parsed YAML data as a plain object. */
  data: Record<string, unknown>;
  /** Markdown body after the closing `---`. */
  body: string;
}

// Matches a leading `---` or `= yaml =` on its own line, the YAML body, and a
// closing `---` or `...` on its own line. Mirrors front-matter@4's regex
// shape: optional BOM, `\r?\n` line endings, no leading whitespace tolerance.
const FRONTMATTER_RE =
  /^﻿?(?:(?:---\s*\r?\n)|(?:= yaml =\s*\r?\n))([\s\S]*?)(?:\r?\n(?:---|\.\.\.))/;

const EMPTY: ParsedFrontmatter = { data: {}, body: '' };

// yaml@2 emits `YAMLParseError.code === 'DUPLICATE_KEY'` for the only lenient
// parse case front-matter@4 used to silently accept. Hoisted for findability.
const YAML_ERR_DUPLICATE_KEY = 'DUPLICATE_KEY';

function parseYamlLenient(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text, { strict: false });
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch (err) {
    // yaml@2 throws YAMLParseError on duplicate keys even with `strict: false`.
    // Fall back to `parseDocument(...).toJS()`, which exposes the
    // partially-resolved tree with last-wins semantics — BUT only when the
    // document's error list is *exclusively* duplicate-key errors. A mixed
    // error set (e.g. `title: A\ntitle: B` plus `: ::`) would otherwise leak
    // the partially-resolved garbage object (e.g. `{"title":"B","":{...}}`)
    // and violate the "malformed → empty data" promise from front-matter@4.
    if (err && typeof err === 'object' && (err as { code?: string }).code === YAML_ERR_DUPLICATE_KEY) {
      const doc = parseYamlDoc(text, { strict: false });
      const hasOtherError = doc.errors.some((e) => e.code !== YAML_ERR_DUPLICATE_KEY);
      if (!hasOtherError) {
        const value = doc.toJS();
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      }
    }
    // Any other parse error → empty data, matches front-matter@4 behavior.
    return {};
  }
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Returns `{ data: {}, body: fullContent }` if no frontmatter is found.
 *
 * Malformed YAML degrades to `{ data: {}, body: fullContent }` — matches
 * front-matter@4 behavior. Callers never see an exception; if they need to
 * surface a parse error they should validate `data` against their schema.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content) return EMPTY;
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { data: {}, body: content };
  const data = parseYamlLenient(match[1] ?? '');
  const body = content.slice(match[0].length).replace(/^\r?\n/, '');
  return { data, body };
}