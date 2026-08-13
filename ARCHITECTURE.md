# Cebian Architecture

A map of the codebase for maintainers. If you're new here, start with
[MAINTAINING.md](MAINTAINING.md) and come back when you need depth.

## Layered architecture

The codebase is organized in five layers with one-way dependency flow:

```
entrypoints  →  components  →  hooks  →  lib
       ↑                                ↑
       └── content scripts             shared contracts
```

Enforced by [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) at lint time
(`.depcruise` rule `no-circular`, plus four "no-up" rules: `hooks-no-up`,
`components-no-entrypoints`, `lib-no-up-runtime`, `background-no-lib-ui`,
`content-no-lib-browser`, `content-no-vfs`).

| Layer      | Path                          | Role                                                |
| ---------- | ----------------------------- | --------------------------------------------------- |
| entrypoints| `entrypoints/{background,content,sidepanel,live-log,...}` | Chrome MV3 host contexts. `background/` is the SW. `sidepanel/` is the chat UI. Content scripts are gated by `lib/browser/`. |
| components | `components/`                 | React UI primitives + feature components (chat, settings, vfs). No access to entrypoints. |
| hooks      | `hooks/`                      | Shared React hooks for UI ↔ background bridging.    |
| lib        | `lib/`                        | Pure logic and storage contracts. **No runtime dependency on UI.** Type-only imports are the exception. |

`lib/` is intentionally the thickest layer because it's where the contract
between UI and background lives. UI pulls `SessionRecord`, `ServerMessage`,
`Attachment`, etc. from `lib/` by type, and the background validates incoming
IPC payloads against those same shapes via `isValidSessionLike` and friends.

## Service worker (background) capability modules

`entrypoints/background/` is structured so **each capability owns its own folder**,
the SW root holds only `index.ts`, and capabilities may import from the four
shared subsystems (`ipc/`, `agent/`, `providers/`, `lifecycle/`) but not from
each other:

```
index.ts                ← only orchestration; imports each module's setup()
├── chat/               ← sessions, viewer routing, backups
│   ├── session-manager.ts   11-method public API; per-session Agent lifecycle
│   ├── session-store.ts     Dexie wrapper (chat-owned data layer)
│   ├── viewers.ts           port → sessionId routing table
│   └── backup-handler.ts    IPC for backup collect / restore
├── recorder/           ← session recording lifecycle
├── memory/             ← auto-organize scheduler + Dexie scan
├── page-actions/       ← selection toolbar + floating ball dispatcher
├── providers/          ← credentials, OAuth refresh, dev seed
├── lifecycle/          ← keepalive ref-count, update-notice banner
└── ipc/                ← port-registry (transport only); no business imports
```

The layering inside `background/` is enforced by `ipc/` and capability folders
never importing each other. If a change needs cross-capability plumbing, route
it through `index.ts` or extract a shared helper into `lifecycle/`/`agent/`.

## IPC: ports vs sendMessage

Two transports, two purposes:

| Transport                | Use                                                      |
| ------------------------ | -------------------------------------------------------- |
| `chrome.runtime.connect` | Long-lived port per UI instance. Default for chat/recorder/memory. |
| `chrome.runtime.sendMessage` | Fire-and-forget RPC. Page actions, VFS, sandbox-rpc, element-picker, backup flush signal. |

Port-based messaging uses **one port per UI instance**, named
`cebian-client` (constant `CLIENT_PORT` in [`lib/ipc/protocol.ts`](lib/ipc/protocol.ts)).
Domain shims (`lib/mcp/sidepanel-channel.ts`, `lib/recorder/sidepanel-channel.ts`)
reuse that port so each UI instance only ever holds one connection.

`sendMessage` listeners aren't routed — they're broadcast to every extension
context. The first handler to claim a message wins. Every handler must check
the message type first or it will eat messages intended for others. There's
also a 64MiB per-message cap, which is why backup restore is chunked and
backup collect reads Dexie directly from the page side.

The transport layer (`entrypoints/background/ipc/port-registry.ts`) knows
nothing about business domains. Each capability registers `onPortConnect` /
`onPortDisconnect` hooks to plug into the lifecycle.

## Chat viewer routing

`chat/viewers.ts` is the **business state** for "which window is viewing
which session" — the transport registry has no concept of sessionId.

```
port-registry   ← knows about ports only
  └── chat/viewers.ts  ← port → sessionId Map (chat's concern)
        └── index.ts   ← orchestration: stopViewing → grace-cancel
```

The `session-manager → viewers` edge is **one-way**; `viewers.ts` MUST NOT
import `session-manager.ts`. Adding `sessionManager.cancel()` inside
`viewers.ts` would create a runtime cycle and depcruise `no-circular` would
fail. The TODO sub-task 7 plan moves grace-cancel into
`chat/client-handlers.ts`, which doesn't have this constraint.

### Grace-cancel pattern

When the last viewer disconnects from a session, the agent isn't cancelled
immediately — there's a 60-second grace period (constant
`AGENT_GRACE_PERIOD_MS` in `entrypoints/background/index.ts`). Quick
reconnects (close sidepanel, switch tabs, copy text) keep the stream alive.
The agent's keepalive (`SessionManager.updateKeepAlive`) keeps the SW
running while the agent is busy, so the timer is guaranteed to fire.

## Session manager public API

`entrypoints/background/chat/session-manager.ts` exports one symbol
(`sessionManager`) and 11 public methods, all consumed by
`entrypoints/background/index.ts` plus one (`hasActiveSession`) by
`memory/organize-manager.ts`:

