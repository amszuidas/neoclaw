import { defineCommand } from 'citty';

import pkg from '../../package.json' with { type: 'json' };

export const mainCmd = defineCommand({
  meta: {
    name: 'neoclaw',
    version: pkg.version,
    description: 'NeoClaw CLI — super AI assistant daemon',
  },
  subCommands: {
    onboard: () => import('./commands/onboard.js').then((m) => m.default),
    start: () => import('./commands/start.js').then((m) => m.default),
    stop: () => import('./commands/stop.js').then((m) => m.default),
    cron: () => import('./commands/cron.js').then((m) => m.default),
  },
});
