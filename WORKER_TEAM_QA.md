# Worker Team — Production QA Prompt Suite / 生产前人工 QA 提示集

> **Mục đích / 目的**: Bộ **19 prompt** để dán trực tiếp vào chat Cebian, chạy **thật** qua hệ thống Worker Team (`delegate_task`), rồi **đối chiếu debug log** để validate trước khi build production. Đây KHÔNG phải unit test — là **bảng kiểm thao tác bởi người** (operator runbook).
> This is a manual, log-verified QA battery for the worker-team (`delegate_task`) subsystem — not automated tests.

---

## 0. Cách dùng / How to use

1. `pnpm dev` → `chrome://extensions` → **Reload** extension → mở **sidepanel**.
2. Bật log: **Settings → About → Debug log = ON**. (Tùy chọn mở **Live log** để xem realtime, hoặc **export** `cebian-debug-<timestamp>.json` sau mỗi nhóm.)
3. Đặt chip composer **⚡Fast / 👥Team** theo từng scenario (mặc định chạy delegation thì để **👥Team**).
4. Gửi prompt ở khối `>`. Chờ worker chạy xong.
5. **Đối chiếu**: tìm các event `sub_agent:worker:*` tương ứng trong log, so với cột "Log soi". Tick `[x] Pass` hoặc `[x] Fail` + ghi chú.
6. Map 1 lượt chat → log: lọc theo `sessionId` + `role` + `attempt`. Mỗi `delegate_task` call = 1 `attempt:start` (retry sẽ thêm `attempt` = 2).

> **Khi có Fail**: **giữ lại file `cebian-debug-*.json`** của ca đó + ghi timestamp. Đó là bằng chứng để debug tiếp.
> **Exit criteria**: chỉ build production (`pnpm build` / `pnpm zip`) khi **toàn bộ scenario `[deterministic]` Pass**. Nhóm `[best-effort]` (cần endpoint lỗi) không chặn nếu không tái hiện được.

---

## 1. Cheat-sheet log tag → ý nghĩa → field chính

Category luôn là `sub_agent`; prefix `sub_agent:worker:`. Nguồn: `entrypoints/background/agent/worker-runner.ts`.

| Event tag | Ý nghĩa | Field chính |
|---|---|---|
| `model:resolved` | Chọn model cho worker (3-tier) | tier, modelId |
| `attempt:start` | 1 attempt worker bắt đầu | role, attempt, modelId |
| `prompt:sent` | Đã gửi prompt vào agent | — |
| `stream:first_token` | Token đầu tới (mốc TTFT) | elapsedMs |
| `stream:phase` | Chuyển pha `before_ttft`/`emitting`/`between_turns` | phase |
| `stream:stop_reason` | Message kết thúc + bộ đếm loop | stopReason, consecutiveReads |
| `tool:start` / `tool:end` | Worker gọi tool (fs_read/create/edit/list) | toolName |
| `stuck_loop:reads` | Bộ đếm loop đang tăng (near-miss) | consecutiveReads, sameChunkRepeats |
| `stuck_loop:trigger` | Detector abort worker | triggerReason, consecutiveReads, hasWrittenThisAttempt, elapsedMs |
| `handoff:extracted` | Parse được handoff JSON từ text | status |
| `handoff:synthesized` | Fallback tự tổng hợp (silent-write / file-rescue) | reason |
| `attempt:done` | Attempt xong | status |
| `attempt:error` | Attempt lỗi | failureReason ∈ `ttft`\|`idle`\|`timeout`\|`ceiling`\|`stuck_loop`, timedOut |
| `retrying` | Single-pass retry kích hoạt | reason (json_parse / schema_fail / missing_output) |
| `output_read_after_timeout_failed` | Hết timeout mà đọc output file vẫn hỏng | path |
| `skill:missing_or_unreadable` | Skill chỉ định không đọc được | skill |
| `input:missing` / `input:read_error` | Input file không tồn tại / lỗi đọc | path |
| `done` | Kết quả cuối (outer `runWorker`) | ok, status, attempts, durationMs, role |

**Ngưỡng (constants đã verify)** — `lib/agent/worker-roles.ts`:
- TTFT = **120 000 ms** · Idle = **180 000 ms**
- Per-role ceiling: content_writer **120s** · frontend_coder **300s** · reviewer **90s** · researcher **90s**
- Handoff JSON & output content trong **tool result** bị cắt ở **2000 ký tự** → `…[truncated]` (`lib/tools/delegate-task.ts`)
- Batch: `Promise.allSettled`, mô tả ghi "up to 4" nhưng **KHÔNG có hard cap** trong code → xem **B3**.

