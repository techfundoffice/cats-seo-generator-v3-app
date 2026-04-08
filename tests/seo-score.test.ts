/**
 * Tests for src/services/seo-score.ts
 *
 * Covers:
 *  - validateVideoSchema (pure synchronous function)
 *  - calculateSEOScore (async, uses seord + cheerio)
 */

import { validateVideoSchema, calculateSEOScore } from '../src/services/seo-score';

// ─── validateVideoSchema ──────────────────────────────────────────────────────

describe('validateVideoSchema', () => {
  const buildVideoSchema = (props: Record<string, string>) => {
    const fields = Object.entries(props)
      .map(([k, v]) => `"${k}": "${v}"`)
      .join(', ');
    return `<script type="application/ld+json">{"@type":"VideoObject", ${fields}}</script>`;
  };

  it('returns isValid=false and lists all missing required props for empty html', () => {
    const { isValid, missingProps, foundProps } = validateVideoSchema('');
    expect(isValid).toBe(false);
    expect(missingProps).toContain('name');
    expect(missingProps).toContain('description');
    expect(missingProps).toContain('thumbnailUrl');
    expect(missingProps).toContain('uploadDate');
    expect(missingProps).toContain('duration');
    expect(missingProps).toContain('embedUrl');
    expect(missingProps).toContain('contentUrl');
    expect(foundProps).toHaveLength(0);
  });

  it('detects "name" via itemprop', () => {
    const html = '<span itemprop="name">My Video</span>';
    const { foundProps, missingProps } = validateVideoSchema(html);
    expect(foundProps).toContain('name');
    expect(missingProps).not.toContain('name');
  });

  it('detects "name" via JSON-LD key', () => {
    const html = '{"name": "My Video"}';
    const { foundProps } = validateVideoSchema(html);
    expect(foundProps).toContain('name');
  });

  it('detects "embedUrl" via youtube.com/embed pattern', () => {
    const html = '<iframe src="https://www.youtube.com/embed/abc123"></iframe>';
    const { foundProps, missingProps } = validateVideoSchema(html);
    expect(foundProps).toContain('embedUrl');
    expect(missingProps).not.toContain('embedUrl');
  });

  it('detects all required properties and returns isValid=true', () => {
    const html = [
      'itemprop="name"',
      'itemprop="description"',
      'itemprop="thumbnailUrl"',
      'itemprop="uploadDate"',
      'itemprop="duration"',
      'youtube.com/embed',
      'itemprop="contentUrl"',
    ].join(' ');
    const { isValid, missingProps } = validateVideoSchema(html);
    expect(isValid).toBe(true);
    expect(missingProps).toHaveLength(0);
  });

  it('detects recommended "publisher" property and adds it to foundProps with suffix', () => {
    const html = 'itemprop="publisher" itemprop="name" itemprop="description" itemprop="thumbnailUrl" itemprop="uploadDate" itemprop="duration" youtube.com/embed itemprop="contentUrl"';
    const { foundProps } = validateVideoSchema(html);
    expect(foundProps).toContain('publisher (recommended)');
  });

  it('detects recommended "interactionStatistic" via InteractionCounter', () => {
    const html = 'InteractionCounter itemprop="name" itemprop="description" itemprop="thumbnailUrl" itemprop="uploadDate" itemprop="duration" youtube.com/embed itemprop="contentUrl"';
    const { foundProps } = validateVideoSchema(html);
    expect(foundProps).toContain('interactionStatistic (recommended)');
  });

  it('returns isValid=false when at least one required prop is missing', () => {
    // Has everything except contentUrl
    const html = 'itemprop="name" itemprop="description" itemprop="thumbnailUrl" itemprop="uploadDate" itemprop="duration" youtube.com/embed';
    const { isValid, missingProps } = validateVideoSchema(html);
    expect(isValid).toBe(false);
    expect(missingProps).toContain('contentUrl');
  });
});

// ─── calculateSEOScore ────────────────────────────────────────────────────────

