// 划词动作输出后处理脚本的一次性沙箱宿主（offscreen 侧）。
//
// 与 skill 共用同一份 sandbox.html，但**刻意不共用实例**：每次执行新建一个 iframe，
// 拿到结果或超时立即销毁。两个理由：
// 1. 长存的共享沙箱是同一个 realm——脚本能挂 message 监听看到后续 skill 的 `sandbox:run`
//    信封（含代码 / 参数 / 权限），再伪造 `sandbox:*` 消息借其权限行事。一次性实例把这条
//    路断掉：本模块只认自己那个 iframe 的消息，共享中继也只认共享实例（白名单），
//    且 sandbox 侧只接受直接宿主发来的协议消息，兄弟 iframe 注入不了。
// 2. 独占实例可以随时销毁，共享实例不能（会打断正在跑的 skill）。
//
// 局限（如实记录）：
// - sandbox page 的 CSP 是所有实例共享的（见 wxt.config.ts），故脚本仍能访问原生 fetch。
//   「一次性」解决的是越权，不解决出网，所以设置页提示用户只跑自己信得过的脚本。
// - 销毁 iframe 能否真的掐断死循环，取决于浏览器把该 iframe 放进了独立渲染进程还是与
//   offscreen 文档同线程。同线程时 `while(true){}` 会连本文档的定时器一起卡住，下面这个
//   超时就发不出来——真正的兜底是 background 侧那道独立超时（见 page-actions/transform.ts），
//   它保证卡片不会永远转圈。

/** 等待上限。能跑到时就靠销毁 iframe 掐断脚本；跑不到时由 background 侧超时兜底。 */
const TRANSFORM_TIMEOUT_MS = 5_000;

/**
 * 结果前缀哨兵：只认带这个前缀的结果，才算「脚本正常返回了一个字符串」。
 *
 * 两条绕过路径都靠它兜住：沙箱序列化返回值时 `JSON.stringify` 失败会退回
 * `String(result)`，于是循环引用对象变成 `"[object Object]"`、`1n` 变成 `"1"`，光靠
 * `typeof === 'string'` 认不出来；脚本也能在顶层直接 `return` 跳过下面那段校验尾巴
 * （沙箱把整段包在 async 箭头里，顶层 return 合法）。这两种情况都产不出这个前缀。
 *
 * 用 NUL 包裹是为了让「脚本恰好返回同样前缀」不可能发生；写成 `\u0000` 转义而不是
 * 字面控制字符，源文件才还是纯文本（嵌真 NUL 会让 git 把它当二进制、diff 全丢）。
 */
const RESULT_SENTINEL = '\u0000cebian-transform\u0000';

export interface TransformResult {
  result?: string;
  error?: string;
}

/**
 * 脚本里可被调用的钩子名。用户脚本按名字定义函数，宿主按阶段挑一个调用。
 *
 * 将来加「送给模型之前先加工选中文本」时，除了在这里加一个 `'preprocess'`，还有两件事
 * 要一起做，别以为只加名字就够：
 * 1. **缺钩子要变成「跳过」而不是报错**。同一段脚本可以只定义 transform，那么预处理
 *    阶段就该原样放过；现在的尾巴是缺了就 throw，只适合「这个阶段必须有钩子」的用法。
 * 2. **钩子名不能撞 window 上的全局**。`typeof <hook>` 会沿作用域链找到沙箱页的全局
 *    对象，所以 `find` / `print` / `open` / `stop` 这类名字会被判成 'function' 并调到
 *    DOM API 上。`transform` / `preprocess` 都安全。
 */
export type ScriptHook = 'transform';

