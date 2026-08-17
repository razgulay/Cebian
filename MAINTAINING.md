# Cebian — Onboarding Guide

A first-day orientation for new maintainers. Assumes you already have the repo
cloned and dependencies installed.

## 1. Set up your dev environment

```bash
# Node ≥ 22.19 is enforced via package.json `engines`
node --version

# Install dependencies (runs wxt prepare + simple-git-hooks install automatically)
pnpm install

# Run the full quality gate once to confirm your environment
pnpm check
```

You should see:

- TypeScript: `tsc --noEmit` exits 0
- i18n lint: 3 lines of `✓`
- Vitest: 58 test files, 555 tests, all pass

If anything fails, check [Common failures](#common-failures) below.

## 2. Map the codebase in 20 minutes

Read in this order — each builds on the previous:

1. **[README.md](README.md)** — what the extension does and key features.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — layered architecture, capability
   modules, the viewer routing story, hybrid injection pattern, storage layout.
3. **[TODO.md](TODO.md)** — what's open, what's in progress, what's
   deferred. Critical for understanding why certain code looks the way it does.
4. **Open [`entrypoints/background/index.ts`](entrypoints/background/index.ts)**
   — the service worker entrypoint. Notice how it calls each capability's
   `setup()` and handles port lifecycle. About 600 lines, mostly orchestration.
5. **Open [`entrypoints/background/chat/session-manager.ts`](entrypoints/background/chat/session-manager.ts)**
   — the biggest file (~1570 lines). Read the header TODO (lines 4-11) first.
6. **Skim [`lib/ipc/protocol.ts`](lib/ipc/protocol.ts)** — the message
   vocabulary between UI and background.

## 3. Common tasks

### Run the extension in Chrome

```bash
pnpm dev
```

Then load `/.output/chrome-mv3-dev/` as an unpacked extension in
`chrome://extensions`. The dev build uses WXT's HMR — most edits reload
themselves. **Beware:** service worker restarts lose module-level state.
Anything that needs to persist across restarts goes in Dexie or
`chrome.storage`.

### Add a new `chrome.storage` setting

1. Define it in [`lib/persistence/storage.ts`](../lib/persistence/storage.ts)
   using `storage.defineItem<T>(...)`.
2. **Register it in [`lib/backup/registry.ts`](../lib/backup/registry.ts)** —
   pick a `StorageClass` (`settings` / `credentials` / `exclude`) and add
   it to `BACKUP_REGISTRY`. The exhaustive test there will fail CI otherwise.
3. Read/write via the typed accessor you exported. Both UI and background
   can import the accessor directly.

### Add a new IPC message

1. Add the variant to `ClientMessage` / `ServerMessage` union in
   [`lib/ipc/protocol.ts`](../lib/ipc/protocol.ts).
2. Handle it in the relevant `client-handlers.ts` (or `entrypoints/background/index.ts`
   for BG-routed cases pre-sub-task-7).
3. Add a Vitest covering the handler's decision branches.

### Touch the session lifecycle

`entrypoints/background/chat/session-manager.ts` is the only file that owns
the per-session Agent lifecycle. The 11 public methods on it are stable
contract — don't change their signatures. Internally, you can refactor, but:

- **Zero direct test coverage today.** Add characterization tests
  *before* changing anything significant. The phase machine (`AgentPhase`),
  `cancel` dispatch by phase, and the race guards in `commitRetryCancel` /
  `commitCompactionCancel` are the load-bearing areas.
- **Don't break the one-way edge** `session-manager → viewers`. If you need
  `viewers.ts` to react to session state, route through `index.ts` (or the
  planned `chat/client-handlers.ts` after sub-task 7).

### Add a new capability to the background

Per the layering rule in TODO.md:

```
ipc/                         ✗ may not import any capability
agent/ providers/ lifecycle/ ✗ may not import capability dirs or ipc/
                              (agent/ → providers/ is the only allowed edge)
capability dirs               ✓ may import ipc/, agent/, providers/, lifecycle/
```

Place it under `entrypoints/background/<name>/`. `index.ts` is the only file
allowed to import multiple capabilities. If you need cross-capability data
flow, push it through `index.ts` or extract a shared helper into one of the
four shared subsystems.

### Touch i18n strings

Three locales: `en.yml`, `zh_CN.yml`, `zh_TW.yml` in `locales/`. Adding
a new key:

1. Add it to all three files (parity is enforced).
2. Use the existing `t('namespace.key')` helper from `@/lib/i18n`.
3. Don't put Chinese characters directly in JSX or component string literals
   — the i18n lint will fail. Use `t()` instead.

## 4. Common failures

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `pnpm check` fails on i18n | Top-level key in `locales/*.yml` not in allow-list, or parity mismatch | Run `node scripts/lint-i18n.mjs` for details. Add the key to the allow-list in the script if it's a namespace. |
| `pnpm depcruise` errors | New cross-layer import | Check [`.dependency-cruiser.cjs`](.dependency-cruiser.cjs) for which rule failed. The fix is structural — move code, don't suppress the rule. |
| Service worker loses state on reload | Module-level `Map`/`Set`/`let` cleared on SW restart | Anything persistent goes in Dexie or `chrome.storage`. |
| `chrome.runtime.sendMessage` "message size exceeded" | Payload > 64MiB | Stream in chunks (see backup restore protocol) or read directly from the source on the receiving side. |
| Tests pass individually but fail in `pnpm check` | Shared state between tests | Look for module-level singletons in `lib/persistence/`, `lib/mcp/`, etc. The fix is per-test isolation, not retry. |

## 5. Where to ask / find things

- **Code questions**: search first. Cebian is small enough (~50K LOC) that
  grep + a few file reads beats asking. The TODO header comments often
  explain *why* a piece of code looks non-obvious.
- **Architecture questions**: [ARCHITECTURE.md](ARCHITECTURE.md) is the
  canonical map. The TODO.md comments on pending refactors are the most
  honest source of "why isn't this cleaner."
- **Bug history**: [CHANGELOG.md](CHANGELOG.md) + `git log --oneline`.
  Both are kept up to date as commits land.

## 6. House rules

- **One branch at a time.** Cleanup from 14-branch drift is recent — keep
  `master` the only local branch unless you're doing a parallel experiment.
  `pnpm run check:branches` will warn you if you forget.
- **Don't merge to master without running `pnpm check` end-to-end.**
  The pre-commit hook does this, but it can be bypassed with
  `git commit --no-verify` — don't.
- **Don't add Chinese characters to user-facing source positions.**
  The i18n lint enforces this; bypassing it makes the codebase unmaintainable
  for non-zh readers.
- **Touching `session-manager.ts` is a checkpoint.** Read the file's
  header TODO, check what's open in [TODO.md](TODO.md), and write tests
  first if you're extracting anything.

Welcome. Most of the hard decisions in this codebase were *avoided*, not
*missed* — every constraint has a comment explaining why. Read the
comments.