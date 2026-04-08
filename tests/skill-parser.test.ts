/**
 * Tests for src/services/skill-parser.ts
 *
 * Covers: parseSkillFile, loadSkills, getCombinedBestPractices,
 * getCombinedRules, and the internal parsing helpers exercised through
 * the public API.
 *
 * Strategy: use jest.mock to redirect SKILL_PATHS.base to a controlled
 * temporary directory so the tests are fully isolated from the host's
 * ~/.claude/skills directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The tests write skill files here; the jest.mock below points SKILL_PATHS.base
// at this same path.
const TEST_SKILLS_BASE = path.join(os.tmpdir(), 'jest-skill-parser-base');

// Override SKILL_PATHS.base before skill-parser.ts (and its transitive imports)
// are evaluated.  jest.mock is automatically hoisted to the top of the file by
// Babel/ts-jest so this runs before the import statements below.
jest.mock('../src/config/seo-skills', () => {
  const actual = jest.requireActual('../src/config/seo-skills') as Record<string, unknown>;
  const skillPaths = actual['SKILL_PATHS'] as Record<string, unknown>;
  return {
    ...actual,
    SKILL_PATHS: {
      ...skillPaths,
      base: require('path').join(require('os').tmpdir(), 'jest-skill-parser-base'),
    },
  };
});

// These imports resolve after the mock is set up.
import {
  parseSkillFile,
  loadSkills,
  getCombinedBestPractices,
  getCombinedRules,
} from '../src/services/skill-parser';

// ─── skill content fixtures ───────────────────────────────────────────────────

const MINIMAL_SKILL_MD = `---
description: A minimal test skill
version: 2.1.0
---

## Rules

- Must include keyword in title
- Should use semantic HTML
- Consider schema markup for better indexing

## Best Practices

- Write at least 1500 words for comprehensive coverage
- Include a clear call to action in every section

## Examples

\`\`\`
<h1>Best Pet Insurance for {breed} in {year}</h1>
\`\`\`
`;

const SKILL_WITH_PATTERNS = `---
description: Skill with code patterns
version: 1.0.0
---

## Patterns

\`\`\`
{"@type": "Article", "name": "{{title}}"}
\`\`\`

\`\`\`html
<meta name="description" content="{{metaDesc}}" />
\`\`\`
`;

const SKILL_WITH_CATEGORIES = `---
description: Category detection skill
version: 1.0.0
---

## Requirements

- Must include JSON-LD schema for structured data
- title must be descriptive and under 60 chars
- Use meta description for better click-through rate
- Add internal links and external anchor text
- Performance optimization for Core Web Vitals
`;

// ─── directory helpers ────────────────────────────────────────────────────────

function writeSkill(name: string, content: string): void {
  const skillDir = path.join(TEST_SKILLS_BASE, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill.md'), content, 'utf-8');
}

// ─── setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  fs.mkdirSync(TEST_SKILLS_BASE, { recursive: true });

  writeSkill('minimal-skill', MINIMAL_SKILL_MD);
  writeSkill('patterns-skill', SKILL_WITH_PATTERNS);
  writeSkill('categories-skill', SKILL_WITH_CATEGORIES);
});

afterAll(() => {
  fs.rmSync(TEST_SKILLS_BASE, { recursive: true, force: true });
});

// ─── parseSkillFile ───────────────────────────────────────────────────────────

describe('parseSkillFile', () => {
  it('returns null for a non-existent skill', () => {
    expect(parseSkillFile('definitely-nonexistent-skill-xyz')).toBeNull();
  });

  it('parses a valid skill and returns a ParsedSkill object', () => {
    const skill = parseSkillFile('minimal-skill');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('minimal-skill');
    expect(skill!.description).toBe('A minimal test skill');
    expect(skill!.version).toBe('2.1.0');
  });

  it('extracted rules have the expected shape', () => {
    const skill = parseSkillFile('minimal-skill')!;
    expect(skill.rules.length).toBeGreaterThan(0);
    const rule = skill.rules[0];
    expect(rule).toHaveProperty('id');
    expect(rule).toHaveProperty('name');
    expect(rule).toHaveProperty('description');
    expect(rule).toHaveProperty('category');
    expect(rule).toHaveProperty('priority');
  });

  it('extracts best practices from the ## Best Practices section', () => {
    const skill = parseSkillFile('minimal-skill')!;
    expect(skill.bestPractices.length).toBeGreaterThan(0);
  });

  it('extracts examples from code blocks in the ## Examples section', () => {
    const skill = parseSkillFile('minimal-skill')!;
    expect(skill.examples.length).toBeGreaterThan(0);
    expect(skill.examples[0]).toContain('h1');
  });

  it('extracts patterns from code blocks in the ## Patterns section', () => {
    const skill = parseSkillFile('patterns-skill')!;
    expect(skill.patterns.length).toBeGreaterThanOrEqual(2);
    const p = skill.patterns[0];
    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('pattern');
    expect(p).toHaveProperty('context');
  });

  it('infers correct rule categories (schema, meta, links, technical)', () => {
    const skill = parseSkillFile('categories-skill')!;
    const cats = skill.rules.map(r => r.category);
    expect(cats).toContain('schema');
    expect(cats).toContain('meta');
    expect(cats).toContain('links');
    expect(cats).toContain('technical');
  });

  it('infers "required" priority for "must" rules', () => {
    const skill = parseSkillFile('categories-skill')!;
    const required = skill.rules.filter(r => r.priority === 'required');
    expect(required.length).toBeGreaterThan(0);
  });

  it('infers "content" category as fallback', () => {
    const skill = parseSkillFile('minimal-skill')!;
    const content = skill.rules.filter(r => r.category === 'content');
    expect(content.length).toBeGreaterThan(0);
  });

  it('supports SKILL.md case variation', () => {
    const upperDir = path.join(TEST_SKILLS_BASE, 'upper-case-skill');
    fs.mkdirSync(upperDir, { recursive: true });
    fs.writeFileSync(path.join(upperDir, 'SKILL.md'), MINIMAL_SKILL_MD, 'utf-8');
    const skill = parseSkillFile('upper-case-skill');
    expect(skill).not.toBeNull();
    fs.rmSync(upperDir, { recursive: true, force: true });
  });
});

// ─── loadSkills ───────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('returns an empty Map for non-existent skill names', () => {
    const skills = loadSkills(['does-not-exist-skill']);
    expect(skills.size).toBe(0);
  });

  it('loads a single skill', () => {
    const skills = loadSkills(['minimal-skill']);
    expect(skills.size).toBe(1);
    expect(skills.has('minimal-skill')).toBe(true);
  });

  it('loads multiple skills at once', () => {
    const skills = loadSkills(['minimal-skill', 'patterns-skill']);
    expect(skills.size).toBe(2);
    expect(skills.has('minimal-skill')).toBe(true);
    expect(skills.has('patterns-skill')).toBe(true);
  });

  it('silently skips non-existent skills when loading a mix', () => {
    const skills = loadSkills(['minimal-skill', 'does-not-exist']);
    expect(skills.size).toBe(1);
  });

  it('returns empty Map for empty array input', () => {
    expect(loadSkills([])).toEqual(new Map());
  });
});

// ─── getCombinedBestPractices ─────────────────────────────────────────────────

describe('getCombinedBestPractices', () => {
  it('returns an empty array for an empty Map', () => {
    expect(getCombinedBestPractices(new Map())).toEqual([]);
  });

  it('returns an array of strings', () => {
    const skills = loadSkills(['minimal-skill']);
    const practices = getCombinedBestPractices(skills);
    expect(Array.isArray(practices)).toBe(true);
    practices.forEach(p => expect(typeof p).toBe('string'));
  });

  it('combines practices from all skills', () => {
    const skills = loadSkills(['minimal-skill', 'patterns-skill']);
    const practices = getCombinedBestPractices(skills);
    expect(practices.length).toBeGreaterThan(0);
  });

  it('deduplicates identical practices across skills', () => {
    // Write two skills that share a best practice line
    writeSkill('dup-skill-a', `---\ndescription: A\nversion:1.0\n---\n## Best Practices\n- Shared practice across skills abc\n- Unique to A\n`);
    writeSkill('dup-skill-b', `---\ndescription: B\nversion:1.0\n---\n## Best Practices\n- Shared practice across skills abc\n- Unique to B\n`);

    const skills = loadSkills(['dup-skill-a', 'dup-skill-b']);
    const practices = getCombinedBestPractices(skills);
    const unique = new Set(practices);
    expect(unique.size).toBe(practices.length);
  });
});

// ─── getCombinedRules ─────────────────────────────────────────────────────────

describe('getCombinedRules', () => {
  it('returns an empty array for an empty Map', () => {
    expect(getCombinedRules(new Map())).toEqual([]);
  });

  it('returns an array of SkillRule objects with expected shape', () => {
    const skills = loadSkills(['categories-skill']);
    const rules = getCombinedRules(skills);
    expect(Array.isArray(rules)).toBe(true);
    rules.forEach(r => {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('category');
      expect(r).toHaveProperty('priority');
    });
  });

  it('combines rules from multiple skills', () => {
    const skills = loadSkills(['minimal-skill', 'categories-skill']);
    const rules = getCombinedRules(skills);
    expect(rules.length).toBeGreaterThanOrEqual(3);
  });

  it('each rule id is unique', () => {
    const skills = loadSkills(['minimal-skill', 'categories-skill']);
    const rules = getCombinedRules(skills);
    const ids = rules.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
