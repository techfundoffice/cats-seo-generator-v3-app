/**
 * On-page SEO scoring (seord + V3 bonus factors) with full line-item breakdown.
 */
import * as cheerio from 'cheerio';
import { SeoCheck } from 'seord';

export function validateVideoSchema(htmlContent: string): { isValid: boolean; missingProps: string[]; foundProps: string[] } {
  const requiredProps = [
    { name: 'name', patterns: ['itemprop="name"', '"name":', '@name'] },
    { name: 'description', patterns: ['itemprop="description"', '"description":'] },
    { name: 'thumbnailUrl', patterns: ['itemprop="thumbnailUrl"', '"thumbnailUrl":'] },
    { name: 'uploadDate', patterns: ['itemprop="uploadDate"', '"uploadDate":'] },
    { name: 'duration', patterns: ['itemprop="duration"', '"duration":'] },
    { name: 'embedUrl', patterns: ['itemprop="embedUrl"', '"embedUrl":', 'youtube.com/embed'] },
    { name: 'contentUrl', patterns: ['itemprop="contentUrl"', '"contentUrl":'] }
  ];

  const recommendedProps = [
    { name: 'publisher', patterns: ['itemprop="publisher"', '"publisher":'] },
    { name: 'interactionStatistic', patterns: ['itemprop="interactionStatistic"', 'InteractionCounter', '"interactionStatistic":'] }
  ];

  const foundProps: string[] = [];
  const missingProps: string[] = [];

  for (const prop of requiredProps) {
    const found = prop.patterns.some(pattern => htmlContent.includes(pattern));
    if (found) {
      foundProps.push(prop.name);
    } else {
      missingProps.push(prop.name);
    }
  }

  for (const prop of recommendedProps) {
    const found = prop.patterns.some(pattern => htmlContent.includes(pattern));
    if (found) {
      foundProps.push(prop.name + ' (recommended)');
    }
  }

  const isValid = missingProps.length === 0;
  return { isValid, missingProps, foundProps };
}

export interface SEOScoreBreakdown {
  seordBase: number;
  bonusTotal: number;
  /** Each key: points contributed toward the 100 cap (bonuses only; seord is separate) */
  lineItems: Record<string, number>;
  finalCapped: number;
}

export interface SEOScoreResult {
  score: number;
  details: {
    wordCount: number;
    keywordDensity: number;
    warnings: number;
    goodPoints: number;
  };
  breakdown: SEOScoreBreakdown;
}

