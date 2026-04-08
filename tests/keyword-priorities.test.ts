/**
 * Tests for src/data/keyword-priorities.ts
 *
 * Covers: getPrioritizedKeywords, getKeywordsByPriority, getNextKeyword,
 * getKeywordStats, getTopKeywords
 */

import {
  getPrioritizedKeywords,
  getKeywordsByPriority,
  getNextKeyword,
  getKeywordStats,
  getTopKeywords,
  type PrioritizedKeyword,
  type PriorityTier,
} from '../src/data/keyword-priorities';

// ─── getPrioritizedKeywords ────────────────────────────────────────────────────

describe('getPrioritizedKeywords', () => {
  it('returns a non-empty array', () => {
    const kws = getPrioritizedKeywords();
    expect(Array.isArray(kws)).toBe(true);
    expect(kws.length).toBeGreaterThan(0);
  });

  it('returns the same reference on repeated calls (caching)', () => {
    expect(getPrioritizedKeywords()).toBe(getPrioritizedKeywords());
  });

  it('each entry has the expected shape', () => {
    const kw = getPrioritizedKeywords()[0];
    expect(kw).toHaveProperty('keyword');
    expect(kw).toHaveProperty('slug');
    expect(kw).toHaveProperty('priority');
    expect(kw).toHaveProperty('score');
    expect(kw).toHaveProperty('category');
  });

  it('entries are sorted by score descending', () => {
    const kws = getPrioritizedKeywords();
    for (let i = 0; i < kws.length - 1; i++) {
      expect(kws[i].score).toBeGreaterThanOrEqual(kws[i + 1].score);
    }
  });

  it('every score is in range [1, 100]', () => {
    for (const kw of getPrioritizedKeywords()) {
      expect(kw.score).toBeGreaterThanOrEqual(1);
      expect(kw.score).toBeLessThanOrEqual(100);
    }
  });

  it('every priority is one of high | medium | low', () => {
    const validTiers: PriorityTier[] = ['high', 'medium', 'low'];
    for (const kw of getPrioritizedKeywords()) {
      expect(validTiers).toContain(kw.priority);
    }
  });

  it('slug is derived from keyword (lowercased, hyphenated)', () => {
    for (const kw of getPrioritizedKeywords().slice(0, 20)) {
      // Slug should be non-empty and match slug pattern
      expect(kw.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

// ─── getKeywordsByPriority ────────────────────────────────────────────────────

describe('getKeywordsByPriority', () => {
  it('returns only "high" tier keywords when asked', () => {
    const highs = getKeywordsByPriority('high');
    expect(highs.length).toBeGreaterThan(0);
    highs.forEach(kw => expect(kw.priority).toBe('high'));
  });

  it('returns only "medium" tier keywords when asked', () => {
    const mediums = getKeywordsByPriority('medium');
    expect(mediums.length).toBeGreaterThan(0);
    mediums.forEach(kw => expect(kw.priority).toBe('medium'));
  });

  it('returns only "low" tier keywords when asked', () => {
    const lows = getKeywordsByPriority('low');
    expect(lows.length).toBeGreaterThan(0);
    lows.forEach(kw => expect(kw.priority).toBe('low'));
  });

  it('high + medium + low count equals total', () => {
    const high = getKeywordsByPriority('high').length;
    const medium = getKeywordsByPriority('medium').length;
    const low = getKeywordsByPriority('low').length;
    const total = getPrioritizedKeywords().length;
    expect(high + medium + low).toBe(total);
  });

  it('high-priority keywords include expected patterns', () => {
    const highs = getKeywordsByPriority('high').map(k => k.keyword.toLowerCase());
    const hasBest = highs.some(k => k.includes('best'));
    expect(hasBest).toBe(true);
  });
});

// ─── getNextKeyword ───────────────────────────────────────────────────────────

describe('getNextKeyword', () => {
  it('returns a PrioritizedKeyword when the set is empty', () => {
    const result = getNextKeyword(new Set());
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('keyword');
  });

  it('returns null when all slugs are present in the existing set', () => {
    const allSlugs = new Set(getPrioritizedKeywords().map(k => k.slug));
    expect(getNextKeyword(allSlugs)).toBeNull();
  });

  it('skips slugs that are in the existing set', () => {
    const all = getPrioritizedKeywords();
    // Block the first keyword, expect the second (or another) to be returned
    const blocked = new Set([all[0].slug]);
    const next = getNextKeyword(blocked);
    expect(next).not.toBeNull();
    expect(next!.slug).not.toBe(all[0].slug);
  });

  it('returns the highest-scored ungenerated keyword', () => {
    const all = getPrioritizedKeywords();
    const result = getNextKeyword(new Set());
    // First element in the sorted list (highest score)
    expect(result!.slug).toBe(all[0].slug);
  });
});

// ─── getKeywordStats (keyword-priorities) ─────────────────────────────────────

describe('getKeywordStats', () => {
  it('total matches getPrioritizedKeywords length', () => {
    const { total } = getKeywordStats();
    expect(total).toBe(getPrioritizedKeywords().length);
  });

  it('byPriority counts sum to total', () => {
    const { total, byPriority } = getKeywordStats();
    const sum = byPriority.high + byPriority.medium + byPriority.low;
    expect(sum).toBe(total);
  });

  it('byCategory is a non-empty object', () => {
    const { byCategory } = getKeywordStats();
    expect(Object.keys(byCategory).length).toBeGreaterThan(0);
  });

  it('byCategory values sum to total', () => {
    const { total, byCategory } = getKeywordStats();
    const sum = Object.values(byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total);
  });
});

// ─── getTopKeywords ───────────────────────────────────────────────────────────

describe('getTopKeywords', () => {
  it('returns an object with high, medium, low arrays', () => {
    const top = getTopKeywords();
    expect(top).toHaveProperty('high');
    expect(top).toHaveProperty('medium');
    expect(top).toHaveProperty('low');
    expect(Array.isArray(top.high)).toBe(true);
    expect(Array.isArray(top.medium)).toBe(true);
    expect(Array.isArray(top.low)).toBe(true);
  });

  it('defaults to top 10 per tier', () => {
    const top = getTopKeywords();
    expect(top.high.length).toBeLessThanOrEqual(10);
    expect(top.medium.length).toBeLessThanOrEqual(10);
    expect(top.low.length).toBeLessThanOrEqual(10);
  });

  it('respects a custom N parameter', () => {
    const top = getTopKeywords(3);
    expect(top.high.length).toBeLessThanOrEqual(3);
    expect(top.medium.length).toBeLessThanOrEqual(3);
    expect(top.low.length).toBeLessThanOrEqual(3);
  });

  it('high tier entries have priority === "high"', () => {
    getTopKeywords(5).high.forEach(kw => expect(kw.priority).toBe('high'));
  });

  it('medium tier entries have priority === "medium"', () => {
    getTopKeywords(5).medium.forEach(kw => expect(kw.priority).toBe('medium'));
  });

  it('low tier entries have priority === "low"', () => {
    getTopKeywords(5).low.forEach(kw => expect(kw.priority).toBe('low'));
  });
});
