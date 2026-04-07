/**
 * Post-publish: Gobii browser QC + live on-page SEO score (independent of pre-deploy).
 */
import type { SEOScoreResult } from './seo-score';
import { calculateSEOScore } from './seo-score';
import {
  createBrowserUseTask,
  extractGobiiStructuredOutput,
  getBrowserUseTaskResult
} from './gobii-client';
import {
  buildGobiiQcPrompt,
  DEFAULT_GOBII_TASK_WAIT_SECONDS,
  DEFAULT_POST_PUBLISH_QC_DELAY_MS,
  GOBII_QC_OUTPUT_SCHEMA
} from '../config/gobii-qc';
import { appendQcHistory, type QcHistoryRecord } from './qc-history-store';
import { secrets } from './doppler-secrets';

export interface PostPublishQcContext {
  articleUrl: string;
  keyword: string;
  slug: string;
  preDeploy: SEOScoreResult;
  addActivityLog: (type: 'info' | 'success' | 'error' | 'warning', message: string, details?: Record<string, unknown>) => void;
}

export interface PostPublishQcResult {
  ok: boolean;
  reason?: string;
  liveScore?: SEOScoreResult;
  gobiiTaskId?: string;
}

function envBool(name: string, defaultVal: boolean): boolean {
  const v = secrets.get(name) || process.env[name];
  if (v == null || v === '') return defaultVal;
  return v === '1' || v.toLowerCase() === 'true';
}

function envInt(name: string, defaultVal: number): number {
  const v = secrets.get(name) || process.env[name];
  if (v == null || v === '') return defaultVal;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean);
}