export async function calculateSEOScore(
  htmlContent: string,
  keyword?: string,
  title?: string,
  metaDescription?: string,
  targetWordCount?: number
): Promise<SEOScoreResult> {
  const emptyBreakdown: SEOScoreBreakdown = {
    seordBase: 0,
    bonusTotal: 0,
    lineItems: {},
    finalCapped: 0
  };

  try {
    const $ = cheerio.load(htmlContent);

    const articleTitle = title || $('title').text() || $('h1').first().text() || 'Pet Insurance Guide';
    const articleMetaDesc = metaDescription || $('meta[name="description"]').attr('content') || '';
    const mainKeyword = keyword || articleTitle.split(' ').slice(0, 3).join(' ').toLowerCase();

    const subKeywords = articleTitle.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'your', 'that', 'this', 'from', 'have', 'will'].includes(w))
      .slice(0, 5);

    const contentJson = {
      title: articleTitle,
      htmlText: htmlContent,
      keyword: mainKeyword,
      subKeywords: subKeywords.length > 0 ? subKeywords : ['pet insurance', 'coverage', 'cost'],
      metaDescription: articleMetaDesc,
      languageCode: 'en',
      countryCode: 'us'
    };

    const seoCheck = new SeoCheck(contentJson, 'catsluvus.com');
    const result = await seoCheck.analyzeSeo();
    const baseScore = Math.round(result.seoScore || 50);

    let bonusPoints = 0;
    const lineItems: Record<string, number> = {};

    const add = (key: string, pts: number) => {
      if (pts <= 0) return;
      lineItems[key] = (lineItems[key] || 0) + pts;
      bonusPoints += pts;
    };

    const hasArticleSchema = htmlContent.includes('"@type":"Article"') || htmlContent.includes('"@type": "Article"');
    const hasFAQSchema = htmlContent.includes('"@type":"FAQPage"') || htmlContent.includes('"@type": "FAQPage"');
    const hasBreadcrumbSchema = htmlContent.includes('"@type":"BreadcrumbList"') || htmlContent.includes('"@type": "BreadcrumbList"');
    const hasOrgSchema = htmlContent.includes('"@type":"Organization"') || htmlContent.includes('"@type": "Organization"');
    if (hasArticleSchema) add('schema_Article', 3);
    if (hasFAQSchema) add('schema_FAQPage', 3);
    if (hasBreadcrumbSchema) add('schema_BreadcrumbList', 2);
    if (hasOrgSchema) add('schema_Organization', 2);

    const internalLinks = $('a[href*="catsluvus.com"], a[href^="/"]').length;
    if (internalLinks >= 5) add('internalLinks_tier1', 4);
    else if (internalLinks >= 3) add('internalLinks_tier1', 2);
    if (internalLinks >= 10) add('internalLinks_tier2_10plus', 4);

    const hasVideoEmbed = htmlContent.includes('youtube.com/embed');
    const hasVideoSchema = htmlContent.includes('VideoObject');
    const videoSchemaValid = validateVideoSchema(htmlContent);

    if (hasVideoEmbed && hasVideoSchema && videoSchemaValid.isValid) {
      add('video_embed_complete_schema', 8);
    } else if (hasVideoEmbed && hasVideoSchema) {
      add('video_embed_partial_schema', 5);
      if (videoSchemaValid.missingProps.length > 0) {
        console.warn(`   [Video Schema] Missing properties for Rich Results: ${videoSchemaValid.missingProps.join(', ')}`);
      }
    } else if (hasVideoEmbed) {
      add('video_embed_no_schema', 3);
    }

    const articleBody = $('article').first();
    const articleText = articleBody.length > 0
      ? articleBody.find('script, style, nav, header, footer').remove().end().text()
      : $('main').first().text() || $('body').text();
    const bodyWordCount = articleText.split(/\s+/).filter((w: string) => w.length > 1).length;
    const wcTarget = targetWordCount || 2500;
    const wcRatio = bodyWordCount / wcTarget;
    if (wcRatio >= 0.85 && wcRatio <= 1.15) add('wordCount_on_target', 5);
    else if (wcRatio >= 0.7 && wcRatio <= 1.3) add('wordCount_slightly_off', 3);
    else if (bodyWordCount >= 800) add('wordCount_minimum', 1);

    const h2Count = $('h2').length;
    const h3Count = $('h3').length;
    if (h2Count >= 5 && h3Count >= 3) add('headings_structure_strong', 5);
    else if (h2Count >= 3) add('headings_structure_ok', 3);

    const imagesWithAlt = $('img[alt]').filter((_, el) => ($(el).attr('alt') || '').trim().length > 0).length;
    if (imagesWithAlt >= 3) add('images_alt_rich', 4);
    else if (imagesWithAlt >= 1) add('images_alt_some', 2);

    if (articleMetaDesc.length >= 120 && articleMetaDesc.length <= 160) add('meta_length_optimal', 3);
    else if (articleMetaDesc.length >= 100 && articleMetaDesc.length <= 180) add('meta_length_ok', 1);

    if (articleTitle.length >= 40 && articleTitle.length <= 60) add('title_length_optimal', 3);
    else if (articleTitle.length >= 30 && articleTitle.length <= 70) add('title_length_ok', 1);

    const hasTables = $('table').length > 0;
    if (hasTables) add('comparison_tables', 3);

    const finalScore = Math.min(100, baseScore + bonusPoints);

    if (bonusPoints > 0) {
      console.log(`   [SEO Bonus] +${bonusPoints} points: ${Object.entries(lineItems).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    }

    const breakdown: SEOScoreBreakdown = {
      seordBase: baseScore,
      bonusTotal: bonusPoints,
      lineItems,
      finalCapped: finalScore
    };

    return {
      score: finalScore,
      details: {
        wordCount: bodyWordCount,
        keywordDensity: result.keywordDensity || 0,
        warnings: result.messages?.warnings?.length || 0,
        goodPoints: (result.messages?.goodPoints?.length || 0) + Math.floor(bonusPoints / 3)
      },
      breakdown
    };
  } catch (error) {
    console.error('[SEO Score] Analysis failed:', error);
    return {
      score: 0,
      details: { wordCount: 0, keywordDensity: 0, warnings: 0, goodPoints: 0 },
      breakdown: { ...emptyBreakdown, finalCapped: 0 }
    };
  }
}
