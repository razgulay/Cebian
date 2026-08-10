/**
 * 会话标签解析——把工作区目录的裸 UUID（`/workspaces/<uuid>/`）翻译成人类可读的
 * 「会话标题 · 日期」。事实源是 Dexie 的 sessions 表（标题会被 AI 后续改写），故这里
 * 只在渲染那一刻去查、不落任何冗余元文件，避免标题漂移。
 *
 * 这是 VFS 浏览器里唯一读 Dexie 的地方：跨库读经 `getSessionLabels`（db.ts 封装，
 * 单一 Dexie 访问点）一次批量取一屏 UUID 的标签，DirView 保持纯展示。
 */
import { getSessionLabels, type SessionLabelRow } from '@/lib/persistence/db';
import { t } from '@/lib/i18n';

/** 时间戳格式化为本地短日期（跟随浏览器 locale）。 */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

/** 一次批量解析多个工作区 UUID 的标签行，返回 `uuid → 标签行` 映射；查不到的 UUID
 *  不出现在 map 里，由调用方回落为「未知会话」。 */
export async function resolveWorkspaceLabels(
  uuids: string[],
): Promise<Map<string, SessionLabelRow>> {
  const rows = await getSessionLabels(uuids);
  return new Map(rows.map((r) => [r.id, r]));
}

/** 工作区目录的列表项标签。已知会话 → 标题（空标题回落「未命名会话」）+ 最后活动日期；
 *  孤儿目录 → 「未知会话 · 短ID」、无日期。 */
/** 工作区目录的列表项标签。已知会话 → 标题（空标题回落「未命名会话」）+ 最后活动日期 +
 *  完整 UUID（列表第二行以灰字展示，即真实目录名，便于区分同名会话 / 复制引用）；
 *  孤儿目录 → 直接展示完整目录名作为标题、无第二行。`isOrphan` 让 DirRow 给标题加
 *  tooltip 解释「这是已删除会话的残留目录」+ 用 muted 颜色与正常目录视觉区分。 */
export function formatWorkspaceEntry(
  uuid: string,
  row: SessionLabelRow | undefined,
): { title: string; dateLabel: string; uuid: string; isOrphan: boolean } {
  if (!row) {
    return {
      // Title is the full directory name (not the 8-char shortId) — the user
      // only sees this short snippet per row and the short id "baobinht" is
      // less informative than "baobinththuan". uuid stays empty so we don't
      // re-render the same string on a redundant second line.
      title: uuid,
      dateLabel: '',
      uuid: '',
      isOrphan: true,
    };
  }
  return {
    title: row.title.trim() || t('vfs.untitledSession'),
    dateLabel: formatDate(row.updatedAt),
    uuid,
    isOrphan: false,
  };
}

/** 进入某个工作区目录时顶部信息条的内容。仅在会话仍存在时返回；孤儿目录返回 null
 *  （不显示信息条，列表项已用「未知会话」标注）。 */
export function formatWorkspaceBanner(
  row: SessionLabelRow | undefined,
): { title: string; createdLabel: string } | null {
  if (!row) return null;
  return {
    title: row.title.trim() || t('vfs.untitledSession'),
    createdLabel: t('vfs.workspaceCreated', [formatDate(row.createdAt)]),
  };
}
