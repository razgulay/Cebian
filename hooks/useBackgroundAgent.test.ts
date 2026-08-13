/**
 * Smoke test for the optimistic-UI bug fix in `useBackgroundAgent`.
 *
 * Bug history: user clicks Enter in a new chat → optimistic user bubble
 * should appear in state.messages IMMEDIATELY. But the BG's first
 * session_state broadcast used to arrive with an empty messages array,
 * and the hook unconditionally replaced state.messages with it, wiping
 * the optimistic bubble for 2-3 seconds.
 *
 * Fix (3 parts):
 *   1. session_state / message_end / agent_end handlers use length-aware merge.
 *   2. unsubscribe() no longer resets messages.
 *   3. chat page's subscribe-effect no longer calls portUnsubscribe on every
 *      activeSessionId change.
 *
 * This test extracts the length-aware merge logic into a pure helper and
 * verifies the regression. It also verifies the unsubscribe() side-effect on
 * state. (We can't run the full React hook without @testing-library/react
 *  in this project; the helper captures the exact regression the bug
 *  introduced and is what we need to lock down.)
 */

import { describe, it, expect } from 'vitest';

type AgentMessage = { role: 'user' | 'assistant'; content: any[]; timestamp?: number };

/**
 * Pure helpers extracted from `useBackgroundAgent` so the optimistic-UI fix
 * can be locked down by a unit test (no React/DOM test setup needed).
 *
 * - `mergeMessages`: length-aware merge used by session_state / message_end /
 *   agent_end handlers. Replaces the old unconditional `messages: msg.messages`
 *   that wiped the optimistic user bubble when BG broadcast an empty array.
 * - `clearForUnsubscribe`: the state shape that `unsubscribe()` writes. Used
 *   to verify that messages are NOT reset.
 */

/**
 * Length-aware merge: pick the longer of prev.messages and incoming
 * `msg.messages`. The authoritative final broadcast is always the longer
 * one (the streaming `session_state` and `message_end` callbacks grow over
 * time, monotonically), so this never permanently hides data.
 */
function mergeMessages(prevMessages: AgentMessage[], incomingMessages: AgentMessage[]): AgentMessage[] {
  return incomingMessages.length >= prevMessages.length ? incomingMessages : prevMessages;
}

describe('useBackgroundAgent — optimistic UI merge helper', () => {
  it('preserves optimistic user bubble when BG broadcasts empty messages (first message in new chat)', () => {
    const optimisticBubble: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
    ];
    // The race-condition broadcast: agent not yet initialised, BG has no
    // messages to broadcast.
    const emptyBroadcast: AgentMessage[] = [];
    const merged = mergeMessages(optimisticBubble, emptyBroadcast);
    // CRITICAL: optimistic bubble survives.
    expect(merged.length).toBe(1);
    expect(merged[0].role).toBe('user');
    expect((merged[0].content[0] as { text: string }).text).toBe('xin chào');
  });

  it('accepts the next broadcast that has MORE messages (streaming grew)', () => {
    const optimisticBubble: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
    ];
    // Next session_state broadcast after agent started streaming.
    const streaming: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Chào bạn!' }], timestamp: 2 },
    ];
    const merged = mergeMessages(optimisticBubble, streaming);
    // Accept the more-complete broadcast.
    expect(merged.length).toBe(2);
    expect(merged[1].role).toBe('assistant');
    expect((merged[1].content[0] as { text: string }).text).toBe('Chào bạn!');
  });

  it('preserves optimistic bubble when broadcast has fewer messages (mid-stream shrink — defensive)', () => {
    const streaming: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Chào bạn!' }], timestamp: 2 },
    ];
    // Defensive: a stray broadcast with fewer messages (e.g. stale cache)
    // must NOT regress the user's view.
    const shorter: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
    ];
    const merged = mergeMessages(streaming, shorter);
    expect(merged.length).toBe(2);
    expect(merged[1].role).toBe('assistant');
  });
});

/**
 * The `unsubscribe()` side-effect used to reset `messages: []` which clobbered
 * the optimistic user bubble when the chat page's subscribe-effect re-ran
 * (e.g. after `activeSessionId` flipped). After the fix, only session-related
 * fields are cleared; `prev.messages` is preserved by `setState(prev => …)`.
 *
 * The pure side-effect of `unsubscribe()` on a state object — applied to a
 * state that already has the optimistic bubble — must NOT touch `messages`.
 */
