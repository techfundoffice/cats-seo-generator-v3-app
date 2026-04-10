import { repairJson } from 'json-repair-js';

/**
 * Extract and parse article JSON from model output.
 * Supports markdown code fences and extra prose around the JSON object.
 */
export function parseArticleJsonResponse<T>(response: string): T {
  let raw = response;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No article JSON in model response');
  }

  const sanitizedJson = raw
    .substring(firstBrace, lastBrace + 1)
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      const isControl = (code >= 0 && code <= 31) || code === 127;
      const isAllowedWhitespace = char === '\t' || char === '\n' || char === '\r';
      return isControl && !isAllowedWhitespace ? '' : char;
    })
    .join('')
    .replace(/\n\s*\n/g, '\n');

  try {
    return JSON.parse(sanitizedJson) as T;
  } catch {
    const repaired = repairJson(sanitizedJson, { returnObjects: false }) as string;
    return JSON.parse(repaired) as T;
  }
}