---

## 2. Nhóm A — Hang / Timeout / Stuck-loop

### A1 · Happy baseline cho cả 4 role  `[deterministic]`
- Chip: 👥Team · Role: mỗi role 1 lượt
- Prompt (lần lượt 4 cái):
  > Have the **content_writer** worker draft a ~150-word product blurb for a fictional coffee brand, save it to `output/blurb.md`.
  > Have the **researcher** worker summarize the pros/cons of IndexedDB vs localStorage and return the summary as structured text in its handoff (researcher is read-only — it writes no file).
  > First save a small file `output/sample.html` with a heading, then have the **reviewer** worker audit it for accessibility issues.
  > Have the **frontend_coder** worker create a self-contained `output/card.html` with one button.
- Kỳ vọng UI: 4 card thành công; các card có output file (content_writer / frontend_coder) mở được bằng nút preview; reviewer / researcher trả text trong handoff (read-only, không file).
- Log soi: mỗi role có `attempt:start → stream:first_token (Δ nhỏ) → stream:phase=emitting → done{ok:true,status:success,attempts:1}`.
- Pass nếu: `durationMs` ≪ ceiling mỗi role, `attempts:1`, `status:success`.
- [ ] Pass  [ ] Fail · ghi chú: ____

### A2 · Stuck-loop detector (pre-write over-read)  `[deterministic]`
- Chip: 👥Team · Role: frontend_coder
- Prompt:
  > Have the **frontend_coder** worker build `output/page.html`. Before writing, it should list the `output/` folder and read `output/page.html` repeatedly to double-check each change — verify thoroughly many times.
  *(Mục tiêu: khiêu khích pattern "đọc lại liên tục" mà L2 detector phải bắt.)*
- Kỳ vọng UI: card báo aborted vì stuck-loop, KHÔNG treo tới tận 300s.
- Log soi: `stuck_loop:reads` tăng dần → `stuck_loop:trigger{triggerReason, consecutiveReads, hasWrittenThisAttempt}` → `attempt:error{failureReason:'stuck_loop'}` → `done`.
- Pass nếu: abort sớm (`elapsedMs` ≪ 300s ceiling), **không** `retrying` (deterministic → retryable=false).
- Fail nếu: burn hết ceiling mà không trigger, hoặc retry loop.
- [ ] Pass  [ ] Fail · ghi chú: ____

### A3 · Silent-write / file-rescue fallback  `[deterministic]`
- Chip: 👥Team · Role: frontend_coder
- Prompt:
  > Have the **frontend_coder** worker write a complete `output/rescued.html` file first, and only afterwards continue reading/verifying it many times before giving the handoff.
  *(Nếu abort tới sau khi file đã ghi xong → L3 rescue phải tổng hợp handoff success.)*
- Kỳ vọng UI: card **success**, output file `rescued.html` đầy đủ, summary mang nhãn như "stuck-loop detected, output file authoritative".
- Log soi: `handoff:synthesized` (KHÔNG phải `handoff:extracted`), `done{status:success}`; `output_read_after_timeout_failed` **không** xuất hiện (vì file đọc được).
- Pass nếu: file đã ghi → vẫn trả success qua synthesized handoff.
- [ ] Pass  [ ] Fail · ghi chú: ____

### A4 · TTFT hang (endpoint chậm/hỏng)  `[best-effort]`
- Chip: 👥Team · Role: bất kỳ
- Bối cảnh: chỉ tái hiện khi model endpoint thật sự không trả token đầu. Nếu có một model cấu hình hỏng, tạm gán cho role đó rồi chạy 1 task thường.
- Prompt:
  > Have the **<role using the slow/broken model>** worker write `output/any.md` with two sentences.
- Log soi: `attempt:error{failureReason:'ttft'}` trong ~120s; `stream:first_token` **không** bao giờ xuất hiện.
- Ghi chú: nếu không có endpoint lỗi để tái hiện → đánh dấu "N/A — không cưỡng bức được", **không chặn** production.
- [ ] Pass  [ ] Fail  [ ] N/A · ghi chú: ____

---

## 3. Nhóm B — Batch parallel + aggregation