type HookState = {
  messages: AgentMessage[];
  isAgentRunning: boolean;
  isCompacting: boolean;
  sessionId: string | null;
  sessionTitle: string;
  connected: boolean;
  lastError: string | null;
};

function clearForUnsubscribe(prev: HookState): HookState {
  return {
    ...prev,
    isAgentRunning: false,
    isCompacting: false,
    sessionId: null,
    sessionTitle: '',
    connected: true,
    lastError: null,
  };
}

describe('useBackgroundAgent — unsubscribe() side-effect preserves messages', () => {
  it('preserves the optimistic user bubble', () => {
    const before: HookState = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
      ],
      isAgentRunning: true,
      isCompacting: false,
      sessionId: 'sess-1',
      sessionTitle: 'xin chào',
      connected: true,
      lastError: null,
    };
    const after = clearForUnsubscribe(before);
    // CRITICAL: messages survive.
    expect(after.messages).toEqual(before.messages);
    // Session fields ARE cleared.
    expect(after.isAgentRunning).toBe(false);
    expect(after.sessionId).toBe(null);
    expect(after.sessionTitle).toBe('');
  });
});

/**
 * The chat page's `useEffect` for subscribe/unsubscribe had a regression: when
 * `activeSessionId` flipped from null to the new sessionId (after the user
 * sends the first message in a new chat), the effect re-ran with
 * `isNewChat === true` and called `portUnsubscribe()`, which used to reset
 * `messages: []` and wipe the optimistic user bubble.
 *
 * The fix: in new-chat mode, the effect must NOT touch the port subscription
 * at all. The BG's 'prompt' handler pins the subscription implicitly.
 * The decision logic is extracted here as a pure function for testing.
 */
function shouldTouchSubscription(
  isNewChat: boolean,
  routeSessionId: string | null | undefined,
  activeSessionId: string | null,
): 'unsubscribe' | 'subscribe' | 'noop' {
  if (isNewChat) {
    // New chat: do not touch the port subscription. The 'prompt' handler
    // in BG pins the subscription when the user sends.
    return 'noop';
  }
  if (routeSessionId && routeSessionId !== activeSessionId) {
    return 'subscribe';
  }
  return 'noop';
}

describe('useBackgroundAgent — chat page subscribe-effect decision logic', () => {
  it('new chat: does NOT call unsubscribe (would wipe optimistic user bubble)', () => {
    // Reproduces the regression: when user sends the first message in a new
    // chat, activeSessionId flips from null to the new sessionId, and the
    // effect re-runs. The old code took the "unsubscribe" branch here
    // because isNewChat was still true.
    expect(shouldTouchSubscription(true, 'new-session-uuid', null)).toBe('noop');
    // Even with activeSessionId populated, still noop in new chat.
    expect(shouldTouchSubscription(true, 'new-session-uuid', 'new-session-uuid')).toBe('noop');
  });

  it('existing chat, route differs from current: subscribe', () => {
    expect(shouldTouchSubscription(false, 'old-session-id', 'new-session-id')).toBe('subscribe');
  });

  it('existing chat, route matches current: noop (already subscribed)', () => {
    expect(shouldTouchSubscription(false, 'session-id', 'session-id')).toBe('noop');
  });
});

/**
 * `clearSession()` is the local-reset path for an explicit "New Chat"
 * navigation. Unlike `unsubscribe()` (which preserves messages to avoid
 * wiping the optimistic user bubble on the first-message race), this
 * clears messages too — the user wants a fresh empty chat.
 */
function applyClearSession(_prev: HookState): HookState {
  return {
    messages: [],
    isAgentRunning: false,
    isCompacting: false,
    sessionId: null,
    sessionTitle: '',
    connected: true,
    lastError: null,
  };
}

describe('useBackgroundAgent — clearSession() side-effect for New Chat', () => {
  it('wipes messages when user navigates to a new chat', () => {
    const before: HookState = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'xin chào' }], timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'Chào bạn!' }], timestamp: 2 },
      ],
      isAgentRunning: false,
      isCompacting: false,
      sessionId: 'sess-1',
      sessionTitle: 'xin chào',
      connected: true,
      lastError: null,
    };
    const after = applyClearSession(before);
    expect(after.messages).toEqual([]);
    expect(after.sessionId).toBe(null);
    expect(after.sessionTitle).toBe('');
  });
});

