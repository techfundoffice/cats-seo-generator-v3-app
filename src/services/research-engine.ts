/**
 * Research Engine Service for SEO Generator V2
 * Extends SkillEngine for autonomous niche discovery and keyword research
 * Agent makes ALL strategic decisions - infrastructure only provides framework
 */

import { SkillEngine } from './skill-engine';
import type { SkillThresholds } from '../types/skills';
import type {
  CategoryContext,
  ResearchPhaseOutput,
  KeywordData,
  AuthorProfile,
  CredibleSource,
  AffiliateEntity
} from '../types/category-context';
import { getSkillsForProfile } from '../config/seo-skills';

export type ResearchPhaseStatus = 'idle' | 'discovering' | 'analyzing' | 'prioritizing' | 'complete' | 'error';

export interface NicheDiscoveryInput {
  vertical?: string;
  excludeCategories?: string[];
  minCPC?: number;
  minVolume?: number;
  maxCompetition?: number;
}

export interface ResearchProgress {
  status: ResearchPhaseStatus;
  currentStep: string;
  progress: number;
  startedAt: string;
  lastUpdate: string;
  errors: string[];
}

/**
 * Research Engine for autonomous category discovery
 * Uses Copilot SDK agent to make ALL strategic decisions
 */
export class ResearchEngine extends SkillEngine {
  private researchOutput: ResearchPhaseOutput | null = null;
  private progress: ResearchProgress;

  constructor(thresholds?: Partial<SkillThresholds>) {
    const skillNames = getSkillsForProfile('autonomous');
    super(skillNames, thresholds);

    this.progress = {
      status: 'idle',
      currentStep: '',
      progress: 0,
      startedAt: '',
      lastUpdate: new Date().toISOString(),
      errors: []
    };
  }

  static createForResearch(thresholds?: Partial<SkillThresholds>): ResearchEngine {
    return new ResearchEngine(thresholds);
  }

  getProgress(): ResearchProgress {
    return { ...this.progress };
  }

  getResearchOutput(): ResearchPhaseOutput | null {
    return this.researchOutput;
  }

  private updateProgress(status: ResearchPhaseStatus, step: string, progress: number): void {
    this.progress = {
      ...this.progress,
      status,
      currentStep: step,
      progress,
      lastUpdate: new Date().toISOString()
    };
  }

  private addError(error: string): void {
    this.progress.errors.push(error);
    this.progress.lastUpdate = new Date().toISOString();
  }

  /**
   * Generate prompt for Copilot SDK to discover high-value niches
   * Agent decides which niche to target based on CPC, volume, and affiliate potential
   */
  getDiscoverNichesPrompt(input: NicheDiscoveryInput = {}): string {
    const bestPractices = this.getBestPracticesForPrompt();

    return `You are an autonomous SEO research agent. Your task is to discover profitable content niches.

OBJECTIVE: Find a high-revenue content niche in the cat/pet vertical that is NOT already being targeted.

EXCLUSIONS (DO NOT suggest these):
- Pet insurance (already running on catsluvus.com/petinsurance)
${input.excludeCategories?.map(c => `- ${c}`).join('\n') || ''}

CRITERIA FOR NICHE SELECTION:
1. High CPC keywords (target: $${input.minCPC || 2}+ average CPC)
2. Meaningful search volume (target: ${input.minVolume || 500}+ monthly searches per keyword)
3. Competition level: ${input.maxCompetition ? `max ${input.maxCompetition}` : 'low to medium preferred'}
4. Affiliate potential (products/services to recommend)
5. Topical authority opportunity (can become THE resource)

${input.vertical ? `FOCUS VERTICAL: ${input.vertical}` : 'VERTICAL: Cat/pet related topics'}

YOUR TASK:
1. Analyze market opportunities in the pet/cat vertical
2. Identify 3-5 potential niches with revenue reasoning
3. Select the BEST niche based on (CPC × volume × affiliate rate)
4. Provide detailed reasoning for your choice

OUTPUT FORMAT (JSON):
{
  "discoveredNiches": [
    {
      "name": "niche name",
      "description": "brief description",
      "estimatedCPC": 2.50,
      "estimatedVolume": 5000,
      "competitionLevel": "low|medium|high",
      "affiliateOpportunities": ["affiliate program 1", "affiliate program 2"],
      "reasoning": "why this niche is profitable"
    }
  ],
  "selectedNiche": {
    "name": "chosen niche",
    "reasoning": "detailed reasoning for selection",
    "marketSize": "$X million",
    "topCompetitors": ["competitor1.com", "competitor2.com"],
    "contentGaps": ["gap 1", "gap 2"],
    "revenueProjection": {
      "monthlyTrafficGoal": 10000,
      "estimatedRPM": 25,
      "affiliateConversionRate": 0.02,
      "month6Revenue": 1500,
      "month12Revenue": 5000
    }
  }
}

${bestPractices}

Return ONLY valid JSON. The agent (you) makes the decision - infrastructure will execute it.`;
  }

