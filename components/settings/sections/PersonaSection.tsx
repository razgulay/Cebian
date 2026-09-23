import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  personaEnabled,
  personaSoul,
  personaIdentity,
  type PersonaIdentity,
} from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

/**
 * PersonaSection — persona layer 开关 + user-authored persona copy + identity fields.
 *
 * Mirrors `InstructionsSection.tsx:11–37` (single Textarea + i18n keys + char
 * counter). Persona data is consumed by `composeSystemPrompt` (the `<persona>`
 * block is injected between `<available-workers>` and `<user-instructions>`) and
 * by `composeUserMessage` (a 1-line recap is appended inside
 * `<reminder-instructions>` adjacent to `<user-request>`).
 *
 * Master switch 位于本页顶部、authoring 表单之上；与 chat composer 芯片
 * (`PersonaChip.tsx`) 互为镜像——两侧共享同一 `local:personaEnabled`
 * storage item，经 `useStorageItem` 的 watch 保持双向同步。
 */
export function PersonaSection() {
  const [personaOn, setPersonaOn] = useStorageItem(personaEnabled, false);
  const [currentSoul, setCurrentSoul] = useStorageItem(personaSoul, '');
  const [currentIdentity, setCurrentIdentity] = useStorageItem(personaIdentity, {
    name: '',
    vibe: '',
    tone: '',
    emoji: '',
  });

  // 本地表单 state — 提交时一次性写回 storage。
  // 原因：useStorageItem 把每个字符都推回 storage watch，对 2000-char
  // Textarea 会触发大量 wxt:storage 事件。在 Textarea 上挂本地 state，
  // 输入只在「失焦」或点击 Save 时回写，与 InstructionsSection 一致。
  const [draftSoul, setDraftSoul] = useState(currentSoul);
  const [draftIdentity, setDraftIdentity] = useState<PersonaIdentity>(currentIdentity);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setDraftSoul(currentSoul);
  }, [currentSoul]);
  useEffect(() => {
    setDraftIdentity(currentIdentity);
  }, [currentIdentity]);

  const onSave = () => {
    setCurrentSoul(draftSoul);
    setCurrentIdentity(draftIdentity);
    setSavedAt(Date.now());
  };

  // 显式 alert 让屏幕阅读器能听到「已保存」反馈（char counter 同样有
  // aria-live='polite'，但 Save 动作值得独立一句）。
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.persona.title')}</h2>

      <div className="flex items-center justify-between gap-4 pb-3 border-b border-border/50">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="persona-enabled" className="text-sm">
            {t('settings.persona.enabled')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.persona.enabledHint')}
          </p>
        </div>
        <Switch
          id="persona-enabled"
          checked={personaOn}
          onCheckedChange={(v) => void setPersonaOn(v)}
          className="shrink-0"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="persona-soul" className="text-sm">
          {t('settings.persona.label')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t('settings.persona.hint')}
        </p>
        <Textarea
          id="persona-soul"
          value={draftSoul}
          onChange={(e) => setDraftSoul(e.target.value)}
          onBlur={onSave}
          placeholder={t('settings.persona.soulPlaceholder')}
          rows={10}
          maxLength={2000}
          className="text-xs min-h-64 max-h-96 overflow-y-auto"
        />
        <p className="text-xs text-muted-foreground text-right" aria-live="polite">
          {draftSoul.length} / 2000
        </p>
      </div>

      <div className="space-y-3 pt-2 border-t border-border">
        <h3 className="text-sm font-medium">Identity</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="persona-name" className="text-xs">
              {t('settings.persona.identityName')}
            </Label>
            <Input
              id="persona-name"
              value={draftIdentity.name}
              onChange={(e) => setDraftIdentity({ ...draftIdentity, name: e.target.value })}
              onBlur={onSave}
              placeholder={t('settings.persona.identityNamePlaceholder')}
              maxLength={64}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="persona-emoji" className="text-xs">
              {t('settings.persona.identityEmoji')}
            </Label>
            <Input
              id="persona-emoji"
              value={draftIdentity.emoji}
              onChange={(e) => setDraftIdentity({ ...draftIdentity, emoji: e.target.value })}
              onBlur={onSave}
              placeholder={t('settings.persona.identityEmojiPlaceholder')}
              maxLength={16}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="persona-vibe" className="text-xs">
              {t('settings.persona.identityVibe')}
            </Label>
            <Input
              id="persona-vibe"
              value={draftIdentity.vibe}
              onChange={(e) => setDraftIdentity({ ...draftIdentity, vibe: e.target.value })}
              onBlur={onSave}
              placeholder={t('settings.persona.identityVibePlaceholder')}
              maxLength={128}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="persona-tone" className="text-xs">
              {t('settings.persona.identityTone')}
            </Label>
            <Input
              id="persona-tone"
              value={draftIdentity.tone}
              onChange={(e) => setDraftIdentity({ ...draftIdentity, tone: e.target.value })}
              onBlur={onSave}
              placeholder={t('settings.persona.identityTonePlaceholder')}
              maxLength={128}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onSave}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
        >
          Save
        </button>
        {savedAt && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {t('common.saved')}
          </p>
        )}
      </div>
    </div>
  );
}
