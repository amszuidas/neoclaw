/**
 * Wework Message Sender
 *
 * 企业微信消息发送工具（用于 WebSocket 长连接模式）。
 */

import type { RunResponse } from '../../agents/types.js';

/**
 * 格式化统计信息
 */
function formatStats(response: RunResponse): string | null {
  const parts: string[] = [];
  if (response.model) parts.push(response.model);
  if (response.elapsedMs != null) parts.push(`${(response.elapsedMs / 1000).toFixed(1)}s`);
  if (response.inputTokens != null) parts.push(`${response.inputTokens} in`);
  if (response.outputTokens != null) parts.push(`${response.outputTokens} out`);
  if (response.costUsd != null) parts.push(`$${response.costUsd.toFixed(4)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 构建 Markdown 消息内容
 */
export function buildMarkdownContent(opts: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): string {
  const lines: string[] = [];

  // 思考内容（折叠显示）
  if (opts.thinking) {
    lines.push('> 💭 **Thinking Process**');
    lines.push('> ');
    // 将思考内容每行加上引用符号
    const thinkingLines = opts.thinking.split('\n');
    for (const line of thinkingLines) {
      lines.push(`> ${line}`);
    }
    lines.push('> ');
    lines.push('---');
  }

  // 主内容
  lines.push(opts.text);

  // 统计信息
  if (opts.stats) {
    lines.push('---');
    lines.push(`<font color="comment">${opts.stats}</font>`);
  }

  return lines.join('\n');
}
