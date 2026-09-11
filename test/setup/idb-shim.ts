// Lightning-fs (transitive dep of VFS) constructs `new IDBKeyVal.Store()`
// at first access. In node test env (vitest standalone), `indexedDB` is
// undefined → unhandled rejection during teardown of any test that
// even briefly touches the vfs module. fake-indexeddb (already in the
// pnpm store as a transitive dep) provides a minimal in-memory IDB
// implementation; assigning it to globalThis before tests run keeps
// the lightning-fs init happy without affecting production behavior
// (production runs in sidepanel/background where window.indexedDB is
// real). This is test-environment noise suppression — the underlying
// behavior under test is unaffected.
import 'fake-indexeddb/auto';
