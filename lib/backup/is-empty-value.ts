// 「值是否为空」helper —— backup merge 判定本地是否处于默认/未配置状态。
//
// 「空」= 该值在持久化层 fallback 之后等价于「用户没动过」，merge 时应被
// 备份覆盖。「空」≠「falsy」——例如 `webdavConfig` 的 `null` 是配置未填、
// `providerCredentials` 缺某 provider key 是该 provider 未配、
// `personaSoul` 的 `''` 是 SOUL 副本为空——这些都触发 merge 补缺。
// 而 `false` 在「personaEnabled」这种 master switch 上也按"默认 OFF"=空
// 处理（与 workerModels "Off 以 delete key 表达" 同 caveat：merge「只增
// 不减」契约使然）。
//
// —— 上下文：lib/backup/sources/storage.ts 与 lib/backup/registry.ts
// 都需要调用此 helper，避免循环 import（registry ← sources/storage），
// 故放在 lib/backup/ 顶层，让两边单向指向。

/**
 * 判断一个值是否「空」——用于 merge 模式下判定本地是否需要被备份补入。
 *
 * 覆盖：null / undefined / 空串 / 空数组 / 无 keys 的对象。其余类型
 * （number 非 0、boolean `false` 等）由 caller 决定 — 例如
 * `personaEnabled` 的 master switch 按 `local || backup` 自行处理
 * `false` 视为空的语义。
 */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}
