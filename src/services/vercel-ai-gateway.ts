import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { secrets } from './doppler-secrets';

/**
 * Claude AI client — two-tier fallback
 *
 * Strategy 1 (primary): Claude Agent SDK via Max subscription
 *   - Uses Claude Code CLI's OAuth session (CLAUDE_CODE_OAUTH_TOKEN or existing login)
 *   - No per-token API costs (flat monthly Max/Pro rate)
 *
 * Strategy 2 (fallback): Anthropic API key directly
 *   - Uses ANTHROPIC_API_KEY from Doppler
 *   - Per-token billing against API credits
 *
 * V3 article JSON calls this via claude-agent-sdk-client.ts (generateWithClaudeAgentSdk).
 */

/**
 * Strategy 1: Generate via Claude Agent SDK (Max subscription)
 * Uses the Claude Code CLI's existing auth — no per-token API costs
 */
const VERCEL_GATEWAY_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
];

async function generateViaAgentSDK(
  userPrompt: string,
  systemPrompt: string,
  maxTokens: number
): Promise<string> {
  console.log('[Claude Agent SDK] Generating via Max subscription...');

  const savedVars: Record<string, string | undefined> = {};
  for (const key of VERCEL_GATEWAY_VARS) {
    savedVars[key] = process.env[key];
    delete process.env[key];
  }
  console.log('[Claude Agent SDK] Stripped Vercel gateway env vars to use Max OAuth');

  let resultText = '';
  let lastError = '';

  try {
    for await (const message of query({
      prompt: userPrompt,
      options: {
        systemPrompt: systemPrompt || undefined,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        if ((message as any).is_error) {
          lastError = message.result || 'unknown SDK error';
          console.error(`[Claude Agent SDK] Error in result: ${lastError.substring(0, 200)}`);
        } else {
          resultText = message.result;
        }
      } else if ((message as any).type === 'error') {
        lastError = JSON.stringify(message);
        console.error(`[Claude Agent SDK] Error message: ${lastError.substring(0, 200)}`);
      }
    }
  } finally {
    for (const key of VERCEL_GATEWAY_VARS) {
      if (savedVars[key] !== undefined) {
        process.env[key] = savedVars[key];
      }
    }
  }

  if (!resultText || resultText.length === 0) {
    throw new Error(`Claude Agent SDK returned empty response. Last error: ${lastError}`);
  }

  console.log(`[Claude Agent SDK] Generated ${resultText.length} characters via Max subscription`);
  return resultText;
}

/**
 * Strategy 2: Generate via Anthropic API key directly
 */
async function generateViaApiKey(
  userPrompt: string,
  systemPrompt: string,
  maxTokens: number
): Promise<string> {
  const apiKey = secrets.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('No ANTHROPIC_API_KEY available for API fallback');
  }

  console.log('[Anthropic API] Using API key directly');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textContent = response.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');

  console.log(`[Anthropic API] Generated ${textContent.length} characters`);
  return textContent;
}

/**
 * Primary export — drop-in replacement for the old vercelAI function.
 * Uses Claude Agent SDK (Max subscription OAuth) first, then Anthropic API key.
 */
export async function claudeAgentGenerate(
  userPrompt: string,
  systemPrompt: string = 'You are an expert SEO content writer. Return only valid JSON as instructed.',
  maxTokens: number = 16000
): Promise<string> {
  // Strategy 1: Claude Agent SDK (Max subscription, no per-token cost)
  try {
    return await generateViaAgentSDK(userPrompt, systemPrompt, maxTokens);
  } catch (error: any) {
    console.warn(`[Claude Agent SDK] Failed: ${error.message}`);
  }

  // Strategy 2: Direct Anthropic API key (only if a real key exists, not Vercel gateway)
  const apiKey = secrets.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (apiKey && !apiKey.includes('vck_') && !process.env.ANTHROPIC_BASE_URL?.includes('vercel')) {
    try {
      return await generateViaApiKey(userPrompt, systemPrompt, maxTokens);
    } catch (error: any) {
      console.warn(`[Anthropic API] Fallback failed: ${error.message}`);
    }
  }

  throw new Error('Claude Agent SDK and Anthropic API fallback both failed');
}

/** @deprecated Use claudeAgentGenerate instead */
export const vercelAI = claudeAgentGenerate;
