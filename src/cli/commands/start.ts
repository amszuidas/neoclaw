import { defineCommand } from 'citty';

import { loadConfig } from '../../config.js';
import { NeoClawDaemon } from '../../daemon.js';

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
