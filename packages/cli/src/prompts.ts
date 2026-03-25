import { cancel, isCancel, password, select, text } from '@clack/prompts';
import { NeoClawConfig } from '@neoclaw/core/config';

function requiredValidator(value: string | undefined): string | undefined {
  if (!value?.trim()) return 'This field is required.';
  return undefined;
}

async function requiredTextPrompt(message: string): Promise<string> {
  const result = await text({
    message,
    validate: requiredValidator,
  });
  if (isCancel(result)) {
    cancelAndExit();
  }
  return result;
}

export function cancelAndExit(
  message: string = 'Onboarding cancelled. No changes were written.'
): never {
  cancel(message);
  process.exit(0);
}

export async function requiredPasswordPrompt(message: string): Promise<string> {
  const result = await password({
    message,
    validate: requiredValidator,
  });
  if (isCancel(result)) {
    cancelAndExit();
  }
  return result;
}

export async function selectAgentPrompt() {
  const selected = await select({
    message: 'Select agent backend',
    options: [
      { value: 'claude_code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
  });
  if (isCancel(selected)) {
    cancelAndExit();
  }
  return selected;
}

export async function selectedChannelPrompt() {
  const selected = await select({
    message: 'Select message channel',
    options: [
      { value: 'feishu', label: 'Feishu / Lark' },
      { value: 'wework', label: 'WeWork' },
    ],
  });
  if (isCancel(selected)) {
    cancelAndExit();
  }
  return selected;
}

export async function channelConfigPrompt(channel: 'feishu' | 'wework') {
  let channelConfig: Partial<NeoClawConfig['channels']>;

  if (channel === 'feishu') {
    const appId = await requiredTextPrompt('Feishu app ID');
    const appSecret = await requiredPasswordPrompt('Feishu app secret');
    channelConfig = {
      feishu: {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
      },
    };
  } else {
    const botId = await requiredTextPrompt('WeWork bot ID');
    const secret = await requiredPasswordPrompt('WeWork secret');
    channelConfig = {
      wework: {
        botId: botId.trim(),
        secret: secret.trim(),
      },
    };
  }

  return channelConfig;
}
