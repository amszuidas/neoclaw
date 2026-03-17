/**
 * Onboarding wizard — generates a config template at ~/.neoclaw/config.json.
 *
 * Run with: bun onboard
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, NEOCLAW_HOME } from './config.js';

const CONFIG_PATH = join(NEOCLAW_HOME, 'config.json');

// Build the template from DEFAULTS.
// - systemPrompt is excluded: the built-in default is used when not configured.
// - Credential fields use placeholder strings as a guide for the user.
const TEMPLATE = {
  ...DEFAULTS,
  agent: {
    ...DEFAULTS.agent,
    systemPrompt: undefined,
  },
  feishu: {
    ...DEFAULTS.feishu,
    appId: 'YOUR_FEISHU_APP_ID',
    appSecret: 'YOUR_FEISHU_APP_SECRET',
  },
  wework: {
    ...DEFAULTS.wework,
    botId: 'YOUR_WEWORK_BOT_ID',
    secret: 'YOUR_WEWORK_SECRET',
  },
};

export async function runOnboard(): Promise<void> {
  console.log('NeoClaw Onboarding Wizard');
  console.log('='.repeat(50));
  console.log();

  // Ensure ~/.neoclaw exists
  if (!existsSync(NEOCLAW_HOME)) {
    mkdirSync(NEOCLAW_HOME, { recursive: true });
    console.log(`Created ${NEOCLAW_HOME}`);
  }

  // ── Step 1: Config file ───────────────────────────────────────
  initConfig();

  // ── Step 2: Skills directory ─────────────────────────────────
  const skillsDir = DEFAULTS.skillsDir ?? join(NEOCLAW_HOME, 'skills');
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
    console.log(`Created skills directory: ${skillsDir}`);
  } else {
    console.log(`Skills directory already exists: ${skillsDir}`);
  }

  // ── Step 4: Memory directory ──────────────────────────────────
  console.log();
  initMemoryDir();

  console.log();
  console.log('Next steps:');
  console.log('  1. Open the config file and fill in your gateway credentials:');
  console.log(`     ${CONFIG_PATH}`);
  console.log();
  console.log('  Required fields (at least one gateway must be configured):');
  console.log();
  console.log('  Feishu (飞书):');
  console.log('     feishu.appId           — from Feishu Open Platform');
  console.log('     feishu.appSecret        — from Feishu Open Platform');
  console.log();
  console.log('  Wework (企业微信智能助手):');
  console.log('     wework.botId            — from Wework Bot Settings (长连接模式)');
  console.log('     wework.secret           — from Wework Bot Settings');
  console.log();
  console.log('  2. Make sure Claude Code is installed:');
  console.log('     npm install -g @anthropic-ai/claude-code');
  console.log();
  console.log('  3. Start the daemon:');
  console.log('     bun start');
  console.log();
  console.log('  4. Send a message to your bot to test it!');
  console.log();
}

/** Write config template if not already configured; print current config otherwise. */
function initConfig(): void {
  if (existsSync(CONFIG_PATH)) {
    const existing = readFileSync(CONFIG_PATH, 'utf-8');
    let hasRealCredentials = false;
    try {
      const cfg = JSON.parse(existing);
      // Check if at least one gateway is properly configured (二选一即可)
      const feishuOk =
        typeof cfg?.feishu?.appId === 'string' &&
        cfg.feishu.appId !== '' &&
        !cfg.feishu.appId.startsWith('YOUR_') &&
        typeof cfg?.feishu?.appSecret === 'string' &&
        cfg.feishu.appSecret !== '' &&
        !cfg.feishu.appSecret.startsWith('YOUR_');
      const weworkOk =
        typeof cfg?.wework?.botId === 'string' &&
        cfg.wework.botId !== '' &&
        !cfg.wework.botId.startsWith('YOUR_') &&
        typeof cfg?.wework?.secret === 'string' &&
        cfg.wework.secret !== '' &&
        !cfg.wework.secret.startsWith('YOUR_');
      hasRealCredentials = feishuOk || weworkOk;
    } catch {
      /* parse error — overwrite */
    }

    if (hasRealCredentials) {
      console.log(`Config already exists at: ${CONFIG_PATH} (credentials configured, skipping)`);
      return;
    }

    console.log(`Overwriting existing template at: ${CONFIG_PATH}`);
  }

  const content = JSON.stringify(TEMPLATE, null, 2);
  writeFileSync(CONFIG_PATH, content);
  console.log(`Config template written to: ${CONFIG_PATH}`);
}

// ── Memory directory ──────────────────────────────────────────

/** Initialize ~/.neoclaw/memory/ with template files and subdirectories. */
function initMemoryDir(): void {
  const memoryDir = join(NEOCLAW_HOME, 'memory');
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  // Create identity/, knowledge/ and episodes/ subdirectories
  for (const sub of ['identity', 'knowledge', 'episodes']) {
    const dir = join(memoryDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`Created memory subdirectory: ${dir}`);
    }
  }

  const srcDir = fileURLToPath(new URL('.', import.meta.url));
  const templatesDir = join(srcDir, 'templates');

  // Copy SOUL.md template to identity/
  const soulDest = join(memoryDir, 'identity', 'SOUL.md');
  if (!existsSync(soulDest)) {
    copyFileSync(join(templatesDir, 'SOUL.md'), soulDest);
    console.log(`Memory template written to: ${soulDest}`);
  } else {
    console.log(`Memory file already exists, skipping: ${soulDest}`);
  }

  // Copy knowledge topic templates
  for (const topic of ['owner-profile', 'preferences', 'people', 'projects', 'notes']) {
    const dest = join(memoryDir, 'knowledge', `${topic}.md`);
    if (!existsSync(dest)) {
      copyFileSync(join(templatesDir, `${topic}.md`), dest);
      console.log(`Memory template written to: ${dest}`);
    } else {
      console.log(`Memory file already exists, skipping: ${dest}`);
    }
  }
}
