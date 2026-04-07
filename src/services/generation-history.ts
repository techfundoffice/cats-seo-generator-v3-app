import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Persistent Generation History Service
// Append-only JSONL files with rotation at 10MB
// ============================================================================

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'generation-history.jsonl');
const ERRORS_FILE = path.join(DATA_DIR, 'errors.jsonl');
const CATEGORY_PROGRESS_FILE = path.join(DATA_DIR, 'category-progress.json');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Ensure data directory exists on module load
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* exists */ }

// ---- Interfaces ----

export interface GenerationRecord {
  id: string;
  keyword: string;
  slug: string;
  category: string;
  url: string;
  timestamp: string;
  durationMs: number;
  model: string;
  seoScore: number;
  wordCount: number;
  sectionCount: number;
  faqCount: number;
  serp: {
    competitorsAnalyzed: number;
    avgWordCount: number;
    topicsFound: string[];
    contentGaps: string[];
  };
  amazon: {
    productCount: number;
    products: Array<{ asin: string; name: string; price: string; rating: string }>;
  };
  images: {
    count: number;
    neuronsCost: number;
    timingMs: number;
  };
  grammarFixes: number;
  jsonRepaired: boolean;
  /** True if a post-parse LLM repair pass was applied (output quality) */
  qualityRepairUsed?: boolean;
  video: {
    found: boolean;
    title?: string;
    channel?: string;
    funnelLevel?: number;
  } | null;
  indexNowSubmitted: boolean;
  deployment: {
    kvKey: string;
    verified: boolean;
  };
  pageSpeed: {
    performance: number;
    seo: number;
    accessibility: number;
    bestPractices: number;
    lcp: number;
    cls: number;
    tbt: number;
  } | null;
  internalLinks: {
    total: number;
  };
  buildVersion: string;
}

export interface ErrorRecord {
  keyword: string;
  category: string;
  timestamp: string;
  step: string;
  error: string;
  retryable: boolean;
  details?: Record<string, any>;
}

export interface CategoryProgress {
  updatedAt: string;
  categories: Record<string, {
    total: number;
    done: number;
    failed: number;
    inProgress: number;
  }>;
}

// ---- File rotation ----

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      const prevPath = filePath + '.prev';
      // Remove old .prev if exists, rename current to .prev
      try { fs.unlinkSync(prevPath); } catch (_) { /* no prev */ }
      fs.renameSync(filePath, prevPath);
    }
  } catch (_) {
    // File doesn't exist yet — nothing to rotate
  }
}

// ---- Write helpers ----

function appendJsonl(filePath: string, record: Record<string, any>): void {
  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch (err: any) {
    console.error(`[GenerationHistory] Failed to write ${path.basename(filePath)}: ${err.message}`);
  }
}

// ---- Public API ----

export function saveGenerationRecord(record: GenerationRecord): void {
  appendJsonl(HISTORY_FILE, record);
}

export function saveErrorRecord(record: ErrorRecord): void {
  appendJsonl(ERRORS_FILE, record);
}

export function updateCategoryProgress(progress: CategoryProgress): void {
  try {
    fs.writeFileSync(CATEGORY_PROGRESS_FILE, JSON.stringify(progress, null, 2));
  } catch (err: any) {
    console.error(`[GenerationHistory] Failed to write category-progress.json: ${err.message}`);
  }
}

export function appendPageSpeedToHistory(slug: string, data: NonNullable<GenerationRecord['pageSpeed']>): void {
  const entry = {
    _type: 'pagespeed-update',
    slug,
    timestamp: new Date().toISOString(),
    pageSpeed: data,
  };
  appendJsonl(HISTORY_FILE, entry);
}

export function getHistory(limit = 50, offset = 0): GenerationRecord[] {
  return readJsonlTail<GenerationRecord>(HISTORY_FILE, limit, offset, (r) => r.id !== undefined && r._type === undefined);
}

export function getHistoryForSlug(slug: string): { record: GenerationRecord | null; pageSpeed: any[] } {
  const lines = readAllLines(HISTORY_FILE);
  let record: GenerationRecord | null = null;
  const pageSpeedUpdates: any[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.slug === slug) {
        if (parsed._type === 'pagespeed-update') {
          pageSpeedUpdates.push(parsed);
        } else if (parsed.id !== undefined) {
          record = parsed;
        }
      }
    } catch (_) { /* skip malformed */ }
  }

  return { record, pageSpeed: pageSpeedUpdates };
}

export function getErrors(limit = 50): ErrorRecord[] {
  return readJsonlTail<ErrorRecord>(ERRORS_FILE, limit, 0);
}

export function getCategoryProgress(): CategoryProgress | null {
  try {
    const raw = fs.readFileSync(CATEGORY_PROGRESS_FILE, 'utf-8');
    return JSON.parse(raw) as CategoryProgress;
  } catch (_) {
    return null;
  }
}

// ---- Read helpers ----

function readAllLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readJsonlTail<T>(filePath: string, limit: number, offset: number, filter?: (r: any) => boolean): T[] {
  const lines = readAllLines(filePath);
  const results: T[] = [];

  // Walk backwards for newest-first
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (filter && !filter(parsed)) continue;
      results.push(parsed as T);
    } catch (_) { /* skip malformed */ }
  }

  return results.slice(offset, offset + limit);
}