| Method                       | Used by                          |
| ---------------------------- | -------------------------------- |
| `watchMCPTools()`            | startup                          |
| `hasActiveSession()`         | auto-organize idle gate          |
| `prompt(sessionId, text, attachments, turn?)` | chat UI            |
| `cancel(sessionId)`          | chat UI + grace-cancel timer     |
| `retry(sessionId, turn?)`    | chat UI                          |
| `editAndRerun(sessionId, idx, text, turn?)` | chat UI             |
| `resolveTool`/`cancelTool`   | interactive tools                |
| `resolvePermission`          | permission cards                 |
| `getSessionState`            | reconnect + list annotation      |
| `destroySession`             | session delete                   |

The file itself has four overlapping concerns (per its own header TODO):
session orchestration, message sync/persist, viewer broadcast, and single-agent
lifecycle. An `AgentRun` extraction is the planned refactor — see
[TODO.md sub-task before item 7](TODO.md).

## Hybrid injection pattern

Mention chips (`@english`) and slash commands (`/english`) used to render
differently — mentions got a chip, slash commands got bolded inline text.
Both now use the **same directive shape**:

```
[DIRECTIVE — ATTACHED PROMPT: "english"]
<expanded prompt body>

[END DIRECTIVE]

---

user's actual typed text (if any)
```

Three variants exist today: `PROMPT` (mention chip), `SKILL` (mention chip),
`COMMAND` (slash command). The bubble parser
([`lib/agent/message-helpers.ts`](lib/agent/message-helpers.ts)) handles all
three and renders the appropriate chip. The LLM still receives the full
expanded prompt body — the directive is purely a UI shape.

The directive prefix is *stripped* before the bubble renders the user's text
(`stripDirectives`). It is *preserved* through BG → UI state reconciliation
([`lib/agent/rewrite-last-user-message.ts`](lib/agent/rewrite-last-user-message.ts)),
which rewrites only the user-typed segment between `\n\n---\n\n` and the
BG wrapper's `\n</user-request>` close. Dropping the close is a known
regression — it lets the bubble latch onto an inner skill-body close tag
and leak template tags into the live UI.

## Storage layout

Three persistent surfaces:

| Surface | Location                | Owner         |
| ------- | ----------------------- | ------------- |
| Sessions (Dexie IDB) | `lib/persistence/db.ts` `db.sessions` table (`id, updatedAt` index) | `chat/session-store.ts` |
| Settings / credentials (chrome.storage) | `lib/persistence/storage.ts` typed `WxtStorageItem` exports | various |
| VFS workspace files | `lib/persistence/vfs.ts` (Isomorphic LightningFS over OPFS) | `entrypoints/background/index.ts` + UI |

### Backup registry

The backup feature (`lib/backup/`) collects from and restores to `chrome.storage`
**only** — sessions are read directly from Dexie on the page side and the
message is a flush signal (the 64MiB sendMessage limit rules out passing them
through). The [`lib/backup/registry.ts`](lib/backup/registry.ts) is the single
source of truth for "which storage item belongs to which class":

- `settings` → `config.json` (no secrets)
- `credentials` → `credentials.json` (default excluded, optionally encrypted)
- `exclude` → not backed up

Adding a new storage item **must** register it here — the exhaustive test
in `lib/backup/registry.test.ts` fails the build otherwise.

## Build pipeline

```
pnpm install  → postinstall runs `wxt prepare` (generates .wxt/types) +
                                  simple-git-hooks (installs pre-commit) +
                                  scripts/patch-wxt-dev.mjs (shim for dev)
pnpm compile  → tsc --noEmit
pnpm test     → vitest (watch)
pnpm test:run → vitest run
pnpm depcruise→ depcruise entrypoints components hooks lib
                  (architecture guardrails)
pnpm check    → wxt prepare && tsc --noEmit && lint-i18n && vitest run
                  (the pre-commit hook runs this)
pnpm check:branches → branch hygiene guard (warning by default;
                       --strict to fail; threshold via BRANCH_HYGIENE_THRESHOLD)
pnpm build    → wxt build && scan-obfuscation (CWS Red Titanium check)
pnpm zip      → wxt zip && scan-obfuscation (publish-ready)
```

The `check` chain is the pre-commit hook. Three quality gates:
1. **TypeScript** (`tsc --noEmit`)
2. **i18n lint** ([`scripts/lint-i18n.mjs`](scripts/lint-i18n.mjs)) — locale top-level keys conform to allow-list, full key parity across en/zh_CN/zh_TW, no Chinese characters in user-facing source positions
3. **Vitest** (currently 555 tests across 58 files)

## Anti-patterns to avoid

- **Don't add new `chrome.runtime.onMessage` listeners in capability folders**
  if the work is BG-only — the four listeners in `lib/` exist because they
  must run in multiple execution contexts (page actions, VFS, sandbox-rpc,
  element-picker). Anything BG-only should be a port hook or routed through
  the planned IPC client router (TODO sub-task 7).
- **Don't let `chat/viewers.ts` import `session-manager.ts`** — the depcruise
  `no-circular` rule will fail.
- **Don't introduce a new storage item without registering it** in
  `lib/backup/registry.ts`.
- **Don't run compaction / retry / cancel as direct calls** from outside
  `chat/client-handlers.ts` (after sub-task 7 lands); the layering rule is
  `capability → ipc/, agent/, providers/, lifecycle/`.

## Related docs

- [TODO.md](TODO.md) — refactor backlog and rationale
- [CHANGELOG.md](CHANGELOG.md) — user-visible change history
- [MAINTAINING.md](MAINTAINING.md) — first-day setup for new maintainers
- [.dependency-cruiser.cjs](.dependency-cruiser.cjs) — the rules this doc describes
- [scripts/check-branches.mjs](scripts/check-branches.mjs) — branch hygiene guard