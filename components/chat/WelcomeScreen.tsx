import { Settings, FileText, Languages, ListChecks, LayoutGrid, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

// 一张示例卡片：图标 + 标题用于显示，prompt 是点击后填入输入框的完整文案。
interface Example {
  icon: LucideIcon;
  title: string;
  prompt: string;
}

interface WelcomeScreenProps {
  /** 是否已配置可用模型。未配置时只展示引导去设置的 CTA。 */
  hasModel: boolean;
  /** 点击示例卡片时回调，参数为要填入输入框的完整 prompt。 */
  onPickExample: (prompt: string) => void;
  /** 点击「前往设置」时回调。 */
  onOpenSettings: () => void;
}

/**
 * 新会话空状态：已配置模型时展示 4 条「助手气泡」式的示例提示（点击填入输入框）；
 * 未配置模型时展示一句说明 + 「前往设置」CTA。
 *
 * 布局：移除原先的居中问候 + 网格卡片，改为左侧对齐的对话气泡（assistant-style
 * left-bubble），与正常聊天消息视觉一致——气泡宽度由 prompt 长度自然决定，最大
 * 80% 视口宽以避免单条占满整行。
 */
export function WelcomeScreen({ hasModel, onPickExample, onOpenSettings }: WelcomeScreenProps) {
  const examples: Example[] = [
    { icon: FileText, title: t('chat.session.exampleSummarizeTitle'), prompt: t('chat.session.exampleSummarizePrompt') },
    { icon: Languages, title: t('chat.session.exampleTranslateTitle'), prompt: t('chat.session.exampleTranslatePrompt') },
    { icon: ListChecks, title: t('chat.session.exampleExtractTitle'), prompt: t('chat.session.exampleExtractPrompt') },
    { icon: LayoutGrid, title: t('chat.session.exampleTabsTitle'), prompt: t('chat.session.exampleTabsPrompt') },
  ];

  return (
    // Use `block` + explicit `min-h-` so the container is sized from its
    // rendered content plus a strong floor — avoids the "flex-1 collapses to
    // content height in a flex column with min-h-0 parent" trap that bit us
    // earlier when the bubbles stuck to the top of the ScrollArea viewport.
    // `100vh - 10rem` ≈ header (~3rem) + ChatInput (~7rem) so the bubble
    // stack sits flush against the ChatInput top edge.
    <div className="block min-h-[calc(100vh-10rem)] w-full">
      <div className="flex min-h-[calc(100vh-10rem)] flex-col justify-end gap-2 pb-2">
      {!hasModel ? (
        <div className="flex max-w-[85%] flex-col gap-2 self-start rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-sm">
          <p className="text-foreground">{t('chat.composer.needModel')}</p>
          <Button variant="outline" size="sm" className="self-start" onClick={onOpenSettings}>
            <Settings className="size-3.5" />
            {t('chat.composer.goToSettings')}
          </Button>
        </div>
      ) : (
        examples.map(({ icon: Icon, title, prompt }) => (
          <button
            key={title}
            type="button"
            onClick={() => onPickExample(prompt)}
            className="group flex max-w-[85%] items-center gap-2 self-start rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            <span className="text-foreground">{title}</span>
          </button>
        ))
      )}
      </div>
    </div>
  );
}