### B1 · Batch 2 item đều thành công  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Using the worker team, run these two tasks **in parallel**: (1) content_writer drafts a haiku into `output/b1-haiku.md`; (2) researcher lists 3 benefits of HTTP/3 as text in its handoff (read-only, no file).
- Kỳ vọng UI: **1 batch card** với 2 item; aggregate "2 succeeded"; chỉ **1 LiveStreamBox chung** ở đầu card.
- Log soi: 2 `attempt:start` với `role` khác nhau **chồng lấn** về thời gian (parallel), 2 `done{ok:true}`; batchSummary `succeeded:2, failed:0`.
- Pass nếu: chạy song song (không tuần tự), tổng hợp đúng, không crosstalk giữa 2 item.
- [ ] Pass  [ ] Fail · ghi chú: ____

### B2 · 1 item fail không được kéo cả batch  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Run in parallel via workers: (1) content_writer writes "hello" into `output/b2-ok.md`; (2) content_writer must read its input from `output/does-not-exist-b2.md` and summarize it into `output/b2-bad.md`.
- Kỳ vọng UI: item (1) thành công, item (2) fail; batch summary `succeeded:1, failed:1`; item thành công vẫn có output + handoff đầy đủ.
- Log soi: item (2) `input:missing{path:'output/does-not-exist-b2.md'}` hoặc `attempt:error`; item (1) `done{status:success}` **vẫn xuất hiện độc lập**.
- Fail nếu: một item lỗi làm abort/không trả kết quả cho item kia (vi phạm `allSettled` isolation).
- [ ] Pass  [ ] Fail · ghi chú: ____

### B3 · Batch > 4 item (KHÔNG hard cap)  `[deterministic]` ⚠️ vùng nghi vấn
- Chip: 👥Team
- Prompt:
  > Using the worker team, run **five** independent content_writer tasks in parallel: write the words alpha, beta, gamma, delta, epsilon into `output/b3-1.md` … `output/b3-5.md` respectively.
- Mục tiêu: **xác định hành vi thật** (mô tả nói "up to 4" nhưng code không chặn). Đếm số `attempt:start`, ghi `durationMs` từng cái, quan sát có đơ/mất kết nối/timeout hàng loạt không.
- Log soi: số lượng `attempt:start` (5 hay bị cắt còn 4?), có `attempt:error{failureReason:'ceiling'|'idle'}` dây chuyền không, UI có render đủ 5 item không.
- Kết luận cần ghi lại: PASS nếu chạy ổn định 5 item; nếu **quá tải/đơ/sai aggregate** → FAIL, và đây là căn cứ để **đề xuất thêm hard-cap** (sửa code = scope riêng, cần duyệt).
- [ ] Pass  [ ] Fail · ghi chú (số attempt thực tế + hệ quả): ____

### B4 · Mutual-exclusion `tasks` + `task/role`  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Delegate a task: role content_writer, task "write one line to output/b4-single.md", AND ALSO run a batch tasks list ["write one line to output/b4-a.md"].
  *(Main agent có thể tách thành 2 call hợp lệ thay vì 1 call lai — khi đó test này kiểm tra nó không phát sinh call lai lỗi.)*
- Kỳ vọng UI: không có kết quả nửa vời; hoặc 2 delegation tách bạch, hoặc 1 text error.
- Log soi: **không** có scenario 1 call vừa có top-level `task` vừa `tasks`; nếu main agent vẫn tạo call lai → tool trả text error "`tasks` is mutually exclusive with top-level `task`/`role`" **trước khi** `attempt:start`.
- Pass nếu: không worker nào chạy với payload ambigu.
- [ ] Pass  [ ] Fail · ghi chú: ____

---

## 4. Nhóm C — Schema / handoff / reviewer

### C1 · Reviewer checklist schema OK  `[deterministic]`
- Chip: 👥Team · Role: reviewer
- Prompt:
  > Save `output/c1-app.js` containing a small buggy function. Then have the **reviewer** worker audit it and produce its structured checklist.
- Kỳ vọng UI: reviewer card render **mini-table** checklist (pass/fail/warn) + summary; `REVIEWER_HANDOFF_SCHEMA` tự-inject.
- Log soi: `handoff:extracted` có `checklist` (nhiều item), `attempt:done`, `done{status}` hợp lệ.
- Pass nếu: checklist render, không retry schema.
- [ ] Pass  [ ] Fail · ghi chú: ____

