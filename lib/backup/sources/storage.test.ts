import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  collectStorage,
  restoreStorage,
  type CollectedStorage,
} from '@/lib/backup/sources/storage';
import {
  lastSelectedModel,
  userInstructions,
  customProviders,
  mcpServers,
  providerCredentials,
  webdavConfig,
  workerModels,
  workerRoleTimeouts,
  personaEnabled,
  personaSoul,
  personaIdentity,
  type MCPServerConfig,
  type ProviderCredentials,
  type CustomProviderConfig,
  type WorkerModelMap,
  type WorkerTimeoutMap,
  type PersonaIdentity,
} from '@/lib/persistence/storage';

const SK = {
  activeModel: 'local:activeModel',
  userInstructions: 'local:userInstructions',
  customProviders: 'local:customProviders',
  mcpServers: 'local:mcpServers',
  providerCredentials: 'local:providerCredentials',
  webdavConfig: 'local:webdavConfig',
  workerModels: 'local:workerModels',
  workerRoleTimeouts: 'local:workerRoleTimeouts',
  personaEnabled: 'local:personaEnabled',
  personaSoul: 'local:persona',
  personaIdentity: 'local:personaIdentity',
};

function bearerServer(id: string, token: string): MCPServerConfig {
  return {
    id,
    name: id,
    enabled: true,
    transport: { type: 'streamable-http', url: `https://${id}.example/mcp` },
    auth: { type: 'bearer', token },
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('collectStorage', () => {
  it('settings 含非密钥项，且绝不含任何密钥', async () => {
    await lastSelectedModel.setValue({ provider: 'openai', modelId: 'gpt' });
    await userInstructions.setValue('hi');
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });

    const { config } = await collectStorage({ settings: true, credentials: true });

    expect(config![SK.activeModel]).toEqual({ provider: 'openai', modelId: 'gpt' });
    expect(config![SK.userInstructions]).toBe('hi');
    // mcpServers 的 safe 部分在 config，但 token 被清空。
    const safeServers = config![SK.mcpServers] as MCPServerConfig[];
    expect(safeServers[0].auth).toEqual({ type: 'bearer', token: '' });
    // config 序列化后绝不含任何密钥明文。
    const configJson = JSON.stringify(config);
    expect(configJson).not.toContain('mcp-secret');
    expect(configJson).not.toContain('sk-x');
  });

  it('mcpServers 的 token 落在 credentials', async () => {
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    const { credentials } = await collectStorage({ settings: true, credentials: true });
    expect(JSON.stringify(credentials![SK.mcpServers])).toContain('mcp-secret');
  });

  it('只选 settings：credentials 为 undefined，密钥不被序列化', async () => {
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });
    const out = await collectStorage({ settings: true, credentials: false });
    expect(out.credentials).toBeUndefined();
    expect(out.config).toBeDefined();
    expect(JSON.stringify(out.config)).not.toContain('mcp-secret');
    expect(JSON.stringify(out.config)).not.toContain('sk-x');
  });

  it('只选 credentials：config 为 undefined', async () => {
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });
    const out = await collectStorage({ settings: false, credentials: true });
    expect(out.config).toBeUndefined();
    expect(JSON.stringify(out.credentials)).toContain('sk-x');
  });
});

describe('restoreStorage — replace', () => {
  it('settings 用备份覆盖；混合 item 用 secret 重组 token', async () => {
    // 本地是另一套值。
    await lastSelectedModel.setValue({ provider: 'local', modelId: 'm' });
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);

    const data: CollectedStorage = {
      config: {
        [SK.activeModel]: { provider: 'backup', modelId: 'b' },
        [SK.mcpServers]: [bearerServer('s1', '')],
      },
      credentials: {
        [SK.mcpServers]: { s1: { token: 'backup-token' } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: true });

    expect(await lastSelectedModel.getValue()).toEqual({ provider: 'backup', modelId: 'b' });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'backup-token' });
  });

  it('replace 但未选 credentials：混合 item token 留空', async () => {
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [bearerServer('s1', '')] },
      credentials: { [SK.mcpServers]: { s1: { token: 'backup-token' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: false });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: '' });
  });

  it('config 里残留 token / header 被无条件剥离（不可信输入防线）', async () => {
    // 构造一个被污染的 config：混合 item 仍带 token 和自定义 header。
    const polluted: MCPServerConfig = {
      ...bearerServer('s1', 'leaked-token'),
      transport: {
        type: 'streamable-http',
        url: 'https://s1.example/mcp',
        headers: { 'X-Api-Key': 'leaked-header' },
      },
    };
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [polluted] },
      // 未选 credentials，故不提供 secret。
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: false });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: '' });
    expect(servers[0].transport.headers).toBeUndefined();
  });

  it('credentials 用备份整体覆盖', async () => {
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'local', verified: true } });
    const data: CollectedStorage = {
      credentials: {
        [SK.providerCredentials]: { anthropic: { authType: 'apiKey', apiKey: 'backup', verified: true } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const creds = await providerCredentials.getValue();
    expect(creds.openai).toBeUndefined();
    expect(creds.anthropic).toBeDefined();
  });
});