  /**
   * Generate prompt for deep niche analysis
   * Agent analyzes the selected niche for keyword opportunities
   */
  getAnalyzeNichePrompt(niche: string, competitors: string[] = []): string {
    const bestPractices = this.getBestPracticesForPrompt();

    return `You are an autonomous SEO research agent. Your task is to deeply analyze the "${niche}" niche.

SELECTED NICHE: ${niche}

KNOWN COMPETITORS:
${competitors.length > 0 ? competitors.map(c => `- ${c}`).join('\n') : '- None identified yet (discover them)'}

YOUR TASK:
1. Identify keyword opportunities (50-100 keywords)
2. Cluster keywords by topic/intent
3. Find content gaps competitors are missing
4. Identify affiliate monetization angles
5. Recommend expert author profiles for E-E-A-T

OUTPUT FORMAT (JSON):
{
  "nicheAnalysis": {
    "totalAddressableMarket": "$X million",
    "searchVolumeTotal": 50000,
    "averageCPC": 2.50,
    "difficultyRange": "20-45",
    "seasonality": "year-round|seasonal",
    "growthTrend": "rising|stable|declining"
  },
  "keywordClusters": [
    {
      "clusterName": "Topic Cluster Name",
      "pillarKeyword": "main keyword",
      "supportingKeywords": ["keyword 1", "keyword 2"],
      "totalVolume": 5000,
      "avgCPC": 2.80,
      "contentAngle": "how to approach this cluster"
    }
  ],
  "competitorAnalysis": {
    "gaps": ["content gap 1", "content gap 2"],
    "opportunities": ["opportunity 1", "opportunity 2"],
    "weaknesses": ["competitor weakness 1", "competitor weakness 2"]
  },
  "affiliatePrograms": [
    {
      "name": "Program Name",
      "network": "ShareASale|CJ|Direct",
      "commissionRate": 15,
      "cookieDuration": 30,
      "estimatedEPC": 0.50,
      "productCategory": "what they sell"
    }
  ],
  "recommendedAuthors": [
    {
      "profileType": "veterinarian|certified specialist|industry expert",
      "credentials": ["DVM", "ACVIM"],
      "expertise": ["topic 1", "topic 2"],
      "trustSignals": "why readers will trust this author"
    }
  ]
}

${bestPractices}

Return ONLY valid JSON. Be specific with real data where possible.`;
  }

  /**
   * Generate prompt for keyword extraction with full metadata
   * Agent provides keywords with CPC, volume, difficulty, and intent
   */
  getExtractKeywordsPrompt(niche: string, clusters: any[]): string {
    const bestPractices = this.getBestPracticesForPrompt();

    return `You are an autonomous SEO research agent. Extract the full keyword list for "${niche}".

NICHE: ${niche}

IDENTIFIED CLUSTERS:
${clusters.map((c, i) => `${i + 1}. ${c.clusterName}: ${c.pillarKeyword}`).join('\n')}

YOUR TASK:
Generate 50-100 keywords with complete metadata for content generation.

KEYWORD REQUIREMENTS:
1. Include pillar keywords (main topics) and supporting keywords
2. Balance informational, commercial, and transactional intent
3. Include long-tail variations for featured snippet opportunities
4. Avoid keyword cannibalization (each keyword = unique intent)

OUTPUT FORMAT (JSON):
{
  "keywords": [
    {
      "keyword": "exact keyword phrase",
      "slug": "keyword-phrase-slug",
      "cpc": 2.50,
      "volume": 1200,
      "difficulty": 35,
      "intent": "informational|commercial|transactional|navigational",
      "cluster": "cluster name",
      "isPillar": true,
      "parentKeyword": null,
      "featuredSnippetOpportunity": true,
      "suggestedH1": "Suggested H1 for this article",
      "targetWordCount": 2500
    }
  ],
  "summary": {
    "totalKeywords": 75,
    "totalMonthlyVolume": 45000,
    "averageCPC": 2.80,
    "averageDifficulty": 32,
    "pillarCount": 8,
    "clusterCount": 8
  }
}

CRITICAL RULES:
- No duplicate keywords
- No overlapping intents (e.g., "best X" and "top X" = same intent, pick one)
- Each keyword must have potential for a standalone article
- Prioritize keywords with featured snippet opportunities

${bestPractices}

Return ONLY valid JSON.`;
  }

