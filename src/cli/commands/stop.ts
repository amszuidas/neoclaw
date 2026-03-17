import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { defineCommand } from 'citty';
import { log } from '@clack/prompts';

import { NEOCLAW_HOME } from '../../config.js';

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the neoclaw daemon.',
  },
  async run() {
    const pidPath = join(NEOCLAW_HOME, 'cache', 'neoclaw.pid');

    // Check if the PID exists
    if (!existsSync(pidPath)) {
      log.success('No daemon is running.');
      return;
    }

    // Read and parse PID
    let pid: number;
    try {
      const content = readFileSync(pidPath, 'utf-8').trim();
      pid = parseInt(content, 10);
    } catch {
      log.success('Stale PID file, removing.');
      unlinkSync(pidPath);
      return;
    }

    // Check if the process is still running
    try {
      process.kill(pid, 0);
    } catch {
      log.success(`Stale PID file (pid=${pid}), removing.`);
      unlinkSync(pidPath);
      return;
    }

    // Force kill
    log.step('Force kill daemon.');
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      log.error(`Failed to send SIGKILL: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));

    // Manually remove PID file if still exists
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
    log.success('Daemon killed.');
  },
});
