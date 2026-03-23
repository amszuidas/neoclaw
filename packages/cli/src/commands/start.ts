import { defineCommand } from 'citty';
import { loadConfig } from '@neoclaw/core/config';
import { NeoClawDaemon } from '../daemon';

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start the neoclaw daemon.',
  },
  async run() {
    const config = loadConfig();
    const daemon = new NeoClawDaemon(config);
    await daemon.run();
  },
});
