/**
 * Tests for src/data/seo-data.ts
 *
 * Covers: getAuthorForTopic, truncateTitle, truncateMetaDescription,
 * enforceSEOLimits, keywordToSlug, getKeywords, getKeywordStats,
 * registerArticleForLinking, bulkRegisterArticles, getInternalLinkCount,
 * autoLink, getRelatedArticles, getIndexNowKey
 */

import {
  EXPERT_AUTHORS,
  getAuthorForTopic,
  truncateTitle,
  truncateMetaDescription,
  enforceSEOLimits,
  SEO_THRESHOLDS,
  keywordToSlug,
  getKeywords,
  getRandomKeywords,
  getKeywordStats,
  registerArticleForLinking,
  bulkRegisterArticles,
  getInternalLinkCount,
  autoLink,
  getRelatedArticles,
  getIndexNowKey,
  CREDIBLE_SOURCES,
  ENTITIES,
} from '../src/data/seo-data';

// ─── getAuthorForTopic ───────────────────────────────────────────────────────

describe('getAuthorForTopic', () => {
  it('returns emergency-specialist author for emergency keywords', () => {
    const author = getAuthorForTopic('Emergency surgery for dogs');
    expect(author.credentials).toMatch(/Emergency|Critical/i);
  });

  it('returns emergency-specialist author for "urgent" keyword', () => {
    const author = getAuthorForTopic('Urgent care coverage');
    expect(author).toBe(EXPERT_AUTHORS[4]);
  });

  it('returns oncology author for cancer keyword', () => {
    const author = getAuthorForTopic('Cancer treatment insurance coverage');
    expect(author).toBe(EXPERT_AUTHORS[1]);
  });

  it('returns oncology author for "heart" keyword', () => {
    const author = getAuthorForTopic('Heart disease coverage for dogs');
    expect(author).toBe(EXPERT_AUTHORS[1]);
  });

  it('returns senior/chronic author for "senior" keyword', () => {
    const author = getAuthorForTopic('Best insurance for senior cats');
    expect(author).toBe(EXPERT_AUTHORS[0]);
  });

  it('returns senior/chronic author for "chronic" keyword', () => {
    const author = getAuthorForTopic('Chronic condition pet insurance');
    expect(author).toBe(EXPERT_AUTHORS[0]);
  });

  it('returns insurance-specialist author for "cost" keyword', () => {
    const author = getAuthorForTopic('Pet insurance cost breakdown');
    expect(author).toBe(EXPERT_AUTHORS[3]);
  });

  it('returns insurance-specialist author for "deductible" keyword', () => {
    const author = getAuthorForTopic('Understanding your deductible');
    expect(author).toBe(EXPERT_AUTHORS[3]);
  });

  it('returns holistic author for "wellness" keyword', () => {
    const author = getAuthorForTopic('Wellness plans and holistic care');
    expect(author).toBe(EXPERT_AUTHORS[2]);
  });

  it('returns a deterministic author for generic titles (hash-based)', () => {
    const title = 'Generic pet insurance article';
    const author1 = getAuthorForTopic(title);
    const author2 = getAuthorForTopic(title);
    expect(author1).toBe(author2);
    expect(EXPERT_AUTHORS).toContain(author1);
  });

  it('always returns a valid EXPERT_AUTHORS entry', () => {
    const titles = [
      'Puppy insurance guide',
      'Compare pet insurance providers',
      'Rabbit insurance options',
      'Best pet insurance 2024',
    ];
    for (const t of titles) {
      expect(EXPERT_AUTHORS).toContain(getAuthorForTopic(t));
    }
  });
});

// ─── truncateTitle ───────────────────────────────────────────────────────────

describe('truncateTitle', () => {
  it('returns the same title when under maxLength', () => {
    const title = 'Short title';
    expect(truncateTitle(title)).toBe('Short title');
  });

  it('trims whitespace', () => {
    expect(truncateTitle('  A title  ')).toBe('A title');
  });

  it('returns empty string unchanged', () => {
    expect(truncateTitle('')).toBe('');
  });

  it('accepts a custom maxLength parameter without throwing', () => {
    const title = 'A reasonable title for testing';
    expect(() => truncateTitle(title, 20)).not.toThrow();
  });
});

// ─── truncateMetaDescription ──────────────────────────────────────────────────

describe('truncateMetaDescription', () => {
  const MAX = SEO_THRESHOLDS.maxMetaDescLength; // 155

  it('returns short descriptions unchanged', () => {
    const desc = 'Short meta description.';
    expect(truncateMetaDescription(desc)).toBe(desc);
  });

  it('returns description exactly at maxLength unchanged', () => {
    const desc = 'x'.repeat(MAX);
    expect(truncateMetaDescription(desc)).toHaveLength(MAX);
  });

  it('truncates long descriptions to at most maxLength characters', () => {
    const longDesc = 'This is a very long sentence. '.repeat(10); // ~300 chars
    const result = truncateMetaDescription(longDesc);
    expect(result.length).toBeLessThanOrEqual(MAX);
  });

  it('prefers complete sentences when truncating', () => {
    const desc = 'First sentence. Second sentence. ' + 'x'.repeat(200);
    const result = truncateMetaDescription(desc);
    // Result should end with a sentence terminator or ellipsis
    expect(result).toMatch(/[.!?]$|\.\.\.$/);
  });

  it('falls back to word-boundary truncation when no complete sentence fits', () => {
    const noSentences = 'word '.repeat(60).trim(); // long text, no sentence endings
    const result = truncateMetaDescription(noSentences);
    expect(result.length).toBeLessThanOrEqual(MAX);
  });

  it('handles undefined/null gracefully (returns input)', () => {
    expect(truncateMetaDescription(null as unknown as string)).toBeFalsy();
    expect(truncateMetaDescription(undefined as unknown as string)).toBeFalsy();
  });
});

