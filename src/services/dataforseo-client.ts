const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;

export interface DataForSEOScore {
  overallScore: number;
  checks: {
    passed: number;
    failed: number;
    warnings: number;
  };
  metrics: {
    titleLength: number;
    descriptionLength: number;
    h1Count: number;
    wordCount: number;
    imagesWithAlt: number;
    imagesWithoutAlt: number;
    internalLinks: number;
    externalLinks: number;
    loadTime?: number;
  };
  issues: string[];
  timestamp: string;
}

interface InstantPagesResponse {
  tasks?: Array<{
    id: string;
    status_code: number;
    status_message: string;
    result?: Array<{
      items?: Array<{
        checks?: Record<string, boolean | number>;
        meta?: {
          title?: string;
          description?: string;
          htags?: { h1?: string[] };
          content?: { plain_text_word_count?: number };
        };
        page_metrics?: {
          images_alt?: number;
          images_non_alt?: number;
          links_internal?: number;
          links_external?: number;
        };
        page_timing?: {
          time_to_interactive?: number;
        };
      }>;
    }>;
  }>;
}

export async function getOnPageScore(url: string): Promise<DataForSEOScore | null> {
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    console.warn('[DataForSEO] Missing credentials, skipping On-Page scoring');
    return null;
  }

  try {
    const credentials = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
    
    console.log(`[DataForSEO] Scoring: ${url}`);
    
    const response = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{
        url: url,
        enable_javascript: false
      }])
    });

    if (!response.ok) {
      console.warn(`[DataForSEO] HTTP error: ${response.status}`);
      return null;
    }

    const data: InstantPagesResponse = await response.json();

    if (!data.tasks || data.tasks.length === 0) {
      console.warn('[DataForSEO] No tasks returned');
      return null;
    }

    const taskResult = data.tasks[0];
    if (taskResult.status_code !== 20000 || !taskResult.result || taskResult.result.length === 0) {
      console.warn(`[DataForSEO] Task failed: ${taskResult.status_message}`);
      return null;
    }

    const result = taskResult.result[0];
    const items = result.items || [];
    const pageData = items[0];

    if (!pageData) {
      console.warn('[DataForSEO] No page data returned');
      return null;
    }

    const checks = pageData.checks || {};
    const meta = pageData.meta || {};
    const pageMetrics = pageData.page_metrics || {};

    let passed = 0;
    let failed = 0;
    let warnings = 0;
    const issues: string[] = [];

    for (const [checkName, checkValue] of Object.entries(checks)) {
      if (checkValue === true) {
        passed++;
      } else if (checkValue === false) {
        failed++;
        issues.push(checkName.replace(/_/g, ' '));
      } else if (typeof checkValue === 'number' && checkValue > 0) {
        warnings++;
      }
    }

    const totalChecks = passed + failed + warnings;
    const overallScore = totalChecks > 0 ? Math.round((passed / totalChecks) * 100) : 0;

    const score: DataForSEOScore = {
      overallScore,
      checks: { passed, failed, warnings },
      metrics: {
        titleLength: meta.title?.length || 0,
        descriptionLength: meta.description?.length || 0,
        h1Count: meta.htags?.h1?.length || 0,
        wordCount: meta.content?.plain_text_word_count || 0,
        imagesWithAlt: pageMetrics.images_alt || 0,
        imagesWithoutAlt: pageMetrics.images_non_alt || 0,
        internalLinks: pageMetrics.links_internal || 0,
        externalLinks: pageMetrics.links_external || 0,
        loadTime: pageData.page_timing?.time_to_interactive
      },
      issues: issues.slice(0, 5),
      timestamp: new Date().toISOString()
    };

    // Log detailed check breakdown for debugging
    const failedChecks = Object.entries(checks)
      .filter(([_, v]) => v === false)
      .map(([k]) => k.replace(/_/g, ' '))
      .slice(0, 10);
    
    console.log(`[DataForSEO] ✅ Score: ${overallScore}/100 (${passed} passed, ${failed} failed, ${warnings} warnings)`);
    if (failedChecks.length > 0) {
      console.log(`[DataForSEO] Failed checks: ${failedChecks.join(', ')}`);
    }
    return score;

  } catch (error: any) {
    console.error(`[DataForSEO] Error: ${error.message}`);
    return null;
  }
}

export async function getOnPageScoreWithRetry(url: string, maxRetries = 2, initialDelayMs = 10000): Promise<DataForSEOScore | null> {
  // Wait for CDN edge caching to propagate before scoring
  if (initialDelayMs > 0) {
    console.log(`[DataForSEO] Waiting ${initialDelayMs/1000}s for CDN propagation...`);
    await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  }
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const score = await getOnPageScore(url);
    if (score) return score;
    
    if (attempt < maxRetries) {
      console.log(`[DataForSEO] Retry ${attempt}/${maxRetries} for: ${url}`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  return null;
}

// Focused technical SEO checks that we can actually fix
export interface TechnicalSEOIssues {
  fixable: string[];
  informational: string[];
}

export function categorizeSEOIssues(issues: string[]): TechnicalSEOIssues {
  const fixable: string[] = [];
  const informational: string[] = [];
  
  // Issues we can't fix (CDN/infrastructure level):
  const infrastructureIssues = [
    'no content encoding',      // Cloudflare handles this automatically
    'high loading time',        // CDN cache timing
    'is redirect',              // HTTP→HTTPS is required
    'from sitemap',             // Not an actual issue
    'no favicon',               // Needs design asset
    'is 4xx code',              // Timing issue
    'is 5xx code',              // Timing issue
  ];
  
  for (const issue of issues) {
    const isInfrastructure = infrastructureIssues.some(i => issue.toLowerCase().includes(i.toLowerCase().replace(/_/g, ' ')));
    if (isInfrastructure) {
      informational.push(issue);
    } else {
      fixable.push(issue);
    }
  }
  
  return { fixable, informational };
}