### C2 · Schema-fail → auto-truncate rồi PASS (không retry)  `[deterministic]`
- Chip: 👥Team · Role: reviewer
- Prompt:
  > Have the **reviewer** worker audit `output/c1-app.js`, but write an extremely detailed, long single-sentence summary well over 200 characters.
  *(Schema `summary` maxLength=200; `autoTruncateHandoff` phải clamp trước khi validate.)*
- Kỳ vọng UI: vẫn success, summary hiển thị bản đã cắt.
- Log soi: **KHÔNG** có `retrying{reason:schema_fail}`; `done{attempts:1,status:success}`.
- Fail nếu: retry / fail vì `must not have more than 200 characters` → clamp không ăn.
- [ ] Pass  [ ] Fail · ghi chú: ____

### C3 · Handoff JSON không parse được → retry 1 pass  `[deterministic]`
- Chip: 👥Team · Role: content_writer
- Prompt:
  > Have the **content_writer** worker write a short poem to `output/c3.md`, and in its handoff, deliberately omit the closing brace of the JSON so it is malformed.
  *(Nếu main agent không truyền chỉ định gây nhiễu này xuống, thay bằng: dùng một model endpoint hay trả JSON hỏng; hoặc bỏ qua C3 nếu không tạo được.)*
- Kỳ vọng UI: card báo retry rồi (hoặc success nếu attempt 2 lành, hoặc failed nếu vẫn hỏng) — **không crash**.
- Log soi: `retrying{reason:'json_parse'}` **đúng 1 lần**, `attempts:2` trong `done`.
- Pass nếu: retry đúng 1 lần rồi trả kết quả sạch (success hoặc failed có chủ đích).
- [ ] Pass  [ ] Fail  [ ] N/A · ghi chú: ____

### C4 · Output content > 2000 ký tự bị cắt ở tool result  `[deterministic]`
- Chip: 👥Team · Role: frontend_coder
- Prompt:
  > Have the **frontend_coder** worker create `output/c4-large.html` with about 8KB of content (a long list), then report the handoff.
- Kỳ vọng UI: main agent nhận `output_content` **bản cắt** (`…[truncated]` quanh 2000 ký tự), nhưng nút preview mở ra **file đầy đủ**.
- Log soi: trong tool result text có marker `--- output_content (...) ---` kèm `…[truncated]`; file VFS không bị cắt.
- Pass nếu: **tool result** ngắn (bảo vệ context main agent) mà **file** vẫn nguyên vẹn.
- [ ] Pass  [ ] Fail · ghi chú: ____

---

## 5. Nhóm D — Path-safety / model / switch

### D1 · output_path thoát session root  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Have the **content_writer** worker save its result to `output/../outside.md` (or an absolute path like `/etc/outside.md`).
- Kỳ vọng UI: text error từ tool-layer path gate, **không** delegation chạy.
- Log soi: **không** có `attempt:start` cho call này (bị chặn trước runner). Không file nào ghi ngoài root.
- Pass nếu: gate chặn, main agent được báo lỗi rõ ràng.
- [ ] Pass  [ ] Fail · ghi chú: ____

### D2 · input file không tồn tại  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Have the **researcher** worker summarize the contents of its input file `output/no-such-input-d2.md` and return the summary as text (researcher writes no output file).
- Kỳ vọng UI: item fail với thông điệp input thiếu; không crash.
- Log soi: hoặc `input:missing{path:'output/no-such-input-d2.md'}` (runner), hoặc bị chặn sớm ở `assertInputFilesReadable` (tool layer) → **ghi rõ nhánh nào** xảy ra.
- [ ] Pass  [ ] Fail · ghi chú (nhánh nào chặn): ____

### D3 · skills gate vô hiệu  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Have the **content_writer** worker write `output/d3.md`, using a skill named `this-skill-does-not-exist`.
- Kỳ vọng UI: worker vẫn chạy và tạo file (graceful), chỉ bỏ qua skill.
- Log soi: `skill:missing_or_unreadable{skill:'this-skill-does-not-exist'}`; `done{ok:true}` (không throw sập).
- Pass nếu: missing skill chỉ là cảnh báo, không phá run.
- [ ] Pass  [ ] Fail · ghi chú: ____