// ─── enforceSEOLimits ────────────────────────────────────────────────────────

describe('enforceSEOLimits', () => {
  it('returns wasModified=false when both fields are within limits', () => {
    const result = enforceSEOLimits({
      title: 'A Normal Title',
      metaDescription: 'A short meta description.',
    });
    expect(result.wasModified).toBe(false);
    expect(result.title).toBe('A Normal Title');
    expect(result.metaDescription).toBe('A short meta description.');
  });

  it('sets wasModified=true when meta description is too long', () => {
    const longMeta = 'Long description. '.repeat(20);
    const result = enforceSEOLimits({ title: 'Title', metaDescription: longMeta });
    expect(result.wasModified).toBe(true);
    expect(result.metaDescription.length).toBeLessThanOrEqual(SEO_THRESHOLDS.maxMetaDescLength);
  });

  it('handles missing title gracefully', () => {
    const result = enforceSEOLimits({ metaDescription: 'Some meta.' });
    expect(result.title).toBe('');
  });

  it('handles missing metaDescription gracefully', () => {
    const result = enforceSEOLimits({ title: 'A Title' });
    expect(result.metaDescription).toBe('');
  });

  it('handles empty object gracefully', () => {
    const result = enforceSEOLimits({});
    expect(result.wasModified).toBe(false);
    expect(result.title).toBe('');
    expect(result.metaDescription).toBe('');
  });
});

// ─── keywordToSlug ────────────────────────────────────────────────────────────

describe('keywordToSlug', () => {
  it('converts spaces to hyphens', () => {
    expect(keywordToSlug('best pet insurance')).toBe('best-pet-insurance');
  });

  it('lowercases the result', () => {
    expect(keywordToSlug('Best Cat Insurance')).toBe('best-cat-insurance');
  });

  it('removes non-alphanumeric characters', () => {
    expect(keywordToSlug('pet insurance (2024)!')).toBe('pet-insurance-2024');
  });

  it('strips leading and trailing hyphens', () => {
    expect(keywordToSlug('  insurance  ')).toBe('insurance');
  });

  it('collapses multiple separators into one hyphen', () => {
    expect(keywordToSlug('cat & dog insurance')).toBe('cat-dog-insurance');
  });

  it('handles an empty string', () => {
    expect(keywordToSlug('')).toBe('');
  });
});

// ─── getKeywords ──────────────────────────────────────────────────────────────

