/**
 * Data model for a stored cron job.
 * Persisted as ~/.neoclaw/cron/<id>.json
 */

export interface CronJob {
  /** UUID v4, used as filename: ~/.neoclaw/cron/<id>.json */
  id: string;
  /** Human-readable label. */
  label?: string;
  /** The prompt/message sent to the agent when this job fires. */
  message: string;

  // ── Routing info (injected from conversation context at creation time) ──
  /** Target chat ID. */
  chatId: string;
  /** Gateway kind (e.g. "feishu"). */
  gatewayKind: string;
  /** Dispatcher conversation key — always equals chatId (cron always targets main chat). */
  conversationId: string;

  // ── Schedule (exactly one must be set) ──
  /** ISO 8601 datetime for a one-time job. */
  runAt?: string;
  /** Standard 5-field cron expression for a recurring job. */
  cronExpr?: string;

  /** Whether the job is active. One-time jobs are disabled after firing. */
  enabled: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the last successful execution. */
  lastRunAt?: string;
}
