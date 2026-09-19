// Canvas Live Artifacts: 渲染 agent 在 BG 打开的 VFS 文件为安全 iframe。
//
// Layout model: 在 sidepanel 中由 `entrypoints/sidepanel/App.tsx` 渲染到
// `react-resizable-panels` 的左半边（共享高度），右半边是 chat。CanvasPane 自己
// 不管 split —— 只负责「拿到当前 session 的 canvas 快照后渲染」。
//
// Pick Element：header 上的 MousePointerClick 按钮开关拾取模式。
// 开关经 prop 下发给 HtmlIframePreview → sandbox 代理页 → 内层 bootstrap；
// 拾取成功 / Escape 取消经原路回报，这里清洗 payload 后用 `canvasPickChannel`
// 发布给 ChatInput（订阅方在 ChatInput）。层层的职责与鉴权见各文件头注释。
//
// iframe 安全模型（详情见 `wxt.config.ts` 的 `content_security_policy.sandbox` +
// `entrypoints/vfs-preview.sandbox/main.ts`）：
//   - 外层（这里）给 iframe `sandbox="allow-scripts allow-forms allow-modals
//     allow-popups"`，**不含** `allow-same-origin` —— iframe 拿到一个不透明
//     origin，与扩展 origin 不同，无法读 `chrome.*` 或扩展存储。
//   - 内层（vfs-preview.html）属于 `manifest.sandbox.pages`，是独立 origin 的空
//     白页，postMessage broker 把用户 HTML 包成 srcdoc 装进 *再一层* iframe。
//   - 多层不透明 origin 加 sandbox CSP，限制脚本为 'unsafe-inline' 等已知源，
//     同时对外部脚本需走 `https:` 域名白名单。即使 agent 写出恶意 HTML，最坏
//     也只能跑在 sandbox 里、烧用户自己 cookie / DOM —— 跨不到扩展域。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EyeOff, FileCode2, MousePointerClick } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { debugLog } from '@/lib/debug/log';
import { canvasPickChannel } from '@/lib/canvas/pick-channel';
import {
  normalizePick,
  CANVAS_TOGGLE_INSPECT_TYPE,
  CANVAS_PICKED_TYPE,
  CANVAS_CANCELLED_TYPE,
} from '@/lib/canvas/element-inspect';
import { useCanvasChannel } from './useCanvasChannel';

/** 与 `entrypoints/vfs/ui/views/HtmlPreview.tsx` 一致：外层 sandbox 令牌
 *  （manifest sandbox.pages 那里再叠一层）。 */
const HOST_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';
const SANDBOX_URL = browser.runtime.getURL('/vfs-preview.html' as never);

/** Firefox 不支持 manifest `sandbox.pages`——代理页会以扩展 origin 运行、脚本被
 *  扩展页 CSP 拦掉（与 VFS 的 HtmlPreview 同款约束）。降级为无脚本 srcdoc 静态
 *  渲染，拾取模式整体不可用（按钮不渲染）。 */
const SUPPORTS_SANDBOX_SCRIPTS = !import.meta.env.FIREFOX;

export interface CanvasPaneProps {
  /** 用户点 close 按钮时回调 —— 父组件（App.tsx）据此置 `canvasPanelOpen=false`，
   *  PanelGroup 卸下 CanvasPane 整片。 */
  onClose: () => void;
}

/** 把 `string | null` 取个非空 fallback 给 `<iframe title>`，nullish 时用空串。 */
function safeTitle(snapshotPath: string | null): string {
  return snapshotPath ?? '';
}

