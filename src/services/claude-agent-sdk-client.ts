/**
 * V3 SEO article text generation — Claude Agent SDK only.
 * (Legacy Workers AI JSON issues led to this path; see cloudflare-image-gen for FLUX.)
 */

import { claudeAgentGenerate } from './vercel-ai-gateway';

export interface ClaudeAgentSdkOptions {
  maxTokens?: number;
  timeout?: number;
}

export interface ClaudeAgentSdkResult {
  content: string;
  model: string;
}

/**
 * Generate text using Claude Agent SDK (Sonnet).
 * Throws immediately on failure — no fallback cascade.
 */
export async function generateWithClaudeAgentSdk(
  prompt: string,
  options: ClaudeAgentSdkOptions = {}
): Promise<ClaudeAgentSdkResult> {
  console.log('[V3] Using Claude Agent SDK (Claude Sonnet 4.5)');
  const maxTokens = options.maxTokens || 16000;
  const result = await claudeAgentGenerate(prompt, undefined, maxTokens);
  return { content: result, model: 'claude-sonnet-4.5' };
}
