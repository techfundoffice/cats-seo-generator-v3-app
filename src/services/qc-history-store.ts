/**
 * Persistent QC history (append-only JSONL), separate from generation-history.jsonl.
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const QC_FILE = path.join(DATA_DIR, 'qc-history.jsonl');

export interface QcHistoryRecord {
  id: string;
  timestamp: string;
  keyword: string;
  slug: string;
  articleUrl: string;
  preDeployScore: number;
  liveScore: number;
  scoreDelta: number;
  preBreakdown: Record<string, unknown>;
  liveBreakdown: Record<string, unknown>;
  gobiiTaskId?: string;
  gobiiStatus?: string;
  qcErrors: string[];
  qcImprovements: string[];
  pipelineOutcome: 'passed' | 'failed';
  failureReason?: string;
}

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch { /* exists */ }

export function appendQcHistory(record: QcHistoryRecord): void {
  try {
    fs.appendFileSync(QC_FILE, JSON.stringify(record) + '\n', 'utf-8');
  } catch (e: any) {
    console.error(`[QC History] Failed to append: ${e.message}`);
  }
}
