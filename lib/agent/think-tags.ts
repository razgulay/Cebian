// Detect và strip raw think tags mà một số LLM (đặc biệt MiniMax M3) emit
// inline trong text content thay vì qua provider API thinking channel riêng.
//
// Tag format (deterministic — LLM luôn emit đúng dạng này):
//   - Open:  less-than + mm:think + greater-than
//   - Close: less-than + slash + mm:think + greater-than
//   - Body:  multi-paragraph, có thể chứa bullets / bold / markdown heading
//
// LLM có thể emit NHIỀU cặp tag trong cùng một text content (ví dụ một
// trước tool call, một sau tool call). Function này strip tất cả và trả về
// reasoning từng cái riêng để caller render thành ThinkingBlock tương ứng.

/**
 * Kết quả: text đã strip hết tag + danh sách reasoning content (theo thứ tự).
 * Nếu text không có tag → reasoning rỗng, text trả nguyên.
 */
export interface ThinkTagResult {
  /** Text gốc với tất cả think tag đã được strip ra. Có thể rỗng nếu text
   *  chỉ chứa tag và không có answer phía sau. */
  text: string;
  /** Mảng reasoning content (đã trim), một entry cho mỗi cặp tag trong text.
   *  Tag rỗng / whitespace-only bị bỏ qua. */
  reasoning: string[];
}

// Match open + body + (close OR end-of-string). Alternation `(?:
// close|$)` quan trọng cho streaming: nếu LLM đã emit open tag + body
// nhưng chưa kịp close, regex vẫn match (body = phần text từ open đến
// end-of-string) → strip được, không để raw `<think>` lộ ra body.
//
// Tag name cho phép optional `mm:` prefix (`<think>` hoặc `<mm:think>`)
// vì LLM đã thấy emit cả 2 dạng tùy phiên. Global flag để matchAll
// collect tất cả occurrences (multiple tags). Whitespace trong tag
// optional + case-insensitive (defensive).
const THINK_TAG_RE =
  /<\s*(?:mm:)?think\s*>([\s\S]*?)(?:<\s*\/\s*(?:mm:)?think\s*>|$)/gi;

/** Orphan closing tag (no matching open). Một số LLM emit `[/think]`
 *  trong text như dấu kết thúc segment mà không có `<think>` mở đầu —
 *  regex ở trên đòi open tag nên không strip case này. Match độc lập
 *  để dọn literal `[/think]` / `[/mm:think]` còn sót trong body. */
const ORPHAN_CLOSE_TAG_RE =
  /<\s*\/\s*(?:mm:)?think\s*>/gi;

/**
 * Strip tất cả think tags khỏi text, đồng thời thu thập reasoning content.
 *
 * Luôn trả về `text` đã strip (an toàn để render trực tiếp — không còn
 * tag literal lẫn vào body). Reasoning array cho caller biết có bao nhiêu
 * đoạn suy luận cần render thành ThinkingBlock.
 *
 * Edge cases đều trả về `{text, reasoning}` hợp lệ:
 *   - Input rỗng / whitespace-only → text gốc, reasoning []
 *   - Không có tag → text gốc, reasoning []
 *   - Có tag nhưng reasoning rỗng → text đã strip, reasoning []
 *   - Nhiều tag (full pair) → text đã strip tất cả, reasoning [r1, r2, ...]
 *   - Open tag chưa close (streaming mid-flight) → strip open + body đã
 *     stream, reasoning [r_partial]
 *   - Chỉ có tag (không có answer) → text rỗng, reasoning [r1, ...]
 *   - Chỉ có orphan closing tag `[/think]` (LLM emit dấu kết thúc
 *     segment lẻ) → đóng tag bị strip khỏi text, reasoning []
 */
export function stripThinkTags(text: string): ThinkTagResult {
  if (!text) return { text, reasoning: [] };

  // Fast path: nếu cả 2 regex đều không match, trả text gốc nguyên xi.
  // Tránh chạm vào whitespace-only / plain prose — đảm bảo idempotency
  // và giữ leading/trailing whitespace đáng lẽ phải còn.
  const hasPaired = THINK_TAG_RE.test(text);
  THINK_TAG_RE.lastIndex = 0;
  if (!hasPaired && !ORPHAN_CLOSE_TAG_RE.test(text)) {
    return { text, reasoning: [] };
  }
  THINK_TAG_RE.lastIndex = 0;
  ORPHAN_CLOSE_TAG_RE.lastIndex = 0;

  // Strip tất cả cặp tag (kể cả unclosed open tag — regex đã match đến
  // end-of-string trong TH đó). Replace global xóa toàn bộ tag + body
  // (capture group [1]) khỏi text. Sau đó dọn orphan closing tag
  // (LLM đôi khi emit `[/think]` đứng một mình — regex trên đòi open
  // tag nên không bắt được). Cuối cùng collapse 3+ newlines thành 2
  // (giữa 2 tags stripped có thể để lại chuỗi \n\n + \n\n →
  // \n\n\n\n mà Markdown renderer không tự gộp) + trim ngoài cùng
  // (loại bỏ newline thừa do tag-bị-strip tạo ra).
  const afterPaired = text.replace(THINK_TAG_RE, '');
  const cleanText = afterPaired
    .replace(ORPHAN_CLOSE_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Thu thập reasoning từ capture group [1] của các paired match.
  // Orphan close không sinh reasoning.
  const reasoning: string[] = [];
  for (const m of text.matchAll(THINK_TAG_RE)) {
    const r = m[1].trim();
    if (r) reasoning.push(r);
  }

  return { text: cleanText, reasoning };
}