#!/usr/bin/env node
/**
 * scripts/patch-wxt-dev.mjs — Patch WXT dev server để bỏ qua `rm` thư mục
 * output khi `command === "serve"`.
 *
 * Tại sao cần patch:
 *   Chrome load unpacked extension ở `.output/chrome-mv3-dev`. Nó lock các
 *   file bundle (background.js 24MB, manifest.json, sidepanel.html, …) đang
 *   chạy. Windows không cho xoá thư mục đang bị process con nắm handle →
 *   EBUSY. WXT build lifecycle luôn `rm(outDir)` trước khi rebuild.
 *
 *   Cách cũ (rename thư mục → xóa sau, hoặc build ra timestamp) đều fail
 *   vì Chrome lock cả path lẫn file con. Cách này bypass: Vite tự ghi đè
 *   từng entrypoint (manifest.json, .html, .js) khi build, nên không cần
 *   xoá thư mục trước. File stale không còn entrypoint nào reference sẽ tự
 *   lỗi thời nhưng vô hại.
 *
 * Cách dùng:
 *   scripts/patch-wxt-dev.mjs        — apply patch nếu chưa có
 *   scripts/patch-wxt-dev.mjs undo   — restore file gốc từ backup
 *
 * Patch chạy tự động qua `postinstall` hook trong package.json. Nếu WXT
 * upgrade, file `internal-build.mjs` thay đổi → script phát hiện mismatch
 * và bỏ qua (không crash install).
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const TARGET = resolve(
  REPO,
  'node_modules/wxt/dist/core/utils/building/internal-build.mjs',
);
const BACKUP = `${TARGET}.unpatched`;
const MARKER = 'CEBIAN_PATCH_DEV_NO_RM';

// Marker phía dưới: dễ tìm, dễ revert bằng cách sed lại.
// Phải có `// ` phía trước — nếu không WXT 0.21+ sẽ parse nó thành
// reference đến biến undefined → ReferenceError lúc dev serve.
const PATCHED_BLOCK_OPEN = `// ${MARKER}
\t// Bỏ qua \`rm\` khi \`command === "serve"\` — Chrome lock file bundle
\t// đang chạy ở thư mục output (Windows → EBUSY). Vite tự ghi đè các
\t// entrypoint khi build, nên không cần xoá thư mục trước. Build
\t// production (\`command === "build"\`) vẫn chạy \`rm\` như cũ.
\tif (wxt.config.command !== "serve") {
`;

const ORIGINAL_BLOCK = '\tawait rm(wxt.config.outDir, {\n\t\trecursive: true,\n\t\tforce: true\n\t});\n';

// Older patches (pre-refactor) used a different comment shape and lacked
// the marker constant — recognize them too so re-running the script on a
// previously-patched install is idempotent instead of warning "no longer
// matches expected shape".
const LEGACY_MARKERS = [
  'PATCH (Cebian dev workflow): bỏ qua `rm` khi `command === "serve"',
];

const PATCHED_BLOCK = `${PATCHED_BLOCK_OPEN}\t\tawait rm(wxt.config.outDir, {\n\t\t\trecursive: true,\n\t\t\tforce: true\n\t\t});\n\t}\n`;

function main() {
  const undo = process.argv[2] === 'undo';

  if (!existsSync(TARGET)) {
    console.log('[patch-wxt-dev] wxt not installed yet — skip');
    return;
  }

  if (undo) {
    if (!existsSync(BACKUP)) {
      console.log('[patch-wxt-dev] no backup at', BACKUP, '— nothing to undo');
      return;
    }
    copyFileSync(BACKUP, TARGET);
    console.log('[patch-wxt-dev] restored from backup');
    return;
  }

  const src = readFileSync(TARGET, 'utf8');

  // Đã patch rồi → no-op.
  if (src.includes(MARKER)) {
    console.log('[patch-wxt-dev] already patched');
    return;
  }
  // Pre-refactor patches used a different comment shape (no marker constant).
  // Recognize them so re-running the script doesn't print a spurious
  // "shape mismatch" warning on already-patched installs.
  for (const legacy of LEGACY_MARKERS) {
    if (src.includes(legacy)) {
      console.log('[patch-wxt-dev] already patched (legacy marker)');
      return;
    }
  }

  // File WXT mới không còn block gốc → skip (WXT đã đổi cấu trúc).
  if (!src.includes(ORIGINAL_BLOCK)) {
    console.warn(
      '[patch-wxt-dev] internal-build.mjs no longer matches expected ' +
        'shape — WXT upgraded? Skipping patch.',
    );
    return;
  }

  // Lần đầu patch: backup file gốc.
  if (!existsSync(BACKUP)) {
    copyFileSync(TARGET, BACKUP);
    console.log('[patch-wxt-dev] backed up original to', BACKUP);
  }

  const patched = src.replace(ORIGINAL_BLOCK, PATCHED_BLOCK);
  writeFileSync(TARGET, patched, 'utf8');
  console.log('[patch-wxt-dev] applied: skip `rm` on dev serve');
}

main();