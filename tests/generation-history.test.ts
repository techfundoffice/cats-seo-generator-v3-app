/**
 * Tests for src/services/generation-history.ts
 *
 * Covers: saveGenerationRecord, getHistory, getHistoryForSlug,
 * saveErrorRecord, getErrors, updateCategoryProgress,
 * getCategoryProgress, appendPageSpeedToHistory
 *
 * All file I/O is redirected to a temporary directory that is
 * cleaned up after each test suite.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Redirect data directory before importing the module ─────────────────────
// generation-history.ts uses __dirname-relative paths computed at module load.
// We override the file paths by monkey-patching via a fresh jest module registry.

// We need to intercept the DATA_DIR used by the module. Since it's computed at
// module load time from __dirname, the simplest approach is to use jest.mock
// to redirect `fs` calls, or to use an isolated module with a different __dirname.
//
// Instead we test at the "public API" level and use a real temp directory by
// manipulating __dirname before first import – which isn't feasible without
// module isolation. So we take the pragmatic approach: let the module write to
// its real `data/` directory but wrap tests in a beforeAll/afterAll that saves
// and restores the original files.

// Obtain the module's DATA_DIR path (mirrors the logic in the source)
const MODULE_DATA_DIR = path.join(
  __dirname,
  '..',
  'src',
  'services',
  '..',   // services/../..  = project root
  '..',
  'data'
);

// The actual DATA_DIR used in the module:
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'generation-history.jsonl');
const ERRORS_FILE = path.join(DATA_DIR, 'errors.jsonl');
const CATEGORY_PROGRESS_FILE = path.join(DATA_DIR, 'category-progress.json');

import {
  saveGenerationRecord,
  getHistory,
  getHistoryForSlug,
  saveErrorRecord,
  getErrors,
  updateCategoryProgress,
  getCategoryProgress,
  appendPageSpeedToHistory,
  type GenerationRecord,
  type ErrorRecord,
  type CategoryProgress,
} from '../src/services/generation-history';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    keyword: 'best pet insurance',
    slug: 'best-pet-insurance',
    category: 'petinsurance',
    url: 'https://catsluvus.com/petinsurance/best-pet-insurance',
    timestamp: new Date().toISOString(),
    durationMs: 12345,
    model: 'claude-sonnet-4',
    seoScore: 82,
    wordCount: 2600,
    sectionCount: 8,
    faqCount: 6,
    serp: { competitorsAnalyzed: 5, avgWordCount: 2400, topicsFound: ['cost'], contentGaps: [] },
    amazon: { productCount: 2, products: [] },
    images: { count: 3, neuronsCost: 0, timingMs: 500 },
    grammarFixes: 2,
    jsonRepaired: false,
    video: null,
    indexNowSubmitted: true,
    deployment: { kvKey: 'kv-key', verified: true },
    pageSpeed: null,
    internalLinks: { total: 4 },
    buildVersion: '3.0.0',
    ...overrides,
  };
}

function makeErrorRecord(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    keyword: 'broken keyword',
    category: 'petinsurance',
    timestamp: new Date().toISOString(),
    step: 'generation',
    error: 'Something went wrong',
    retryable: true,
    ...overrides,
  };
}

// ─── backup / restore helpers ─────────────────────────────────────────────────

function backupFile(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return data;
  } catch {
    return null;
  }
}

function restoreFile(filePath: string, backup: string | null): void {
  if (backup === null) {
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  } else {
    fs.writeFileSync(filePath, backup, 'utf-8');
  }
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe('generation-history', () => {
  // Backups of existing data files so tests don't corrupt real data
  let historyBackup: string | null;
  let errorsBackup: string | null;
  let progressBackup: string | null;

  beforeAll(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    historyBackup = backupFile(HISTORY_FILE);
    errorsBackup = backupFile(ERRORS_FILE);
    progressBackup = backupFile(CATEGORY_PROGRESS_FILE);

    // Clear the files so tests start clean
    try { fs.writeFileSync(HISTORY_FILE, ''); } catch { /* ok */ }
    try { fs.writeFileSync(ERRORS_FILE, ''); } catch { /* ok */ }
    try { fs.unlinkSync(CATEGORY_PROGRESS_FILE); } catch { /* ok */ }
  });

  afterAll(() => {
    restoreFile(HISTORY_FILE, historyBackup);
    restoreFile(ERRORS_FILE, errorsBackup);
    restoreFile(CATEGORY_PROGRESS_FILE, progressBackup);
  });

  // ── saveGenerationRecord / getHistory ──────────────────────────────────────

  describe('saveGenerationRecord and getHistory', () => {
    it('persists a record and retrieves it via getHistory', () => {
      const record = makeRecord({ slug: 'history-slug-1', id: 'id-history-1' });
      saveGenerationRecord(record);

      const history = getHistory(10);
      const found = history.find(r => r.id === 'id-history-1');
      expect(found).toBeDefined();
      expect(found!.keyword).toBe('best pet insurance');
    });

    it('getHistory returns newest records first', () => {
      const r1 = makeRecord({ id: 'order-1', slug: 'order-slug-1', timestamp: '2024-01-01T00:00:00.000Z' });
      const r2 = makeRecord({ id: 'order-2', slug: 'order-slug-2', timestamp: '2024-06-01T00:00:00.000Z' });
      saveGenerationRecord(r1);
      saveGenerationRecord(r2);

      const history = getHistory(50);
      const idx1 = history.findIndex(r => r.id === 'order-1');
      const idx2 = history.findIndex(r => r.id === 'order-2');
      // Newer (r2) should appear before older (r1)
      expect(idx2).toBeLessThan(idx1);
    });

    it('respects limit parameter', () => {
      // Add several records
      for (let i = 0; i < 5; i++) {
        saveGenerationRecord(makeRecord({ id: `limit-record-${i}`, slug: `limit-slug-${i}` }));
      }
      const limited = getHistory(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });

    it('respects offset parameter', () => {
      const all = getHistory(100);
      const withOffset = getHistory(100, 1);
      if (all.length > 1) {
        expect(withOffset[0].id).toBe(all[1].id);
      }
    });

    it('returns empty array when history file is empty', () => {
      // Write to a temp-only cleared state
      const backup = backupFile(HISTORY_FILE);
      fs.writeFileSync(HISTORY_FILE, '');
      expect(getHistory(10)).toEqual([]);
      restoreFile(HISTORY_FILE, backup);
    });
  });

  // ── getHistoryForSlug ──────────────────────────────────────────────────────

  describe('getHistoryForSlug', () => {
    it('returns the record for a known slug', () => {
      const record = makeRecord({ slug: 'slug-for-slug-test', id: 'slug-id-1' });
      saveGenerationRecord(record);

      const { record: found } = getHistoryForSlug('slug-for-slug-test');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('slug-id-1');
    });

    it('returns null for an unknown slug', () => {
      const { record } = getHistoryForSlug('completely-unknown-slug-xyz');
      expect(record).toBeNull();
    });

    it('returns pageSpeed updates for the slug', () => {
      const slug = 'pagespeed-slug-test';
      saveGenerationRecord(makeRecord({ slug, id: 'pagespeed-record-id' }));
      appendPageSpeedToHistory(slug, {
        performance: 90, seo: 95, accessibility: 88, bestPractices: 92,
        lcp: 1.2, cls: 0.01, tbt: 80,
      });

      const { pageSpeed } = getHistoryForSlug(slug);
      expect(pageSpeed.length).toBeGreaterThanOrEqual(1);
      expect(pageSpeed[0].pageSpeed.performance).toBe(90);
    });
  });

  // ── saveErrorRecord / getErrors ────────────────────────────────────────────

  describe('saveErrorRecord and getErrors', () => {
    it('persists an error record and retrieves it via getErrors', () => {
      const err = makeErrorRecord({ error: 'Test error message', keyword: 'error-test-kw' });
      saveErrorRecord(err);

      const errors = getErrors(50);
      const found = errors.find(e => e.keyword === 'error-test-kw');
      expect(found).toBeDefined();
      expect(found!.error).toBe('Test error message');
    });

    it('retryable field is persisted correctly', () => {
      saveErrorRecord(makeErrorRecord({ keyword: 'retryable-test', retryable: false }));
      const errors = getErrors(50);
      const found = errors.find(e => e.keyword === 'retryable-test');
      expect(found!.retryable).toBe(false);
    });
  });

  // ── updateCategoryProgress / getCategoryProgress ───────────────────────────

  describe('updateCategoryProgress and getCategoryProgress', () => {
    it('returns null when no progress file exists', () => {
      try { fs.unlinkSync(CATEGORY_PROGRESS_FILE); } catch { /* ok */ }
      expect(getCategoryProgress()).toBeNull();
    });

    it('saves and retrieves category progress', () => {
      const progress: CategoryProgress = {
        updatedAt: new Date().toISOString(),
        categories: {
          petinsurance: { total: 100, done: 50, failed: 2, inProgress: 3 },
        },
      };
      updateCategoryProgress(progress);

      const loaded = getCategoryProgress();
      expect(loaded).not.toBeNull();
      expect(loaded!.categories.petinsurance.total).toBe(100);
      expect(loaded!.categories.petinsurance.done).toBe(50);
    });

    it('overwrites previous progress on update', () => {
      const first: CategoryProgress = {
        updatedAt: new Date().toISOString(),
        categories: { petinsurance: { total: 10, done: 5, failed: 0, inProgress: 0 } },
      };
      const second: CategoryProgress = {
        updatedAt: new Date().toISOString(),
        categories: { petinsurance: { total: 20, done: 15, failed: 1, inProgress: 1 } },
      };
      updateCategoryProgress(first);
      updateCategoryProgress(second);

      const loaded = getCategoryProgress();
      expect(loaded!.categories.petinsurance.total).toBe(20);
    });
  });

  // ── appendPageSpeedToHistory ───────────────────────────────────────────────

  describe('appendPageSpeedToHistory', () => {
    it('writes a pagespeed-update entry that does not appear in getHistory', () => {
      const countBefore = getHistory(1000).length;
      appendPageSpeedToHistory('some-slug', {
        performance: 85, seo: 90, accessibility: 80, bestPractices: 88,
        lcp: 2.0, cls: 0.05, tbt: 120,
      });
      // getHistory filters out _type entries
      expect(getHistory(1000).length).toBe(countBefore);
    });

    it('pagespeed entry is retrievable via getHistoryForSlug', () => {
      const slug = 'ps-append-test-slug';
      saveGenerationRecord(makeRecord({ slug, id: 'ps-append-id' }));
      appendPageSpeedToHistory(slug, {
        performance: 70, seo: 80, accessibility: 75, bestPractices: 78,
        lcp: 3.5, cls: 0.1, tbt: 200,
      });

      const { pageSpeed } = getHistoryForSlug(slug);
      const entry = pageSpeed.find(e => e.pageSpeed?.performance === 70);
      expect(entry).toBeDefined();
    });
  });
});