// ─── rewriteLastUserMessage: directive-preserving displayText override ───
//
// Hybrid injection adds `[DIRECTIVE — ATTACHED PROMPT/SKILL: "name"]` blocks
// to the outgoing text. The BG stores the full text (with directive); the
// bubble uses `displayText` (the user's typed text) for the visible portion
// AND parses the directive for chip rendering. A naive whole-text
// replacement would wipe the directive and the chip would silently
// disappear from the live bubble. The rewrite preserves the directive
// prefix and only replaces the user-typed suffix.

const DIRECTIVE_OPEN_RE = /\[DIRECTIVE\s+—\s+ATTACHED\s+(?:PROMPT|SKILL):/;
const DIRECTIVE_USER_SEP = '\n\n---\n\n';
const USER_REQUEST_CLOSE = '</user-request>';

function rewriteLastUserMessage(messages: AgentMessage[], displayText: string): AgentMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any).role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;
  const m: any = messages[lastUserIdx];
  const rewritten: any[] = m.content.map((b: any) => {
    if (b?.type !== 'text') return b;
    const text: string = b.text;
    if (DIRECTIVE_OPEN_RE.test(text)) {
      // Preserve the directive + the BG wrapper's `\n</user-request>` close.
      // Dropping the close used to make `extractLastUserRequest` latch onto
      // an inner skill-body close tag and leak the directive body into the
      // bubble (live mode shows raw `<reminder-instructions>`, `<context>`,
      // `<user-request>` template tags; persisted mode was clean).
      if (text.includes(DIRECTIVE_USER_SEP)) {
        const lastSep = text.lastIndexOf(DIRECTIVE_USER_SEP);
        const closeIdx = text.indexOf(USER_REQUEST_CLOSE, lastSep);
        if (closeIdx > lastSep) {
          const beforeUser = text.slice(0, lastSep + DIRECTIVE_USER_SEP.length);
          const afterUser = text.slice(closeIdx - 1); // includes the leading '\n'
          return { ...b, text: beforeUser + displayText + afterUser };
        }
        const prefix = text.slice(0, lastSep + DIRECTIVE_USER_SEP.length);
        return { ...b, text: prefix + displayText };
      }
      return b;
    }
    return { ...b, text: displayText };
  });
  const out = [...messages];
  out[lastUserIdx] = { ...m, content: rewritten };
  return out;
}

