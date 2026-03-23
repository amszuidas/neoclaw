/**
 * Session transcript summarizer.
 *
 * Uses claude CLI in --print mode (single-shot, no persistent process)
 * to generate a structured summary from conversation history.
 */

import { Config } from '../config';

const DEFAULT_SUMMARY_TIMEOUT_SECS = 300;

/** Model priority: config.agents.claude_code.summaryModel > ANTHROPIC_SMALL_FAST_MODEL > haiku default. */
function getSummaryModel(): string {
  try {
    const config = Config.get();
    if (config.agents.claude_code?.summaryModel) return config.agents.claude_code.summaryModel;
  } catch {
    /* ignore */
  }
  return 'haiku';
}

function getSummaryTimeoutMs(): number {
  try {
    const config = Config.get();
    const secs = config.summaryTimeoutSecs ?? DEFAULT_SUMMARY_TIMEOUT_SECS;
    return Math.max(1, secs) * 1000;
  } catch {
    return DEFAULT_SUMMARY_TIMEOUT_SECS * 1000;
  }
}

export interface SessionSummary {
  title: string;
  summary: string;
  topics: string[];
  decisions: string[];
}

const SUMMARIZE_PROMPT = `You are a conversation summarizer. Analyze the following transcript and produce a structured summary.

Output EXACTLY in this format (no extra text before or after):
---
title: "<concise title describing the main topic>"
date: "<YYYY-MM-DD>"
tags: [<comma-separated relevant tags>]
---

## Summary
<2-4 sentence summary of the conversation>

## Key Topics
- <topic 1>
- <topic 2>

## Decisions & Outcomes
- <decision or outcome 1>
- <decision or outcome 2>

## Notable Information
- <any important facts, preferences, or context worth remembering>

Transcript:
`;

export async function summarizeTranscript(transcript: string): Promise<string> {
  const model = getSummaryModel();
  const timeoutMs = getSummaryTimeoutMs();
  const prompt = SUMMARIZE_PROMPT + transcript;
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE_ENTRYPOINT'];

  const result = Bun.spawnSync(['claude', '--model', model, '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    timeout: timeoutMs,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`Claude CLI failed (exit ${result.exitCode}): ${stderr}`);
  }

  return result.stdout.toString().trim();
}
