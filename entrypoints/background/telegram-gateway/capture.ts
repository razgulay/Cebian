// Telegram Gateway — CDP tab capture（/tabs 流程专用）。
//
// 为什么不用 captureVisibleTab：它只能拍「当前 focused window 里的 visible
// tab」——后台 tab 直接报 `view is invisible`；被 Memory Saver discard 的 tab
// 连 renderer 都没有。改走 chrome.debugger + CDP `Page.captureScreenshot`：
// offscreen 渲染、不 activate、不抢用户焦点、不吃 2/s 配额；discarded tab 先
// reload 唤醒到 complete 再拍。
//
// 硬约束：attach 成功后必须在 finally 里 detach——挂着不摘 = tab 常驻黄色
// 「正在被调试」横幅。并发用 per-tab 串行化：double-tap / webhook 重投会让
// 同一 tab 的两次 capture 互相踩（旧实现的 activate/capture 竞态），排队执行；
// 跨 tab 不串行（互相独立，5 个 tab 连拍不互相阻塞）。

const CDP_VERSION = '1.3';
/** discarded → reload 唤醒的等待上限（慢站点 reload 可能要好几秒）。 */
const DISCARD_WAKE_TIMEOUT_MS = 15_000;

/** tabId → 该 tab 当前 capture 队列尾（同 tab 串行、跨 tab 并行）。 */
const captureQueues = new Map<number, Promise<unknown>>();

/**
 * 等 tab 从 discarded/unloaded 唤醒到 complete（tabs.onUpdated + catch-up，
 * 结构同 lib/browser/tab-actions 的 waitForNavigation——那是导航泛型版；这里
 * 只需要「唤醒等待」，超时由 caller 报人类可读的睡眠文案）。
 */
function waitForTabWake(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`wake timeout after ${timeoutMs}ms`)));
    }, timeoutMs);
    const listener = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        settle(resolve);
      }
    };
    // 等待期间 tab 被关掉 → 立刻失败（不烧满超时——死 tab 重试无意义）
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        settle(() => reject(new Error('tab gone while waking')));
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // catch-up：reload 可能已在我们挂上监听之前完成
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') settle(resolve);
      })
      .catch(() => {
        settle(() => reject(new Error('tab gone while waking')));
      });
  });
}

/** 单次 capture（不含串行化）。所有失败路径都 throw 人类可读的越南语文案。 */
async function captureOnce(tabId: number): Promise<{ base64: string; title: string }> {
  let targetTab: chrome.tabs.Tab;
  try {
    targetTab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.warn('[telegram-gateway] capture: tabs.get failed', { tabId, err });
    throw new Error('Tab đã bị đóng hoặc không tồn tại');
  }

  // discarded（Memory Saver）→ 没有 renderer，先 reload 唤醒到 complete 再拍。
  if (targetTab.discarded) {
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabWake(tabId, DISCARD_WAKE_TIMEOUT_MS);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 等待期间 tab 被关掉 → 报「không tồn tại」而不是「ngủ quá lâu」——
      // 对死 tab 报「重试也没用」的正确语义，避免 user 无限重试。
      if (/closed|gone/i.test(raw)) {
        throw new Error('Tab đã bị đóng hoặc không tồn tại');
      }
      throw new Error('Tab đang ngủ — đã thử đánh thức nhưng quá lâu');
    }
    // reload 后 title 可能已更新——best-effort 重读一次，失败沿用旧值
    targetTab =
      (await chrome.tabs.get(tabId).catch(() => null)) ?? targetTab;
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // attach 报「already attached」只可能来自**外部** debugger（DevTools）——
    // 同一 extension 的重复 attach 是 no-op 成功、根本不会走到这里。
    if (/already attached|devtools/i.test(raw)) {
      throw new Error('Tab đang mở DevTools — đóng DevTools rồi thử lại');
    }
    // chrome:// / Web Store 等受限页不可被 debugger attach（「Cannot attach to
    // this target」）——与 DevTools 冲突是两回事，文案必须分开（/tabs keyboard
    // 会列出这些系统页，点到的概率不低）。
    if (/cannot attach/i.test(raw)) {
      throw new Error('Trang hệ thống không cho phép chụp tab này');
    }
    throw new Error(`Capture failed: ${raw}`);
  }

  try {
    let result: { data?: string } | undefined;
    try {
      result = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 60,
      })) as { data?: string } | undefined;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new Error(`Capture failed: ${raw}`);
    }
    const base64 = result?.data;
    if (typeof base64 !== 'string' || base64.length === 0) {
      // 不经 Capture failed 前缀二次包装——这条本身就是给 user 看的最终文案
      throw new Error('CDP trả về ảnh rỗng');
    }
    // CDP 返回裸 base64（无 data: 前缀）——与 sendPhoto 的 image_base64 契约直配
    return { base64, title: targetTab.title ?? '' };
  } finally {
    // 无论成败都 detach——不留黄色 debug 条
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* 本来就没 attach 上 / 已被对方摘除 —— 忽略 */
    }
  }
}

/**
 * /tabs 流程的 capture 入口（同 tab 串行、跨 tab 并行）。
 * 失败一律 reject（Error.message 是给 user 看的越南语文案）——绝不静默，
 * 绝不返回半成品；发不发照片由 caller（dispatchTabsCallback）决定。
 */
export function captureTabForTelegram(
  tabId: number,
): Promise<{ base64: string; title: string }> {
  const prev = captureQueues.get(tabId) ?? Promise.resolve();
  // 前一个失败也继续排——用户重试不该被上一次的失败卡死
  const job = prev.then(
    () => captureOnce(tabId),
    () => captureOnce(tabId),
  );
  captureQueues.set(tabId, job);
  // 内部副本吞掉 rejection（caller 手里有 job 本体），settle 后清理表项
  void job
    .catch(() => {})
    .then(() => {
      if (captureQueues.get(tabId) === job) captureQueues.delete(tabId);
    });
  return job;
}
