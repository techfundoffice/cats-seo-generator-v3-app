/**
 * Gobii browser-use QC: prompt + JSON schema for structured output.
 * @see https://docs.gobii.ai/api-reference/browser-use-tasks-api/post-tasksbrowser-use
 */

export const GOBII_DEFAULT_BASE = 'https://gobii.ai/api/v1';

/**
 * Maximum `wait` (seconds) on POST /tasks/browser-use/ per OpenAPI TaskDetail.
 * @see https://docs.gobii.ai/GobiiAPI.yaml — components.schemas.TaskDetail.properties.wait.maximum
 */
export const GOBII_TASK_WAIT_MAX_SECONDS = 1350;

/** Default synchronous wait (seconds) for POST /tasks/browser-use/ */
export const DEFAULT_GOBII_TASK_WAIT_SECONDS = 120;

/** Extra delay after URL verification before Gobii (ms) */
export const DEFAULT_POST_PUBLISH_QC_DELAY_MS = 4000;

/**
 * JSON Schema for Gobii task output (output_schema field).
 * Gobii passes this to the agent to structure the response.
 */
export const GOBII_QC_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['articleUrl', 'errors', 'improvements'],
  properties: {
    articleUrl: { type: 'string', format: 'uri' },
    errors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Blocking or serious issues observed on the live page'
    },
    improvements: {
      type: 'array',
      items: { type: 'string' },
      description: 'Non-blocking improvements for editorial QC'
    },
    pageTitle: { type: 'string' },
    httpOk: { type: 'boolean' },
    notes: { type: 'string' }
  }
};

export function buildGobiiQcPrompt(articleUrl: string, keyword: string): string {
  return `You are running post-publish quality control for an SEO article.

TASK:
1. Open this exact URL in the browser and wait for the main article content to load: ${articleUrl}
2. Confirm HTTP 200 and that the page shows article body content (not an error page).
3. Topic / keyword context: "${keyword}"

OUTPUT:
- List concrete **errors** (broken layout, missing critical sections, wrong title, obvious SEO defects, accessibility blockers).
- List **improvements** (editorial polish, optional SEO tweaks, clarity) — non-blocking suggestions.
- Be specific; no generic filler.

Return structured JSON matching the provided output schema only.`;
}