/**
 * 把用户脚本包成沙箱要求的形态（沙箱按 `module.exports` 取返回值）。
 *
 * 用户写的是**完整函数**（`function transform(text, vars) { ... }`），脚本原样放在最前
 * 面，后面追加一段查名并调用的尾巴。这样比让用户写「函数体」好两点：脚本是语法自洽的
 * 一份 JS（能整段复制粘贴、编辑器高亮也对）；同一段脚本可以定义多个钩子并共享辅助函数。
 *
 * 注意尾巴仍然可能被跳过——顶层 `return` 是合法的（沙箱把整段包在 async 箭头里），
 * 那条路上的返回值最终靠 RESULT_SENTINEL 认定，见下方 `result === undefined` 分支。
 * 换契约消掉的是「花括号数错导致的意外」，不是「刻意绕过」。
 *
 * 判定用 `typeof x !== 'function'` 而不是比 undefined：前者对**未声明**的标识符是安全的，
 * 后者会抛 ReferenceError，把「你没定义这个函数」变成一句看不懂的报错。
 *
 * 尾巴里的临时变量加 `__cebian_` 前缀：它和用户脚本同处一个作用域，叫 `out` 会和用户
 * 自己的顶层 `const out` 撞出一句「Identifier already declared」而看不出是谁的问题。
 * `args` / `module` 是沙箱注入的名字，用户不能声明——这条写进了设置页的说明。
 *
 * 包装与校验同住这里：执行契约由宿主定义，background 只管把原始脚本递过来。
 */
function wrapHookCall(script: string, hook: ScriptHook): string {
  return [
    script,
    // 空行兜住用户脚本末尾可能的行注释，别把下一行吃掉。
    '',
    `if (typeof ${hook} !== 'function') {`,
    `  throw new Error('Script must define a function named "${hook}"');`,
    '}',
    `const __cebian_out = await ${hook}(args.text, args.vars);`,
    "if (typeof __cebian_out !== 'string') {",
    `  throw new Error('${hook}() must return a string, got ' + typeof __cebian_out);`,
    '}',
    `module.exports = ${JSON.stringify(RESULT_SENTINEL)} + __cebian_out;`,
  ].join('\n');
}

/** 在一次性沙箱里调用脚本的某个钩子，返回字符串结果或错误。永不 reject。 */
export function runScriptHookInFreshSandbox(
  script: string,
  hook: ScriptHook,
  args: Record<string, unknown>,
): Promise<TransformResult> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('/sandbox.html');
    frame.style.display = 'none';

    let settled = false;
    let started = false;
    const finish = (out: TransformResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(out);
    };

    const onMessage = (event: MessageEvent) => {
      // 只听自己这个 iframe；别的实例（skill 的共享沙箱）与它无关。
      if (event.source !== frame.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'sandbox:ready') {
        // 只发一次：脚本可以自己 postMessage 伪造 ready，不设闸就会被它拖进重复执行循环。
        if (started) return;
        started = true;
        frame.contentWindow?.postMessage(
          {
            type: 'sandbox:run',
            // 一次性实例只跑一次，故 id 用固定值即可——它不参与任何授权决策。
            id: 'transform',
            code: wrapHookCall(script, hook),
            args,
            permissions: [],
            vfsScope: null,
          },
          '*',
        );
        return;
      }
      if (msg.type === 'sandbox:run_result') {
        if (typeof msg.error === 'string') finish({ error: msg.error });
        else if (typeof msg.result === 'string' && msg.result.startsWith(RESULT_SENTINEL)) {
          finish({ result: msg.result.slice(RESULT_SENTINEL.length) });
        } else if (msg.result === undefined) {
          // 尾巴没跑到才会什么都没设：脚本在顶层直接 return 了（沙箱把整段包在一个
          // async 箭头里，所以顶层 return 合法但会跳过尾巴）。旧的「只写函数体」写法
          // 正是这样，故把话说明白，而不是笼统报「返回值不是字符串」。
          finish({
            error: `Script must define a function named "${hook}" — a bare top-level return is not enough`,
          });
        } else finish({ error: 'Transform script must return a string' });
      }
      // 其它 sandbox:* 消息（chrome_call / vfs_call / bg_fetch 等）一概忽略——零权限执行
      // 不该发出它们，发出即视为脚本在试探：不给回应，也绝不转发给 background。
    };

    const timer = setTimeout(
      () => finish({ error: `Transform script timed out after ${TRANSFORM_TIMEOUT_MS} ms` }),
      TRANSFORM_TIMEOUT_MS,
    );

    window.addEventListener('message', onMessage);
    document.body.appendChild(frame);
  });
}
