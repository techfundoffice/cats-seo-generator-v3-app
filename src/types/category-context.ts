/**
 * Category Context Types for SEO Generator V2
 * Enables autonomous category discovery and dynamic content generation
 * All fields populated by Copilot SDK agent during research phase
 */

export interface KeywordData {
  keyword: string;
  slug: string;
  cpc: number;
  volume: number;
  difficulty: number;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  cluster?: string;
  isPillar?: boolean;
  parentKeyword?: string;
  // Additional fields for activity tracking
  status?: 'pending' | 'in-progress' | 'completed' | 'skipped' | 'published';
  priority?: string;
  score?: number;
  seoScore?: number;
  skillScore?: number;
  performanceScore?: number;
  keywordDensity?: number;
  wordCount?: number;
  estimatedTraffic?: number;
  recommendedAction?: string;
  deployAction?: 'deploy' | 'review' | 'skip' | 'optimize';
}

export interface AuthorProfile {
  name: string;
  title: string;
  credentials: string[];
  bio: string;
  image: string;
  expertise: string[];
  socialLinks?: {
    linkedin?: string;
    twitter?: string;
  };
}

export interface CredibleSource {
  name: string;
  url: string;
  authorityScore: number;
  type: 'government' | 'academic' | 'industry' | 'news' | 'research';
  description?: string;
}

export interface AffiliateEntity {
  name: string;
  type: 'product' | 'service' | 'brand' | 'platform';
  affiliateUrl: string;
  commissionRate: number;
  commissionType: 'percentage' | 'fixed';
  cookieDuration: number;
  avgOrderValue?: number;
  conversionRate?: number;
}

export interface CategoryMetadata {
  totalCPC: number;
  avgVolume: number;
  avgDifficulty: number;
  affiliateRate: number;
  revenuePotential: number;
  marketSize: string;
  growthTrend: 'rising' | 'stable' | 'declining';
  competitionLevel: 'low' | 'medium' | 'high';
}

export interface MenuLink {
  label: string;
  path: string;
  isExternal?: boolean;
}

export interface CategoryBranding {
  primaryColor: string;
  secondaryColor: string;
  logoUrl?: string;
  tagline: string;
  footerText: string;
  menuLinks: MenuLink[];
  siteName?: string;
}

export interface CategoryContext {
  domain: string;
  basePath: string;
  categorySlug: string;
  categoryName: string;
  categoryDescription: string;

  keywords: KeywordData[];
  authors: AuthorProfile[];
  credibleSources: CredibleSource[];
  entities: AffiliateEntity[];

  kvPrefix: string;
  sitemapPath: string;

  metadata: CategoryMetadata;
  branding: CategoryBranding;

  publishedKeywords: string[];

  createdAt: string;
  updatedAt: string;
  researchPhaseId: string;

  // Additional fields for activity logging
  niche?: string;
  vertical?: string;
}

export interface ResearchPhaseOutput {
  id: string;
  status: 'idle' | 'discovering' | 'analyzing' | 'prioritizing' | 'complete' | 'error';
  startedAt: string;
  completedAt?: string;

  nicheDiscovery: {
    vertical?: string;
    niche: string;
    reasoning: string;
    marketSize: string;
    competitorCount: number;
    topCompetitors?: string[];
    growthRate?: string;
  };

  keywordResearch: {
    totalKeywords: number;
    avgCPC: number;
    avgVolume: number;
    topKeywords: KeywordData[];
    clusters: {
      name: string;
      pillarKeyword: string;
      supportingKeywords: string[];
      totalVolume: number;
      totalCPC: number;
    }[];
  };

  competitorAnalysis: {
    gaps: string[];
    opportunities: string[];
    contentAngles?: string[];
    weaknesses?: string[];
    topCompetitors?: string[];
  };

  monetization: {
    affiliatePrograms: {
      name: string;
      network?: string;
      commissionRate: number;
      cookieDuration: number;
      estimatedEPC?: number;
    }[];
    adRevenueEstimate?: {
      rpm: number;
      monthlyTrafficGoal: number;
      monthlyRevenueEstimate: number;
    };
    adPotential?: string;
    revenueProjection: {
      month1?: number;
      month3?: number;
      month6: number;
      month12: number;
    };
  };

  targetStructure: {
    domain: string;
    basePath: string;
    slugFormat: string;
    sitemapPath: string;
    kvPrefix: string;
  };

  categoryContext?: CategoryContext;

  errors?: string[];
}

export interface KeywordRegistry {
  categorySlug: string;
  kvPrefix: string;
  publishedKeywords: Map<string, {
    slug: string;
    publishedAt: string;
    url: string;
    titleTag: string;
    h1: string;
    intent: string;
    cluster?: string;
  }>;
  pendingKeywords: KeywordData[];
  skippedKeywords: Map<string, string>;
}

export interface CannibalizationCheck {
  keyword: string;
  existingKeyword?: string;
  similarityScore: number;
  isCannibalized: boolean;
  recommendation: 'proceed' | 'merge' | 'skip' | 'redirect';
  reason?: string;
}

export function createEmptyCategoryContext(categorySlug: string, domain: string, basePath: string): CategoryContext {
  return {
    domain,
    basePath,
    categorySlug,
    categoryName: '',
    categoryDescription: '',
    keywords: [],
    authors: [],
    credibleSources: [],
    entities: [],
    kvPrefix: `${categorySlug}:`,
    sitemapPath: `${basePath}/sitemap.xml`,
    metadata: {
      totalCPC: 0,
      avgVolume: 0,
      avgDifficulty: 0,
      affiliateRate: 0,
      revenuePotential: 0,
      marketSize: '',
      growthTrend: 'stable',
      competitionLevel: 'medium',
    },
    branding: {
      primaryColor: '#2563eb',
      secondaryColor: '#1e40af',
      tagline: '',
      footerText: '',
      menuLinks: [],
    },
    publishedKeywords: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    researchPhaseId: '',
  };
}

export function createEmptyResearchPhaseOutput(): ResearchPhaseOutput {
  return {
    id: `research-${Date.now()}`,
    status: 'idle',
    startedAt: new Date().toISOString(),
    nicheDiscovery: {
      vertical: '',
      niche: '',
      reasoning: '',
      marketSize: '',
      competitorCount: 0,
      topCompetitors: [],
    },
    keywordResearch: {
      totalKeywords: 0,
      avgCPC: 0,
      avgVolume: 0,
      topKeywords: [],
      clusters: [],
    },
    competitorAnalysis: {
      gaps: [],
      opportunities: [],
      contentAngles: [],
      weaknesses: [],
    },
    monetization: {
      affiliatePrograms: [],
      adRevenueEstimate: {
        rpm: 0,
        monthlyTrafficGoal: 0,
        monthlyRevenueEstimate: 0,
      },
      revenueProjection: {
        month3: 0,
        month6: 0,
        month12: 0,
      },
    },
    targetStructure: {
      domain: '',
      basePath: '',
      slugFormat: '',
      sitemapPath: '',
      kvPrefix: '',
    },
  };
}
