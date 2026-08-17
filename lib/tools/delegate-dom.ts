import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_DELEGATE_DOM } from '@/lib/tools/names';

/**
 * `delegate_dom` tool — hands a heavy page-reading task to the configured
 * cheap sub-agent model, returning a concise text result to the main agent.
 *
 * Why this exists: `read_page` in `markdown` mode can return 20 KB+ of page
 * content per call. Feeding that into a premium reasoning model burns tokens
 * on raw text the model doesn't need to "think" about — it just needs the
 * answer. `delegate_dom` routes the reading to a cheap model (configured in
 * Settings → Advanced → DOM sub-agent model), which reads the page, summarizes
 * / extracts, and returns ≤ 10 KB back. The main model only pays for the
 * short result, not the full page.
 *
 * When the sub-agent model is unset (null), this tool is hidden from the
 * main agent's tool list entirely (see `buildSessionToolArray`'s filter in
 * `lib/tools/index.ts`). So the tool's execute() can assume a model IS
 * configured — the no-model case never reaches here.
 *
 * Architecture:
 *   main agent → delegate_dom.execute(task)
 *     → runDomSubAgent({ task, signal })  [BG SW]
 *       → createDomSubAgent(model) + agent.prompt(task)
 *       → return final assistant text (≤ 10 KB)
 *     ← tool result string
 *
 * The tool is synchronous from the main agent's POV: pi-agent-core awaits
 * the execute() promise before continuing the loop.
 */

const DelegateDomParameters = Type.Object({
  task: Type.String({
    description:
      'Natural-language description of what the sub-agent should read or extract from the current page. ' +
      'Be specific: "Summarize the pricing table on this page" beats "read the page". ' +
      'The sub-agent has read_page, inspect, subagent_scroll, and subagent_click — it will figure out which to use to find the data. ' +
      'Keep your task under ~500 chars.',
  }),
  tabId: Type.Optional(Type.Number({
    description:
      'Optional. Tab ID to operate on. ALWAYS pass this when you have a `[Active Tab]` line in the context block — the runner\'s `chrome.tabs.query` fallback can race with tab switches and pick the wrong tab. ' +
      'If omitted, the runner falls back to querying the current active tab (less reliable).',
  })),
  expected_schema: Type.Optional(Type.String({
    description:
      'Optional. A TypeScript interface or JSON snippet describing the exact JSON structure you want ' +
      'the sub-agent to return in its `data` field. Example: `[{ name: string, price: number }]`. ' +
      'If provided, the sub-agent will strictly return JSON matching this schema. ' +
      'If omitted, the sub-agent returns free-form text or markdown.',
  })),
  complexity: Type.Optional(Type.Union([Type.Literal('simple'), Type.Literal('complex')], {
    description:
      'Optional. Defaults to "simple" (sub-agent runs with thinking disabled, fastest/cheapest). ' +
      'Set to "complex" if the extraction requires deep reasoning, evaluating trade-offs, ' +
      'or parsing heavily obfuscated industry terms. When "complex", the sub-agent is allowed ' +
      'to "think" before extracting.',
    default: 'simple',
  })),
}, {
  description:
    'Delegate a heavy page-reading or extraction task to the configured cheap DOM sub-agent model. ' +
    'Use this instead of read_page when you only need the ANSWER (a summary, a JSON list, a price) ' +
    'and not the raw page text — it saves your context budget. ' +
    'The sub-agent returns a structured JSON payload: `{ status: "success" | "partial" | "failed", data: any, reason: string }`. ' +
    'If `status` is "failed" or "partial", read the `reason` to decide whether to retry with different instructions, ' +
    'provide the user with feedback, or just fall back to using `read_page` yourself. ' +
    'Sub-agent can read, scroll, and click "Show more" / "Load more" expand buttons to reveal hidden data; ' +
    'it cannot type, submit forms, or do destructive actions. Pass `tabId` from the `[Active Tab]` line ' +
    'in the context block — `chrome.tabs.query` is unreliable from the SW context.',
});

/**
 * Create the delegate_dom tool. This is a factory (not a singleton) so that
 * the tool list builder can choose to omit it when no sub-agent model is
 * configured. The execute() lazily imports the runner to avoid pulling BG-only
 * modules into the bundle when this tool isn't used.
 */
export function createDelegateDomTool(): AgentTool<typeof DelegateDomParameters> {
  return {
    name: TOOL_DELEGATE_DOM,
    label: 'Delegate DOM',
    description:
      'Delegate a heavy page-reading task to a cheap sub-agent model. ' +
      'Use instead of read_page when you only need the answer, not the raw text. ' +
      'Returns a structured JSON payload: { status, data, reason }. ' +
      'Sub-agent is read-only + scroll + click-to-expand (no typing, no form submit).',
    parameters: DelegateDomParameters,
    async execute(_toolCallId, args, signal): Promise<AgentToolResult<Record<string, never>>> {
      const { task, expected_schema, complexity, tabId } = args as {
        task: string;
        expected_schema?: string;
        complexity?: 'simple' | 'complex';
        tabId?: number;
      };
      if (!task || !task.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: `task` is required and must not be empty.' }],
          details: {},
        };
      }

      // Lazy-import the runner so this module stays importable from contexts
      // that don't have the BG SW (e.g. unit tests for the tool definition).
      // The runner lives in entrypoints/background/ and pulls in createCebianAgent.
      const { runDomSubAgent } = await import('@/entrypoints/background/dom-sub-agent-runner');

      const result = await runDomSubAgent({ task, expected_schema, complexity, tabId, signal });

      if (!result.ok) {
        return {
          content: [{
            type: 'text',
            text: `DOM sub-agent failed${result.modelKey ? ` (${result.modelKey})` : ''}: ${result.error ?? 'unknown error'}`,
          }],
          details: {},
        };
      }

      // Annotate the result with the sub-agent model so the main agent (and
      // the tool card UI) can attribute the work. We keep it as a single
      // text block — the details object is empty because the chat UI doesn't
      // render anything special for this tool beyond the text.
      const annotated = result.text
        ? `${result.text}\n\n— via DOM sub-agent (${result.modelKey})`
        : `DOM sub-agent (${result.modelKey}) returned an empty response.`;

      return {
        content: [{ type: 'text', text: annotated }],
        details: {},
      };
    },
  };
}

/**
 * Singleton instance — the tool is stateless, so one shared instance is fine.
 * `buildSessionToolArray` includes this only when a sub-agent model is
 * configured (it checks `domSubAgentModel` in storage).
 */
export const delegateDomTool = createDelegateDomTool();