describe('getKeywords', () => {
  it('returns the correct shape', () => {
    const result = getKeywords();
    expect(result).toHaveProperty('keywords');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('offset');
    expect(result).toHaveProperty('limit');
  });

  it('returns 100 keywords by default', () => {
    const result = getKeywords();
    expect(result.keywords.length).toBe(100);
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it('respects offset and limit parameters', () => {
    const first = getKeywords(0, 5);
    const second = getKeywords(5, 5);
    expect(first.keywords.length).toBe(5);
    expect(second.keywords.length).toBe(5);
    // No overlap
    for (const kw of second.keywords) {
      expect(first.keywords).not.toContain(kw);
    }
  });

  it('total is consistent across calls', () => {
    expect(getKeywords(0, 1).total).toBe(getKeywords(50, 1).total);
  });
});

// ─── getRandomKeywords ────────────────────────────────────────────────────────

describe('getRandomKeywords', () => {
  it('returns the requested count', () => {
    expect(getRandomKeywords(5)).toHaveLength(5);
    expect(getRandomKeywords(1)).toHaveLength(1);
  });

  it('returns strings', () => {
    getRandomKeywords(3).forEach(kw => expect(typeof kw).toBe('string'));
  });
});

// ─── getKeywordStats (seo-data) ───────────────────────────────────────────────

describe('getKeywordStats (seo-data)', () => {
  it('returns total that matches ALL_KEYWORDS length', () => {
    const { total } = getKeywordStats();
    const { total: t2 } = getKeywords(0, 1);
    expect(total).toBe(t2);
  });

  it('category counts sum to total', () => {
    const { total, categories } = getKeywordStats();
    const sum = Object.values(categories).reduce((a, b) => a + b, 0);
    expect(sum).toBe(total);
  });

  it('has expected category keys', () => {
    const { categories } = getKeywordStats();
    expect(categories).toHaveProperty('cat');
    expect(categories).toHaveProperty('dog');
    expect(categories).toHaveProperty('exotic');
    expect(categories).toHaveProperty('general');
  });
});

// ─── CREDIBLE_SOURCES & ENTITIES ─────────────────────────────────────────────

describe('CREDIBLE_SOURCES', () => {
  it('has required source keys', () => {
    expect(CREDIBLE_SOURCES).toHaveProperty('avma');
    expect(CREDIBLE_SOURCES).toHaveProperty('naphia');
    expect(CREDIBLE_SOURCES).toHaveProperty('aspca');
  });

  it('each source has name, url, and type fields', () => {
    for (const source of Object.values(CREDIBLE_SOURCES)) {
      expect(source).toHaveProperty('name');
      expect(source).toHaveProperty('url');
      expect(source).toHaveProperty('type');
    }
  });
});

describe('ENTITIES', () => {
  it('has base, dog, and cat arrays', () => {
    expect(Array.isArray(ENTITIES.base)).toBe(true);
    expect(Array.isArray(ENTITIES.dog)).toBe(true);
    expect(Array.isArray(ENTITIES.cat)).toBe(true);
  });
});

// ─── getIndexNowKey ───────────────────────────────────────────────────────────

describe('getIndexNowKey', () => {
  it('returns a non-empty string', () => {
    const key = getIndexNowKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });
});

// ─── registerArticleForLinking / bulkRegisterArticles / getInternalLinkCount ──

describe('internal linking registry', () => {
  it('getInternalLinkCount increases after registering an article', () => {
    const before = getInternalLinkCount();
    registerArticleForLinking('test-unique-slug-abc', 'petinsurance');
    expect(getInternalLinkCount()).toBeGreaterThan(before);
  });

  it('bulkRegisterArticles returns count of registered slugs', () => {
    const slugs = ['bulk-slug-1', 'bulk-slug-2', 'bulk-slug-3'];
    const count = bulkRegisterArticles(slugs, 'petinsurance');
    expect(count).toBe(3);
  });

  it('bulkRegisterArticles ignores empty slugs', () => {
    const count = bulkRegisterArticles(['', '', 'valid-slug-xyz'], 'petinsurance');
    expect(count).toBe(1);
  });

  it('bulkRegisterArticles returns 0 for missing category', () => {
    const count = bulkRegisterArticles(['some-slug'], '');
    expect(count).toBe(0);
  });
});

// ─── autoLink ────────────────────────────────────────────────────────────────

describe('autoLink', () => {
  beforeAll(() => {
    // Register a known article so autoLink has something to link to
    registerArticleForLinking('french-bulldog-insurance', 'petinsurance');
  });

  it('returns the content unchanged when no registered keywords match', () => {
    const content = '<p>No matching keywords in this content at all xyz123.</p>';
    const result = autoLink(content, 'current-slug', 'petinsurance');
    expect(result).toBe(content);
  });

  it('returns input unchanged when KEYWORD_LINKS is empty or content is non-string', () => {
    expect(autoLink(null as unknown as string, 'slug', 'cat')).toBeFalsy();
    expect(autoLink(undefined as unknown as string, 'slug', 'cat')).toBeFalsy();
  });

  it('does not link to current article slug', () => {
    const content = '<p>french bulldog insurance is great.</p>';
    const result = autoLink(content, 'french-bulldog-insurance', 'petinsurance');
    // Should not add link pointing to itself
    expect(result).not.toMatch(/href="\/petinsurance\/french-bulldog-insurance"/);
  });

  it('adds at most 5 links', () => {
    // Register many slugs to ensure we have enough candidates
    for (let i = 0; i < 10; i++) {
      registerArticleForLinking(`unique-autolink-slug-${i}`, 'petinsurance');
    }
    const matches = Array.from({ length: 10 }, (_, i) => `unique autolink slug ${i}`).join(' ');
    const content = `<article><p>${matches}</p></article>`;
    const result = autoLink(content, 'different-slug', 'petinsurance');
    const linkCount = (result.match(/<a /g) || []).length;
    expect(linkCount).toBeLessThanOrEqual(5);
  });
});

// ─── getRelatedArticles ───────────────────────────────────────────────────────

describe('getRelatedArticles', () => {
  beforeAll(() => {
    registerArticleForLinking('related-test-article-one', 'petinsurance');
    registerArticleForLinking('related-test-article-two', 'petinsurance');
  });

  it('returns an array', () => {
    const results = getRelatedArticles('some-other-slug', 'petinsurance');
    expect(Array.isArray(results)).toBe(true);
  });

  it('respects the limit parameter', () => {
    const results = getRelatedArticles('some-slug', 'petinsurance', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('each result has slug, anchorText, category fields', () => {
    const results = getRelatedArticles('another-slug', 'petinsurance', 5);
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('anchorText');
      expect(r).toHaveProperty('category');
    }
  });

  it('does not include the current slug in results', () => {
    const slug = 'related-test-article-one';
    const results = getRelatedArticles(slug, 'petinsurance', 10);
    expect(results.map(r => r.slug)).not.toContain(slug);
  });
});