export async function runPostPublishQualityControl(ctx: PostPublishQcContext): Promise<PostPublishQcResult> {
  const strict = envBool('POST_PUBLISH_QC_STRICT', true);
  const gobiiKey = secrets.get('GOBII_API_KEY') || process.env.GOBII_API_KEY;
  const delayMs = envInt('POST_PUBLISH_QC_DELAY_MS', DEFAULT_POST_PUBLISH_QC_DELAY_MS);
  const waitSeconds = envInt('GOBII_TASK_WAIT_SECONDS', DEFAULT_GOBII_TASK_WAIT_SECONDS);
  const minLive = envInt('LIVE_SEO_MIN_SCORE', 0); // 0 = disabled
  const failOnGobiiErrors = envBool('FAIL_ON_GOBII_QC_ERRORS', false);

  await new Promise(r => setTimeout(r, delayMs));

  let gobiiTaskId: string | undefined;
  let qcErrors: string[] = [];
  let qcImprovements: string[] = [];
  let gobiiStatus: string | undefined;

  if (!gobiiKey) {
    if (strict) {
      const msg = '[Step 13/12] Post-publish QC FAILED: GOBII_API_KEY not configured (POST_PUBLISH_QC_STRICT=true)';
      ctx.addActivityLog('error', msg, { step: '13/12', url: ctx.articleUrl, keyword: ctx.keyword });
      persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
      return { ok: false, reason: 'missing_gobii_key' };
    }
    ctx.addActivityLog('warning', '[Step 13/12] Gobii skipped — no GOBII_API_KEY (non-strict)', { url: ctx.articleUrl, step: '13/12' });
  } else {
    const prompt = buildGobiiQcPrompt(ctx.articleUrl, ctx.keyword);
    const { ok, status, data } = await createBrowserUseTask({
      prompt,
      output_schema: GOBII_QC_OUTPUT_SCHEMA,
      wait: Math.max(0, waitSeconds)
    });

    gobiiTaskId = typeof data.id === 'string' ? data.id : undefined;
    gobiiStatus = typeof data.status === 'string' ? data.status : undefined;

    if (!ok || status === 402) {
      const reason = data.error_message || `HTTP ${status}`;
      const msg = `[Step 13/12] Gobii task failed: ${reason}`;
      ctx.addActivityLog('error', msg, { step: '13/12', url: ctx.articleUrl, gobiiTaskId, status });
      persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
      return { ok: false, reason: 'gobii_http_error', gobiiTaskId };
    }

    if (data.status === 'failed' || data.error_message) {
      const msg = `[Step 13/12] Gobii task status failed: ${data.error_message || data.status}`;
      ctx.addActivityLog('error', msg, { step: '13/12', url: ctx.articleUrl, gobiiTaskId });
      persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
      return { ok: false, reason: 'gobii_task_failed', gobiiTaskId };
    }

    let structured = extractGobiiStructuredOutput(data);
    if (!structured && gobiiTaskId && (!data.status || data.status === 'pending' || data.status === 'in_progress')) {
      const poll = await getBrowserUseTaskResult(gobiiTaskId);
      structured = extractGobiiStructuredOutput(poll.data);
      gobiiStatus = typeof poll.data.status === 'string' ? poll.data.status : gobiiStatus;
    }

    if (structured) {
      qcErrors = parseStringArray(structured.errors);
      qcImprovements = parseStringArray(structured.improvements);
    }

    if (failOnGobiiErrors && qcErrors.length > 0) {
      const msg = `[Step 13/12] QC errors reported (${qcErrors.length}) — FAIL_ON_GOBII_QC_ERRORS=true`;
      ctx.addActivityLog('error', msg, {
        step: '13/12',
        url: ctx.articleUrl,
        qcErrors,
        qcImprovements,
        gobiiTaskId
      });
      persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
      return { ok: false, reason: 'gobii_qc_errors', gobiiTaskId };
    }
  }

  let liveHtml: string;
  try {
    const res = await fetch(ctx.articleUrl, {
      headers: { 'User-Agent': 'SEO-V3-PostPublish-QC/1.0' }
    });
    if (!res.ok) {
      const msg = `[Step 13/12] Live fetch failed HTTP ${res.status} for ${ctx.articleUrl}`;
      ctx.addActivityLog('error', msg, { step: '13/12', url: ctx.articleUrl });
      persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
      return { ok: false, reason: 'live_fetch_failed' };
    }
    liveHtml = await res.text();
  } catch (e: any) {
    const msg = `[Step 13/12] Live fetch error: ${e.message}`;
    ctx.addActivityLog('error', msg, { step: '13/12', url: ctx.articleUrl });
    persistQcRecord(ctx, 'failed', msg, undefined, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
    return { ok: false, reason: 'live_fetch_error' };
  }

  const liveScore = await calculateSEOScore(liveHtml, ctx.keyword, undefined, undefined, undefined);
  const delta = liveScore.score - ctx.preDeploy.score;

  if (minLive > 0 && liveScore.score < minLive) {
    const msg = `[Step 13/12] Live SEO ${liveScore.score}/100 below LIVE_SEO_MIN_SCORE (${minLive})`;
    ctx.addActivityLog('error', msg, {
      step: '13/12',
      url: ctx.articleUrl,
      preDeployScore: ctx.preDeploy.score,
      liveSeoScore: liveScore.score,
      seoScoreDelta: delta,
      preBreakdown: ctx.preDeploy.breakdown,
      liveBreakdown: liveScore.breakdown,
      qcErrors,
      qcImprovements,
      gobiiTaskId
    });
    persistQcRecord(ctx, 'failed', msg, liveScore, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
    return { ok: false, reason: 'below_live_min', liveScore };
  }

  const summary = `QC: ${ctx.articleUrl} | Pre: ${ctx.preDeploy.score}/100 → Live: ${liveScore.score}/100 (Δ ${delta >= 0 ? '+' : ''}${delta}) | Gobii issues: ${qcErrors.length} | Suggestions: ${qcImprovements.length}`;
  ctx.addActivityLog('success', `[Step 13/12] Post-publish QC ${summary}`, {
    step: '13/12',
    url: ctx.articleUrl,
    preDeployScore: ctx.preDeploy.score,
    liveSeoScore: liveScore.score,
    seoScoreDelta: delta,
    preBreakdown: ctx.preDeploy.breakdown,
    liveBreakdown: liveScore.breakdown,
    qcErrors,
    qcImprovements,
    gobiiTaskId,
    gobiiStatus
  });

  persistQcRecord(ctx, 'passed', undefined, liveScore, qcErrors, qcImprovements, gobiiTaskId, gobiiStatus);
  return { ok: true, liveScore, gobiiTaskId };
}

function persistQcRecord(
  ctx: PostPublishQcContext,
  outcome: 'passed' | 'failed',
  failureReason: string | undefined,
  live: SEOScoreResult | undefined,
  qcErrors: string[],
  qcImprovements: string[],
  gobiiTaskId: string | undefined,
  gobiiStatus: string | undefined
): void {
  const delta = live ? live.score - ctx.preDeploy.score : 0;
  const rec: QcHistoryRecord = {
    id: `${ctx.slug}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    keyword: ctx.keyword,
    slug: ctx.slug,
    articleUrl: ctx.articleUrl,
    preDeployScore: ctx.preDeploy.score,
    liveScore: live?.score ?? -1,
    scoreDelta: delta,
    preBreakdown: ctx.preDeploy.breakdown as unknown as Record<string, unknown>,
    liveBreakdown: (live?.breakdown ?? {}) as unknown as Record<string, unknown>,
    gobiiTaskId,
    gobiiStatus,
    qcErrors,
    qcImprovements,
    pipelineOutcome: outcome,
    failureReason
  };
  appendQcHistory(rec);
}
