/**
 * Skill Engine Service for SEO Generator V2
 * Applies skills to content generation, validation, and auditing
 */

import type {
  ParsedSkill,
  SkillRule,
  SkillSet,
  ValidationResult,
  AuditResult,
  AuditIssue,
  CategoryScore,
  SkillThresholds
} from '../types/skills';
import { loadSkills, getCombinedRules, getCombinedBestPractices } from './skill-parser';
import { DEFAULT_THRESHOLDS, getSkillsForProfile, QUALITY_GATES } from '../config/seo-skills';

/**
 * Skill Engine class for applying SEO skills
 */
export class SkillEngine {
  private skills: Map<string, ParsedSkill>;
  private thresholds: SkillThresholds;

  constructor(skillNames: string[], thresholds?: Partial<SkillThresholds>) {
    this.skills = loadSkills(skillNames);
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Create engine from profile name
   */
  static fromProfile(profileName: string, thresholds?: Partial<SkillThresholds>): SkillEngine {
    const skillNames = getSkillsForProfile(profileName);
    return new SkillEngine(skillNames, thresholds);
  }

  /**
   * Get all loaded skills
   */
  getLoadedSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Get combined best practices for prompt enhancement
   */
  getBestPracticesForPrompt(): string {
    const practices = getCombinedBestPractices(this.skills);

    if (practices.length === 0) {
      return '';
    }

    return `\n\nSEO SKILL BEST PRACTICES (Apply these principles):\n${practices.slice(0, 15).map((p, i) => `${i + 1}. ${p}`).join('\n')}\n`;
  }

  /**
   * Validate content against skill rules
   */
  validateContent(html: string, keyword: string): ValidationResult {
    const issues: string[] = [];
    let totalScore = 100;

    // Word count check
    const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;

    if (wordCount < this.thresholds.minWordCount) {
      issues.push(`Word count (${wordCount}) is below minimum (${this.thresholds.minWordCount})`);
      totalScore -= 15;
    }

    // Keyword density check
    const keywordCount = (textContent.toLowerCase().match(new RegExp(keyword.toLowerCase(), 'g')) || []).length;
    const density = (keywordCount / wordCount) * 100;

    if (density < this.thresholds.keywordDensity.min) {
      issues.push(`Keyword density (${density.toFixed(2)}%) is below minimum (${this.thresholds.keywordDensity.min}%)`);
      totalScore -= 10;
    } else if (density > this.thresholds.keywordDensity.max) {
      issues.push(`Keyword density (${density.toFixed(2)}%) exceeds maximum (${this.thresholds.keywordDensity.max}%)`);
      totalScore -= 10;
    }

    // Title length check
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const titleLength = titleMatch[1].length;
      if (titleLength < this.thresholds.titleLength.min || titleLength > this.thresholds.titleLength.max) {
        issues.push(`Title length (${titleLength}) should be ${this.thresholds.titleLength.min}-${this.thresholds.titleLength.max} characters`);
        totalScore -= 10;
      }
    }

    // Meta description check
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (metaMatch) {
      const metaLength = metaMatch[1].length;
      if (metaLength < this.thresholds.metaDescriptionLength.min || metaLength > this.thresholds.metaDescriptionLength.max) {
        issues.push(`Meta description length (${metaLength}) should be ${this.thresholds.metaDescriptionLength.min}-${this.thresholds.metaDescriptionLength.max} characters`);
        totalScore -= 10;
      }
    }

    // FAQ count check
    const faqCount = (html.match(/<div[^>]+class="[^"]*faq[^"]*"/gi) || []).length ||
                     (html.match(/<details/gi) || []).length ||
                     (html.match(/"@type"\s*:\s*"FAQPage"/gi) || []).length;
    if (faqCount < this.thresholds.minFAQs) {
      issues.push(`FAQ count (${faqCount}) is below minimum (${this.thresholds.minFAQs})`);
      totalScore -= 5;
    }

    // Internal links check
    const internalLinks = (html.match(/href=["']\/[^"']+["']/gi) || []).length;
    if (internalLinks < this.thresholds.minInternalLinks) {
      issues.push(`Internal links (${internalLinks}) is below minimum (${this.thresholds.minInternalLinks})`);
      totalScore -= 5;
    }

    // External links check
    const externalLinks = (html.match(/href=["']https?:\/\/(?!catsluvus\.com)[^"']+["']/gi) || []).length;
    if (externalLinks < this.thresholds.minExternalLinks) {
      issues.push(`External authority links (${externalLinks}) is below minimum (${this.thresholds.minExternalLinks})`);
      totalScore -= 5;
    }

    // Schema.org check
    const hasSchema = html.includes('application/ld+json');
    if (!hasSchema) {
      issues.push('Missing Schema.org structured data');
      totalScore -= 10;
    }

    return {
      passed: totalScore >= QUALITY_GATES.review,
      score: Math.max(0, totalScore),
      message: issues.length === 0 ? 'All validations passed' : `Found ${issues.length} issues`,
      suggestions: issues
    };
  }

