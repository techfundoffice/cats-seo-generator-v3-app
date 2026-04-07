import { google } from 'googleapis';

const SITE_URL = 'https://catsluvus.com/';
const SITEMAP_URL = 'https://catsluvus.com/petinsurance/sitemap.xml';

interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

let authClient: any = null;
let lastSitemapSubmit = 0;
const SITEMAP_THROTTLE_MS = 60000; // Only submit sitemap every 60 seconds max

// Indexing API rate limiting (Google allows ~200/day)
let indexingRequestCount = 0;
let indexingDayStart = Date.now();
const INDEXING_DAILY_LIMIT = 180; // Conservative limit below 200
const INDEXING_MIN_INTERVAL_MS = 10000; // At least 10 seconds between requests
let lastIndexingRequest = 0;

function checkIndexingRateLimit(): { allowed: boolean; reason?: string } {
  const now = Date.now();
  
  // Reset daily counter if new day
  if (now - indexingDayStart > 86400000) {
    indexingRequestCount = 0;
    indexingDayStart = now;
  }
  
  // Check daily limit
  if (indexingRequestCount >= INDEXING_DAILY_LIMIT) {
    return { allowed: false, reason: `Daily limit reached (${INDEXING_DAILY_LIMIT})` };
  }
  
  // Check interval
  if (now - lastIndexingRequest < INDEXING_MIN_INTERVAL_MS) {
    return { allowed: false, reason: `Too soon (wait ${Math.ceil((INDEXING_MIN_INTERVAL_MS - (now - lastIndexingRequest)) / 1000)}s)` };
  }
  
  return { allowed: true };
}

async function getAuthClient() {
  if (authClient) return authClient;

  const serviceAccountJson = process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    console.log('[GSC] No service account credentials found, using ping fallback');
    return null;
  }

  try {
    const credentials: ServiceAccountCredentials = JSON.parse(serviceAccountJson);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/webmasters',
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/indexing'
      ]
    });

    authClient = await auth.getClient();
    console.log(`[GSC] Authenticated as service account: ${credentials.client_email}`);
    return authClient;
  } catch (error: any) {
    console.error('[GSC] Auth error:', error.message);
    return null;
  }
}

