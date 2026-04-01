import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { defineCommand } from 'citty';
import { log } from '@clack/prompts';
import { NEOCLAW_HOME } from '@neoclaw/core/config';

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the neoclaw daemon.',
  },
  async run() {
    const pidPath = join(NEOCLAW_HOME, 'cache', 'neoclaw.pid');
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const killPid = (pid: number, signal: NodeJS.Signals): boolean => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    };

    // Check if the PID exists
    if (existsSync(pidPath)) {
      // Read and parse PID
      let pid: number;
      try {
        const content = readFileSync(pidPath, 'utf-8').trim();
        pid = parseInt(content, 10);
      } catch {
        log.success('Stale PID file, removing.');
        unlinkSync(pidPath);
        pid = 0;
      }

      // Check if the process is still running
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          log.step(`Stopping daemon pid=${pid}...`);
          killPid(pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 1500));
          if (isAlive(pid)) {
            log.step(`Daemon pid=${pid} still alive, force killing...`);
            killPid(pid, 'SIGKILL');
          }
        } catch {
          log.success(`Stale PID file (pid=${pid}), removing.`);
        }
      }

      // Manually remove PID file if still exists
      if (existsSync(pidPath)) unlinkSync(pidPath);
    }

    // Regression safeguard: clean up any leftover daemon start processes.
    const pattern = 'packages/cli/src/index.ts start';
    const pgrep = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf-8' });
    const leftovers =
      pgrep.status === 0
        ? pgrep.stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        : [];

    if (leftovers.length > 0) {
      log.step(`Cleaning up ${leftovers.length} leftover daemon process(es).`);
      for (const pid of leftovers) killPid(pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      for (const pid of leftovers) killPid(pid, 'SIGKILL');
    }

    log.success('Daemon stopped.');
  },
});