### D4 · Model 3-tier fallback  `[deterministic]`
- Chip: 👥Team · Cần Settings → Advanced → Worker Models.
- (a) No override:
  > Have the **content_writer** worker write "tier test a" to `output/d4a.md`.
  → `model:resolved` = per-role model (hoặc main model nếu role thừa kế).
- (b) Valid override (chọn 1 model khác có sẵn):
  > Have the **content_writer** worker, using model_override "<provider/modelId B>", write "tier test b" to `output/d4b.md`.
  → `model:resolved` tier = override.
- (c) Bad/unavailable override:
  > Have the **content_writer** worker, using model_override "bogus/provider-x", write "tier test c" to `output/d4c.md`.
  → runner về main model / báo lỗi rõ, không crash.
- Log soi: field tier/modelId trong `model:resolved` 3 lượt khác nhau đúng kỳ vọng.
- [ ] Pass  [ ] Fail · ghi chú: ____

### D5 · Master switch Fast vs Team  `[deterministic]`
- Prompt (chạy ở CẢ HAI trạng thái chip):
  > Write a 3-line welcome message into `output/d5.md`.
- **👥Team**: có `sub_agent:worker:*` (delegate_task được dùng).
- **⚡Fast**: **KHÔNG** có `sub_agent:worker:*` nào — main agent tự dùng `fs_create_file`; verify cả 2 phía gate đồng bộ (tool `delegate_task` absent + system prompt không inject `<available-workers>` khi OFF).
- Pass nếu: hành vi đảo đúng theo chip, không "ma" (chip OFF mà vẫn delegate, hoặc ON mà không có `<available-workers>`).
- [ ] Pass  [ ] Fail · ghi chú: ____

---

## 6. Nhóm E — Live Micro-Stream Box (tính năng vừa ship — smoke)

### E1 · Box đơn + collapse Task body  `[deterministic]`
- Chip: 👥Team · Role: frontend_coder
- Prompt:
  > Have the **frontend_coder** worker create `output/e1.html` with a form and some CSS (give it a task big enough to stream for ~5+ seconds).
- Kỳ vọng UI: mono box xuất hiện **sau** TTFT và bắt đầu nhả chữ; Task body bị **ẩn** khi stream chạy; khi worker xong, box **biến mất ngay** + Task/summary trở lại.
- Console (DevTools của sidepanel): **KHÔNG** có warn `[worker-live-stream] worker_stream missing toolCallId`.
- Log soi: `sub_agent:worker:tool:start` cho đúng các dòng `● tool:` hiện trong box.
- Pass nếu: visible-during-run, hidden-after-run, không warn.
- [ ] Pass  [ ] Fail · ghi chú: ____

### E2 · Batch chỉ 1 box chung + khớp 1:1 với tool:start  `[deterministic]`
- Chip: 👥Team
- Prompt:
  > Using the worker team, run 2 parallel frontend_coder tasks creating `output/e2-a.html` and `output/e2-b.html` (each streaming ~5+ seconds).
- Kỳ vọng UI: batch card có **ĐÚNG 1** LiveStreamBox ở đầu (không phải mỗi item 1 box); phần Task từng item vẫn hiện; box biến mất khi batch resolve.
- Log soi: tổng số dòng `● tool:` trong box khớp tổng `sub_agent:worker:tool:start` của cả 2 item (chung outer toolCallId).
- Pass nếu: một box duy nhất, nội dung là tổ hợp stream của cả batch.
- [ ] Pass  [ ] Fail · ghi chú: ____

---

## 7. Tổng kết / Sign-off

| Nhóm | Số scenario | Deterministic | Best-effort | Fail |
|---|---|---|---|---|
| A · Timeout/stuck-loop | 4 | A1–A3 | A4 | ____ |
| B · Batch | 4 | B1–B4 | — | ____ |
| C · Schema/handoff | 4 | C1–C4 | — | ____ |
| D · Path/model/switch | 5 | D1–D5 | — | ____ |
| E · Live-stream box | 2 | E1–E2 | — | ____ |
| **Tổng** | **19** | **17** | **2 (A4, C3 optional)** | ____ |

**Chỉ build production khi mọi dòng `[deterministic]` Pass.** Nếu **B3 / A2 / C2** Fail → đó là bug thật, **dừng & báo**, mở scope sửa code riêng (không tự sửa trong lượt tài liệu này).

**Đính kèm mỗi Fail**: file `cebian-debug-<ts>.json` tương ứng + scenario ID.