describe('calculateSEOScore', () => {
  const makeArticle = ({
    title = 'Best Pet Insurance 2024',
    meta = 'Comprehensive guide to pet insurance covering costs, coverage, and top providers for dogs and cats.',
    body = 'word '.repeat(2500),
    extraHtml = '',
  } = {}) => `
    <html>
      <head>
        <title>${title}</title>
        <meta name="description" content="${meta}" />
      </head>
      <body>
        <article>
          <h1>${title}</h1>
          <h2>Section One</h2><h2>Section Two</h2><h2>Section Three</h2>
          <h2>Section Four</h2><h2>Section Five</h2>
          <h3>Sub One</h3><h3>Sub Two</h3><h3>Sub Three</h3>
          <p>${body}</p>
          ${extraHtml}
        </article>
      </body>
    </html>`;

  it('returns a result with score, details, and breakdown', async () => {
    const result = await calculateSEOScore(makeArticle(), 'pet insurance');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('details');
    expect(result).toHaveProperty('breakdown');
  });

  it('score is a number between 0 and 100', async () => {
    const result = await calculateSEOScore(makeArticle(), 'pet insurance');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('details contains wordCount, keywordDensity, warnings, goodPoints', async () => {
    const result = await calculateSEOScore(makeArticle(), 'pet insurance');
    expect(result.details).toHaveProperty('wordCount');
    expect(result.details).toHaveProperty('keywordDensity');
    expect(result.details).toHaveProperty('warnings');
    expect(result.details).toHaveProperty('goodPoints');
  });

  it('breakdown has seordBase, bonusTotal, lineItems, finalCapped', async () => {
    const result = await calculateSEOScore(makeArticle(), 'pet insurance');
    expect(result.breakdown).toHaveProperty('seordBase');
    expect(result.breakdown).toHaveProperty('bonusTotal');
    expect(result.breakdown).toHaveProperty('lineItems');
    expect(result.breakdown).toHaveProperty('finalCapped');
  });

  it('returns a valid result for empty HTML without throwing', async () => {
    const result = await calculateSEOScore('');
    expect(result).toHaveProperty('score');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('awards bonus points for Article schema', async () => {
    const withSchema = makeArticle({
      extraHtml: '<script type="application/ld+json">{"@type":"Article"}</script>',
    });
    const without = makeArticle();
    const [withResult, withoutResult] = await Promise.all([
      calculateSEOScore(withSchema, 'pet insurance'),
      calculateSEOScore(without, 'pet insurance'),
    ]);
    expect(withResult.breakdown.lineItems['schema_Article']).toBe(3);
    expect(withoutResult.breakdown.lineItems['schema_Article']).toBeUndefined();
  });

  it('awards bonus points for FAQPage schema', async () => {
    const html = makeArticle({
      extraHtml: '<script type="application/ld+json">{"@type":"FAQPage"}</script>',
    });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['schema_FAQPage']).toBe(3);
  });

  it('awards bonus points for BreadcrumbList schema', async () => {
    const html = makeArticle({
      extraHtml: '<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>',
    });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['schema_BreadcrumbList']).toBe(2);
  });

  it('awards bonus points for Organization schema', async () => {
    const html = makeArticle({
      extraHtml: '<script type="application/ld+json">{"@type":"Organization"}</script>',
    });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['schema_Organization']).toBe(2);
  });

  it('awards comparison_tables bonus when a table is present', async () => {
    const html = makeArticle({
      extraHtml: '<table><tr><td>a</td><td>b</td></tr></table>',
    });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['comparison_tables']).toBe(3);
  });

  it('awards internalLinks_tier1 bonus for 3-4 internal links', async () => {
    const links = Array.from(
      { length: 3 },
      (_, i) => `<a href="/petinsurance/article-${i}">Link ${i}</a>`
    ).join('');
    const html = makeArticle({ extraHtml: links });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['internalLinks_tier1']).toBe(2);
  });

  it('awards internalLinks_tier1 bonus for 5+ internal links', async () => {
    const links = Array.from(
      { length: 5 },
      (_, i) => `<a href="/petinsurance/article-${i}">Link ${i}</a>`
    ).join('');
    const html = makeArticle({ extraHtml: links });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['internalLinks_tier1']).toBe(4);
  });

  it('awards images_alt_some for 1-2 images with alt text', async () => {
    const html = makeArticle({
      extraHtml: '<img src="a.jpg" alt="A cat" /><img src="b.jpg" alt="" />',
    });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['images_alt_some']).toBe(2);
  });

  it('awards images_alt_rich for 3+ images with alt text', async () => {
    const imgs = Array.from(
      { length: 3 },
      (_, i) => `<img src="${i}.jpg" alt="Image ${i}" />`
    ).join('');
    const html = makeArticle({ extraHtml: imgs });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['images_alt_rich']).toBe(4);
  });

  it('awards meta_length_optimal for 120-160 char meta description', async () => {
    const meta = 'a'.repeat(140);
    const html = makeArticle({ meta });
    const result = await calculateSEOScore(html, 'pet insurance', undefined, meta);
    expect(result.breakdown.lineItems['meta_length_optimal']).toBe(3);
  });

  it('awards title_length_optimal for 40-60 char title', async () => {
    const title = 'Best Pet Insurance Guide for Dogs and Cats'; // 43 chars
    const html = makeArticle({ title });
    const result = await calculateSEOScore(html, 'pet insurance', title);
    expect(result.breakdown.lineItems['title_length_optimal']).toBe(3);
  });

  it('awards video bonuses for embed with complete VideoObject schema', async () => {
    const videoHtml = `
      <iframe src="https://www.youtube.com/embed/abc123"></iframe>
      <script type="application/ld+json">{
        "@type": "VideoObject",
        "name": "Test Video",
        "description": "A video",
        "thumbnailUrl": "https://example.com/thumb.jpg",
        "uploadDate": "2024-01-01",
        "duration": "PT5M",
        "embedUrl": "https://www.youtube.com/embed/abc123",
        "contentUrl": "https://www.youtube.com/watch?v=abc123"
      }</script>`;
    const html = makeArticle({ extraHtml: videoHtml });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['video_embed_complete_schema']).toBe(8);
  });

  it('awards partial video bonus for embed with incomplete VideoObject schema', async () => {
    const videoHtml = `
      <iframe src="https://www.youtube.com/embed/abc123"></iframe>
      <script type="application/ld+json">{"@type": "VideoObject", "name": "Test"}</script>`;
    const html = makeArticle({ extraHtml: videoHtml });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['video_embed_partial_schema']).toBe(5);
  });

  it('awards video_embed_no_schema bonus when embed has no VideoObject schema', async () => {
    const videoHtml = '<iframe src="https://www.youtube.com/embed/abc123"></iframe>';
    const html = makeArticle({ extraHtml: videoHtml });
    const result = await calculateSEOScore(html, 'pet insurance');
    expect(result.breakdown.lineItems['video_embed_no_schema']).toBe(3);
  });

  it('finalCapped does not exceed 100', async () => {
    // Add all possible bonuses
    const allBonuses = `
      <script type="application/ld+json">{"@type":"Article"}</script>
      <script type="application/ld+json">{"@type":"FAQPage"}</script>
      <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
      <script type="application/ld+json">{"@type":"Organization"}</script>
      <table><tr><td>x</td></tr></table>
      <img src="1.jpg" alt="Image 1" /><img src="2.jpg" alt="Image 2" /><img src="3.jpg" alt="Image 3" />
      ${Array.from({ length: 10 }, (_, i) => `<a href="/petinsurance/x-${i}">L</a>`).join('')}
      <iframe src="https://www.youtube.com/embed/abc"></iframe>
      <script type="application/ld+json">{
        "@type":"VideoObject","name":"V","description":"D","thumbnailUrl":"T",
        "uploadDate":"2024","duration":"PT1M","embedUrl":"https://www.youtube.com/embed/abc","contentUrl":"C"
      }</script>`;
    const html = makeArticle({ meta: 'a'.repeat(140), title: 'Best Pet Insurance Guide for Dogs and Cats', extraHtml: allBonuses });
    const result = await calculateSEOScore(html, 'pet insurance', 'Best Pet Insurance Guide for Dogs and Cats', 'a'.repeat(140));
    expect(result.breakdown.finalCapped).toBeLessThanOrEqual(100);
    expect(result.score).toBeLessThanOrEqual(100);
  }, 30000);
});
