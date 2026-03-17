#! /usr/bin/env bun

import { runMain } from 'citty';
import { mainCmd } from './cli/index.js';

// CLI entry point. Sub-commands are defined in `src/cli/index.ts` and lazily loaded from `src/cli/commands/`
// Run `neoclaw --help` for the full command reference.
runMain(mainCmd);
