/**
 * Tier 2: Apify Amazon Product Service
 * Fallback when Amazon Creators API fails (e.g., AccessDeniedException)
 * Uses Apify Amazon Product Scraper actor
 *
 * Uses Apify's waitForFinish API with polling fallback for queued/running runs.
 */

declare const fetch: typeof globalThis.fetch;

import { secrets } from "./doppler-secrets";

const APIFY_ACTOR_ID = "junglee~free-amazon-product-scraper";
const AMAZON_AFFILIATE_TAG = secrets.get("AMAZON_AFFILIATE_TAG") || process.env.AMAZON_AFFILIATE_TAG || "catsluvus03-20";
const AMAZON_MARKETPLACE = "www.amazon.com";
const APIFY_WAIT_SECS = 180; // Max seconds to wait for initial run
const APIFY_POLL_INTERVAL_MS = 10_000; // 10s between polls
const APIFY_POLL_MAX_MS = 300_000; // 5 min max additional polling

interface ApifyProductResult {
  asin: string;
  title: string;
  thumbnailImage: string;
  price?: { value: number; currency: string; displayPrice: string };
  listPrice?: string;
  stars?: number;
  reviewsCount?: number;
  starsBreakdown?: Record<string, number>;
  isPrime?: boolean;
  features?: string[];
  brand?: string;
  description?: string;
  inStock?: boolean;
  breadCrumbs?: string;
}

export interface AmazonProduct {
  asin: string;
  title: string;
  url: string;
  imageUrl: string;
  price: string;
  priceValue: number;
  listPrice: string;
  rating: number;
  reviewCount: number;
  isPrime: boolean;
  features: string[];
  brand: string;
  description: string;
}

function getApifyToken(): string | undefined {
  return secrets.get("APIFY_TOKEN") || process.env.APIFY_TOKEN;
}

/**
 * Poll an Apify run until it reaches a terminal status (SUCCEEDED/FAILED/ABORTED/TIMED-OUT).
 */
async function pollRunUntilDone(token: string, runId: string): Promise<string> {
  const startTime = Date.now();
  while (Date.now() - startTime < APIFY_POLL_MAX_MS) {
    await new Promise(resolve => setTimeout(resolve, APIFY_POLL_INTERVAL_MS));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const resp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`);
    if (!resp.ok) throw new Error(`Failed to poll run status: ${resp.status}`);
    const data = (await resp.json()) as any;
    const status: string = data.data?.status;
    console.log(`[Apify Amazon] Run ${runId} poll after ${elapsed}s: ${status}`);
    if (status === 'SUCCEEDED') return status;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${runId} ended with status: ${status}`);
    }
    // READY or RUNNING — keep polling
  }
  throw new Error(`Apify run ${runId} timed out after ${APIFY_POLL_MAX_MS / 1000}s of polling`);
}

/**
 * Start an Apify run and wait for it to finish.
 * Uses waitForFinish for the initial request, then polls if still queued/running.
 */
async function startRunAndWait(
  token: string,
  input: object
): Promise<{ runId: string; status: string }> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${token}&waitForFinish=${APIFY_WAIT_SECS}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Apify run failed: ${response.status} ${response.statusText} ${errText}`);
  }

  const data = (await response.json()) as any;
  const runId: string = data.data?.id;
  const status: string = data.data?.status;

  if (!runId) throw new Error("No run ID returned from Apify");

  if (status === 'SUCCEEDED') {
    return { runId, status };
  }

  // Still queued or running — poll until done instead of throwing
  if (status === 'READY' || status === 'RUNNING') {
    console.log(`[Apify Amazon] Run ${runId} status: ${status} after ${APIFY_WAIT_SECS}s waitForFinish, polling...`);
    const finalStatus = await pollRunUntilDone(token, runId);
    return { runId, status: finalStatus };
  }

  throw new Error(`Apify run ${runId} finished with status: ${status}`);
}

/**
 * Fetch dataset items from a completed Apify run.
 */
async function fetchDatasetItems(token: string, runId: string): Promise<ApifyProductResult[]> {
  const response = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`
  );
  if (!response.ok) throw new Error(`Failed to fetch dataset: ${response.status}`);
  return await response.json();
}

function mapToProduct(item: ApifyProductResult): AmazonProduct {
  return {
    asin: item.asin,
    title: item.title || "Unknown Product",
    url: `https://${AMAZON_MARKETPLACE}/dp/${item.asin}?tag=${AMAZON_AFFILIATE_TAG}`,
    imageUrl: item.thumbnailImage || "",
    price: item.price?.displayPrice || "Price not available",
    priceValue: item.price?.value || 0,
    listPrice: item.listPrice || "",
    rating: item.stars || 0,
    reviewCount: item.reviewsCount || 0,
    isPrime: item.isPrime || false,
    features: item.features || [],
    brand: item.brand || "",
    description: item.description || "",
  };
}

export interface ApifySearchResult {
  products: AmazonProduct[];
  metadata: {
    runId: string;
    runUrl: string;
    elapsedMs: number;
    status: string;
  };
}

export async function searchProductsViaApify(keyword: string, maxResults: number = 3): Promise<ApifySearchResult> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");

  console.log(`[Apify Amazon] Searching for: "${keyword}" (max ${maxResults})`);

  const startTime = Date.now();
  try {
    const searchUrl = `https://${AMAZON_MARKETPLACE}/s?k=${encodeURIComponent(keyword)}`;
    const { runId, status } = await startRunAndWait(APIFY_TOKEN, {
      categoryUrls: [{ url: searchUrl }],
      maxItemsPerStartUrl: maxResults,
      maxPagesPerStartUrl: 1,
    });
    const elapsedMs = Date.now() - startTime;

    console.log(`[Apify Amazon] Run ${runId} succeeded in ${Math.round(elapsedMs / 1000)}s`);
    const items = await fetchDatasetItems(APIFY_TOKEN, runId);
    console.log(`[Apify Amazon] Got ${items.length} results for "${keyword}"`);

    return {
      products: items.slice(0, maxResults).map(mapToProduct),
      metadata: {
        runId,
        runUrl: `https://console.apify.com/actors/runs/${runId}`,
        elapsedMs,
        status,
      },
    };
  } catch (error: any) {
    console.error(`[Apify Amazon] Search error: ${error.message}`);
    throw error;
  }
}

export async function getProductByAsinViaApify(asin: string): Promise<AmazonProduct | null> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");

  console.log(`[Apify Amazon] Fetching product ASIN: ${asin}`);

  try {
    const { runId } = await startRunAndWait(APIFY_TOKEN, {
      startUrls: [{ url: `https://${AMAZON_MARKETPLACE}/dp/${asin}` }],
      country: "US",
      maxItemsPerStartUrl: 1,
      proxyConfiguration: { useApifyProxy: true },
    });

    const items = await fetchDatasetItems(APIFY_TOKEN, runId);
    if (items.length === 0) return null;

    const product = mapToProduct(items[0]);
    product.asin = product.asin || asin;
    product.url = `https://${AMAZON_MARKETPLACE}/dp/${product.asin || asin}?tag=${AMAZON_AFFILIATE_TAG}`;
    return product;
  } catch (error: any) {
    console.error(`[Apify Amazon] ASIN lookup error: ${error.message}`);
    return null;
  }
}

export function isApifyAvailable(): boolean {
  return !!getApifyToken();
}
