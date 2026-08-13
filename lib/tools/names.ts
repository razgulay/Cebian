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
