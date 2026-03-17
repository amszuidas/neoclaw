import { defineCommand } from 'citty';
import { runOnboard } from '../../onboard.js';

export default defineCommand({
  meta: {
    name: 'onboard',
    description: 'Initialize neoclaw configuration. ',
  },
  async run() {
    await runOnboard();
  },
});
