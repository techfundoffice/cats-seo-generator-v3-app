/**
 * Gobii Cloud API — browser-use tasks
 * @see https://docs.gobii.ai/developers/developer-basics
 * @see https://docs.gobii.ai/developers/webhooks.md — success payloads use `result` for structured JSON
 */
import { GOBII_TASK_WAIT_MAX_SECONDS } from '../config/gobii-qc';
import { secrets } from './doppler-secrets';

export interface GobiiTaskCreateBody {
  prompt: string;
  output_schema?: Record<string, unknown>;
  /** Seconds; synchronous when > 0. Capped to GOBII_TASK_WAIT_MAX_SECONDS (OpenAPI). */
  wait?: number;
  webhook?: string;
}

export interface GobiiTaskResponse {
  id?: string;
  status?: string;
  prompt?: string;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
  /**
   * Structured output when `output_schema` was provided; object or JSON string.
   * Official webhook examples use this key for completed tasks.
   */
  result?: unknown;
  /** Legacy / alternate shapes — not in published OpenAPI TaskDetail but kept for drift */
  output?: unknown;
  structured_output?: unknown;
  [key: string]: unknown;
}

function apiBase(): string {
  return secrets.get('GOBII_API_BASE') || process.env.GOBII_API_BASE || 'https://gobii.ai/api/v1';
}

function apiKey(): string | undefined {
  return secrets.get('GOBII_API_KEY') || process.env.GOBII_API_KEY;
}

export async function gobiiPing(): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  const key = apiKey();
  if (!key) return { ok: false, error: 'GOBII_API_KEY not set' };
  try {
    const res = await fetch(`${apiBase()}/ping/`, {
      headers: { 'X-Api-Key': key }
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function clampWaitSeconds(wait: number | undefined): number | undefined {
  if (wait == null) return undefined;
  const w = Math.floor(wait);
  if (!Number.isFinite(w) || w < 0) return 0;
  return Math.min(GOBII_TASK_WAIT_MAX_SECONDS, w);
}

/**
 * POST /tasks/browser-use/ — create browser-use task.
 * Use `wait` (seconds) for synchronous completion when supported.
 */
export async function createBrowserUseTask(
  body: GobiiTaskCreateBody
): Promise<{ ok: boolean; status: number; data: GobiiTaskResponse; rawText?: string }> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, data: { error_message: 'GOBII_API_KEY not set' } };
  }
  const payload: GobiiTaskCreateBody = {
    ...body,
    wait: clampWaitSeconds(body.wait)
  };
  const res = await fetch(`${apiBase()}/tasks/browser-use/`, {
    method: 'POST',
    headers: {
      'X-Api-Key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const rawText = await res.text();
  let data: GobiiTaskResponse = {};
  try {
    data = JSON.parse(rawText) as GobiiTaskResponse;
  } catch {
    data = { error_message: rawText.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data, rawText };
}

export async function getBrowserUseTaskResult(taskId: string): Promise<{ ok: boolean; status: number; data: GobiiTaskResponse }> {
  const key = apiKey();
  if (!key) {
    return { ok: false, status: 0, data: {} };
  }
  const res = await fetch(`${apiBase()}/tasks/browser-use/${encodeURIComponent(taskId)}/result/`, {
    headers: { 'X-Api-Key': key }
  });
  const data = (await res.json().catch(() => ({}))) as GobiiTaskResponse;
  return { ok: res.ok, status: res.status, data };
}

/** Turn API `result` (or legacy fields) into a plain object, or null. */
function normalizeStructuredCandidate(candidate: unknown): Record<string, unknown> | null {
  if (candidate == null) return null;
  if (typeof candidate === 'string') {
    const t = candidate.trim();
    if (!t) return null;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>;
  }
  return null;
}

/**
 * Extract structured QC object from a task or result response.
 * Primary: `result` (documented on webhooks and task payloads).
 */
export function extractGobiiStructuredOutput(data: GobiiTaskResponse): Record<string, unknown> | null {
  const primary = normalizeStructuredCandidate(data.result);
  if (primary) return primary;

  const fallbacks: unknown[] = [data.output, data.structured_output, data.task_result];
  for (const c of fallbacks) {
    const o = normalizeStructuredCandidate(c);
    if (o) return o;
  }
  return null;
}
