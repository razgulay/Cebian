// 工具身份常量（运行时字符串字面量）。集中定义，供 lib/tools/ 下各工具实现、
// 注册表、以及 UI 标签解析共用，避免裸字符串散落各处。

// ─── Tool name constants ───

/** Tool that pauses the agent loop to ask the user a question */
export const TOOL_ASK_USER = 'ask_user' as const;
/** Tool that executes arbitrary JS in the active tab */
export const TOOL_EXECUTE_JS = 'execute_js' as const;
/** Tool that extracts page content in various formats */
export const TOOL_READ_PAGE = 'read_page' as const;
/** Tool that simulates user interactions on the page */
export const TOOL_INTERACT = 'interact' as const;
/** Tool that returns a structured DOM snapshot for selector discovery */
export const TOOL_INSPECT = 'inspect' as const;
/** Tool that manages browser tabs */
export const TOOL_TAB = 'tab' as const;
/** Tool that captures a screenshot of the active tab */
export const TOOL_SCREENSHOT = 'screenshot' as const;
/** Tool that reads / searches PDF tabs via pdf.js inside the offscreen document */
export const TOOL_PDF = 'pdf' as const;

// ─── Filesystem tool name constants ───

/** Tool that creates a new file in the virtual filesystem */
export const TOOL_FS_CREATE_FILE = 'fs_create_file' as const;
/** Tool that edits a file via precise string replacement */
export const TOOL_FS_EDIT_FILE = 'fs_edit_file' as const;
/** Tool that creates a directory in the virtual filesystem */
export const TOOL_FS_MKDIR = 'fs_mkdir' as const;
/** Tool that renames or moves a file/directory */
export const TOOL_FS_RENAME = 'fs_rename' as const;
/** Tool that deletes a file or directory */
export const TOOL_FS_DELETE = 'fs_delete' as const;
/** Tool that reads file content from the virtual filesystem */
export const TOOL_FS_READ_FILE = 'fs_read_file' as const;
/** Tool that lists directory contents */
export const TOOL_FS_LIST = 'fs_list' as const;
/** Tool that searches for files by name or content */
export const TOOL_FS_SEARCH = 'fs_search' as const;
/** Tool that fetches a URL and saves the response body to a VFS file */
export const TOOL_FS_SAVE_URL = 'fs_save_url' as const;
/** Tool that executes skill scripts with declared chrome.* permissions */
export const TOOL_RUN_SKILL = 'run_skill' as const;
/** Tool that calls Chrome browser APIs directly via structured parameters */
export const TOOL_CHROME_API = 'chrome_api' as const;
/** Tool that delegates a heavy DOM-reading task to the configured cheap sub-agent model.
 *  When unset (the sub-agent model is null in settings), the tool is hidden from the
 *  main agent's tool list entirely. */
export const TOOL_DELEGATE_DOM = 'delegate_dom' as const;
/** Tool that delegates a sub-task to a fixed worker role (content_writer /
 *  frontend_coder / reviewer / researcher) running as an isolated sub-agent
 *  that handoffs via VFS files. Worker roles never receive this tool —
 *  recursion guard is enforced by `lib/agent/worker-roles.ts` whitelists. */
export const TOOL_DELEGATE_TASK = 'delegate_task' as const;
/** Read-only scrolling tool assigned exclusively to the DOM sub-agent. */
export const TOOL_SUBAGENT_SCROLL = 'subagent_scroll' as const;
/** Click-to-expand tool assigned exclusively to the DOM sub-agent.
 *  Allows the sub-agent to click "Show more" / "Load more" / "Xem thêm" / etc.
 *  buttons on the page so it can read content that would otherwise be hidden
 *  behind an expand interaction. No user-prompt permission gate — the
 *  sub-agent decides autonomously and the gate only allows the click action. */
export const TOOL_SUBAGENT_CLICK = 'subagent_click' as const;
/** Tool that lists files + chunk counts + embedder metadata for a named
 *  RAG collection. Read-only Neon query; does NOT touch VFS. Exists so the
 *  LLM has a way to answer "what files are in <collection>?" without
 *  reaching for fs_list/fs_search (which only see the virtual filesystem
 *  under /home/user/...). */
export const TOOL_RAG_INSPECT = 'rag_inspect' as const;
/** Opens a VFS file in the canvas pane (live HTML preview in sidepanel).
 *  Per-session factory — see `lib/canvas/tool-canvas-open.ts`. */
export const TOOL_CANVAS_OPEN = 'canvas_open' as const;
/** LLM-facing scheduler tools — see `lib/scheduler/tool-scheduler.ts`. */
export const TOOL_SCHEDULER_LIST = 'scheduler_list' as const;
export const TOOL_SCHEDULER_CREATE = 'scheduler_create' as const;
export const TOOL_SCHEDULER_DELETE = 'scheduler_delete' as const;
export const TOOL_SCHEDULER_RUN_NOW = 'scheduler_run_now' as const;
/** Tool that runs a hybrid (vector + BM25 / RRF) search inside a named
 *  RAG collection and returns the top-K chunks as a structured text
 *  block. Off by default — `lib/tools/index.ts` only pushes it into
 *  `sharedTools` when `settings.ragSearchEnabled === true`, and the
 *  system-prompt augmentation is gated on the same flag. The two must
 *  agree so the LLM never hallucinates a call to a non-existent tool. */
export const TOOL_RAG_SEARCH = 'rag_search' as const;
/** 联网搜索：按用户配置的引擎顺序在后台标签页里搜索并返回结构化结果 */
export const TOOL_WEB_SEARCH = 'web_search' as const;