  /**
   * Comprehensive audit of article content
   */
  auditContent(html: string, keyword: string): AuditResult {
    const issues: AuditIssue[] = [];
    const validation = this.validateContent(html, keyword);

    // Initialize category scores
    const categories = {
      content: { score: 100, passed: 0, failed: 0, warnings: 0 },
      technical: { score: 100, passed: 0, failed: 0, warnings: 0 },
      schema: { score: 100, passed: 0, failed: 0, warnings: 0 },
      links: { score: 100, passed: 0, failed: 0, warnings: 0 }
    };

    // Parse HTML for analysis
    const textContent = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = textContent.split(/\s+/).length;

    // Content checks
    this.checkContent(html, textContent, wordCount, keyword, categories.content, issues);

    // Technical checks
    this.checkTechnical(html, categories.technical, issues);

    // Schema checks
    this.checkSchema(html, categories.schema, issues);

    // Links checks
    this.checkLinks(html, categories.links, issues);

    // Calculate overall score
    const overallScore = Math.round(
      (categories.content.score * 0.4) +
      (categories.technical.score * 0.2) +
      (categories.schema.score * 0.2) +
      (categories.links.score * 0.2)
    );

    return {
      overallScore,
      categories,
      issues,
      recommendations: validation.suggestions || []
    };
  }

  private checkContent(
    html: string,
    textContent: string,
    wordCount: number,
    keyword: string,
    category: CategoryScore,
    issues: AuditIssue[]
  ): void {
    // Word count
    if (wordCount >= this.thresholds.minWordCount) {
      category.passed++;
    } else {
      category.failed++;
      category.score -= 20;
      issues.push({
        severity: 'error',
        category: 'content',
        rule: 'word-count',
        message: `Word count (${wordCount}) is below minimum (${this.thresholds.minWordCount})`,
        suggestion: `Add more comprehensive content to reach at least ${this.thresholds.minWordCount} words`
      });
    }

    // Keyword usage
    const keywordCount = (textContent.toLowerCase().match(new RegExp(keyword.toLowerCase(), 'g')) || []).length;
    if (keywordCount >= 8) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 10;
      issues.push({
        severity: 'warning',
        category: 'content',
        rule: 'keyword-usage',
        message: `Keyword "${keyword}" used ${keywordCount} times (target: 8-12)`,
        suggestion: 'Use the target keyword more naturally throughout the content'
      });
    }