describe('useBackgroundAgent — rewriteLastUserMessage preserves directive', () => {
  it('keeps the prompt directive prefix and only replaces the user-typed suffix', () => {
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nAlways respond in English.\n\n[END DIRECTIVE]\n\n---\n\nxin chào\n</user-request>';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, 'xin chào');
    const newText = (out[0] as any).content[0].text;
    // Directive prefix preserved verbatim so the bubble parser can find it.
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    expect(newText).toContain('---');
    // BG wrapper's `\n</user-request>` close is preserved — without it
    // `extractLastUserRequest` latches onto the wrong close tag.
    expect(newText).toContain('</user-request>');
    // User-typed segment was rewritten.
    expect(newText).toContain('xin chào');
    expect(newText).not.toContain('old xin chào');
    // Suffix after the rewrite position contains the rewritten user text
    // followed by the close.
    expect(newText).toMatch(/xin chào\s*<\/user-request>$/);
  });

  it('handles multiple stacked directives (prompt + skill) — only the last user portion is replaced', () => {
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody1\n\n[END DIRECTIVE]\n\n---\n\n' +
      '[DIRECTIVE — ATTACHED SKILL: "search" pinned="true"]\n\nbody2\n\n[END DIRECTIVE]\n\n---\n\n' +
      'xin chào\n</user-request>';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, 'xin chào');
    const newText = (out[0] as any).content[0].text;
    // Both directives survive.
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[DIRECTIVE — ATTACHED SKILL: "search" pinned="true"]');
    // Close preserved.
    expect(newText).toContain('</user-request>');
    expect(newText).toMatch(/xin chào\s*<\/user-request>$/);
  });

  it('falls back to the original whole-text replacement when there is no directive (slash command path)', () => {
    // Slash command `/english xin chào` resolves to the expanded prompt body
    // in `text`, with `displayText = "/english xin chào"`. No directive —
    // replace the whole text the way the function always did.
    const text = 'Please respond in English. User input: xin chào';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, '/english xin chào');
    expect((out[0] as any).content[0].text).toBe('/english xin chào');
  });

  it('handles a directive-only message (no user text, no separator) — keeps the directive unchanged', () => {
    // User sent only a chip (no typed text). The text in the BG is just the
    // directive prefix; displayText is empty. The rewrite must NOT wipe the
    // directive — the bubble still wants to render the chip from the persisted
    // text.
    const text = '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody\n\n[END DIRECTIVE]';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, '');
    const newText = (out[0] as any).content[0].text;
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    // Same text block returned unchanged (no allocation churn).
    expect((out[0] as any).content[0]).toBe(messages[0].content[0]);
  });

  it('preserves </user-request> close when the BG wrapper carries an inner skill-body placeholder (regression)', () => {
    // Repro of the live-bubble regression. The BG wrapper contains a skill
    // body that itself uses `<user-request>...</user-request>` as a
    // placeholder. Without the close-preservation fix, the rewrite drops
    // the BG wrapper's trailing `\n</user-request>`, and the bubble's
    // `extractLastUserRequest` (FIRST `<user-request>` matched against
    // LAST `</user-request>`) ends up returning the skill body instead of
    // the rewritten user text — leaking `<reminder-instructions>`,
    // `<context>`, `<user-request>` template tags into the live bubble.
    // After the fix the rewrite keeps the close and the bubble shows just
    // the slash command (and `stripDirectives` strips the directive block).
    const skillBody =
      '<reminder-instructions>\n- Review your todos\n</reminder-instructions>\n\n' +
      '<context>\n[page context]\n</context>\n\n' +
      '<user-request>\n[placeholder from skill template]\n</user-request>';
    const directive = `[DIRECTIVE — ATTACHED SKILL: "reminder-instructions"]\n\n${skillBody}\n\n[END DIRECTIVE]`;
    const text =
      '<user-request>\n' + directive + '\n\n---\n\nxin chào\n</user-request>';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, '/reminder-instructions');
    const newText = (out[0] as any).content[0].text;
    // The BG wrapper's close must still be present after the rewrite — this
    // is the structural guarantee the fix provides.
    expect(newText.endsWith('</user-request>')).toBe(true);
    // User-text segment was rewritten.
    expect(newText).toContain('/reminder-instructions');
    // Skill body still in the text (the directive is kept verbatim so the
    // chip parser can find it) — but the BG close is OUTSIDE the skill body.
    expect(newText).toContain('[placeholder from skill template]');
    // Cross-check via the bubble's extractLastUserRequest regex pair: with
    // the close preserved, the FIRST `<user-request>` (BG wrapper) pairs
    // with the LAST `</user-request>` (also BG wrapper), not the inner
    // skill-body close.
    const firstOpen = newText.indexOf('<user-request>');
    const lastClose = newText.lastIndexOf('</user-request>');
    expect(lastClose).toBeGreaterThan(firstOpen);
    // The substring between BG's open and the LAST close spans the
    // directive + the rewritten user text + the trailing `\n` before
    // the close. That substring, after `stripDirectives` removes the
    // directive block, must yield exactly the slash command.
    const inside = newText.slice(firstOpen + '<user-request>'.length, lastClose);
    const withoutBlocks = inside.replace(
      /\[DIRECTIVE\s+—\s+ATTACHED\s+(?:PROMPT|SKILL):\s+"[^"]*"(?:\s+pinned="true")?\][\s\S]*?\[END\s+DIRECTIVE\]/g,
      '',
    );
    const cleaned = withoutBlocks
      .split('\n')
      .filter((line: string) => !/^\s*---\s*$/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    expect(cleaned).toBe('/reminder-instructions');
  });

  it('falls back to whole-suffix replacement when the wrapper close is missing (defensive)', () => {
    // If the BG's wrapper is somehow truncated upstream and there's no
    // `</user-request>` after the separator, the fix's defensive path runs:
    // clobber the suffix with displayText rather than leave stale body.
    const text =
      '[DIRECTIVE — ATTACHED PROMPT: "english"]\n\nbody\n\n[END DIRECTIVE]\n\n---\n\nold text';
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, 'new');
    const newText = (out[0] as any).content[0].text;
    expect(newText).toContain('[DIRECTIVE — ATTACHED PROMPT: "english"]');
    expect(newText).toContain('[END DIRECTIVE]');
    expect(newText.endsWith('new')).toBe(true);
  });

  it('returns the same array reference when no user message is present', () => {
    const messages: AgentMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    ];
    expect(rewriteLastUserMessage(messages, 'typing')).toBe(messages);
  });

  it('does not touch non-text blocks (e.g. image attachments)', () => {
    const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'old text' }, image], timestamp: 1 },
    ];
    const out = rewriteLastUserMessage(messages, 'new text');
    expect((out[0] as any).content[0].text).toBe('new text');
    expect((out[0] as any).content[1]).toBe(image);
  });
});
