//
// CollapsibleSection — 一个默认折叠的区块外壳。
//
// 用仓库已有的 `Accordion`（Radix）而不是引入 `@radix-ui/react-collapsible`：
// Accordion 已经在本项目多处使用（设置页、侧边栏），行为与动画都已就位，
// 再加一个同类的折叠原语没有意义。
//
// 折叠的是**内容**，标题行始终可见——用户需要知道有这么一块设置存在。
//

import type { ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export interface CollapsibleSectionProps {
  title: string;
  hint: string;
  children: ReactNode;
}

export function CollapsibleSection({ title, hint, children }: CollapsibleSectionProps) {
  return (
    <Accordion type="single" collapsible className="rounded-lg border border-border px-4">
      <AccordionItem value="section" className="border-b-0">
        <AccordionTrigger className="py-3 hover:no-underline">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-xs font-normal text-muted-foreground">{hint}</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-3 pt-0">{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