    // H2 headings
    const h2Count = (html.match(/<h2/gi) || []).length;
    if (h2Count >= 4) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 5;
      issues.push({
        severity: 'warning',
        category: 'content',
        rule: 'heading-structure',
        message: `Only ${h2Count} H2 headings found (target: 4+)`,
        suggestion: 'Add more section headings to improve content structure'
      });
    }
  }

  private checkTechnical(html: string, category: CategoryScore, issues: AuditIssue[]): void {
    // Title tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1].length >= 30 && titleMatch[1].length <= 60) {
      category.passed++;
    } else {
      category.failed++;
      category.score -= 15;
      issues.push({
        severity: 'error',
        category: 'technical',
        rule: 'title-length',
        message: titleMatch ? `Title is ${titleMatch[1].length} chars (should be 30-60)` : 'Missing title tag',
        suggestion: 'Optimize title length for search results display'
      });
    }

    // Meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (metaMatch && metaMatch[1].length >= 120 && metaMatch[1].length <= 160) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 10;
      issues.push({
        severity: 'warning',
        category: 'technical',
        rule: 'meta-description',
        message: metaMatch ? `Meta description is ${metaMatch[1].length} chars (target: 120-160)` : 'Missing meta description',
        suggestion: 'Craft a compelling meta description within character limits'
      });
    }

    // Image alt tags
    const images = html.match(/<img[^>]+>/gi) || [];
    const imagesWithAlt = images.filter(img => /alt=["'][^"']+["']/.test(img));
    if (images.length === 0 || imagesWithAlt.length === images.length) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 5;
      issues.push({
        severity: 'warning',
        category: 'technical',
        rule: 'image-alt',
        message: `${images.length - imagesWithAlt.length} images missing alt text`,
        suggestion: 'Add descriptive alt text to all images for accessibility and SEO'
      });
    }
  }

  private checkSchema(html: string, category: CategoryScore, issues: AuditIssue[]): void {
    const schemaScripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];

    if (schemaScripts.length > 0) {
      category.passed++;

      // Check for specific schema types
      const hasArticle = schemaScripts.some(s => /"@type"\s*:\s*"Article"/i.test(s));
      const hasFAQ = schemaScripts.some(s => /"@type"\s*:\s*"FAQPage"/i.test(s));
      const hasBreadcrumb = schemaScripts.some(s => /"@type"\s*:\s*"BreadcrumbList"/i.test(s));

      if (hasArticle) category.passed++;
      else {
        category.warnings++;
        category.score -= 5;
        issues.push({
          severity: 'warning',
          category: 'schema',
          rule: 'article-schema',
          message: 'Missing Article schema markup',
          suggestion: 'Add Article schema for better search result display'
        });
      }

      if (hasFAQ) category.passed++;
      else {
        category.warnings++;
        category.score -= 5;
        issues.push({
          severity: 'info',
          category: 'schema',
          rule: 'faq-schema',
          message: 'No FAQ schema detected',
          suggestion: 'Add FAQPage schema to qualify for FAQ rich results'
        });
      }
    } else {
      category.failed++;
      category.score -= 25;
      issues.push({
        severity: 'error',
        category: 'schema',
        rule: 'structured-data',
        message: 'No Schema.org structured data found',
        suggestion: 'Add JSON-LD structured data for Article, FAQPage, and BreadcrumbList'
      });
    }
  }

  private checkLinks(html: string, category: CategoryScore, issues: AuditIssue[]): void {
    // Internal links
    const internalLinks = (html.match(/href=["']\/[^"']+["']/gi) || []).length;
    if (internalLinks >= this.thresholds.minInternalLinks) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 15;
      issues.push({
        severity: 'warning',
        category: 'links',
        rule: 'internal-links',
        message: `Only ${internalLinks} internal links (target: ${this.thresholds.minInternalLinks}+)`,
        suggestion: 'Add more internal links to related articles for better site navigation'
      });
    }

    // External authority links
    const externalLinks = (html.match(/href=["']https?:\/\/(?!catsluvus\.com)[^"']+["']/gi) || []).length;
    if (externalLinks >= this.thresholds.minExternalLinks) {
      category.passed++;
    } else {
      category.warnings++;
      category.score -= 10;
      issues.push({
        severity: 'warning',
        category: 'links',
        rule: 'external-links',
        message: `Only ${externalLinks} external links (target: ${this.thresholds.minExternalLinks}+)`,
        suggestion: 'Add links to authoritative external sources to build trust'
      });
    }

    // Check for broken link patterns (relative without leading slash)
    const suspiciousLinks = (html.match(/href=["'][^/"'][^"']+\.html["']/gi) || []).length;
    if (suspiciousLinks > 0) {
      category.warnings++;
      category.score -= 5;
      issues.push({
        severity: 'warning',
        category: 'links',
        rule: 'link-format',
        message: `${suspiciousLinks} potentially malformed relative links detected`,
        suggestion: 'Ensure all internal links start with / or are absolute URLs'
      });
    }
  }

  /**
   * Enhance a generation prompt with skill-based rules
   */
  enhancePrompt(basePrompt: string): string {
    const bestPractices = this.getBestPracticesForPrompt();
    const rules = getCombinedRules(this.skills);

    let enhancement = bestPractices;

    // Add required rules
    const requiredRules = rules.filter(r => r.priority === 'required');
    if (requiredRules.length > 0) {
      enhancement += `\n\nREQUIRED RULES (Must follow):\n${requiredRules.slice(0, 10).map(r => `- ${r.description}`).join('\n')}\n`;
    }

    return basePrompt + enhancement;
  }
}

/**
 * Create a skill engine with default comprehensive profile
 */
export function createSkillEngine(profile: string = 'comprehensive'): SkillEngine {
  return SkillEngine.fromProfile(profile);
}

/**
 * Quick validation helper
 */
export function quickValidate(html: string, keyword: string): ValidationResult {
  const engine = createSkillEngine('quick');
  return engine.validateContent(html, keyword);
}

/**
 * Full audit helper
 */
export function fullAudit(html: string, keyword: string): AuditResult {
  const engine = createSkillEngine('comprehensive');
  return engine.auditContent(html, keyword);
}
