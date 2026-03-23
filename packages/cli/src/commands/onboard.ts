import { intro, isCancel, log, note, outro, spinner, confirm } from '@clack/prompts';
import {
  NEOCLAW_HOME,
  NeoClawConfig,
  NeoClawConfigSchema,
  NeoClawConfigJsonSchema,
  DEFAULT_CONFIG,
} from '@neoclaw/core/config';
import { defineCommand } from 'citty';
import { merge } from 'es-toolkit/object';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cancelAndExit,
  selectAgentPrompt,
  selectedChannelPrompt,
  channelConfigPrompt,
} from '../prompts';

/**
 * 检查本地是否已有 `config.json`
 */
function checkConfig(path: string) {
  let rawConfig: unknown | undefined;
  try {
    rawConfig = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    log.info('Configuration file read failed. A new file will be created.');
  }

  if (rawConfig) {
    const parsedRaw = NeoClawConfigSchema.safeParse(rawConfig);
    if (parsedRaw.success) {
      cancelAndExit('Configuration file already exists.');
    } else {
      log.info('Configuration file is invalid. Using empty config template as the starting point.');
    }
  }
}

/**
 * Initialize ~/.neoclaw/config.json
 */
export async function initConfig(): Promise<string> {
  const configPath = join(NEOCLAW_HOME, 'config.json');

  checkConfig(configPath);

  const selectedAgent = await selectAgentPrompt();
  const selectedChannel = await selectedChannelPrompt();
  const channelConfig = await channelConfigPrompt(selectedChannel);
  const shouldWrite = await confirm({
    message: 'Write these changes to config.json?',
    initialValue: true,
  });
  if (isCancel(shouldWrite) || !shouldWrite) {
    cancelAndExit();
  }

  const userInput: Partial<NeoClawConfig> = {
    agent: selectedAgent,
    channels: channelConfig,
  };
  const template: Partial<NeoClawConfig> = {
    timeoutSecs: DEFAULT_CONFIG.timeoutSecs,
    summaryTimeoutSecs: DEFAULT_CONFIG.summaryTimeoutSecs,
    workspacesDir: DEFAULT_CONFIG.workspacesDir,
    mcpServers: DEFAULT_CONFIG.mcpServers,
    skillsDir: DEFAULT_CONFIG.skillsDir,
    fileBlacklist: [],
    agents: DEFAULT_CONFIG.agents,
    channels: DEFAULT_CONFIG.channels,
  };

  const configSchemaPath = join(NEOCLAW_HOME, 'config.schema.json');
  const merged = merge(template, userInput);
  const config: NeoClawConfig = {
    $schema: pathToFileURL(configSchemaPath).href,
    ...NeoClawConfigSchema.parse(merged),
  };

  // 首次初始化时自动创建 ~/.neoclaw 目录
  mkdirSync(dirname(configPath), { recursive: true });
  // 写入 JSON Schema
  writeFileSync(configSchemaPath, `${JSON.stringify(NeoClawConfigJsonSchema, null, 2)}\n`, 'utf-8');
  // 写入 config.json
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

  return configPath;
}

/**
 * Initialize ~/.neoclaw/memory/ with template files and subdirectories.
 */
export async function initMemory(): Promise<string> {
  const spin = spinner();
  spin.start('Preparing memory directories and templates...');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const memoryDir = join(NEOCLAW_HOME, 'memory');
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
    createdDirs.push(memoryDir);
  }

  // Create identity/, knowledge/ and episodes/ subdirectories
  for (const sub of ['identity', 'knowledge', 'episodes']) {
    const dir = join(memoryDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      createdDirs.push(dir);
    }
  }

  const templatesDir = fileURLToPath(new URL('../templates', import.meta.url));
  if (!existsSync(templatesDir)) {
    spin.error('Memory templates directory not found');
    throw new Error(`Memory templates directory not found: ${templatesDir}`);
  }

  // Copy SOUL.md template to identity/
  const soulDest = join(memoryDir, 'identity', 'SOUL.md');
  if (!existsSync(soulDest)) {
    copyFileSync(join(templatesDir, 'SOUL.md'), soulDest);
    createdFiles.push(soulDest);
  } else {
    skippedFiles.push(soulDest);
  }

  // Copy knowledge topic templates
  for (const topic of ['owner-profile', 'preferences', 'people', 'projects', 'notes']) {
    const dest = join(memoryDir, 'knowledge', `${topic}.md`);
    if (!existsSync(dest)) {
      copyFileSync(join(templatesDir, `${topic}.md`), dest);
      createdFiles.push(dest);
    } else {
      skippedFiles.push(dest);
    }
  }

  spin.stop('Memory initialized.');
  return memoryDir;
}

export default defineCommand({
  meta: {
    name: 'onboard',
    description: 'Initialize neoclaw configuration. ',
  },
  async run() {
    intro('NeoClaw onboard');
    const configPath = await initConfig();
    const memoryPath = await initMemory();

    const summaryLines = [
      `You can edit the config file at: ${configPath}`,
      `You can edit the memory file at: ${memoryPath}`,
    ];
    note(summaryLines.join('\n'));
    outro('NeoClaw onboard finish');
  },
});
