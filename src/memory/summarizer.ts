/**
 * Session transcript summarizer.
 *
 * Uses claude CLI in --print mode (single-shot, no persistent process)
 * to generate a structured summary from conversation history.
 */

import { loadConfig } from '../config.js';

/** Model priority: config.agent.summaryModel > ANTHROPIC_SMALL_FAST_MODEL > haiku default. */
function getSummaryModel(): string {
  try {
    const config = loadConfig();
    if (config.agent.summaryModel) return config.agent.summaryModel;
  } catch {
    /* ignore */
  }
  return 'haiku';
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
  const prompt = SUMMARIZE_PROMPT + transcript;
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE_ENTRYPOINT'];

  const result = Bun.spawnSync(['claude', '--model', model, '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
    timeout: 60_000,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`Claude CLI failed (exit ${result.exitCode}): ${stderr}`);
  }

  return result.stdout.toString().trim();
}
