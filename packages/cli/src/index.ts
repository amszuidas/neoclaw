#! /usr/bin/env bun

import { defineCommand, runMain } from 'citty';
import pkg from '../package.json' with { type: 'json' };

const mainCmd = defineCommand({
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

const rawArgs = process.argv.slice(2);

// CLI entry point. Sub-commands are defined in `src/cli/index.ts` and lazily loaded from `src/cli/commands/`
// Run `neoclaw --help` for the full command reference.
runMain(mainCmd, {
  rawArgs: rawArgs.length === 0 ? ['--help'] : rawArgs,
});
