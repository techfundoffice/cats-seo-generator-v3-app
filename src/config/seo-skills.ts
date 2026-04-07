/**
 * SEO Skills Configuration for SEO Generator V2
 * Defines skill profiles and their component skills
 */

import path from 'path';
import os from 'os';
import type { SkillProfile, SkillThresholds } from '../types/skills';

/**
 * Skill profiles for different use cases
 */
export const SEO_SKILL_PROFILES: Record<string, SkillProfile> = {
  quick: {
    name: 'Quick',
    description: 'Essential SEO optimization for fast article generation',
    skills: ['seo-content-writer', 'seo-meta-optimizer']
  },
  comprehensive: {
    name: 'Comprehensive',
    description: 'Full SEO + marketing psychology with AI detection avoidance',
    skills: [
      'seo-audit',
      'seo-content-writer',
      'seo-meta-optimizer',
      'seo-schema-generator',
      'seo-perfect-score',    // 95-100 SEO score optimization
      'marketing-psychology'  // Human-like writing & AI detection avoidance
    ]
  },
  advanced: {
    name: 'Advanced',
    description: 'Expert SEO + marketing with AI detection avoidance & conversion optimization',
    skills: [
      'seo-audit',
      'seo-content-writer',
      'seo-meta-optimizer',
      'seo-schema-generator',
      'seo-keyword-strategist',
      'seo-content-planner',
      'seo-structure-architect',
      'marketing-psychology',  // Human-like writing & AI detection avoidance
      'marketing-ideas'        // Conversion optimization
    ]
  },
  marketing: {
    name: 'Marketing',
    description: 'SEO + full marketing suite for conversion optimization',
    skills: [
      'seo-content-writer',
      'seo-meta-optimizer',
      'marketing-ideas',
      'marketing-psychology'
    ]
  },
  autonomous: {
    name: 'Autonomous Research',
    description: 'Agent-driven niche discovery, keyword research, and market analysis for autonomous category selection',
    skills: [
      'seo-keyword-strategist',
      'deep-research',
      'market-sizing-analysis',
      'apify-market-research',
      'apify-competitor-intelligence',
      'seo-cannibalization-detector',
      'seo-content-planner'
    ]
  }
};

/**
 * Default thresholds for SEO validation
 */
export const DEFAULT_THRESHOLDS: SkillThresholds = {
  minWordCount: 2500,
  maxWordCount: 10000,
  keywordDensity: { min: 1.0, max: 2.5 },
  titleLength: { min: 30, max: 55 },
  metaDescriptionLength: { min: 120, max: 155 },
  minFAQs: 6,
  minSections: 4,
  minInternalLinks: 3,
  minExternalLinks: 2
};

/**
 * Quality gate thresholds for deployment decisions
 */
export const QUALITY_GATES = {
  deploy: 80,      // >= 80: Auto-deploy enabled
  review: 60,      // 60-79: Manual review required
  optimize: 40,    // 40-59: Optimization suggested
  reject: 0        // < 40: Block deployment
};

/**
 * Available skills directory paths
 */
export const SKILL_PATHS = {
  base: process.env.SKILLS_BASE_PATH || path.join(os.homedir(), '.claude', 'skills'),
  seo: [
    'seo-audit',
    'seo-content-writer',
    'seo-meta-optimizer',
    'seo-schema-generator',
    'seo-keyword-strategist',
    'seo-authority-builder',
    'seo-cannibalization-detector',
    'seo-content-auditor',
    'seo-content-planner',
    'seo-content-refresher',
    'seo-snippet-hunter',
    'seo-structure-architect',
    'seo-fundamentals',
    'seo-perfect-score',
    'seo-pagespeed-analyzer',
    'seo-performance-optimizer'
  ],
  marketing: [
    'marketing-ideas',
    'marketing-psychology'
  ],
  research: [
    'deep-research',
    'market-sizing-analysis',
    'apify-market-research',
    'apify-competitor-intelligence'
  ],
  vercel: [
    'react-best-practices',
    'composition-patterns',
    'web-design-guidelines'
  ]
};

/**
 * Get skills for a profile
 */
export function getSkillsForProfile(profileName: string): string[] {
  const profile = SEO_SKILL_PROFILES[profileName];
  return profile ? profile.skills : SEO_SKILL_PROFILES.comprehensive.skills;
}

/**
 * Get all available skills
 */
export function getAllAvailableSkills(): string[] {
  return [
    ...SKILL_PATHS.seo,
    ...SKILL_PATHS.marketing,
    ...SKILL_PATHS.research,
    ...SKILL_PATHS.vercel
  ];
}

/**
 * Get deployment recommendation based on score
 */
export function getDeploymentRecommendation(score: number): {
  action: 'deploy' | 'review' | 'optimize' | 'reject';
  message: string;
} {
  if (score >= QUALITY_GATES.deploy) {
    return { action: 'deploy', message: 'Article meets quality standards. Auto-deploy enabled.' };
  } else if (score >= QUALITY_GATES.review) {
    return { action: 'review', message: 'Article needs manual review before deployment.' };
  } else if (score >= QUALITY_GATES.optimize) {
    return { action: 'optimize', message: 'Article needs optimization. Review suggested improvements.' };
  } else {
    return { action: 'reject', message: 'Article does not meet minimum quality standards.' };
  }
}
