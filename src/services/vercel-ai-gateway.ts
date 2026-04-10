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
 * Development mode: Return mock article data for testing
 */
function getMockArticleResponse(userPrompt: string): string {
  // Extract keyword from prompt
  const keywordMatch = userPrompt.match(/"([^"]+)"/);
  const keyword = keywordMatch ? keywordMatch[1] : 'pet insurance';

  return JSON.stringify({
    "title": `Best ${keyword} Plans 2026: Expert Guide`,
    "metaDescription": `Compare the best ${keyword} options for 2026. Expert reviews, pricing, and coverage details to help you choose the right plan for your pet.`,
    "quickAnswer": `The best ${keyword} depends on your needs, but Lemonade offers excellent coverage starting at $15/month with fast claims processing. For comprehensive protection, consider Trupanion with 90% reimbursement rates.`,
    "keyTakeaways": [
      `Lemonade provides affordable ${keyword} starting at $15/month with AI-powered claims`,
      "Trupanion offers 90% reimbursement with direct vet payments",
      "Healthy Paws has unlimited annual payouts with no caps on claims",
      "ASPCA offers flexible deductibles with good preventive care coverage",
      "Compare at least 3 providers before choosing a plan"
    ],
    "images": [
      {
        "url": "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?w=800&q=80",
        "alt": `Dog receiving ${keyword} examination`,
        "caption": "Regular vet visits are covered by most pet insurance plans."
      },
      {
        "url": "https://images.unsplash.com/photo-1544568100-847a948585b9?w=800&q=80",
        "alt": `Pet owner comparing ${keyword} options`,
        "caption": "Choosing the right insurance plan protects your pet's health."
      },
      {
        "url": "https://images.unsplash.com/photo-1601758228041-f3b2795255f1?w=800&q=80",
        "alt": `Veterinarian discussing ${keyword} with client`,
        "caption": "Consult with your vet about insurance coverage options."
      }
    ],
    "introduction": `Finding the right ${keyword} can be overwhelming with so many options available. This comprehensive guide compares the top providers, their coverage details, pricing, and what to look for when choosing a plan. Whether you're insuring a puppy, kitten, or senior pet, understanding your options ensures you get the best protection for your furry family member.`,
    "sections": [
      {
        "heading": "Top Pet Insurance Providers Compared",
        "content": "When comparing pet insurance companies, focus on coverage limits, reimbursement rates, and customer service. Lemonade stands out for its affordable premiums and fast digital claims process. Trupanion offers the highest reimbursement rates at 90% with convenient direct vet payments. Healthy Paws provides unlimited annual payouts, making it ideal for pets with chronic conditions."
      },
      {
        "heading": "What Does Pet Insurance Cover?",
        "content": "Most pet insurance plans cover accidents, illnesses, and emergency care. Some include wellness visits, dental care, and alternative therapies. Understanding what your plan covers versus what it excludes helps you choose the right level of protection for your pet's specific needs."
      },
      {
        "heading": "Pet Insurance Costs and Pricing",
        "content": "Monthly premiums typically range from $15 to $70 depending on your pet's age, breed, and coverage level. Younger pets cost less to insure, while certain breeds like French Bulldogs or Persians may have higher rates due to breed-specific health risks."
      }
    ],
    "comparisonTable": {
      "headers": ["Provider", "Monthly Cost", "Deductible", "Reimbursement", "Annual Limit"],
      "rows": [
        ["Lemonade", "$15-40", "$100-500", "70-90%", "$5k-100k"],
        ["Healthy Paws", "$20-50", "$100-500", "70-90%", "Unlimited"],
        ["Trupanion", "$30-70", "$0-1000", "90%", "Unlimited"],
        ["ASPCA", "$18-45", "$100-500", "70-90%", "$5k-10k"]
      ]
    },
    "faqs": [
      {
        "question": `What is ${keyword}?`,
        "answer": `${keyword} provides financial protection for unexpected veterinary costs. It covers accidents, illnesses, and emergency care, helping pet owners afford necessary medical treatment without depleting savings. Most plans reimburse 70-90% of eligible vet bills after you pay your deductible.`
      },
      {
        "question": `How much does ${keyword} cost?`,
        "answer": `Pet insurance premiums range from $15 to $70 per month depending on your pet's age, breed, and coverage level. Puppies and kittens cost $15-30/month, while senior pets may cost $40-70/month. Comprehensive plans with wellness coverage cost more than basic accident-only plans.`
      },
      {
        "question": `Which ${keyword} provider is best?`,
        "answer": `The best pet insurance depends on your needs. Lemonade offers the most affordable premiums with fast claims. Trupanion provides the highest reimbursement rates at 90%. Healthy Paws is best for pets needing unlimited annual coverage. Compare at least three providers before choosing.`
      }
    ],
    "conclusion": `Choosing the right ${keyword} protects both your pet's health and your finances. Compare multiple providers, read customer reviews, and consider your pet's specific needs when selecting a plan. Most importantly, insure your pet while they're young and healthy to avoid breed-specific exclusions and pre-existing condition limitations.`,
    "externalLinks": [
      {
        "url": "https://www.aspca.org/pet-care/general-pet-care/pet-insurance",
        "text": "ASPCA Pet Insurance Guide",
        "context": "The ASPCA provides comprehensive information about pet insurance options."
      },
      {
        "url": "https://www.avma.org/resources/pet-owners/pet-insurance",
        "text": "AVMA Pet Insurance Resources",
        "context": "The American Veterinary Medical Association offers guidance on pet insurance."
      }
    ],
    "internalLinks": [
      {
        "url": "/pet-insurance-for-dogs",
        "anchorText": "dog insurance guide",
        "context": "Compare dog-specific insurance options in our detailed guide."
      }
    ],
    "providerProsCons": [
      {
        "provider": "Lemonade",
        "pros": ["Low monthly premiums starting at $15", "Fast AI-powered claims processing", "User-friendly mobile app"],
        "cons": ["Lower annual limits than competitors", "No wellness add-on available", "Limited coverage for older pets"]
      },
      {
        "provider": "Healthy Paws",
        "pros": ["Unlimited annual payouts", "No caps on claims", "Fast reimbursement"],
        "cons": ["Higher premiums for comprehensive coverage", "No wellness coverage option", "Premiums increase with age"]
      },
      {
        "provider": "Trupanion",
        "pros": ["90% reimbursement rate", "Direct vet payment option", "Covers hereditary conditions"],
        "cons": ["Higher monthly costs", "Only one reimbursement tier", "Longer waiting periods"]
      }
    ],
    "wordCount": 2500
  }, null, 2);
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
  // DEVELOPMENT MODE: Return mock data for placeholder keys
  const apiKey = secrets.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  if (apiKey && (apiKey.includes('placeholder') || apiKey.includes('sk-ant-placeholder'))) {
    console.log('[DEV MODE] Using mock response for placeholder API key');
    return getMockArticleResponse(userPrompt);
  }

  // Strategy 1: Claude Agent SDK (Max subscription, no per-token cost)
  try {
    return await generateViaAgentSDK(userPrompt, systemPrompt, maxTokens);
  } catch (error: any) {
    console.warn(`[Claude Agent SDK] Failed: ${error.message}`);
  }

  // Strategy 2: Direct Anthropic API key (only if a real key exists, not Vercel gateway)
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
