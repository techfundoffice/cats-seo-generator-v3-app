import path from 'path';
import { createRequire } from 'module';

const _require = createRequire(__filename);
const sdkPath = path.join(__dirname, '../lib/amazon-creatorsapi/dist/index');
const { ApiClient, DefaultApi, SearchItemsRequestContent, GetItemsRequestContent } = _require(sdkPath);

interface AmazonProduct {
  asin: string;
  title: string;
  price: string;
  priceValue: number;
  imageUrl: string;
  detailPageUrl: string;
  availability: string;
  rating?: number;
  reviewCount?: number;
  features?: string[];
}

interface AmazonSearchResult {
  products: AmazonProduct[];
  totalResults: number;
  searchUrl: string;
}

const AMAZON_TAG = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
const CREDENTIAL_ID = process.env.AMAZON_CREDENTIAL_ID;
const CREDENTIAL_SECRET = process.env.AMAZON_API_SECRET;
const CREDENTIAL_VERSION = '2.1';
const MARKETPLACE = 'www.amazon.com';

let apiClient: any = null;
let api: any = null;

function initializeApi() {
  if (!CREDENTIAL_ID || !CREDENTIAL_SECRET) {
    console.warn('[Amazon API] Missing credentials - API not initialized');
    return false;
  }
  
  if (api) return true;
  
  try {
    apiClient = new ApiClient();
    apiClient.credentialId = CREDENTIAL_ID;
    apiClient.credentialSecret = CREDENTIAL_SECRET;
    apiClient.version = CREDENTIAL_VERSION;
    api = new DefaultApi(apiClient);
    console.log('[Amazon API] Initialized successfully');
    return true;
  } catch (error) {
    console.error('[Amazon API] Failed to initialize:', error);
    return false;
  }
}

export async function searchAmazonProducts(
  keywords: string,
  category: string = 'All',
  itemCount: number = 3
): Promise<AmazonSearchResult> {
  if (!initializeApi()) {
    return {
      products: [],
      totalResults: 0,
      searchUrl: `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}&tag=${AMAZON_TAG}`
    };
  }
  
  try {
    const searchRequest = new SearchItemsRequestContent();
    searchRequest.partnerTag = AMAZON_TAG;
    searchRequest.keywords = keywords;
    searchRequest.searchIndex = category;
    searchRequest.itemCount = Math.min(itemCount, 10);
    searchRequest.resources = [
      'images.primary.large',
      'images.primary.medium',
      'itemInfo.title',
      'itemInfo.features',
      'offersV2.listings.price',
      'offersV2.listings.availability',
      'offersV2.listings.condition',
      'customerReviews.starRating',
      'customerReviews.count'
    ];
    
    const response = await api.searchItems(MARKETPLACE, { searchItemsRequestContent: searchRequest });
    
    if (!response || !response.searchResult || !response.searchResult.items) {
      console.log('[Amazon API] No results for:', keywords);
      return {
        products: [],
        totalResults: 0,
        searchUrl: `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}&tag=${AMAZON_TAG}`
      };
    }
    
    const products: AmazonProduct[] = response.searchResult.items.map((item: any) => {
      const price = item.offersV2?.listings?.[0]?.price;
      const priceDisplay = price?.displayAmount || 'See Price';
      const priceValue = price?.amount || 0;
      
      return {
        asin: item.asin,
        title: item.itemInfo?.title?.displayValue || 'Unknown Product',
        price: priceDisplay,
        priceValue: priceValue,
        imageUrl: item.images?.primary?.large?.url || item.images?.primary?.medium?.url || '',
        detailPageUrl: item.detailPageUrl || `https://www.amazon.com/dp/${item.asin}?tag=${AMAZON_TAG}`,
        availability: item.offersV2?.listings?.[0]?.availability?.message || 'Check Availability',
        rating: item.customerReviews?.starRating?.value,
        reviewCount: item.customerReviews?.count,
        features: item.itemInfo?.features?.displayValues || []
      };
    });
    
    console.log(`[Amazon API] Found ${products.length} products for: ${keywords}`);
    
    return {
      products,
      totalResults: response.searchResult.totalResultCount || products.length,
      searchUrl: `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}&tag=${AMAZON_TAG}`
    };
  } catch (error: any) {
    console.error('[Amazon API] Search error:', error.message || error);
    return {
      products: [],
      totalResults: 0,
      searchUrl: `https://www.amazon.com/s?k=${encodeURIComponent(keywords)}&tag=${AMAZON_TAG}`
    };
  }
}

export async function getAmazonProduct(asin: string): Promise<AmazonProduct | null> {
  if (!initializeApi()) {
    return null;
  }
  
  try {
    const getItemsRequest = new GetItemsRequestContent();
    getItemsRequest.partnerTag = AMAZON_TAG;
    getItemsRequest.itemIds = [asin];
    getItemsRequest.resources = [
      'images.primary.large',
      'itemInfo.title',
      'itemInfo.features',
      'offersV2.listings.price',
      'offersV2.listings.availability',
      'customerReviews.starRating',
      'customerReviews.count'
    ];
    
    const response = await api.getItems(MARKETPLACE, { getItemsRequestContent: getItemsRequest });
    
    if (!response || !response.itemsResult || !response.itemsResult.items?.length) {
      return null;
    }
    
    const item = response.itemsResult.items[0];
    const price = item.offersV2?.listings?.[0]?.price;
    
    return {
      asin: item.asin,
      title: item.itemInfo?.title?.displayValue || 'Unknown Product',
      price: price?.displayAmount || 'See Price',
      priceValue: price?.amount || 0,
      imageUrl: item.images?.primary?.large?.url || '',
      detailPageUrl: item.detailPageUrl || `https://www.amazon.com/dp/${item.asin}?tag=${AMAZON_TAG}`,
      availability: item.offersV2?.listings?.[0]?.availability?.message || 'Check Availability',
      rating: item.customerReviews?.starRating?.value,
      reviewCount: item.customerReviews?.count,
      features: item.itemInfo?.features?.displayValues || []
    };
  } catch (error: any) {
    console.error('[Amazon API] GetItem error:', error.message || error);
    return null;
  }
}

export function buildAmazonAffiliateUrl(productName: string): string {
  const searchQuery = encodeURIComponent(productName);
  return `https://www.amazon.com/s?k=${searchQuery}&tag=${AMAZON_TAG}`;
}

export function buildAmazonAsinUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}?tag=${AMAZON_TAG}`;
}

export { AMAZON_TAG };