  /**
   * Generate prompt for revenue prioritization
   * Agent ranks keywords by (CPC × volume × affiliate potential)
   */
  getPrioritizeByRevenuePrompt(keywords: KeywordData[], affiliatePrograms: any[]): string {
    return `You are an autonomous SEO research agent. Prioritize keywords by revenue potential.

AVAILABLE KEYWORDS: ${keywords.length} total

TOP 20 KEYWORDS BY RAW VOLUME:
${keywords
  .sort((a, b) => b.volume - a.volume)
  .slice(0, 20)
  .map((k, i) => `${i + 1}. ${k.keyword} (vol: ${k.volume}, cpc: $${k.cpc})`)
  .join('\n')}

AFFILIATE PROGRAMS AVAILABLE:
${affiliatePrograms.map(p => `- ${p.name}: ${p.commissionRate}% commission, ${p.cookieDuration} day cookie`).join('\n')}

YOUR TASK:
Rank ALL keywords by revenue potential using this formula:
RevenuePotential = (CPC × 0.4) + (Volume × 0.001 × 0.3) + (AffiliateScore × 0.3)

Where AffiliateScore (0-10) = how well the keyword aligns with affiliate products

OUTPUT FORMAT (JSON):
{
  "prioritizedKeywords": [
    {
      "keyword": "keyword",
      "revenuePotential": 8.5,
      "breakdown": {
        "cpcScore": 3.2,
        "volumeScore": 2.8,
        "affiliateScore": 2.5
      },
      "recommendedOrder": 1,
      "reasoning": "why this keyword ranks here"
    }
  ],
  "publishingStrategy": {
    "phase1": {
      "keywords": ["top 10 keywords"],
      "goal": "establish topical authority",
      "timeline": "weeks 1-4"
    },
    "phase2": {
      "keywords": ["keywords 11-30"],
      "goal": "expand coverage",
      "timeline": "weeks 5-12"
    },
    "phase3": {
      "keywords": ["remaining keywords"],
      "goal": "long-tail domination",
      "timeline": "weeks 13-24"
    }
  }
}

Return ONLY valid JSON.`;
  }

  /**
   * Generate the final CategoryContext from research output
   * Transforms agent research into infrastructure-ready config
   */
  outputCategoryContext(
    researchOutput: ResearchPhaseOutput,
    domain: string = 'catsluvus.com'
  ): CategoryContext {
    const { nicheDiscovery, keywordResearch, monetization, targetStructure } = researchOutput;
    const extendedOutput = researchOutput as any;

    const authors: AuthorProfile[] = (extendedOutput.recommendedAuthors || []).map((a: any) => ({
      name: a.name || `${a.profileType} Expert`,
      title: a.profileType || 'Expert',
      credentials: a.credentials || [],
      bio: a.trustSignals || '',
      image: '',
      expertise: a.expertise || [],
      socialLinks: {}
    }));

    const growthTrend = extendedOutput.growthTrend || 'stable';
    const competitionLevel = extendedOutput.competitionLevel || 'medium';

    const context: CategoryContext = {
      domain: targetStructure.domain || domain,
      basePath: targetStructure.basePath || `/${nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-')}`,
      categorySlug: nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-'),
      categoryName: nicheDiscovery.niche,
      categoryDescription: nicheDiscovery.reasoning,

      keywords: keywordResearch.topKeywords,
      authors: authors,
      credibleSources: [],
      entities: monetization.affiliatePrograms.map(p => ({
        name: p.name,
        type: 'service' as const,
        affiliateUrl: '',
        commissionRate: p.commissionRate,
        commissionType: 'percentage' as const,
        cookieDuration: p.cookieDuration
      })),

      kvPrefix: targetStructure.kvPrefix || `${nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-')}:`,
      sitemapPath: targetStructure.sitemapPath || `/${nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-')}/sitemap.xml`,

      metadata: {
        totalCPC: keywordResearch.avgCPC * keywordResearch.totalKeywords,
        avgVolume: keywordResearch.avgVolume,
        avgDifficulty: 0,
        affiliateRate: monetization.affiliatePrograms.reduce((sum, p) => sum + p.commissionRate, 0) / Math.max(monetization.affiliatePrograms.length, 1),
        revenuePotential: monetization.revenueProjection.month12,
        marketSize: nicheDiscovery.marketSize,
        growthTrend: growthTrend as 'rising' | 'stable' | 'declining',
        competitionLevel: competitionLevel as 'low' | 'medium' | 'high'
      },

      branding: {
        primaryColor: '#2563eb',
        secondaryColor: '#1e40af',
        tagline: `Expert ${nicheDiscovery.niche} Resources`,
        footerText: `© ${new Date().getFullYear()} ${domain} - Your Trusted ${nicheDiscovery.niche} Resource`,
        menuLinks: []
      },

      publishedKeywords: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      researchPhaseId: researchOutput.id
    };

    return context;
  }

