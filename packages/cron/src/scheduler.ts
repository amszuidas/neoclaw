/**
 * CronScheduler — polls every 30 seconds and fires due cron jobs.
 *
 * When a job fires, it creates a synthetic InboundMessage and calls
 * dispatcher.handle() so the job runs in the correct conversation workspace
 * and the result is delivered back to the originating chat.
 */

import { randomUUID } from 'node:crypto';
import type { RunResponse } from '@neoclaw/core';
import type { Dispatcher } from '@neoclaw/core/dispatcher';
import type { InboundMessage } from '@neoclaw/core/types/gateway';
import { logger } from '@neoclaw/core/utils/logger';
import { listJobs, saveJob } from './store.js';
import type { CronJob } from './types.js';

const log = logger('cron');

const POLL_INTERVAL_MS = 30_000; // 30 seconds

// ── Cron expression matcher ───────────────────────────────────

/**
 * Returns true if `now` matches the 5-field cron expression AND the job
 * hasn't already run within the last 50 seconds (prevents double-fires
 * when the 30s poll lands twice in the same minute).
 *
 * Supported syntax per field: *, N, N-M, N/step, *\/step, N,M,...
 */
function matchesCron(expr: string, now: Date, lastRunAt: Date | null): boolean {
  // Prevent double-fire within the same cron period
  if (lastRunAt && now.getTime() - lastRunAt.getTime() < 50_000) return false;

  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return false;

  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const matchField = (field: string, value: number, min: number, max: number): boolean => {
    if (field === '*') return true;

    if (field.includes('/')) {
      const [rangeStr, stepStr] = field.split('/') as [string, string];
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return false;
      const start = rangeStr === '*' ? min : parseInt(rangeStr, 10);
      return value >= start && value <= max && (value - start) % step === 0;
    }

    if (field.includes(',')) {
      return field.split(',').some((part) => parseInt(part.trim(), 10) === value);
    }

    if (field.includes('-')) {
      const [loStr, hiStr] = field.split('-') as [string, string];
      return value >= parseInt(loStr, 10) && value <= parseInt(hiStr, 10);
    }

    return parseInt(field, 10) === value;
  };

  return (
    matchField(minF, now.getMinutes(), 0, 59) &&
    matchField(hourF, now.getHours(), 0, 23) &&
    matchField(domF, now.getDate(), 1, 31) &&
    matchField(monF, now.getMonth() + 1, 1, 12) &&
    matchField(dowF, now.getDay(), 0, 6)
  );
}

// ── CronScheduler ─────────────────────────────────────────────

export class CronScheduler {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _inFlight = new Set<string>(); // job IDs currently executing

  constructor(private readonly _dispatcher: Dispatcher) {}

  start(): void {
    if (this._timer) return;
    log.info(`Cron scheduler started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
    // Immediate tick to catch any jobs that were due while the daemon was offline
    void this._tick();
    this._timer = setInterval(() => void this._tick(), POLL_INTERVAL_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log.info('Cron scheduler stopped');
  }

  // ── Polling ─────────────────────────────────────────────────

  private async _tick(): Promise<void> {
    const now = new Date();
    let jobs: CronJob[];
    try {
      jobs = listJobs().filter((j) => j.enabled);
    } catch (err) {
      log.warn(`Failed to list cron jobs: ${err}`);
      return;
    }

    for (const job of jobs) {
      if (this._inFlight.has(job.id)) continue;
      if (this._isDue(job, now)) {
        void this._fire(job, now);
      }
    }
  }

  private _isDue(job: CronJob, now: Date): boolean {
    if (job.runAt) {
      return new Date(job.runAt) <= now;
    }
    if (job.cronExpr) {
      const lastRun = job.lastRunAt ? new Date(job.lastRunAt) : null;
      return matchesCron(job.cronExpr, now, lastRun);
    }
    return false;
  }

  // ── Firing ──────────────────────────────────────────────────

  private async _fire(job: CronJob, now: Date): Promise<void> {
    this._inFlight.add(job.id);
    log.info(`Firing cron job "${job.label ?? job.id}"`);

    // Update state before calling dispatcher to prevent double-fire on slow jobs
    job.lastRunAt = now.toISOString();
    if (job.runAt) {
      job.enabled = false; // one-time job: disable after first fire
    }
    try {
      saveJob(job);
    } catch (err) {
      log.warn(`Failed to persist job state before firing "${job.id}": ${err}`);
    }

    try {
      const text =
        `[定时任务触发]\n\n` +
        `**任务名称：** ${job.label ?? '(未命名)'}\n` +
        `**触发时间：** ${now.toISOString()}\n\n` +
        `**任务详情：**\n${job.message}`;

      const msg: InboundMessage = {
        id: randomUUID(),
        text,
        chatId: job.chatId,
        authorId: 'cron',
        authorName: 'CronScheduler',
        gatewayKind: job.gatewayKind,
      };

      const dispatcher = this._dispatcher;
      const replyFn = async (response: RunResponse): Promise<void> => {
        try {
          await dispatcher.sendTo(job.gatewayKind, job.chatId, response);
        } catch (err) {
          log.error(`Failed to deliver result for cron job "${job.id}": ${err}`);
        }
      };

      await dispatcher.handle(msg, replyFn);
      log.info(`Cron job "${job.label ?? job.id}" completed`);
    } catch (err) {
      log.error(`Cron job "${job.id}" execution failed: ${err}`);
    } finally {
      this._inFlight.delete(job.id);
    }
  }
}
