import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * useTypewriterText — 流式文本的 Typewriter Buffer Queue（前端缓冲队列）。
 *
 * 模型吐出的完整文本（target）不直接进 DOM：hook 持有一个「已显示长度」游标，
 * 用固定间隔的 timer 从队列里匀速捞出字符追加到显示面——把 80ms coalesce
 * 窗口攒出的成块文本拉平成连续的打字机节奏。设计要点：
 *
 *  - **自适应追赶**：每 tick 揭示 `pending / CATCHUP_TICKS`（≈12 tick 追平
 *    积压），下限 1 保证始终前进（涓流时逐字），上限 60 防止单帧跳变过长
 *    （大块积压也在 ~0.4s 内平滑追平，不吞字、不无限落后）。
 *  - **完成即冲刷**：`active` 翻 false 的瞬间把剩余 buffer 全部显示——
 *    agent_end 后不允许任何文字滞留在队列里。
 *  - **内容被换**：target 不是当前已显示前缀的延续（重试 / 编辑 / 分支切换
 *    导致整段内容替换）时重置游标，绝不把旧游标索引进新字符串里显示错字。
 *  - **非流式零开销**：`active=false` 时直接透传 target，不建 timer——历史
 *    消息 / 其它 MarkdownRenderer 调用点行为与性能完全不变。
 *
 * 逻辑拆分：`revealLength` 是纯函数（单测钉住节奏），hook 只负责 timer 与
 * 游标状态（项目无 @testing-library/react，与 useBackgroundAgent.test.ts
 * 的「pure helper + 薄壳」先例一致）。
 */

/** 每次揭示的间隔（25–40ms 区间取 33ms ≈ 30fps，与显示刷新同量级）。 */
const TICK_MS = 33;
/** 单 tick 揭示上限——防止单帧跳变过长（60 字符 ≈ 一行的一半）。 */
const MAX_REVEAL_PER_TICK = 60;
/** 追平积压的目标 tick 数：pending 越大单 tick 揭示越多，~12 tick（≈0.4s）追平。 */
const CATCHUP_TICKS = 12;

/** 单次 tick 应揭示的字符数（纯函数）。pending ≤ 0 → 0（无进展）。 */
export function revealLength(pending: number): number {
  if (pending <= 0) return 0;
  return Math.min(MAX_REVEAL_PER_TICK, Math.max(1, Math.ceil(pending / CATCHUP_TICKS)));
}

/**
 * 打字机缓冲：`active` 期间返回 target 的已显示前缀（匀速增长），结束时
 * 冲刷并透传完整 target。target 前缀延续（正常流式追加）不打断节奏。
 */
export function useTypewriterText(target: string, active: boolean): string {
  const [shownLen, setShownLen] = useState(() => (active ? 0 : target.length));
  const shownLenRef = useRef(shownLen);
  const targetRef = useRef(target);
  const prevTargetRef = useRef('');
  targetRef.current = target;

  // target 变化三分类：非流式 → 冲刷透传；前缀延续 → 不动（打字继续）；
  // 内容整体被换 → 游标归零重打（不是从头播放旧文本，是新内容从零开始）。
  // 用 useLayoutEffect：换内容的 render 若带着旧游标先画一帧会把新文本开头
  // 渲染错（甚至整段闪现）——必须在 paint 前把游标归位。
  useLayoutEffect(() => {
    const prev = prevTargetRef.current;
    prevTargetRef.current = target;
    if (!active) {
      setShownLen(target.length);
      shownLenRef.current = target.length;
      return;
    }
    if (prev && !target.startsWith(prev.slice(0, shownLenRef.current))) {
      setShownLen(0);
      shownLenRef.current = 0;
    }
  }, [target, active]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const t = targetRef.current;
      setShownLen((len) => {
        const next = Math.min(t.length, len + revealLength(t.length - len));
        if (next === len) return len;
        shownLenRef.current = next;
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return active ? target.slice(0, shownLen) : target;
}
