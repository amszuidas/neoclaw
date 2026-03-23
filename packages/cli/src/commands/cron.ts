/**
 * neoclaw cron — subcommand group for managing NeoClaw cron jobs.
 *
 * Reads NEOCLAW_CHAT_ID and NEOCLAW_GATEWAY_KIND from environment variables,
 * which the daemon injects into the Claude Code subprocess at spawn time.
 *
 * Usage:
 *   neoclaw cron create --message <msg> (--run-at <iso> | --cron-expr <expr>) [--label <label>]
 *   neoclaw cron list [--include-disabled]
 *   neoclaw cron delete --job-id <id>
 *   neoclaw cron update --job-id <id> [--label <label>] [--message <msg>]
 *                                     [--run-at <iso>] [--cron-expr <expr>] [--enabled <true|false>]
 *
 * All subcommands output a single JSON object.
 */

import { randomUUID } from 'node:crypto';
import { defineCommand } from 'citty';
import { deleteJob, listJobs, loadJob, saveJob } from '@neoclaw/cron/store';
import type { CronJob } from '@neoclaw/cron/types';

// ── Helpers ───────────────────────────────────────────────────

function out(obj: unknown): never {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

function fail(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// ── Subcommands ───────────────────────────────────────────────

const createCmd = defineCommand({
  meta: { name: 'create', description: 'Create a new scheduled job.' },
  args: {
    message: {
      type: 'string',
      description: 'Prompt to send when the job fires',
      required: true,
      alias: ['m'],
    },
    label: { type: 'string', description: 'Optional human-readable label' },
    'run-at': { type: 'string', description: 'ISO 8601 datetime for a one-time job' },
    'cron-expr': { type: 'string', description: '5-field cron expression for a recurring job' },
  },
  run({ args }) {
    const chatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
    const gatewayKind = process.env['NEOCLAW_GATEWAY_KIND'] ?? '';
    if (!chatId || !gatewayKind)
      fail('NEOCLAW_CHAT_ID and NEOCLAW_GATEWAY_KIND env vars are not set');

    const message = args.message.trim();
    const label = args.label?.trim() || undefined;
    const runAt = args['run-at']?.trim() || undefined;
    const cronExpr = args['cron-expr']?.trim() || undefined;

    if (!message) fail('--message cannot be an empty string');
    if (!runAt && !cronExpr) fail('one of --run-at or --cron-expr is required');
    if (runAt && cronExpr) fail('--run-at and --cron-expr are mutually exclusive');

    if (runAt) {
      const d = new Date(runAt);
      if (isNaN(d.getTime())) fail(`invalid datetime: "${runAt}"`);
    }

    const job: CronJob = {
      id: randomUUID(),
      label,
      message,
      chatId,
      gatewayKind,
      conversationId: chatId,
      runAt,
      cronExpr,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    saveJob(job);
    out({ ok: true, jobId: job.id, label: job.label, runAt, cronExpr });
  },
});

const listCmd = defineCommand({
  meta: { name: 'list', description: 'List scheduled jobs.' },
  args: {
    'include-disabled': { type: 'boolean', description: 'Include disabled jobs in output' },
  },
  run({ args }) {
    const chatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
    const includeDisabled = args['include-disabled'] === true;
    let jobs = listJobs();
    if (chatId) jobs = jobs.filter((j) => j.chatId === chatId);
    if (!includeDisabled) jobs = jobs.filter((j) => j.enabled);
    out({
      ok: true,
      count: jobs.length,
      jobs: jobs.map((j) => ({
        jobId: j.id,
        label: j.label,
        message: j.message,
        runAt: j.runAt,
        cronExpr: j.cronExpr,
        enabled: j.enabled,
        createdAt: j.createdAt,
        lastRunAt: j.lastRunAt,
      })),
    });
  },
});

const deleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Delete a scheduled job.' },
  args: {
    'job-id': { type: 'string', description: 'ID of the job to delete', required: true },
  },
  run({ args }) {
    const chatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
    const jobId = args['job-id'].trim();

    const job = loadJob(jobId);
    if (!job) fail(`job "${jobId}" not found`);
    if (chatId && job.chatId !== chatId) fail('permission denied: job belongs to a different chat');

    deleteJob(jobId);
    out({ ok: true, jobId });
  },
});

const updateCmd = defineCommand({
  meta: { name: 'update', description: 'Update fields of an existing scheduled job.' },
  args: {
    'job-id': { type: 'string', description: 'ID of the job to update', required: true },
    label: { type: 'string', description: 'New label' },
    message: { type: 'string', description: 'New message' },
    'run-at': { type: 'string', description: 'Switch to one-time: ISO 8601 datetime' },
    'cron-expr': { type: 'string', description: 'Switch to recurring: 5-field cron expression' },
    enabled: { type: 'string', description: 'true or false' },
  },
  run({ args }) {
    const chatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
    const jobId = args['job-id'].trim();

    const job = loadJob(jobId);
    if (!job) fail(`job "${jobId}" not found`);
    if (chatId && job.chatId !== chatId) fail('permission denied: job belongs to a different chat');

    const label = args.label?.trim();
    const message = args.message?.trim();
    const runAt = args['run-at']?.trim();
    const cronExpr = args['cron-expr']?.trim();
    const enabledStr = args.enabled?.trim();

    if (label !== undefined) job.label = label;
    if (message !== undefined) job.message = message;
    if (enabledStr !== undefined) job.enabled = enabledStr === 'true';
    if (runAt !== undefined) {
      const d = new Date(runAt);
      if (isNaN(d.getTime())) fail(`invalid datetime: "${runAt}"`);
      job.runAt = runAt;
      job.cronExpr = undefined; // switch to one-time
    }
    if (cronExpr !== undefined) {
      job.cronExpr = cronExpr;
      job.runAt = undefined; // switch to recurring
    }

    saveJob(job);
    out({ ok: true, jobId, label: job.label, enabled: job.enabled });
  },
});

// ── Root cron command ─────────────────────────────────────────

export default defineCommand({
  meta: { name: 'cron', description: 'Manage NeoClaw scheduled jobs.' },
  subCommands: {
    create: createCmd,
    list: listCmd,
    delete: deleteCmd,
    update: updateCmd,
  },
});
