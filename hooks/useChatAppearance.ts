import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { chatAppearance, resolveChatAppearance, type ChatAppearance } from '@/lib/persistence/storage';
import { migrateLegacyChatAppearance } from '@/lib/ui/chat-appearance';

/**
 * 一次性迁移：fork 的 `local:chatFontSize` / `local:chatFontFamily` → `local:chatAppearance`。
 *
 * 只在**新 key 从未写过**时执行（`storage.getItem` 返回 null，不带 fallback 读原始值），
 * 这样已经用上新版设置的用户不会被旧值反向覆盖；旧 key 两个都缺失时 `migrate...` 返回
 * null，同样不写。迁移后旧 key 保留原样（不回删）——回滚到旧版本时外观设置仍在。
 */
async function migrateLegacyAppearanceOnce(): Promise<void> {
  try {
    const existing = await storage.getItem('local:chatAppearance');
    if (existing !== null) return;
    const legacy = migrateLegacyChatAppearance({
      fontSize: (await storage.getItem('local:chatFontSize')) as number | null,
      fontFamily: (await storage.getItem('local:chatFontFamily')) as string | null,
    });
    if (legacy) await chatAppearance.setValue(legacy);
  } catch (err) {
    // 迁移是增益路径：失败只记日志，不阻断外观读取（下面仍按默认值放行）。
    console.warn('[chat-appearance] legacy migration failed:', err);
  }
}

/**
 * 订阅对话区外观（已规范化）。首次读出前返回 null，调用方据此推迟渲染，避免先按默认字号
 * 画一帧再跳变。
 *
 * 先挂 watch 再读初值：若初读返回前已有更新推送进来，丢弃迟到的初读，免得旧值覆盖新值。
 * 读失败时按默认外观放行，不让对话区永远空白。
 */
export function useChatAppearance(): ChatAppearance | null {
  const [value, setValue] = useState<ChatAppearance | null>(null);

  useEffect(() => {
    let active = true;
    let updated = false;
    const unwatch = chatAppearance.watch((next) => {
      updated = true;
      if (active) setValue(resolveChatAppearance(next));
    });
    // 迁移先于初读：确保旧版用户的设置在首帧就能生效，而不是先渲染默认再跳变。
    void migrateLegacyAppearanceOnce().then(() =>
      chatAppearance
        .getValue()
        .then((initial) => {
          if (active && !updated) setValue(resolveChatAppearance(initial));
        })
        .catch((err) => {
          console.warn('[chat-appearance] load failed, using defaults:', err);
          if (active && !updated) setValue(resolveChatAppearance(null));
        }),
    );
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  return value;
}