describe('restoreStorage — 混合 item 的密钥单独随 credentials 恢复', () => {
  it('只选 credentials（不选 settings）时，MCP 密钥写进本地已有 server（replace 覆盖）', async () => {
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);
    const data: CollectedStorage = {
      credentials: { [SK.mcpServers]: { s1: { token: 'backup-token' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    // 本地配置保留、token 被备份覆盖。
    expect(servers[0].id).toBe('s1');
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'backup-token' });
  });

  it('只选 credentials + merge：本地已有 token 保留、缺失的才补', async () => {
    await mcpServers.setValue([
      bearerServer('s1', 'local-live-token'), // 本地有有效 token
      bearerServer('s2', ''), // 本地 token 空
    ]);
    const data: CollectedStorage = {
      credentials: {
        [SK.mcpServers]: { s1: { token: 'backup-1' }, s2: { token: 'backup-2' } },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    const s1 = servers.find((s) => s.id === 's1')!;
    const s2 = servers.find((s) => s.id === 's2')!;
    expect(s1.auth).toEqual({ type: 'bearer', token: 'local-live-token' }); // 保留本地
    expect(s2.auth).toEqual({ type: 'bearer', token: 'backup-2' }); // 补缺
  });

  it('备份 secret 含本地不存在的 server → 不凭空新增', async () => {
    await mcpServers.setValue([bearerServer('s1', '')]);
    const data: CollectedStorage = {
      credentials: {
        [SK.mcpServers]: { s1: { token: 't1' }, sX: { token: 'tX' } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe('s1');
  });

  it('settings + credentials 同时 replace：safe 配置 + 密钥都还原', async () => {
    await mcpServers.setValue([bearerServer('s1', 'old')]);
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [bearerServer('s1', '')] },
      credentials: { [SK.mcpServers]: { s1: { token: 'restored' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: true });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'restored' });
  });
});

describe('customProviders headers 端到端（密钥进 credentials、不进 config）', () => {
  const withHeaders: CustomProviderConfig = {
    id: 'p-h',
    name: 'With Headers',
    baseUrl: 'https://p-h.example/v1',
    models: [],
    headers: { 'X-Api-Key': 'prov-header-secret' },
  };

  it('collect：headers 落 credentials，config 里的 safe provider 不含 headers 明文', async () => {
    await customProviders.setValue([withHeaders]);
    const { config, credentials } = await collectStorage({ settings: true, credentials: true });

    const safe = config![SK.customProviders] as CustomProviderConfig[];
    expect(safe[0].headers).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('prov-header-secret');
    expect(JSON.stringify(credentials![SK.customProviders])).toContain('prov-header-secret');
  });

  it('只选 settings：header 密钥不被序列化', async () => {
    await customProviders.setValue([withHeaders]);
    const out = await collectStorage({ settings: true, credentials: false });
    expect(out.credentials).toBeUndefined();
    expect(JSON.stringify(out.config)).not.toContain('prov-header-secret');
  });

  it('restore：config 里残留的 headers 被无条件剥离（不可信输入防线）', async () => {
    const polluted: CustomProviderConfig = { ...withHeaders, headers: { 'X-Api-Key': 'leaked' } };
    const data: CollectedStorage = { config: { [SK.customProviders]: [polluted] } };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: false });
    const result = await customProviders.getValue();
    expect(result[0].headers).toBeUndefined();
  });

  it('只选 credentials（replace）：header 密钥写进本地已有 provider', async () => {
    await customProviders.setValue([{ ...withHeaders, headers: undefined }]);
    const data: CollectedStorage = {
      credentials: { [SK.customProviders]: { 'p-h': { headers: { 'X-Api-Key': 'restored' } } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const result = await customProviders.getValue();
    expect(result[0].headers).toEqual({ 'X-Api-Key': 'restored' });
  });
});

describe('restoreStorage — merge', () => {
  it('标量设置（无 fillMissing）merge 下保留本地、不写', async () => {
    await lastSelectedModel.setValue({ provider: 'local', modelId: 'm' });
    const data: CollectedStorage = {
      config: { [SK.activeModel]: { provider: 'backup', modelId: 'b' } },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });
    expect(await lastSelectedModel.getValue()).toEqual({ provider: 'local', modelId: 'm' });
  });

  it('customProviders 按 id 补缺：本地已有保留、本地缺的从备份补入', async () => {
    const provLocal: CustomProviderConfig = {
      id: 'p-local',
      name: 'Local',
      baseUrl: 'https://local/v1',
      models: [],
    };
    const provBackupSame: CustomProviderConfig = {
      id: 'p-local',
      name: 'Backup overwrites? no',
      baseUrl: 'https://backup/v1',
      models: [],
    };
    const provBackupNew: CustomProviderConfig = {
      id: 'p-new',
      name: 'New from backup',
      baseUrl: 'https://new/v1',
      models: [],
    };
    await customProviders.setValue([provLocal]);

    const data: CollectedStorage = {
      config: { [SK.customProviders]: [provBackupSame, provBackupNew] },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });

    const result = await customProviders.getValue();
    const ids = result.map((p) => p.id).sort();
    expect(ids).toEqual(['p-local', 'p-new']);
    // 同 id 保留本地（name 不被备份覆盖）。
    expect(result.find((p) => p.id === 'p-local')!.name).toBe('Local');
    // 本地缺的从备份补入。
    expect(result.find((p) => p.id === 'p-new')!.name).toBe('New from backup');
  });

  it('customProviders 按 id 补缺：备份内部重复 id 只取首个、不重复灌入', async () => {
    const provDup1: CustomProviderConfig = {
      id: 'p-dup',
      name: 'First',
      baseUrl: 'https://first/v1',
      models: [],
    };
    const provDup2: CustomProviderConfig = {
      id: 'p-dup',
      name: 'Second',
      baseUrl: 'https://second/v1',
      models: [],
    };
    await customProviders.setValue([]);

    const data: CollectedStorage = {
      config: { [SK.customProviders]: [provDup1, provDup2] },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });

    const result = await customProviders.getValue();
    // 备份里两个同 id，只补入首个，不产生重复。
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-dup');
    expect(result[0].name).toBe('First');
  });

  it('mcpServers 按 id 补缺：本地保留、备份新 server 补入，同选 credentials 时补入 token', async () => {
    await mcpServers.setValue([bearerServer('s-local', 'local-token')]);
    const data: CollectedStorage = {
      config: {
        [SK.mcpServers]: [
          bearerServer('s-local', ''), // safe 形态（token 已被 split 清空）
          bearerServer('s-new', ''),
        ],
      },
      credentials: {
        [SK.mcpServers]: { 's-new': { token: 'new-token' } },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: true });

    const servers = await mcpServers.getValue();
    const sLocal = servers.find((s) => s.id === 's-local')!;
    const sNew = servers.find((s) => s.id === 's-new')!;
    // 本地 server 保留本地 token（不被覆盖）。
    expect(sLocal.auth).toEqual({ type: 'bearer', token: 'local-token' });
    // 备份新 server 补入，且其 token 由 credentials 补缺恢复。
    expect(sNew.auth).toEqual({ type: 'bearer', token: 'new-token' });
  });

  it('providerCredentials 逐 provider 补缺：本地已有的保留，缺的补入', async () => {
    const local: ProviderCredentials = {
      openai: { authType: 'apiKey', apiKey: 'local-openai', verified: true },
    };
    await providerCredentials.setValue(local);

    const data: CollectedStorage = {
      credentials: {
        [SK.providerCredentials]: {
          openai: { authType: 'apiKey', apiKey: 'backup-openai', verified: true },
          anthropic: { authType: 'apiKey', apiKey: 'backup-anthropic', verified: true },
        },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: false, credentials: true });

    const creds = await providerCredentials.getValue();
    // openai 本地已有 → 保留本地。
    expect((creds.openai as { apiKey: string }).apiKey).toBe('local-openai');
    // anthropic 本地缺 → 从备份补入。
    expect((creds.anthropic as { apiKey: string }).apiKey).toBe('backup-anthropic');
  });

  it('webdavConfig 补缺：本地已配置则保留，本地为 null 才补入', async () => {
    const backup = { url: 'https://dav', username: 'u', password: 'p', directory: '/c' };

    // 本地已配置 → 保留本地。
    await webdavConfig.setValue({ url: 'https://local', username: 'lu', password: 'lp', directory: '/l' });
    await restoreStorage(
      { credentials: { [SK.webdavConfig]: backup } },
      { strategy: 'merge', settings: false, credentials: true },
    );
    expect((await webdavConfig.getValue())!.url).toBe('https://local');

    // 本地为 null → 补入备份。
    await webdavConfig.setValue(null);
    await restoreStorage(
      { credentials: { [SK.webdavConfig]: backup } },
      { strategy: 'merge', settings: false, credentials: true },
    );
    expect((await webdavConfig.getValue())!.url).toBe('https://dav');
  });

  // worker maps 的 merge 补缺：修复「恢复后 worker 模型 / 超时全部落回默认」的回归
  // 锚点——本地为空（新 profile）时备份必须整体生效，而不是被 merge 静默丢弃。
  it('workerModels 补缺：本地为空时备份整体生效（新 profile 恢复不丢模型）', async () => {
    const backup: WorkerModelMap = {
      content_writer: { provider: 'gw', modelId: 'flash-med' },
      reviewer: { provider: 'gw', modelId: 'flash-high' },
    };
    // 本地保持 fallback {}（新 profile 形态）。
    expect(await workerModels.getValue()).toEqual({});

    await restoreStorage(
      { config: { [SK.workerModels]: backup } },
      { strategy: 'merge', settings: true, credentials: false },
    );

    expect(await workerModels.getValue()).toEqual(backup);
  });

  it('workerModels 补缺：本地已有的 role 保留本地、缺失的 role 从备份补入', async () => {
    const local: WorkerModelMap = {
      content_writer: { provider: 'local-p', modelId: 'local-m' },
      // 仅本地有、备份没有的 role——merge「只增不减」，必须原样保留。
      frontend_coder: { provider: 'local-p', modelId: 'local-fe' },
    };
    await workerModels.setValue(local);

    const backup: WorkerModelMap = {
      content_writer: { provider: 'gw', modelId: 'flash-med' },
      researcher: { provider: 'gw', modelId: 'flash' },
    };
    await restoreStorage(
      { config: { [SK.workerModels]: backup } },
      { strategy: 'merge', settings: true, credentials: false },
    );

    const result = await workerModels.getValue();
    // 同 role 本地优先，不被备份旧选择覆盖。
    expect(result.content_writer).toEqual({ provider: 'local-p', modelId: 'local-m' });
    // 本地缺的 role 补入。
    expect(result.researcher).toEqual({ provider: 'gw', modelId: 'flash' });
    // 备份里没有的本地 role 不被 merge 删掉。
    expect(result.frontend_coder).toEqual({ provider: 'local-p', modelId: 'local-fe' });
    // 两侧都没有的 role 不凭空出现。
    expect(result.reviewer).toBeUndefined();
  });

  it('workerRoleTimeouts 补缺：本地为空时备份整体生效、同 role 本地优先', async () => {
    const backup: WorkerTimeoutMap = { frontend_coder: 300000, reviewer: 90000 };
    expect(await workerRoleTimeouts.getValue()).toEqual({});

    await restoreStorage(
      { config: { [SK.workerRoleTimeouts]: backup } },
      { strategy: 'merge', settings: true, credentials: false },
    );
    expect(await workerRoleTimeouts.getValue()).toEqual(backup);

    // 本地调过的 role 保留本地，缺失的 role 补入。
    await workerRoleTimeouts.setValue({ frontend_coder: 600000 });
    await restoreStorage(
      { config: { [SK.workerRoleTimeouts]: backup } },
      { strategy: 'merge', settings: true, credentials: false },
    );
    const result = await workerRoleTimeouts.getValue();
    expect(result.frontend_coder).toBe(600000);
    expect(result.reviewer).toBe(90000);
  });

  // persona 三件套修复：merge 模式下默认状态（OFF/''/空 identity）须被备份补入，
  // 本地已配置则保留。修复前 3 条都没有 fillMissing → merge silently skip，
  // local defaults 保持不变 → backup persona content 被 drop。
  describe('persona items (修复合并模式静默跳过)', () => {
    const backupEnabled = true;
    const backupSoul = 'Speak in first person.';
    const backupIdentity: PersonaIdentity = {
      name: 'Cebian',
      vibe: 'precise',
      tone: 'casual',
      emoji: '🦞',
    };

    it('本地默认（OFF / 空串 / 空 identity） → 备份内容整体生效', async () => {
      // 确认起始是默认（与 persistence/storage fallback 一致）。
      expect(await personaEnabled.getValue()).toBe(false);
      expect(await personaSoul.getValue()).toBe('');
      expect(await personaIdentity.getValue()).toEqual({
        name: '',
        vibe: '',
        tone: '',
        emoji: '',
      });

      await restoreStorage(
        {
          config: {
            [SK.personaEnabled]: backupEnabled,
            [SK.personaSoul]: backupSoul,
            [SK.personaIdentity]: backupIdentity,
          },
        },
        { strategy: 'merge', settings: true, credentials: false },
      );

      // 三件套全部从备份补入。
      expect(await personaEnabled.getValue()).toBe(true);
      expect(await personaSoul.getValue()).toBe(backupSoul);
      expect(await personaIdentity.getValue()).toEqual(backupIdentity);
    });

    it('本地任一 persona 项已配置 → merge 保留本地、不被备份覆盖', async () => {
      await personaEnabled.setValue(true);
      await personaSoul.setValue('local soul — 保留');
      await personaIdentity.setValue({
        name: 'LocalName',
        vibe: 'local-vibe',
        tone: 'local-tone',
        emoji: '🎯',
      });

      await restoreStorage(
        {
          config: {
            [SK.personaEnabled]: false,
            [SK.personaSoul]: 'backup soul — should-be-ignored',
            [SK.personaIdentity]: backupIdentity,
          },
        },
        { strategy: 'merge', settings: true, credentials: false },
      );

      // personaEnabled 本地 true → 保留（不被备份 false 覆盖）。
      expect(await personaEnabled.getValue()).toBe(true);
      // personaSoul 本地非空 → 保留。
      expect(await personaSoul.getValue()).toBe('local soul — 保留');
      // personaIdentity 本地非空 → 整个对象保留（不与备份逐字段 merge）。
      expect(await personaIdentity.getValue()).toEqual({
        name: 'LocalName',
        vibe: 'local-vibe',
        tone: 'local-tone',
        emoji: '🎯',
      });
    });

    it('replace 策略：备份值永远覆盖、不论本地状态', async () => {
      await personaEnabled.setValue(true);
      await personaSoul.setValue('irrelevant');
      await personaIdentity.setValue({
        name: 'X',
        vibe: 'v',
        tone: 't',
        emoji: 'e',
      });

      await restoreStorage(
        {
          config: {
            [SK.personaEnabled]: false,
            [SK.personaSoul]: '',
            [SK.personaIdentity]: {
              name: '',
              vibe: '',
              tone: '',
              emoji: '',
            },
          },
        },
        { strategy: 'replace', settings: true, credentials: false },
      );

      // 即使备份值就是默认空状态，replace 也覆盖写入。
      expect(await personaEnabled.getValue()).toBe(false);
      expect(await personaSoul.getValue()).toBe('');
      expect(await personaIdentity.getValue()).toEqual({
        name: '',
        vibe: '',
        tone: '',
        emoji: '',
      });
    });
  });
});