  /**
   * Parse agent JSON response into structured data
   * Handles common parsing issues from LLM output
   */
  parseAgentResponse<T>(response: string): T | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.addError('No JSON object found in agent response');
        return null;
      }

      const cleaned = jsonMatch[0]
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/[\x00-\x1F\x7F]/g, '');

      return JSON.parse(cleaned) as T;
    } catch (error) {
      this.addError(`Failed to parse agent response: ${error}`);
      return null;
    }
  }

  /**
   * Alias for getDiscoverNichesPrompt (V2 compatibility)
   */
  getNicheDiscoveryPrompt(options: NicheDiscoveryInput = {}): string {
    return this.getDiscoverNichesPrompt(options);
  }

  /**
   * Alias for getAnalyzeNichePrompt (V2 compatibility)
   */
  getNicheAnalysisPrompt(niche: string, keywordSeeds: string[] = []): string {
    return this.getAnalyzeNichePrompt(niche, keywordSeeds);
  }

  /**
   * Validate keyword uniqueness to prevent cannibalization
   * Returns keywords that don't overlap with existing published content
   */
  validateKeywordUniqueness(
    newKeywords: KeywordData[],
    publishedKeywords: string[]
  ): { valid: KeywordData[]; duplicates: string[] } {
    const publishedSet = new Set(publishedKeywords.map(k => k.toLowerCase()));
    const valid: KeywordData[] = [];
    const duplicates: string[] = [];

    for (const keyword of newKeywords) {
      const normalized = keyword.keyword.toLowerCase();

      if (publishedSet.has(normalized)) {
        duplicates.push(keyword.keyword);
        continue;
      }

      const isSimilar = publishedKeywords.some(published => {
        const pubWords = new Set(published.toLowerCase().split(/\s+/));
        const newWords = normalized.split(/\s+/);
        const overlap = newWords.filter(w => pubWords.has(w)).length;
        return overlap / newWords.length > 0.7;
      });

      if (isSimilar) {
        duplicates.push(keyword.keyword);
      } else {
        valid.push(keyword);
        publishedSet.add(normalized);
      }
    }

    return { valid, duplicates };
  }

  /**
   * Get cannibalization check prompt for agent
   */
  getCannibalizationCheckPrompt(keyword: string, existingKeywords: string[]): string {
    return `Check if "${keyword}" would cannibalize any existing content.

EXISTING KEYWORDS:
${existingKeywords.slice(0, 50).map((k, i) => `${i + 1}. ${k}`).join('\n')}

RULES:
- Same search intent = cannibalization (e.g., "best cat food" vs "top cat food")
- Similar topic but different angle = OK (e.g., "best cat food" vs "cheapest cat food")
- Long-tail of existing = OK if provides NEW value

OUTPUT FORMAT (JSON):
{
  "keyword": "${keyword}",
  "isCannibalized": true|false,
  "similarTo": "existing keyword if cannibalized",
  "recommendation": "proceed|merge|skip|redirect",
  "reason": "explanation"
}

Return ONLY valid JSON.`;
  }
}

export function createResearchEngine(): ResearchEngine {
  return ResearchEngine.createForResearch();
}
