/**
 * Skill Types for SEO Generator V2
 * Defines interfaces for skill parsing, application, and validation
 */

export interface SkillRule {
  id: string;
  name: string;
  description: string;
  category: 'content' | 'meta' | 'schema' | 'links' | 'technical';
  priority: 'required' | 'recommended' | 'optional';
  validator?: (content: string) => ValidationResult;
}

export interface SkillSet {
  name: string;
  version: string;
  rules: SkillRule[];
  patterns: SkillPattern[];
  thresholds: SkillThresholds;
}

export interface SkillPattern {
  name: string;
  pattern: RegExp | string;
  replacement?: string;
  context: string;
}

export interface SkillThresholds {
  minWordCount: number;
  maxWordCount: number;
  keywordDensity: { min: number; max: number };
  titleLength: { min: number; max: number };
  metaDescriptionLength: { min: number; max: number };
  minFAQs: number;
  minSections: number;
  minInternalLinks: number;
  minExternalLinks: number;
}

export interface ValidationResult {
  passed: boolean;
  score: number;
  message: string;
  suggestions?: string[];
}

export interface AuditResult {
  overallScore: number;
  categories: {
    content: CategoryScore;
    technical: CategoryScore;
    schema: CategoryScore;
    links: CategoryScore;
  };
  issues: AuditIssue[];
  recommendations: string[];
}

export interface CategoryScore {
  score: number;
  passed: number;
  failed: number;
  warnings: number;
}

export interface AuditIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  rule: string;
  message: string;
  suggestion?: string;
}

export interface SkillProfile {
  name: string;
  description: string;
  skills: string[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  version: string;
  rules: SkillRule[];
  patterns: SkillPattern[];
  examples: string[];
  bestPractices: string[];
}
