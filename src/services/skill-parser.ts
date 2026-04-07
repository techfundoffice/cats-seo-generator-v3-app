/**
 * Skill Parser Service for SEO Generator V2
 * Parses skill markdown files and extracts rules, patterns, and best practices
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParsedSkill, SkillRule, SkillPattern } from '../types/skills';
import { SKILL_PATHS } from '../config/seo-skills';

/**
 * Parse a skill markdown file and extract structured data
 */
export function parseSkillFile(skillName: string): ParsedSkill | null {
  const skillDir = path.join(SKILL_PATHS.base, skillName);

  // Try multiple case variations for skill.md
  const possibleNames = ['skill.md', 'SKILL.md', 'Skill.md'];
  let skillPath: string | null = null;

  for (const fileName of possibleNames) {
    const testPath = path.join(skillDir, fileName);
    if (fs.existsSync(testPath)) {
      skillPath = testPath;
      break;
    }
  }

  if (!skillPath) {
    console.log(`[Skill Parser] Skill file not found in: ${skillDir}`);
    return null;
  }

  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    return parseSkillContent(skillName, content);
  } catch (error: any) {
    console.error(`[Skill Parser] Error reading skill file: ${error.message}`);
    return null;
  }
}

/**
 * Parse skill content and extract structured data
 */
function parseSkillContent(skillName: string, content: string): ParsedSkill {
  const skill: ParsedSkill = {
    name: skillName,
    description: '',
    version: '1.0.0',
    rules: [],
    patterns: [],
    examples: [],
    bestPractices: []
  };

  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    const descMatch = frontmatter.match(/description:\s*(.+)/);
    const versionMatch = frontmatter.match(/version:\s*(.+)/);
    if (descMatch) skill.description = descMatch[1].trim();
    if (versionMatch) skill.version = versionMatch[1].trim();
  }

  // Extract sections
  const sections = content.split(/^##\s+/m);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const heading = lines[0]?.toLowerCase() || '';
    const sectionContent = lines.slice(1).join('\n');

    if (heading.includes('rule') || heading.includes('requirement')) {
      skill.rules.push(...extractRules(sectionContent, skillName));
    } else if (heading.includes('pattern') || heading.includes('template')) {
      skill.patterns.push(...extractPatterns(sectionContent));
    } else if (heading.includes('example')) {
      skill.examples.push(...extractExamples(sectionContent));
    } else if (heading.includes('best practice') || heading.includes('tip')) {
      skill.bestPractices.push(...extractBestPractices(sectionContent));
    }
  }

  // Also extract bullet points as best practices
  const bulletPoints = content.match(/^[-*]\s+(.+)$/gm);
  if (bulletPoints) {
    for (const point of bulletPoints) {
      const text = point.replace(/^[-*]\s+/, '').trim();
      if (text.length > 20 && text.length < 200) {
        skill.bestPractices.push(text);
      }
    }
  }

  return skill;
}

/**
 * Extract rules from section content
 */
function extractRules(content: string, skillName: string): SkillRule[] {
  const rules: SkillRule[] = [];
  const lines = content.split('\n');

  let ruleIndex = 0;
  for (const line of lines) {
    const cleanLine = line.replace(/^[-*\d.]+\s*/, '').trim();
    if (cleanLine.length > 10) {
      const category = inferCategory(cleanLine);
      const priority = inferPriority(cleanLine);

      rules.push({
        id: `${skillName}-rule-${++ruleIndex}`,
        name: cleanLine.substring(0, 50),
        description: cleanLine,
        category,
        priority
      });
    }
  }

  return rules;
}

/**
 * Extract patterns from section content
 */
function extractPatterns(content: string): SkillPattern[] {
  const patterns: SkillPattern[] = [];

  // Look for code blocks with patterns
  const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
  for (const block of codeBlocks) {
    const code = block.replace(/```\w*\n?|\n?```/g, '').trim();
    if (code.length > 5) {
      patterns.push({
        name: `pattern-${patterns.length + 1}`,
        pattern: code,
        context: 'template'
      });
    }
  }

  return patterns;
}

/**
 * Extract examples from section content
 */
function extractExamples(content: string): string[] {
  const examples: string[] = [];

  // Look for code blocks
  const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
  for (const block of codeBlocks) {
    examples.push(block.replace(/```\w*\n?|\n?```/g, '').trim());
  }

  // Look for quoted examples
  const quotes = content.match(/"[^"]+"/g) || [];
  for (const quote of quotes) {
    examples.push(quote.replace(/"/g, ''));
  }

  return examples;
}

/**
 * Extract best practices from section content
 */
function extractBestPractices(content: string): string[] {
  const practices: string[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const cleanLine = line.replace(/^[-*\d.]+\s*/, '').trim();
    if (cleanLine.length > 20 && !cleanLine.startsWith('#')) {
      practices.push(cleanLine);
    }
  }

  return practices;
}

/**
 * Infer category from rule text
 */
function inferCategory(text: string): 'content' | 'meta' | 'schema' | 'links' | 'technical' {
  const lower = text.toLowerCase();

  if (lower.includes('schema') || lower.includes('json-ld') || lower.includes('structured')) {
    return 'schema';
  }
  if (lower.includes('link') || lower.includes('anchor') || lower.includes('href')) {
    return 'links';
  }
  if (lower.includes('title') || lower.includes('meta') || lower.includes('description')) {
    return 'meta';
  }
  if (lower.includes('performance') || lower.includes('speed') || lower.includes('technical')) {
    return 'technical';
  }

  return 'content';
}

/**
 * Infer priority from rule text
 */
function inferPriority(text: string): 'required' | 'recommended' | 'optional' {
  const lower = text.toLowerCase();

  if (lower.includes('must') || lower.includes('required') || lower.includes('critical')) {
    return 'required';
  }
  if (lower.includes('should') || lower.includes('recommended')) {
    return 'recommended';
  }

  return 'optional';
}

/**
 * Load multiple skills at once
 */
export function loadSkills(skillNames: string[]): Map<string, ParsedSkill> {
  const skills = new Map<string, ParsedSkill>();

  for (const name of skillNames) {
    const skill = parseSkillFile(name);
    if (skill) {
      skills.set(name, skill);
      console.log(`[Skill Parser] Loaded skill: ${name} (${skill.rules.length} rules, ${skill.bestPractices.length} best practices)`);
    }
  }

  return skills;
}

/**
 * Get combined best practices from multiple skills
 */
export function getCombinedBestPractices(skills: Map<string, ParsedSkill>): string[] {
  const practices: string[] = [];

  for (const skill of skills.values()) {
    practices.push(...skill.bestPractices);
  }

  // Deduplicate
  return [...new Set(practices)];
}

/**
 * Get combined rules from multiple skills
 */
export function getCombinedRules(skills: Map<string, ParsedSkill>): SkillRule[] {
  const rules: SkillRule[] = [];

  for (const skill of skills.values()) {
    rules.push(...skill.rules);
  }

  return rules;
}