export function CanvasPane({ onClose }: CanvasPaneProps) {
  const snapshot = useCanvasChannel();
  const openFile = snapshot?.openFile ?? null;
  const [inspectEnabled, setInspectEnabled] = useState(false);

  // 没有文件可预览时拾取模式没有意义（内层文档都不存在），收回开关状态，
  // 下次打开文件从干净态开始。文件间切换不清——拾取是跨热更新的连续工作流。
  useEffect(() => {
    if (!openFile) setInspectEnabled(false);
  }, [openFile]);

  // Escape（焦点在 sidepanel 侧）取消拾取。焦点在预览 iframe 里时由内层
  // bootstrap 自己处理并回报 `canvas-inspect-cancelled`——两条路径殊途同归：
  // 都落在本组件把 inspectEnabled 置 false，再经 prop 下发 toggle-off 收敛
  // （sandbox 页与内层对重复的 off 幂等，见 main.ts）。
  useEffect(() => {
    if (!inspectEnabled) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setInspectEnabled(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [inspectEnabled]);

  const handleToggleInspect = () => {
    debugLog.info('ui', 'canvas:inspect:toggle', { from: inspectEnabled });
    setInspectEnabled((v) => !v);
  };

  // 内层拾取成功：清洗 payload（不可信——内层跑的是用户 HTML）→ 发布给
  // ChatInput。无论 payload 好坏都把 inspectEnabled 收回 false：sandbox 页
  // 会记住开启态，不发 toggle-off 的话热更新会把拾取模式悄悄重新激活，
  // 而按钮显示却是关。
  const handlePicked = (raw: unknown) => {
    setInspectEnabled(false);
    const pick = normalizePick(raw);
    const canvasPath = openFile?.path ?? null;
    if (!pick || canvasPath === null) {
      debugLog.info('ui', 'canvas:pick:dropped', {
        payloadOk: pick !== null,
        hasPath: canvasPath !== null,
      });
      return;
    }
    debugLog.info('ui', 'canvas:pick', {
      canvasPath,
      tagName: pick.tagName,
      selector: pick.selector,
    });
    canvasPickChannel.publish({ pick, canvasPath });
  };

  // 内层 Escape 取消：与本地 Escape 同一收敛路径。
  const handleInspectCancelled = () => {
    setInspectEnabled(false);
  };

  return (
    <div className="h-full w-full flex flex-col bg-background border-r">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode2 className="size-4 text-muted-foreground shrink-0" />
          <span
            className="text-xs font-medium truncate"
            title={openFile?.path ?? ''}
          >
            {openFile?.path ?? t('canvas.pane.titleFallback')}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {SUPPORTS_SANDBOX_SCRIPTS && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={inspectEnabled ? t('canvas.pane.inspectOff') : t('canvas.pane.inspectOn')}
                  disabled={!openFile}
                  className={inspectEnabled ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
                  onClick={handleToggleInspect}
                >
                  <MousePointerClick className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {inspectEnabled ? t('canvas.pane.inspectOff') : t('canvas.pane.inspectOn')}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('canvas.pane.closeAria')}
                onClick={onClose}
              >
                <EyeOff className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('canvas.pane.closeAria')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        {openFile ? (
          SUPPORTS_SANDBOX_SCRIPTS ? (
            <HtmlIframePreview
              html={openFile.content}
              title={safeTitle(openFile.path)}
              inspectEnabled={inspectEnabled}
              onPicked={handlePicked}
              onInspectCancelled={handleInspectCancelled}
            />
          ) : (
            <StaticIframePreview
              html={openFile.content}
              title={safeTitle(openFile.path)}
            />
          )
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

interface HtmlIframePreviewProps {
  html: string;
  title: string;
  /** 拾取模式开关。prop 变化（以及 proxy 页 ready 兜底）时下发
   *  `canvas-toggle-inspect`；sandbox 页记住状态并负责跨热更新重放。 */
  inspectEnabled: boolean;
  /** 内层拾取成功。payload 原样上抛（未清洗），CanvasPane 负责 normalize。 */
  onPicked: (payload: unknown) => void;
  /** 内层 Escape 取消拾取。 */
  onInspectCancelled: () => void;
}

/**
 * 一个隔离的 HTML 预览 iframe —— 与 `entrypoints/vfs/ui/views/HtmlPreview.tsx`
 * 同款 broker 协议（监听 `vfs-preview-ready` 之后 postMessage `vfs-preview-render`），
 * 并叠加 Pick Element 的 toggle / 回报三跳（见文件头与 sandbox main.ts 协议注释）。
 * 这个组件存在是因为：
 *   - sidepanel 不该跨 entrypoint 直接 import 一个 entrypoint/vfs 文件（架构边界）。
 *   - 复制一份轻量级 iframe 包装，比为这一处 `<iframe>` 抽公共组件更直接。
 */
function HtmlIframePreview({ html, title, inspectEnabled, onPicked, onInspectCancelled }: HtmlIframePreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef(html);
  const readyRef = useRef(false);
  htmlRef.current = html;
  // 回调 / 开关都经 ref 转发：message 监听器只挂一次，永远读最新闭包；
  // sendInspect 也从 ref 读当前状态，ready 兜底发的就是「此刻」的开关。
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;
  const onInspectCancelledRef = useRef(onInspectCancelled);
  onInspectCancelledRef.current = onInspectCancelled;
  const inspectRef = useRef(inspectEnabled);
  inspectRef.current = inspectEnabled;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => {
      // `vfs-preview.html` 内部 dest 在 manifest sandbox.pages 里，
      // origin=null/不透明；targetOrigin 只能是 '*'（详见 vfs-preview.sandbox/main.ts）。
      frame.contentWindow?.postMessage(
        { type: 'vfs-preview-render', html: htmlRef.current },
        '*',
      );
    };
    const sendInspect = () => {
      frame.contentWindow?.postMessage(
        { type: CANVAS_TOGGLE_INSPECT_TYPE, enabled: inspectRef.current },
        '*',
      );
    };
    const onMessage = (event: MessageEvent) => {
      // 只听这个 iframe 自己发的消息；opaque origin 下 event.origin='null' 不能用鉴权。
      if (event.source !== frame.contentWindow) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === 'vfs-preview-ready') {
        readyRef.current = true;
        send();
        // 正常情况下 toggle 都发生在 ready 之后，这里只是 mount 竞态的兜底。
        sendInspect();
        return;
      }
      if (type === CANVAS_PICKED_TYPE) {
        onPickedRef.current((event.data as { element?: unknown }).element);
        return;
      }
      if (type === CANVAS_CANCELLED_TYPE) {
        onInspectCancelledRef.current();
      }
    };
    window.addEventListener('message', onMessage);
    // 监听器就位后再赋 src —— 否则代理页 ready 通知到达时我们错过了.
    frame.src = SANDBOX_URL;
    return () => {
      window.removeEventListener('message', onMessage);
      readyRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (readyRef.current && frameRef.current?.contentWindow) {
      frameRef.current.contentWindow.postMessage(
        { type: 'vfs-preview-render', html },
        '*',
      );
    }
  }, [html]);

  // 拾取开关变化 → 下发 sandbox 页（未 ready 时跳过——ready 兜底路径会带
  // 一次当前状态；有文件才点得到按钮，而文件打开才会 mount 本组件，实际
  // 到不了这个分支）。
  useLayoutEffect(() => {
    if (!readyRef.current) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: CANVAS_TOGGLE_INSPECT_TYPE, enabled: inspectEnabled },
      '*',
    );
  }, [inspectEnabled]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={HOST_SANDBOX}
      className="absolute inset-0 w-full h-full border-0 bg-white"
    />
  );
}

/** Firefox 降级：无脚本 srcdoc 静态渲染。`sandbox=""` 连脚本都禁，srcdoc 又
 *  继承扩展页 CSP（`script-src 'self'`）——双保险，与 HtmlPreview 同款。 */
function StaticIframePreview({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={html}
      className="absolute inset-0 w-full h-full border-0 bg-white"
    />
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
      <FileCode2 className="size-10 opacity-30" aria-hidden />
      <p className="text-sm">{t('canvas.pane.empty.title')}</p>
      <p className="text-xs">{t('canvas.pane.empty.hint')}</p>
    </div>
  );
}
