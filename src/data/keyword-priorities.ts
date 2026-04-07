/**
 * Keyword Priority System
 *
 * Prioritizes keywords based on:
 * - Search volume potential (estimated)
 * - Commercial intent (buyer keywords)
 * - Competition level
 *
 * Priority Tiers:
 * 1. HIGH: High-volume, high-intent keywords (best pet insurance, cost, comparison)
 * 2. MEDIUM: Breed-specific, condition-specific keywords
 * 3. LOW: Long-tail, niche keywords
 */

import { ALL_KEYWORDS, keywordToSlug } from './seo-data';

export type PriorityTier = 'high' | 'medium' | 'low';

export interface PrioritizedKeyword {
  keyword: string;
  slug: string;
  priority: PriorityTier;
  score: number; // 1-100, higher = more valuable
  category: string;
}

// High-priority patterns (commercial intent, high volume)
const HIGH_PRIORITY_PATTERNS = [
  /^best pet insurance/i,
  /^best cat insurance/i,
  /^best dog insurance/i,
  /^cheapest pet insurance/i,
  /^affordable.*insurance/i,
  /pet insurance cost/i,
  /pet insurance comparison/i,
  /pet insurance review/i,
  /how much.*pet insurance/i,
  /is pet insurance worth/i,
  /pet insurance for (dogs|cats|puppies|kittens)/i,
  /pet insurance (california|texas|florida|new york)/i,
  /(lemonade|embrace|healthy paws|trupanion|nationwide|figo|aspca|pumpkin|spot|metlife).*review/i,
];

// Medium-priority patterns (breed-specific, condition-specific)
const MEDIUM_PRIORITY_PATTERNS = [
  /insurance for (french bulldog|german shepherd|golden retriever|labrador)/i,
  /(persian|maine coon|siamese|bengal|ragdoll).*insurance/i,
  /insurance.*(senior|older|puppy|kitten)/i,
  /insurance.*(cancer|dental|surgery|emergency)/i,
  /pre.?existing condition/i,
  /no waiting period/i,
  /accident.only/i,
  /wellness.*insurance/i,
  /hereditary.*condition/i,
  /(exotic|rabbit|bird|guinea pig|hamster|ferret|reptile).*insurance/i,
];

// Category detection
function detectCategory(keyword: string): string {
  const lower = keyword.toLowerCase();

  if (/review|compare|vs|versus/.test(lower)) return 'comparison';
  if (/cost|price|cheap|affordable|budget/.test(lower)) return 'cost';
  if (/best|top|rated/.test(lower)) return 'best-of';
  if (/(dog|puppy|canine)/.test(lower)) return 'dogs';
  if (/(cat|kitten|feline)/.test(lower)) return 'cats';
  if (/(rabbit|bird|guinea|hamster|ferret|reptile|exotic)/.test(lower)) return 'exotic';
  if (/(senior|older|elderly)/.test(lower)) return 'senior-pets';
  if (/(cancer|diabetes|kidney|heart|dental|surgery)/.test(lower)) return 'conditions';
  if (/(california|texas|florida|new york|state)/.test(lower)) return 'location';
  if (/(lemonade|embrace|healthy paws|trupanion|nationwide|figo|aspca|pumpkin|spot|metlife|progressive)/.test(lower)) return 'provider-reviews';

  return 'general';
}

// Score calculation (1-100)
function calculateScore(keyword: string, priority: PriorityTier): number {
  let baseScore = priority === 'high' ? 80 : priority === 'medium' ? 50 : 20;

  const lower = keyword.toLowerCase();

  // Boost for commercial intent words
  if (/best|top|cheap|affordable|compare/.test(lower)) baseScore += 10;

  // Boost for specific, actionable keywords
  if (/how to|guide|review|vs/.test(lower)) baseScore += 5;

  // Boost for 2024/2025/2026 (timely content)
  if (/202[456]/.test(lower)) baseScore += 5;

  // Slight penalty for very long keywords (harder to rank)
  if (keyword.split(' ').length > 6) baseScore -= 5;

  return Math.min(100, Math.max(1, baseScore));
}

// Determine priority tier
function determinePriority(keyword: string): PriorityTier {
  if (HIGH_PRIORITY_PATTERNS.some(p => p.test(keyword))) {
    return 'high';
  }
  if (MEDIUM_PRIORITY_PATTERNS.some(p => p.test(keyword))) {
    return 'medium';
  }
  return 'low';
}

// Build prioritized keyword list
function buildPrioritizedKeywords(): PrioritizedKeyword[] {
  return ALL_KEYWORDS.map(keyword => {
    const priority = determinePriority(keyword);
    return {
      keyword,
      slug: keywordToSlug(keyword),
      priority,
      score: calculateScore(keyword, priority),
      category: detectCategory(keyword),
    };
  }).sort((a, b) => b.score - a.score); // Sort by score descending
}

// Cached prioritized list
let _prioritizedKeywords: PrioritizedKeyword[] | null = null;

export function getPrioritizedKeywords(): PrioritizedKeyword[] {
  if (!_prioritizedKeywords) {
    _prioritizedKeywords = buildPrioritizedKeywords();
  }
  return _prioritizedKeywords;
}

// Get keywords by priority tier
export function getKeywordsByPriority(tier: PriorityTier): PrioritizedKeyword[] {
  return getPrioritizedKeywords().filter(k => k.priority === tier);
}

// Get next keyword that hasn't been generated (checks against existing slugs)
export function getNextKeyword(existingSlugs: Set<string>): PrioritizedKeyword | null {
  const keywords = getPrioritizedKeywords();

  for (const kw of keywords) {
    if (!existingSlugs.has(kw.slug)) {
      return kw;
    }
  }

  return null; // All keywords have been generated
}

// Get statistics
export function getKeywordStats(): {
  total: number;
  byPriority: Record<PriorityTier, number>;
  byCategory: Record<string, number>;
} {
  const keywords = getPrioritizedKeywords();

  const byPriority: Record<PriorityTier, number> = { high: 0, medium: 0, low: 0 };
  const byCategory: Record<string, number> = {};

  for (const kw of keywords) {
    byPriority[kw.priority]++;
    byCategory[kw.category] = (byCategory[kw.category] || 0) + 1;
  }

  return {
    total: keywords.length,
    byPriority,
    byCategory,
  };
}

// Export top N keywords for each priority
export function getTopKeywords(n: number = 10): {
  high: PrioritizedKeyword[];
  medium: PrioritizedKeyword[];
  low: PrioritizedKeyword[];
} {
  return {
    high: getKeywordsByPriority('high').slice(0, n),
    medium: getKeywordsByPriority('medium').slice(0, n),
    low: getKeywordsByPriority('low').slice(0, n),
  };
}
