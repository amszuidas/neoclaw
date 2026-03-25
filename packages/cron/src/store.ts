/**
 * Cron job persistence — reads and writes ~/.neoclaw/cron/<id>.json files.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { NEOCLAW_HOME } from '@neoclaw/core/config';
import type { CronJob } from './types.js';

export const CRON_DIR = join(NEOCLAW_HOME, 'cron');

function ensureDir(): void {
  if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true });
}

function jobPath(id: string): string {
  return join(CRON_DIR, `${id}.json`);
}

export function saveJob(job: CronJob): void {
  ensureDir();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(id: string): CronJob | null {
  const path = jobPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CronJob;
  } catch {
    return null;
  }
}

export function deleteJob(id: string): boolean {
  const path = jobPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function listJobs(): CronJob[] {
  ensureDir();
  const jobs: CronJob[] = [];
  for (const file of readdirSync(CRON_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      jobs.push(JSON.parse(readFileSync(join(CRON_DIR, file), 'utf-8')) as CronJob);
    } catch {
      // skip corrupt files
    }
  }
  return jobs;
}