export async function submitSitemap(): Promise<{ success: boolean; message: string }> {
  // Throttle sitemap submissions
  const now = Date.now();
  if (now - lastSitemapSubmit < SITEMAP_THROTTLE_MS) {
    return { success: true, message: 'Sitemap submission throttled (too recent)' };
  }

  try {
    const auth = await getAuthClient();
    if (!auth) {
      return { success: false, message: 'No auth credentials available' };
    }

    const searchconsole = google.searchconsole({ version: 'v1', auth });

    await searchconsole.sitemaps.submit({
      siteUrl: SITE_URL,
      feedpath: SITEMAP_URL
    });

    lastSitemapSubmit = now;
    console.log(`[GSC] ✓ Sitemap submitted: ${SITEMAP_URL}`);
    return { success: true, message: 'Sitemap submitted to Google Search Console' };
  } catch (error: any) {
    console.log(`[GSC] Sitemap submission: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function requestIndexing(url: string): Promise<{ success: boolean; message: string }> {
  // Check rate limit first
  const rateCheck = checkIndexingRateLimit();
  if (!rateCheck.allowed) {
    console.log(`[GSC] Indexing rate-limited: ${rateCheck.reason}`);
    return { success: false, message: `Rate limited: ${rateCheck.reason}` };
  }
  
  try {
    const auth = await getAuthClient();
    if (!auth) {
      return { success: false, message: 'No auth credentials available' };
    }

    const indexing = google.indexing({ version: 'v3', auth });

    await indexing.urlNotifications.publish({
      requestBody: {
        url: url,
        type: 'URL_UPDATED'
      }
    });

    // Update rate limit counters on success
    lastIndexingRequest = Date.now();
    indexingRequestCount++;
    
    console.log(`[GSC] ✓ Indexing requested: ${url} (${indexingRequestCount}/${INDEXING_DAILY_LIMIT} today)`);
    return { success: true, message: `Indexing requested for ${url}` };
  } catch (error: any) {
    // Indexing API requires special access, so this often fails
    console.log(`[GSC] Indexing API: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function notifyGoogleOfNewArticle(articleUrl: string): Promise<void> {
  // Submit sitemap (throttled)
  await submitSitemap();
  
  // Try indexing API (optional, often fails without special access)
  await requestIndexing(articleUrl);
}

// Batch submit multiple URLs (for bulk operations)
export async function batchNotify(urls: string[]): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;

  // Submit sitemap once
  await submitSitemap();

  // Try indexing each URL
  for (const url of urls) {
    const result = await requestIndexing(url);
    if (result.success) {
      success++;
    } else {
      failed++;
    }
  }

  return { success, failed };
}

// Rich Results validation using URL Inspection API
export interface RichResultItem {
  richResultType: string;
  items?: Array<{
    name?: string;
    issues?: Array<{
      issueMessage: string;
      severity: 'WARNING' | 'ERROR';
    }>;
  }>;
}

export interface UrlInspectionResult {
  success: boolean;
  inspectionResult?: {
    indexStatusResult?: {
      verdict: string;
      coverageState: string;
      robotsTxtState: string;
      indexingState: string;
      lastCrawlTime?: string;
      pageFetchState: string;
      googleCanonical?: string;
      userCanonical?: string;
    };
    richResultsResult?: {
      verdict: string;
      detectedItems: RichResultItem[];
    };
  };
  error?: string;
}

export async function inspectUrl(url: string): Promise<UrlInspectionResult> {
  try {
    const auth = await getAuthClient();
    if (!auth) {
      return { success: false, error: 'No auth credentials available' };
    }

    const accessToken = await auth.getAccessToken();
    if (!accessToken || !accessToken.token) {
      return { success: false, error: 'Failed to get access token' };
    }

    // Use fetch to call the URL Inspection API directly
    // Note: API only accepts inspectionUrl and siteUrl, no inspectType parameter
    const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inspectionUrl: url,
        siteUrl: SITE_URL
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[GSC] URL Inspection failed (${response.status}): ${errorText}`);
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return {
      success: true,
      inspectionResult: data.inspectionResult
    };
  } catch (error: any) {
    console.log(`[GSC] URL Inspection error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Validate rich results for an article and log results
export async function validateRichResults(articleUrl: string): Promise<{
  valid: boolean;
  detectedTypes: string[];
  warnings: string[];
  errors: string[];
}> {
  const result: {
    valid: boolean;
    detectedTypes: string[];
    warnings: string[];
    errors: string[];
  } = {
    valid: false,
    detectedTypes: [],
    warnings: [],
    errors: []
  };

  try {
    const inspection = await inspectUrl(articleUrl);
    
    if (!inspection.success) {
      console.log(`[Rich Results] ⚠️ Inspection unavailable: ${inspection.error}`);
      result.warnings.push(`Inspection unavailable: ${inspection.error}`);
      return result;
    }

    const richResults = inspection.inspectionResult?.richResultsResult;
    
    if (!richResults) {
      console.log(`[Rich Results] ⚠️ No rich results data returned`);
      result.warnings.push('No rich results data in response');
      return result;
    }

    // Log verdict
    const verdict = richResults.verdict;
    if (verdict === 'PASS') {
      console.log(`[Rich Results] ✅ Validation PASSED`);
      result.valid = true;
    } else if (verdict === 'PARTIAL') {
      console.log(`[Rich Results] ⚠️ Validation PARTIAL (some issues)`);
      result.valid = true;
    } else {
      console.log(`[Rich Results] ❌ Validation FAILED: ${verdict}`);
    }

    // Log detected items and issues
    for (const item of richResults.detectedItems || []) {
      result.detectedTypes.push(item.richResultType);
      console.log(`[Rich Results] 📋 Detected: ${item.richResultType}`);
      
      // Check for issues in each detected item
      for (const subItem of item.items || []) {
        for (const issue of subItem.issues || []) {
          if (issue.severity === 'ERROR') {
            result.errors.push(`${item.richResultType}: ${issue.issueMessage}`);
            console.log(`[Rich Results] ❌ Error in ${item.richResultType}: ${issue.issueMessage}`);
          } else if (issue.severity === 'WARNING') {
            result.warnings.push(`${item.richResultType}: ${issue.issueMessage}`);
            console.log(`[Rich Results] ⚠️ Warning in ${item.richResultType}: ${issue.issueMessage}`);
          }
        }
      }
    }

    // Summary log
    const summary = `${result.detectedTypes.length} types, ${result.errors.length} errors, ${result.warnings.length} warnings`;
    console.log(`[Rich Results] 📊 Summary: ${summary}`);

    return result;
  } catch (error: any) {
    console.log(`[Rich Results] ❌ Validation error: ${error.message}`);
    result.errors.push(error.message);
    return result;
  }
}
