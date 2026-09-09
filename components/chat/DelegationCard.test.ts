// `aggregateBatchStatus` 是 outer batch container 的 pure decision helper ——
// 必须和 runner-side `aggregateBatchHandoffs` 1:1 镜像。Subtask 1.3 review #1
// 的 bug 就是「UI 跑了不同的 decision table，4/4 success 误报 partial」 ——
// 把这条 decision table 钉死在测试里，避免下次重构又跑偏。
//
// Subtask 2.3 还测了 `summarizeChecklist` —— mini-table header 用的 pass/warn/fail
// 计数器。它是 table 渲染唯一的 pure helper；React 渲染层走 react-testing-library
// 的方式我们没用（项目没有 @testing-library/react 历史），所以这条测试锁住的是
// 计数契约本身：空数组 / undefined → undefined（非空才渲染）；非合法 status
// 元素 silently skip（防 schema 漏过脏数据）。

import { describe, expect, it } from 'vitest';
import {
  aggregateBatchStatus,
  summarizeChecklist,
  type DelegationCardItemProps,
  type ChecklistItem,
} from './DelegationCard';

function item(status: DelegationCardItemProps['status']): DelegationCardItemProps {
  return {
    role: 'content_writer',
    status,
    task: 't',
  };
}

describe('aggregateBatchStatus', () => {
  it('empty list → failed (sane default, mirrors runner)', () => {
    expect(aggregateBatchStatus([])).toBe('failed');
  });

  it('all success → success (NOT partial — review #1 regression guard)', () => {
    expect(aggregateBatchStatus([item('success'), item('success'), item('success')])).toBe('success');
  });

  it('any running → running (coarse outer wins over per-item resolved)', () => {
    expect(aggregateBatchStatus([item('success'), item('running'), item('failed')])).toBe('running');
  });

  it('mixed success + fail (no running) → partial', () => {
    expect(aggregateBatchStatus([item('success'), item('failed')])).toBe('partial');
    expect(aggregateBatchStatus([item('success'), item('success'), item('failed')])).toBe('partial');
  });

  it('mixed success + partial item → partial (same shape as success + fail)', () => {
    // runner 标 partial 的 item 仍是 success-with-caveat；outer 算 partial
    // 是因为「不是所有 item 都 success」。这里保护 outer 表不走偏。
    expect(aggregateBatchStatus([item('success'), item('partial')])).toBe('partial');
  });

  it('all failed / cancelled / timedOut → failed', () => {
    expect(aggregateBatchStatus([item('failed'), item('failed')])).toBe('failed');
    expect(aggregateBatchStatus([item('cancelled'), item('timedOut')])).toBe('failed');
    expect(aggregateBatchStatus([item('failed'), item('cancelled'), item('timedOut')])).toBe('failed');
  });
});

describe('summarizeChecklist', () => {
  // helpers — build a checklist row with the kebab id / status / evidence triple
  // that Subtask 2.2 schema-validate.ts` REVIEWER_HANDOFF_SCHEMA` keeps in lockstep
  // with `REVIEWER_CHECKLIST_ITEM_IDS`.
  const row = (status: ChecklistItem['status'], item = 'no-localstorage', evidence = 'ok'): ChecklistItem =>
    ({ item, status, evidence });

  it('undefined → undefined (caller skips mini-table render)', () => {
    expect(summarizeChecklist(undefined)).toBeUndefined();
  });

  it('empty array → undefined (matches real "no audits emitted" path; do NOT mis-report 0/0/0)', () => {
    expect(summarizeChecklist([])).toBeUndefined();
  });

  it('passes only → {pass: N, warn: 0, fail: 0}', () => {
    expect(summarizeChecklist([row('pass'), row('pass'), row('pass')]))
      .toEqual({ pass: 3, warn: 0, fail: 0 });
  });

  it('fails only → {pass: 0, warn: 0, fail: N} (all-bucket-zero regression guard)', () => {
    // All-fail case must zero out pass + warn, not leave them undefined —
    // mini-table header counts come straight from this object.
    expect(summarizeChecklist([row('fail'), row('fail')]))
      .toEqual({ pass: 0, warn: 0, fail: 2 });
  });

  it('single-element warn → {pass: 0, warn: 1, fail: 0}', () => {
    // 1-item edge: ensure the counter does not double-count or skip the lone row.
    expect(summarizeChecklist([row('warn')]))
      .toEqual({ pass: 0, warn: 1, fail: 0 });
  });

  it('mixed pass / warn / fail counts each bucket correctly', () => {
    expect(summarizeChecklist([
      row('pass'),
      row('warn'),
      row('fail'),
      row('fail'),
      row('pass'),
    ])).toEqual({ pass: 2, warn: 1, fail: 2 });
  });

  it('silently drops entries with unknown status (schema leak defense)', () => {
    // Schema (Subtask 2.2) 强制 status enum，但 UI 不能因脏数据 crash。
    const dirty = [
      row('pass'),
      // cast 通过 —— 测试故意伪造 schema 漏过的形状。
      { item: 'broken', status: 'maybe', evidence: 'x' } as unknown as ChecklistItem,
      row('fail'),
    ];
    expect(summarizeChecklist(dirty)).toEqual({ pass: 1, warn: 0, fail: 1 });
  });

  it('silently drops null / non-object entries (defensive parse)', () => {
    const dirty = [
      row('pass'),
      null,
      undefined,
      'string',
      42,
      row('warn'),
    ] as unknown as ChecklistItem[];
    expect(summarizeChecklist(dirty)).toEqual({ pass: 1, warn: 1, fail: 0 });
  });
});
