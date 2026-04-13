import { Router, Request, Response } from 'express';
import * as cheerio from 'cheerio';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import { secrets } from '../services/doppler-secrets';
import { generateWithClaudeAgentSdk } from '../services/claude-agent-sdk-client';
import { claudeAgentGenerate } from '../services/vercel-ai-gateway';
import { getOnPageScoreWithRetry, categorizeSEOIssues } from '../services/dataforseo-client';
import { generateArticleImages, getImageQuotaStatus, GeneratedImage } from '../services/cloudflare-image-gen';
import { calculateSEOScore } from '../services/seo-score';
import { runPostPublishQualityControl } from '../services/post-publish-qc';
// V3: Indexing Tracker Integration (autonomous index verification)
import { initIndexTracker, trackNewArticle, processIndexQueue, getIndexStatus, forceRecheck, initKVConfig, cleanupOldItems } from '../services/indexing-tracker';
// V3: Skill Engine Integration
import { SkillEngine } from '../services/skill-engine';
import { ResearchEngine, createResearchEngine, ResearchPhaseStatus } from '../services/research-engine';
import { getDeploymentRecommendation, QUALITY_GATES } from '../config/seo-skills';
import type { CategoryContext, ResearchPhaseOutput, KeywordData } from '../types/category-context';
import { createEmptyResearchPhaseOutput, createEmptyCategoryContext } from '../types/category-context';
import {
  ALL_KEYWORDS,
  getKeywords,
  getKeywordStats,
  keywordToSlug,
  getAuthorForTopic,
  autoLink,
  EXPERT_AUTHORS,
  CREDIBLE_SOURCES,
  SEO_THRESHOLDS,
  ENTITIES,
  bulkRegisterArticles,
  registerArticleForLinking,
  getRelatedArticles,
  getInternalLinkCount,
  enforceSEOLimits,
  notifyIndexNow,
  getIndexNowKey
} from '../data/seo-data';
import {
  getPrioritizedKeywords,
  getNextKeyword,
  PrioritizedKeyword
} from '../data/keyword-priorities';
import { searchAmazonProducts, AMAZON_TAG } from '../services/amazon-products';
import { repairJson } from 'json-repair-js';
import { searchProductsViaApify, isApifyAvailable, type ApifySearchResult } from '../services/apify-amazon';
import { saveGenerationRecord, saveErrorRecord, appendPageSpeedToHistory, updateCategoryProgress, type GenerationRecord, type ErrorRecord } from '../services/generation-history';

// Lazy-load google-search-console to avoid 20+ second startup delay from googleapis
let gscModule: any = null;
async function getGSCModule() {
  if (!gscModule) {
    gscModule = await import('../services/google-search-console');
  }
  return gscModule;
}
async function notifyGoogleOfNewArticle(slug: string): Promise<{ success: boolean; message: string; sitemap?: any; indexing?: any; timestamp?: string }> {
  const gsc = await getGSCModule();
  return gsc.notifyGoogleOfNewArticle(slug);
}

async function validateArticleRichResults(articleUrl: string): Promise<{ valid: boolean; detectedTypes: string[]; warnings: string[]; errors: string[] }> {
  const gsc = await getGSCModule();
  return gsc.validateRichResults(articleUrl);
}

const router = Router();

// Dynamic year - automatically uses current year
const CURRENT_YEAR = new Date().getFullYear();

// ============================================================================
// Track keywords currently being processed by workers (prevents race conditions)
const keywordsInProgress: Set<string> = new Set();

// PageSpeed Result Interface (defined early for queue system)
// ============================================================================

interface PageSpeedResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  coreWebVitals: {
    lcp: number;
    cls: number;
    tbt: number;
    fcp: number;
    si: number;
    ttfb: number;
  };
  opportunities: Array<{
    title: string;
    description: string;
    savings: string;
  }>;
  fetchedAt: string;
}

// ============================================================================
// PageSpeed Rate Limiter - Prevents 429 errors with queue and exponential backoff
// ============================================================================

interface PageSpeedQueueItem {
  url: string;
  strategy: 'mobile' | 'desktop';
  articleSlug: string;
  originalHtml: string;
  kvKey: string;
  context: CategoryContext | null;
  retryCount: number;
  addedAt: number;
}

const pageSpeedQueue: PageSpeedQueueItem[] = [];
let pageSpeedLastCall = 0;
let pageSpeedProcessing = false;
const PAGESPEED_MIN_INTERVAL = 120000; // 120 seconds between checks
const PAGESPEED_MAX_RETRIES = 3;
const PAGESPEED_BACKOFF_BASE = 120000; // Start with 2 minute backoff for 429s
const AI_GENERATION_TIMEOUT_MS = 120000; // 2 minutes for AI generation calls

function queuePageSpeedCheck(item: Omit<PageSpeedQueueItem, 'retryCount' | 'addedAt'>) {
  pageSpeedQueue.push({
    ...item,
    retryCount: 0,
    addedAt: Date.now()
  });
  console.log(`[PageSpeed Queue] Added: ${item.articleSlug} (queue size: ${pageSpeedQueue.length})`);
  processPageSpeedQueue();
}

async function processPageSpeedQueue() {
  if (pageSpeedProcessing || pageSpeedQueue.length === 0) return;
  
  const now = Date.now();
  const timeSinceLastCall = now - pageSpeedLastCall;
  
  if (timeSinceLastCall < PAGESPEED_MIN_INTERVAL) {
    const waitTime = PAGESPEED_MIN_INTERVAL - timeSinceLastCall;
    console.log(`[PageSpeed Queue] Rate limited, waiting ${Math.round(waitTime/1000)}s (${pageSpeedQueue.length} in queue)`);
    setTimeout(processPageSpeedQueue, waitTime + 1000);
    return;
  }
  
  pageSpeedProcessing = true;
  const item = pageSpeedQueue.shift()!;
  
  try {
    pageSpeedLastCall = Date.now();
    const pageSpeed = await analyzePageSpeedWithRetry(item.url, item.strategy, item.retryCount);
    
    console.log(`[SEO-V3] 🚀 PageSpeed: ${pageSpeed.scores.performance}/100 perf, ${pageSpeed.scores.seo}/100 seo, LCP ${pageSpeed.coreWebVitals.lcp}ms`);
    
    if (pageSpeed.scores.performance < 70) {
      console.log(`[SEO-V3] ⚠️ Performance ${pageSpeed.scores.performance}/100 - applying auto-optimizations...`);
      
      const optimizedHtml = optimizeArticleHtml(item.originalHtml);
      
      const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
      if (cfApiToken) {
        const redeployUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(item.kvKey)}`;
        await fetch(redeployUrl, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
          body: optimizedHtml
        });
        console.log(`[SEO-V3] ✨ Redeployed optimized version: ${item.kvKey}`);
        
        addActivityLog('success', `[V3] Optimized HTML deployed`, {
          url: item.url,
          originalPerformance: pageSpeed.scores.performance
        });
      }
    } else if (pageSpeed.coreWebVitals.lcp > 4000) {
      console.log(`[SEO-V3] ⚠️ LCP too slow (${pageSpeed.coreWebVitals.lcp}ms) - may hurt rankings`);
    }
    
    addActivityLog('info', `[V3] PageSpeed: Perf ${pageSpeed.scores.performance}/100 | SEO ${pageSpeed.scores.seo}/100 | A11y ${pageSpeed.scores.accessibility}/100 | BP ${pageSpeed.scores.bestPractices}/100 | LCP ${pageSpeed.coreWebVitals.lcp}ms | CLS ${pageSpeed.coreWebVitals.cls} | TBT ${pageSpeed.coreWebVitals.tbt}ms`, {
      url: item.url,
      performance: pageSpeed.scores.performance,
      seo: pageSpeed.scores.seo,
      accessibility: pageSpeed.scores.accessibility,
      bestPractices: pageSpeed.scores.bestPractices,
      lcp: pageSpeed.coreWebVitals.lcp,
      cls: pageSpeed.coreWebVitals.cls,
      tbt: pageSpeed.coreWebVitals.tbt,
      fcp: pageSpeed.coreWebVitals.fcp,
      ttfb: pageSpeed.coreWebVitals.ttfb
    });

    // Persist PageSpeed to generation history
    try {
      appendPageSpeedToHistory(item.articleSlug, {
        performance: pageSpeed.scores.performance,
        seo: pageSpeed.scores.seo,
        accessibility: pageSpeed.scores.accessibility,
        bestPractices: pageSpeed.scores.bestPractices,
        lcp: pageSpeed.coreWebVitals.lcp,
        cls: pageSpeed.coreWebVitals.cls,
        tbt: pageSpeed.coreWebVitals.tbt,
      });
    } catch (_) { /* ignore history write errors */ }

  } catch (err: any) {
    if (err.message?.includes('429') && item.retryCount < PAGESPEED_MAX_RETRIES) {
      const backoffTime = PAGESPEED_BACKOFF_BASE * Math.pow(2, item.retryCount);
      console.log(`[PageSpeed Queue] 429 rate limited, retrying in ${Math.round(backoffTime/1000)}s (attempt ${item.retryCount + 1}/${PAGESPEED_MAX_RETRIES})`);
      
      setTimeout(() => {
        pageSpeedQueue.push({
          ...item,
          retryCount: item.retryCount + 1
        });
        processPageSpeedQueue();
      }, backoffTime);
    } else {
      console.log(`[PageSpeed Queue] Skipped: ${item.articleSlug} - ${err.message}`);
    }
  }
  
  pageSpeedProcessing = false;
  
  if (pageSpeedQueue.length > 0) {
    setTimeout(processPageSpeedQueue, PAGESPEED_MIN_INTERVAL);
  }
}

async function analyzePageSpeedWithRetry(url: string, strategy: 'mobile' | 'desktop', retryCount: number): Promise<PageSpeedResult> {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  const keyParam = googleApiKey ? `&key=${googleApiKey}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices${keyParam}`;
  
  console.log(`[PageSpeed] Analyzing ${url} (${strategy})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}${googleApiKey ? ' [with API key]' : ' [no API key]'}...`);
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`PageSpeed API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const lighthouse = data.lighthouseResult;
  
  if (!lighthouse) {
    throw new Error('No Lighthouse results in response');
  }
  
  const opportunities: PageSpeedResult['opportunities'] = [];
  const opportunityAudits = [
    'render-blocking-resources', 'unused-css-rules', 'unused-javascript',
    'modern-image-formats', 'offscreen-images', 'efficient-animated-content'
  ];
  
  for (const auditId of opportunityAudits) {
    const audit = lighthouse.audits?.[auditId];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        title: audit.title || auditId,
        description: audit.description || '',
        savings: audit.displayValue || 'Potential savings'
      });
    }
  }
  
  return {
    url,
    strategy,
    scores: {
      performance: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
      accessibility: Math.round((lighthouse.categories?.accessibility?.score || 0) * 100),
      bestPractices: Math.round((lighthouse.categories?.['best-practices']?.score || 0) * 100),
      seo: Math.round((lighthouse.categories?.seo?.score || 0) * 100)
    },
    coreWebVitals: {
      lcp: Math.round(lighthouse.audits?.['largest-contentful-paint']?.numericValue || 0),
      cls: parseFloat((lighthouse.audits?.['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      tbt: Math.round(lighthouse.audits?.['total-blocking-time']?.numericValue || 0),
      fcp: Math.round(lighthouse.audits?.['first-contentful-paint']?.numericValue || 0),
      si: Math.round(lighthouse.audits?.['speed-index']?.numericValue || 0),
      ttfb: Math.round(lighthouse.audits?.['server-response-time']?.numericValue || 0)
    },
    opportunities,
    fetchedAt: new Date().toISOString()
  };
}

// ============================================================================
// Free PAA (People Also Ask) / Related Questions Fetcher
// Uses Google Autocomplete API (free, no API key required)
// ============================================================================

interface RelatedQuestion {
  question: string;
  source: 'autocomplete' | 'generated';
}

/**
 * Fetch real Google Autocomplete suggestions for a keyword
 * This is FREE and requires no API key
 */
async function fetchGoogleAutocomplete(keyword: string): Promise<string[]> {
  try {
    const queries = [
      keyword,
      `${keyword} cost`,
      `${keyword} worth it`,
      `${keyword} vs`,
      `how much ${keyword}`,
      `what is ${keyword}`,
      `best ${keyword}`,
      `${keyword} reviews`
    ];

    const allSuggestions: string[] = [];

    for (const query of queries.slice(0, 4)) { // Limit to 4 to be fast
      try {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data) && Array.isArray(data[1])) {
            allSuggestions.push(...data[1].filter((s: string) => s.includes('?') || s.length > 20));
          }
        }
      } catch (e) {
        // Silently continue on individual failures
      }
    }

    return [...new Set(allSuggestions)].slice(0, 10);
  } catch (error) {
    console.log('[PAA] Autocomplete fetch failed, using fallback');
    return [];
  }
}

/**
 * Generate PAA-style questions based on keyword patterns
 * Fallback when autocomplete doesn't return enough questions
 */
function generatePAAQuestions(keyword: string): string[] {
  const patterns = [
    `What is the average cost of ${keyword}?`,
    `Is ${keyword} worth the money?`,
    `Which company offers the best ${keyword}?`,
    `How do I choose ${keyword}?`,
    `What does ${keyword} cover?`,
    `Are there any ${keyword} that cover pre-existing conditions?`,
    `How much is ${keyword} per month?`,
    `What is not covered by ${keyword}?`,
    `When should I get ${keyword}?`,
    `Can I get ${keyword} for an older pet?`
  ];

  return patterns;
}

/**
 * Fetch real "People Also Ask" style questions for SEO optimization
 * Combines Google Autocomplete + intelligent generation
 */
async function fetchPAAQuestions(keyword: string): Promise<RelatedQuestion[]> {
  const questions: RelatedQuestion[] = [];

  // Try Google Autocomplete first (real data)
  const autocomplete = await fetchGoogleAutocomplete(keyword);
  
  // Filter for question-like suggestions
  const questionWords = ['how', 'what', 'which', 'is', 'are', 'does', 'do', 'can', 'should', 'why', 'when', 'where'];
  
  for (const suggestion of autocomplete) {
    const lower = suggestion.toLowerCase();
    if (questionWords.some(w => lower.startsWith(w)) || suggestion.includes('?')) {
      questions.push({ question: suggestion, source: 'autocomplete' });
    }
  }

  // Add generated questions if we don't have enough
  if (questions.length < 8) {
    const generated = generatePAAQuestions(keyword);
    for (const q of generated) {
      if (questions.length >= 8) break;
      if (!questions.some(existing => existing.question.toLowerCase() === q.toLowerCase())) {
        questions.push({ question: q, source: 'generated' });
      }
    }
  }

  console.log(`[PAA] Found ${questions.filter(q => q.source === 'autocomplete').length} real questions, ${questions.filter(q => q.source === 'generated').length} generated`);
  return questions.slice(0, 8);
}

// ============================================================================
// GitHub Copilot SDK Integration (True SDK, not CLI wrapper)
// Uses CopilotClient -> createSession() -> sendAndWait()
// ============================================================================

let CopilotClientClass: any = null;
let defineTool: any = null;
let sdkLoaded = false;
let sdkError: string | null = null;

// ============================================================================
// YouTube Video Search for SEO Articles
// Uses Python youtube_search library to find relevant videos
// ============================================================================

interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
  duration: string;
  durationISO: string;
  channel: string;
  views: string;
  viewCount: number;
  published: string;
  publishedISO: string;
  thumbnailUrl: string;
  embedUrl: string;
  watchUrl: string;
}

interface YouTubeSearchResult {
  success: boolean;
  keyword?: string;
  count?: number;
  videos?: YouTubeVideo[];
  error?: string;
}

/**
 * Search YouTube for relevant videos
 * Calls Python script that uses youtube_search library (no API key needed)
 */
async function searchYouTubeVideo(keyword: string): Promise<YouTubeSearchResult> {
  try {
    const scriptPath = path.resolve(process.cwd(), 'src/services/youtube-search.py');
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', [scriptPath, keyword], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('YouTube search timeout after 15s')); }, 15000);
      child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`YouTube search exited ${code}: ${stderr}`)); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    return JSON.parse(result.trim());
  } catch (error: any) {
    console.log(`⚠️ [YouTube] Search failed for "${keyword}":`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// V3 Video Search Funnel - 5-Level Relevance-Based Video Discovery
// See .github/skills/video-search-funnel/SKILL.md for full specification
// ============================================================================

const CATEGORY_SEARCH_TERMS: Record<string, string[]> = {
  'cat-food-delivery-services': ['best cat food brands review', 'cat food review', 'healthy cat food guide'],
  'cat-trees-furniture': ['cat tree review', `best cat trees ${CURRENT_YEAR}`, 'cat furniture tour'],
  'cat-dna-testing': ['cat DNA test results', 'cat breed test review', 'cat genetics explained'],
  'cat-grooming': ['cat grooming tutorial', 'how to groom cat at home', 'cat brushing tips'],
  'cat-litter-boxes': ['best cat litter box review', 'self cleaning litter box', 'cat litter comparison'],
  'cat-health': ['cat health tips vet', 'cat wellness check', 'healthy cat signs'],
  'cat-nutrition': ['cat nutrition guide', 'what to feed your cat', 'cat diet tips'],
  'cat-toys': ['best cat toys review', 'interactive cat toys', 'cat toy comparison'],
  'cat-beds': ['best cat beds review', 'cozy cat bed tour', 'cat sleeping spots'],
  'cat-carriers': ['cat carrier review', 'best cat carrier travel', 'cat travel tips'],
  'cat-trees-condos': ['cat condo review', `best cat condos ${CURRENT_YEAR}`, 'cat climbing tower'],
};

const FUNNY_CAT_CONTEXT_ACTIONS: Record<string, string[]> = {
  'cat-food-delivery-services': ['eating', 'food reaction', 'treats', 'hungry cat'],
  'cat-nutrition': ['eating', 'food', 'mealtime', 'treats reaction'],
  'cat-trees-furniture': ['climbing', 'jumping', 'falling off tree', 'tower fails'],
  'cat-trees-condos': ['climbing fails', 'jumping', 'cat tower', 'climbing'],
  'cat-beds': ['sleeping', 'napping', 'cozy', 'bed fails'],
  'cat-grooming': ['bath time', 'grooming fails', 'brushing reaction', 'spa day'],
  'cat-litter-boxes': ['bathroom', 'litter box', 'digging'],
  'cat-dna-testing': ['breed reveal', 'personality', 'smart cat'],
  'cat-health': ['vet visit', 'medicine time', 'check up'],
  'DEFAULT': [`compilation ${CURRENT_YEAR}`, 'fails', 'cute moments', 'being weird'],
};

// ============================================================================
// V3 CATEGORY-SPECIFIC CONTENT DATA
// Dynamic authors, brands, images, FAQs, and external links per category
// Prevents hardcoded DNA testing content from appearing in litter box articles
// ============================================================================

interface CategoryContentData {
  author: { name: string; title: string; credentials: string; bio: string };
  brands: string[];
  comparisonHeaders: string[];
  comparisonRows: string[][];
  imageAltTemplates: string[];
  imageCaptions: string[];
  faqTemplates: { question: string; answerHint: string }[];
  externalLinks: { url: string; text: string; context: string }[];
}

const CATEGORY_CONTENT_DATA: Record<string, CategoryContentData> = {
  'cat-automatic-litter-box-cleaners': {
    author: { 
      name: 'Dr. Jennifer Adams', 
      title: 'Pet Product Reviewer', 
      credentials: 'DVM, 12+ years reviewing cat products',
      bio: 'Veterinarian and expert product reviewer specializing in cat hygiene and automated pet products.'
    },
    brands: ['Litter-Robot 4', 'PetSafe ScoopFree', 'Whisker Litter-Robot', 'CatGenie', 'PetKit Pura Max'],
    comparisonHeaders: ['Product', 'Noise Level', 'Capacity', 'Smart Features'],
    comparisonRows: [
      ['Litter-Robot 4', '< 40 dB', '8+ lbs cats', 'WiFi, App, Health Tracking'],
      ['PetSafe ScoopFree', '< 45 dB', '15 lbs cats', 'Crystal Trays, Odor Control'],
      ['CatGenie', '< 50 dB', '6+ lbs cats', 'Self-Washing, Flushable'],
      ['PetKit Pura Max', '< 38 dB', '18 lbs cats', 'App Control, Deodorizer'],
      ['Whisker Litter-Robot 3', '< 42 dB', '7+ lbs cats', 'WiFi, Night Light']
    ],
    imageAltTemplates: ['automatic litter box {keyword}', 'self-cleaning litter box {keyword}', 'cat using automatic litter box'],
    imageCaptions: ['Modern automatic litter box for hassle-free cleaning.', 'Self-cleaning technology keeps your home fresh.', 'Smart litter box with app connectivity.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how it works' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $189-$699' },
      { question: 'Is {keyword} worth the investment?', answerHint: 'Time savings vs cost analysis' },
      { question: 'How loud is {keyword}?', answerHint: 'Decibel levels 38-50 dB' },
      { question: 'What size cats can use {keyword}?', answerHint: 'Weight limits by model' },
      { question: 'How often should I clean {keyword}?', answerHint: 'Maintenance schedule' },
      { question: 'Do cats like {keyword}?', answerHint: 'Transition tips and acceptance rates' },
      { question: 'What litter works best with {keyword}?', answerHint: 'Clumping vs crystal litter compatibility' }
    ],
    externalLinks: [
      { url: 'https://www.litter-robot.com', text: 'Litter-Robot Official', context: 'Link in comparison section' },
      { url: 'https://www.petsafe.net', text: 'PetSafe Official', context: 'Link in comparison section' },
      { url: 'https://www.petkit.com', text: 'PetKit Official', context: 'Link in comparison section' }
    ]
  },
  'cat-trees-furniture': {
    author: { 
      name: 'Sarah Thompson', 
      title: 'Cat Behavior Specialist', 
      credentials: 'CCBC, 15+ years in feline enrichment',
      bio: 'Certified cat behavior consultant specializing in feline environmental enrichment and cat furniture design.'
    },
    brands: ['Frisco', 'Feandrea', 'Go Pet Club', 'Armarkat', 'TRIXIE'],
    comparisonHeaders: ['Brand', 'Height', 'Weight Capacity', 'Key Features'],
    comparisonRows: [
      ['Frisco', '48-72"', '40+ lbs', 'Sisal Posts, Condos, Platforms'],
      ['Feandrea', '54-67"', '35+ lbs', 'Multi-Level, Hammocks, Caves'],
      ['Go Pet Club', '50-77"', '45+ lbs', 'Ladders, Baskets, Scratching Posts'],
      ['Armarkat', '50-78"', '30+ lbs', 'Fleece Covering, Perches'],
      ['TRIXIE', '48-65"', '50+ lbs', 'Scratching Surfaces, Toys']
    ],
    imageAltTemplates: ['cat tree {keyword}', 'cat furniture {keyword}', 'cat climbing tower {keyword}'],
    imageCaptions: ['Multi-level cat tree for active cats.', 'Premium cat furniture with scratching posts.', 'Cozy cat condo for rest and play.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and benefits' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $40-$300' },
      { question: 'What height {keyword} is best?', answerHint: 'Based on cat size and room space' },
      { question: 'How to choose {keyword} for multiple cats?', answerHint: 'Platforms and weight capacity' },
      { question: 'How to assemble {keyword}?', answerHint: 'Tools and time needed' },
      { question: 'How durable is {keyword}?', answerHint: 'Materials and lifespan' },
      { question: 'Can {keyword} tip over?', answerHint: 'Stability and anchoring tips' },
      { question: 'What features matter most in {keyword}?', answerHint: 'Scratching posts, perches, condos' }
    ],
    externalLinks: [
      { url: 'https://www.chewy.com/b/cat-trees-condos-scratchers-312', text: 'Chewy Cat Trees', context: 'Link in comparison section' },
      { url: 'https://www.amazon.com/cat-trees', text: 'Amazon Cat Trees', context: 'Link in comparison section' },
      { url: 'https://www.petco.com/shop/en/petcostore/category/cat/cat-furniture', text: 'Petco Cat Furniture', context: 'Link in comparison section' }
    ]
  },
  'cat-dna-testing': {
    author: { 
      name: 'Dr. Sarah Mitchell', 
      title: 'Feline Geneticist', 
      credentials: 'PhD in Animal Genetics',
      bio: 'Expert in feline genetics and cat DNA testing with over 10 years of research experience.'
    },
    brands: ['Basepaws', 'Wisdom Panel', 'Orivet', 'MyCatDNA', 'Optimal Selection'],
    comparisonHeaders: ['Provider', 'Breeds Tested', 'Health Markers', 'Turnaround'],
    comparisonRows: [
      ['Basepaws', '21+ breeds', '40+ markers', '4-6 weeks'],
      ['Wisdom Panel', '70+ breeds', '25+ markers', '2-3 weeks'],
      ['Orivet', '18+ breeds', '200+ markers', '2-3 weeks'],
      ['MyCatDNA', '22+ breeds', '40+ markers', '3-4 weeks'],
      ['Optimal Selection', '28 breeds', '40+ markers', '2-3 weeks']
    ],
    imageAltTemplates: ['cat DNA testing {keyword}', 'feline genetics {keyword}', 'cat breed test {keyword}'],
    imageCaptions: ['Understanding your cat\'s genetic makeup.', 'DNA testing reveals breed and health insights.', 'Discover your cat\'s unique genetic story.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how DNA tests work' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $89-$299' },
      { question: 'How accurate is {keyword}?', answerHint: 'Accuracy stats 95%+' },
      { question: 'Which is best for {keyword}?', answerHint: 'Top recommendation' },
      { question: 'How long do {keyword} results take?', answerHint: 'Turnaround 2-6 weeks' },
      { question: 'Is {keyword} worth it?', answerHint: 'Value analysis' },
      { question: 'What breeds can be detected?', answerHint: 'Number of breeds detected' },
      { question: 'Are there health insights?', answerHint: 'Health markers overview' }
    ],
    externalLinks: [
      { url: 'https://basepaws.com', text: 'Basepaws Cat DNA Test', context: 'Link in comparison section' },
      { url: 'https://www.wisdompanel.com', text: 'Wisdom Panel', context: 'Link in comparison section' }
    ]
  },
  'cat-food-delivery-services': {
    author: { 
      name: 'Dr. Amanda Chen', 
      title: 'Veterinary Nutritionist', 
      credentials: 'DVM, Diplomate ACVN',
      bio: 'Board-certified veterinary nutritionist specializing in feline dietary needs and premium cat food.'
    },
    brands: ['Smalls', 'The Farmer\'s Dog', 'Nom Nom', 'Ollie', 'Open Farm'],
    comparisonHeaders: ['Brand', 'Food Type', 'Delivery Frequency', 'Key Features'],
    comparisonRows: [
      ['Smalls', 'Fresh/Freeze-Dried', 'Bi-weekly', 'Human-Grade, Cat-Specific'],
      ['Nom Nom', 'Fresh Cooked', 'Weekly', 'Vet-Formulated, Portioned'],
      ['Ollie', 'Fresh Cooked', 'Bi-weekly', 'Human-Grade, Custom Recipes'],
      ['The Farmer\'s Dog', 'Fresh Cooked', 'Bi-weekly', 'Human-Grade, USDA Certified'],
      ['Open Farm', 'Dry/Wet', 'Monthly', 'Ethically Sourced, Sustainable']
    ],
    imageAltTemplates: ['cat food delivery {keyword}', 'fresh cat food {keyword}', 'premium cat food subscription {keyword}'],
    imageCaptions: ['Fresh cat food delivered to your door.', 'Premium cat nutrition made easy.', 'Healthy meals for your feline friend.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how it works' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $1-$6/day' },
      { question: 'Is {keyword} worth it?', answerHint: 'Quality vs convenience analysis' },
      { question: 'How often is {keyword} delivered?', answerHint: 'Delivery schedules' },
      { question: 'Is {keyword} healthy for cats?', answerHint: 'Nutritional benefits' },
      { question: 'Can I customize {keyword}?', answerHint: 'Customization options' },
      { question: 'How long does {keyword} stay fresh?', answerHint: 'Storage and shelf life' },
      { question: 'Which {keyword} is best for picky eaters?', answerHint: 'Taste preferences' }
    ],
    externalLinks: [
      { url: 'https://www.smalls.com', text: 'Smalls Cat Food', context: 'Link in comparison section' },
      { url: 'https://www.nomnomnow.com', text: 'Nom Nom Fresh Pet Food', context: 'Link in comparison section' }
    ]
  },
  'DEFAULT': {
    author: { 
      name: 'Lisa Park', 
      title: 'Cat Care Expert', 
      credentials: 'CPDT-KA, 10+ years in pet care',
      bio: 'Professional cat care specialist with expertise in feline wellness and product recommendations.'
    },
    brands: ['Top Brand 1', 'Top Brand 2', 'Top Brand 3', 'Top Brand 4', 'Top Brand 5'],
    comparisonHeaders: ['Brand', 'Features', 'Quality', 'Rating'],
    comparisonRows: [
      ['Top Brand 1', 'Premium Features', 'High', '4.8/5'],
      ['Top Brand 2', 'Standard Features', 'Good', '4.5/5'],
      ['Top Brand 3', 'Advanced Features', 'High', '4.7/5'],
      ['Top Brand 4', 'Basic Features', 'Standard', '4.2/5'],
      ['Top Brand 5', 'Pro Features', 'Premium', '4.9/5']
    ],
    imageAltTemplates: ['cat product {keyword}', 'cat care {keyword}', 'cat supplies {keyword}'],
    imageCaptions: ['Quality cat products for your feline.', 'Expert-recommended cat supplies.', 'The best in cat care.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and overview' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price range overview' },
      { question: 'Is {keyword} worth it?', answerHint: 'Value analysis' },
      { question: 'What are the best options for {keyword}?', answerHint: 'Top recommendations' },
      { question: 'How to choose {keyword}?', answerHint: 'Selection criteria' },
      { question: 'Where to buy {keyword}?', answerHint: 'Purchase options' },
      { question: 'How does {keyword} compare?', answerHint: 'Comparison overview' },
      { question: 'What should I know about {keyword}?', answerHint: 'Key considerations' }
    ],
    externalLinks: [
      { url: 'https://www.aspca.org/pet-care/cat-care', text: 'ASPCA Cat Care', context: 'Authoritative cat care guidance' },
      { url: 'https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center', text: 'Cornell Feline Health Center', context: 'Veterinary research and feline health' },
      { url: 'https://www.avma.org/resources-tools/pet-owners/petcare', text: 'AVMA Pet Care', context: 'American Veterinary Medical Association guidance' }
    ]
  }
};

const UNIVERSAL_AUTHORITY_LINKS = [
  { url: 'https://www.aspca.org/pet-care/cat-care', text: 'ASPCA Cat Care Guide', domain: 'aspca.org' },
  { url: 'https://www.vet.cornell.edu/departments-centers-and-institutes/cornell-feline-health-center', text: 'Cornell Feline Health Center', domain: 'cornell.edu' },
  { url: 'https://www.avma.org/resources-tools/pet-owners/petcare', text: 'AVMA Pet Owner Resources', domain: 'avma.org' },
  { url: 'https://www.humanesociety.org/resources/cat-care', text: 'Humane Society Cat Care', domain: 'humanesociety.org' },
  { url: 'https://icatcare.org/advice/', text: 'International Cat Care', domain: 'icatcare.org' }
];

function getCategoryContentData(categorySlug: string): CategoryContentData {
  const normalizedSlug = categorySlug.toLowerCase()
    .replace(/&amp;/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-+/g, '-');
  
  return CATEGORY_CONTENT_DATA[normalizedSlug] || CATEGORY_CONTENT_DATA['DEFAULT'];
}

/**
 * Fetch real Amazon products for a keyword and format for comparison table
 * Returns formatted data for AI prompt and product schema
 */
interface AmazonProductData {
  products: Array<{
    name: string;
    price: string;
    priceValue: number;
    listPrice: string;
    asin: string;
    url: string;
    imageUrl: string;
    rating: string;
    reviewCount: number;
    isPrime: boolean;
    features: string;
    featuresList: string[];
    brand: string;
    description: string;
    amazonSearch: string;
  }>;
  comparisonRows: string[][];
  productSchemaItems: object[];
  promptText: string;
}

async function fetchAmazonProductsForKeyword(keyword: string, category: string = 'All'): Promise<AmazonProductData> {
  const emptyResult: AmazonProductData = {
    products: [],
    comparisonRows: [],
    productSchemaItems: [],
    promptText: ''
  };

  // Helper: convert raw product list to AmazonProductData format
  function formatProductData(rawProducts: Array<{
    title: string; price: string; priceValue?: number; listPrice?: string;
    asin: string; detailPageUrl?: string; url?: string; imageUrl?: string; rating?: number;
    features?: string[]; brand?: string; description?: string;
    reviewCount?: number; isPrime?: boolean;
  }>): AmazonProductData {
    const products = rawProducts.map(p => ({
      name: p.title,
      price: p.price,
      priceValue: p.priceValue || 0,
      listPrice: p.listPrice || '',
      asin: p.asin,
      url: p.detailPageUrl || p.url || `https://www.amazon.com/dp/${p.asin}?tag=${AMAZON_TAG}`,
      imageUrl: p.imageUrl || '',
      rating: p.rating ? `${p.rating}/5` : '4.5/5',
      reviewCount: p.reviewCount || 0,
      isPrime: p.isPrime || false,
      features: p.features?.length ? p.features.slice(0, 5).join('; ') : 'Premium quality',
      featuresList: p.features || [],
      brand: p.brand || '',
      description: p.description || '',
      amazonSearch: p.title.replace(/[^a-zA-Z0-9\s]/g, '').split(' ').slice(0, 5).join('+')
    }));

    const comparisonRows = products.map(p => [
      p.brand ? `${p.name} by ${p.brand}` : p.name,
      p.price || 'Check Price',
      p.features,
      p.reviewCount > 0 ? `${p.rating} (${p.reviewCount.toLocaleString()} reviews)` : p.rating,
      p.amazonSearch
    ]);

    const productSchemaItems = products.map((p, index) => ({
      "@type": "ListItem" as const,
      "position": index + 1,
      "item": {
        "@type": "Product" as const,
        "name": p.name.length > 70 ? p.name.substring(0, 67) + '...' : p.name,
        "description": p.description || `${p.name} - ${p.features}`,
        "image": p.imageUrl || undefined,
        "brand": p.brand ? { "@type": "Brand" as const, "name": p.brand } : undefined,
        "sku": p.asin,
        "offers": {
          "@type": "Offer" as const,
          "price": p.priceValue.toString(),
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": p.url,
          "shippingDetails": {
            "@type": "OfferShippingDetails" as const,
            "shippingDestination": {
              "@type": "DefinedRegion" as const,
              "addressCountry": "US"
            },
            "deliveryTime": {
              "@type": "ShippingDeliveryTime" as const,
              "businessDays": {
                "@type": "QuantitativeValue" as const,
                "minValue": 1,
                "maxValue": p.isPrime ? 2 : 5
              }
            },
            "shippingRate": {
              "@type": "MonetaryAmount" as const,
              "value": p.isPrime ? "0" : "5.99",
              "currency": "USD"
            }
          },
          "hasMerchantReturnPolicy": {
            "@type": "MerchantReturnPolicy" as const,
            "applicableCountry": "US",
            "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
            "merchantReturnDays": 30,
            "returnMethod": "https://schema.org/ReturnByMail",
            "returnFees": "https://schema.org/FreeReturn"
          }
        },
        "aggregateRating": p.rating ? {
          "@type": "AggregateRating" as const,
          "ratingValue": p.rating.replace('/5', ''),
          "bestRating": "5",
          "reviewCount": p.reviewCount > 0 ? p.reviewCount.toString() : undefined
        } : undefined
      }
    }));

    const promptText = `
REAL AMAZON PRODUCTS — WRITE YOUR ARTICLE AROUND THESE PRODUCTS:
${products.map((p, i) => {
  const lines = [`${i + 1}. "${p.name}" — ${p.price} (ASIN: ${p.asin})`];
  if (p.brand) lines.push(`   Brand: ${p.brand}`);
  if (p.listPrice && p.listPrice !== p.price) lines.push(`   Was: ${p.listPrice} (discounted)`);
  lines.push(`   Rating: ${p.rating} (${p.reviewCount > 0 ? p.reviewCount.toLocaleString() + ' reviews' : 'new product'})`);
  if (p.isPrime) lines.push(`   ✓ Amazon Prime eligible`);
  if (p.featuresList.length > 0) {
    lines.push(`   Key Features:`);
    p.featuresList.slice(0, 5).forEach(f => lines.push(`     • ${f}`));
  }
  if (p.description) lines.push(`   Description: ${p.description.substring(0, 300)}`);
  lines.push(`   URL: ${p.url}`);
  return lines.join('\n');
}).join('\n\n')}

INSTRUCTIONS: Reference these products BY NAME throughout your article sections.
Mention specific features, prices, and review counts when discussing products.
The comparison table is handled separately — focus on weaving product details into your content.
Do NOT make up products. Do NOT include comparison tables in article sections.
`;

    return { products, comparisonRows, productSchemaItems, promptText };
  }

  // Tier 1: Apify Amazon Crawler (fast, reliable)
  if (isApifyAvailable()) {
    try {
      console.log(`[Amazon] Tier 1: Fetching via Apify for: "${keyword}"`);
      addActivityLog('info', `[V3] Apify: Starting Amazon search for "${keyword}"`, { keyword });
      const apifyResult = await searchProductsViaApify(keyword, 3);
      const { products: apifyProducts, metadata } = apifyResult;

      addActivityLog('info', `[V3] Apify run ${metadata.runId}: ${metadata.status} in ${Math.round(metadata.elapsedMs / 1000)}s — ${apifyProducts.length} products`, {
        runId: metadata.runId,
        runUrl: metadata.runUrl,
        status: metadata.status,
        elapsedMs: metadata.elapsedMs,
        productCount: apifyProducts.length,
        keyword,
      });

      if (apifyProducts.length > 0) {
        const isCatCategory = /cat|kitten|feline/i.test(keyword) || /cat|kitten|feline/i.test(category);
        let filteredProducts = apifyProducts;
        if (isCatCategory) {
          const stopWords = new Set(['for', 'the', 'a', 'an', 'in', 'on', 'with', 'and', 'of', 'to', 'is', 'best', 'top', 'how']);
          const keywordWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));
          const keywordLower = keyword.toLowerCase();

          filteredProducts = apifyProducts.filter(p => {
            const title = (p.title || '').toLowerCase();

            const isDog = /\bdog\b|\bpuppy\b|\bpuppies\b|\bcanine\b/.test(title) && !/\bcat\b|\bkitten\b|\bfeline\b/.test(title);
            if (isDog) {
              console.log(`[Amazon] ⚠️ Filtered out dog product: "${p.title}"`);
              return false;
            }

            const isFish = /\bfish\b|\baquarium\b|\bfish tank\b|\baquatic\b/.test(title);
            if (isFish) {
              console.log(`[Amazon] ⚠️ Filtered out fish product: "${p.title}"`);
              return false;
            }

            if ((keywordLower.includes('feeder') || keywordLower.includes('food')) && /\blitter\b|\blitter box\b/.test(title)) {
              console.log(`[Amazon] ⚠️ Filtered out off-category product (litter for feeder/food keyword): "${p.title}"`);
              return false;
            }
            if (keywordLower.includes('litter') && /\bfeeder\b|\bfood bowl\b/.test(title)) {
              console.log(`[Amazon] ⚠️ Filtered out off-category product (feeder for litter keyword): "${p.title}"`);
              return false;
            }

            if (keywordWords.length > 0) {
              const hasKeywordMatch = keywordWords.some(w => title.includes(w));
              if (!hasKeywordMatch) {
                console.log(`[Amazon] ⚠️ Filtered out irrelevant product (no keyword match): "${p.title}"`);
                return false;
              }
            }

            return true;
          });
        }

        if (filteredProducts.length < 3 && isCatCategory && filteredProducts.length < apifyProducts.length) {
          console.log(`[Amazon] Only ${filteredProducts.length} relevant cat products after filtering, retrying with refined query...`);
          try {
            const refinedKeyword = keyword.replace(/step by step|how to|guide|best|top/gi, '').trim() + ' for cats';
            const retryResult = await searchProductsViaApify(refinedKeyword, 3);
            const retryProducts = retryResult.products.filter(p => {
              const title = (p.title || '').toLowerCase();
              if (/\bdog\b|\bpuppy\b|\bpuppies\b|\bcanine\b/.test(title) && !/\bcat\b|\bkitten\b|\bfeline\b/.test(title)) return false;
              if (/\bfish\b|\baquarium\b|\bfish tank\b|\baquatic\b/.test(title)) return false;
              return true;
            });
            if (retryProducts.length > filteredProducts.length) {
              console.log(`[Amazon] Retry found ${retryProducts.length} cat-relevant products with "${refinedKeyword}"`);
              filteredProducts = retryProducts;
            }
          } catch (retryErr: any) {
            console.warn(`[Amazon] Retry search failed: ${retryErr.message}`);
          }
        }

        if (filteredProducts.length > 0) {
          console.log(`[Amazon] Tier 1: Found ${filteredProducts.length} relevant products via Apify`);
          addActivityLog('success', `[V3] Apify: Found ${filteredProducts.length} Amazon products (${filteredProducts.map(p => p.asin).join(', ')})`, {
            keyword,
            asins: filteredProducts.map(p => p.asin),
            runId: metadata.runId,
          });
          return formatProductData(filteredProducts.map(p => ({
            title: p.title,
            price: p.price,
            priceValue: p.priceValue,
            listPrice: p.listPrice,
            asin: p.asin,
            detailPageUrl: p.url,
            imageUrl: p.imageUrl,
            rating: p.rating,
            reviewCount: p.reviewCount,
            isPrime: p.isPrime,
            features: p.features,
            brand: p.brand,
            description: p.description,
          })));
        }
      }
      console.log(`[Amazon] Tier 1: No products found via Apify`);
      addActivityLog('warning', `[V3] Apify: 0 products returned for "${keyword}" (run ${metadata.runId})`, { keyword, runId: metadata.runId });
    } catch (error: any) {
      console.warn(`[Amazon] Tier 1 (Apify) failed: ${error.message}`);
      addActivityLog('error', `[V3] Apify failed: ${error.message}`, { keyword, error: error.message });
    }
  } else {
    console.log(`[Amazon] Tier 1: Apify not available (no APIFY_TOKEN), skipping to Tier 2`);
  }

  // Tier 2: Amazon Creators API fallback
  try {
    console.log(`[Amazon] Tier 2: Trying Creators API for: "${keyword}"`);
    const result = await searchAmazonProducts(keyword, category, 3);

    if (result.products && result.products.length > 0) {
      console.log(`[Amazon] Tier 2: Found ${result.products.length} products via Creators API`);
      return formatProductData(result.products);
    }
    console.log(`[Amazon] Tier 2: No products found via Creators API`);
  } catch (error: any) {
    console.warn(`[Amazon] Tier 2 (Creators API) failed: ${error.message}`);
  }

  console.log(`[Amazon] All tiers exhausted for: "${keyword}"`);
  return emptyResult;
}

/**
 * Get category-specific product guidance for the AI
 * This helps the AI understand what types of real products exist for each category
 * WITHOUT hardcoding specific products - the AI uses its training knowledge
 */
function getCategoryProductExamples(categorySlug: string, keyword: string): string {
  const categoryGuidance: Record<string, string> = {
    'cat-carriers-travel-products': `
For CAT CARRIERS, popular brands include: Sherpa, Petmate, Sleepypod, Catit, Bergan, AmazonBasics, Necoichi, Mr. Peanut's.
Example product format: "Sherpa Original Deluxe Pet Carrier - Medium" with price ~$40-60
Consider: airline-approved carriers, soft-sided vs hard-sided, backpack carriers, expandable carriers.`,

    'cat-calming-anxiety-products': `
For CAT CALMING PRODUCTS, popular brands include: Feliway, Comfort Zone, ThunderEase, Pet Naturals, VetriScience, Zesty Paws, NaturVet.
Example product format: "Feliway Classic Calming Diffuser Starter Kit" with price ~$25-40
Consider: pheromone diffusers, calming collars, treats/chews, sprays, supplements.`,

    'cat-litter-boxes': `
For CAT LITTER BOXES, popular brands include: Litter-Robot, PetSafe, Nature's Miracle, Catit, Van Ness, Petmate, IRIS USA, Modkat.
Example product format: "IRIS USA Top Entry Cat Litter Box" with price ~$25-45
Consider: covered/hooded, top-entry, self-cleaning/automatic, high-sided, corner designs.`,

    'cat-automatic-litter-box-cleaners': `
For AUTOMATIC LITTER BOXES, popular brands include: Litter-Robot, PetSafe ScoopFree, CatGenie, PetKit, Whisker, Casa Leo.
Example product format: "Litter-Robot 4 Automatic Self-Cleaning Litter Box" with price ~$500-700
Consider: WiFi-enabled, health tracking, multiple cat capacity, noise level, maintenance.`,

    'cat-trees-furniture': `
For CAT TREES & FURNITURE, popular brands include: Frisco, Feandrea, Go Pet Club, Armarkat, TRIXIE, Yaheetech, Hey-brother.
Example product format: "Frisco 72-Inch Cat Tree with Hammock" with price ~$80-150
Consider: height, weight capacity, scratching posts, condos, platforms, hammocks.`,

    'cat-dna-testing': `
For CAT DNA TESTS, popular brands include: Basepaws, Wisdom Panel, Orivet, MyCatDNA, Optimal Selection.
Example product format: "Basepaws Cat DNA Test Kit - Breed + Health" with price ~$129-199
Consider: breeds detected, health markers, turnaround time, accuracy.`,

    'cat-food-delivery-services': `
For CAT FOOD DELIVERY, popular brands include: Smalls, Nom Nom, Ollie, The Farmer's Dog, Open Farm, Tiki Cat, Weruva.
Example product format: "Smalls Fresh Cat Food Subscription - Chicken Recipe" with price ~$2-5/day
Consider: fresh vs freeze-dried, subscription frequency, customization, ingredients.`,

    'cat-toys-interactive': `
For INTERACTIVE CAT TOYS, popular brands include: Kong, Catit, SmartyKat, Petstages, PetFusion, Frisco, Potaroma, BENTOPAL.
Example product format: "Catit Senses 2.0 Digger Interactive Cat Toy" with price ~$15-30
Consider: electronic toys, laser toys, feather wands, puzzle toys, ball tracks, motion-activated toys.`,

    'cat-grooming-tools': `
For CAT GROOMING TOOLS, popular brands include: Furminator, Hertzko, Safari, Chris Christensen, JW Pet, Li'l Pals, Burt's Bees, Wahl.
Example product format: "Furminator Undercoat Deshedding Tool for Cats" with price ~$20-35
Consider: deshedding tools, slicker brushes, nail clippers, grooming gloves, dematting combs, bathing supplies.`,

    'cat-travel-accessories': `
For CAT TRAVEL ACCESSORIES, popular brands include: Sleepypod, Sturdibag, Pet Gear, Sherpa, Catit, MidWest, petisfam, Lil Back Bracer.
Example product format: "Sleepypod Mobile Pet Bed & Carrier" with price ~$100-200
Consider: carriers, car seats, travel litter boxes, harnesses, water bottles, portable bowls, anxiety wraps.`,

    'cat-training-products': `
For CAT TRAINING PRODUCTS, popular brands include: PetSafe, SSSCat, Karen Pryor, Catit, SmartCat, Downtown Pet Supply, Frisco.
Example product format: "PetSafe SSSCAT Motion-Activated Spray Deterrent" with price ~$20-40
Consider: clicker trainers, deterrent sprays, scratching post trainers, treat dispensers, training pads.`,

    'cat-senior-care': `
For CAT SENIOR CARE, popular brands include: Cosequin, Feliway, PetFusion, K&H Pet Products, Purina Pro Plan, Hill's Science Diet, VetriScience.
Example product format: "Cosequin Joint Health Supplement for Cats" with price ~$15-30
Consider: joint supplements, heated beds, orthopedic beds, senior food, water fountains, ramps, calming aids.`,

    'cat-dental-care': `
For CAT DENTAL CARE, popular brands include: Virbac, Greenies, TropiClean, Oxyfresh, Petsmile, Arm & Hammer, Vet's Best.
Example product format: "Virbac C.E.T. Enzymatic Cat Toothpaste" with price ~$10-20
Consider: toothpaste, toothbrushes, dental treats, water additives, dental wipes, plaque removers.`,

    'cat-outdoor-enclosures': `
For CAT OUTDOOR ENCLOSURES, popular brands include: Outback Jack, Kittywalk, PawHut, Aivituvin, COZIWOW, Petmate, Prevue Pet.
Example product format: "Kittywalk Penthouse Outdoor Cat Enclosure" with price ~$100-300
Consider: catios, window box enclosures, tunnel systems, portable playpens, DIY kits, weatherproof enclosures.`,

    'cat-puzzle-feeders': `
For CAT PUZZLE FEEDERS, popular brands include: Catit Senses, Trixie, Doc & Phoebe, LickiMat, Nina Ottosson, PetSafe, Frisco.
Example product format: "Trixie 5-in-1 Activity Center for Cats" with price ~$15-35
Consider: slow feeders, food puzzles, treat dispensers, lick mats, snuffle mats, foraging toys.`,

    'cat-calming-products': `
For CAT CALMING PRODUCTS, popular brands include: Feliway, ThunderEase, Pet Naturals, Zesty Paws, NaturVet, Comfort Zone, Rescue Remedy.
Example product format: "Feliway Classic Calming Diffuser Kit" with price ~$20-40
Consider: pheromone diffusers, calming collars, anxiety treats, calming sprays, supplements, thunder shirts.`,

    'cat-subscription-boxes': `
For CAT SUBSCRIPTION BOXES, popular brands include: KitNipBox, meowbox, CatLadyBox, Rescue Box, The Catnip Times, PetGiftBox.
Example product format: "KitNipBox Happy Cat Monthly Subscription" with price ~$20-35/month
Consider: toy boxes, treat boxes, themed boxes, multi-cat options, eco-friendly boxes, luxury boxes.`,

    'DEFAULT': `
For "${keyword}", think of the TOP 5 most popular products sold on Amazon for this category.
Use your knowledge of real brands and products that cat owners actually buy.
Include a mix of premium and budget-friendly options with realistic prices.`
  };

  const slug = categorySlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return categoryGuidance[slug] || categoryGuidance['DEFAULT'];
}

function buildFallbackComparisonTable(categorySlug: string, keyword: string): { headers: string[]; rows: string[][] } {
  const amazonTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
  const fallbackProducts: Record<string, Array<[string, string, string, string]>> = {
    'cat-senior-care': [
      ['Cosequin Joint Health Supplement for Cats', '$14.99', 'Glucosamine & chondroitin, sprinkle capsule, #1 vet recommended', '4.6'],
      ['Purina Pro Plan Senior Cat Food - Chicken', '$24.99', 'High protein, real chicken, supports immune health, easy digest', '4.7'],
      ['K&H Pet Products Heated Cat Bed', '$39.99', 'Orthopedic foam, 6-watt heater, machine washable, indoor use', '4.5'],
      ['VetriScience Vetri Lysine Plus for Cats', '$12.99', 'Immune support, lysine supplement, chicken liver flavor, soft chews', '4.4'],
      ['PetFusion BetterBox Non-Stick Litter Box', '$34.95', 'Low entry for seniors, non-stick coating, large size, easy clean', '4.3'],
    ],
    'cat-grooming-tools-kits': [
      ['Furminator Undercoat Deshedding Tool for Cats', '$24.99', 'Reduces shedding up to 90%, stainless steel edge, ergonomic handle', '4.6'],
      ['Hertzko Self-Cleaning Slicker Brush', '$15.99', 'Retractable bristles, gentle on skin, removes tangles & loose fur', '4.5'],
      ['Safari Professional Nail Trimmer for Cats', '$6.99', 'Stainless steel, safety guard, non-slip grip, sharp precision', '4.4'],
      ['Burt\'s Bees Waterless Cat Shampoo Spray', '$8.99', 'Natural ingredients, pH balanced, apple & rosemary, no rinse needed', '4.5'],
      ['Pet Grooming Glove - Gentle Deshedding Brush', '$9.99', 'Five-finger design, gentle massage, works on all coat types', '4.3'],
    ],
    'cat-cameras-monitors': [
      ['Petcube Cam Indoor Wi-Fi Pet Camera', '$39.99', '1080p HD, night vision, 2-way audio, motion alerts, free cloud', '4.3'],
      ['Wyze Cam v3 Pet Camera', '$35.98', 'Color night vision, motion detection, 2-way audio, IP65 rated', '4.5'],
      ['Furbo 360° Dog/Cat Camera with Treat Tossing', '$149.99', '360° view, treat tossing, barking alerts, 1080p, 2-way audio', '4.2'],
      ['Blink Mini Indoor Smart Security Camera', '$29.99', '1080p HD, motion detection, 2-way audio, works with Alexa', '4.4'],
      ['eufy Pet Camera with AI Tracking', '$39.99', '2K resolution, AI pet detection, 360° pan & tilt, local storage', '4.4'],
    ],
    'cat-insurance-plans': [
      ['Lemonade Pet Insurance for Cats', '$10/mo', 'AI-powered claims, 90% reimbursement, customizable deductible', '4.5'],
      ['Healthy Paws Cat Insurance', '$15/mo', 'No caps on payouts, fast claims, covers hereditary conditions', '4.7'],
      ['Trupanion Cat Insurance', '$25/mo', 'Direct vet payment, 90% coverage, no payout limits per condition', '4.4'],
      ['ASPCA Pet Health Insurance for Cats', '$12/mo', 'Wellness add-on, 10% multi-pet discount, customizable plans', '4.3'],
      ['Embrace Pet Insurance for Cats', '$18/mo', 'Diminishing deductible, dental coverage, wellness rewards', '4.5'],
    ],
    'cat-harnesses-leashes': [
      ['rabbitgoo Cat Harness and Leash Set', '$16.99', 'Escape-proof, adjustable, reflective strips, breathable mesh', '4.3'],
      ['Kitty Holster Cat Harness', '$29.95', 'Undyed cotton, escape-proof, velcro closure, made in USA', '4.4'],
      ['PetSafe Come With Me Kitty Harness', '$12.99', 'Bungee leash, shoulder/chest fit, gentle steering, lightweight', '4.2'],
      ['Voyager Step-In Air Cat Harness', '$14.99', 'All-weather mesh, step-in design, reflective bands, breathable', '4.4'],
      ['Catit Nylon Adjustable Cat Harness', '$9.99', 'Figure-8 design, lightweight nylon, adjustable girth, budget pick', '4.1'],
    ],
    'cat-carriers-travel-products': [
      ['Sherpa Original Deluxe Pet Carrier - Medium', '$44.99', 'Airline-approved, mesh panels, machine washable, locking zippers', '4.5'],
      ['Sleepypod Mobile Pet Bed & Carrier', '$189.99', 'Crash-tested, converts to bed, premium materials, safety certified', '4.6'],
      ['Catit Cabrio Cat Carrier', '$29.99', 'Top & front loading, ventilated, easy clean, airline-compatible', '4.4'],
      ['Pet Magasin Hard Cover Cat Carrier', '$29.99', 'Collapsible, top-load, ventilation holes, easy storage', '4.3'],
      ['PetAmi Deluxe Cat Carrier Backpack', '$39.99', 'Ventilated design, safety buckle, padded straps, breathable mesh', '4.4'],
    ],
    'cat-litter-boxes': [
      ['IRIS USA Top Entry Cat Litter Box', '$24.99', 'Top entry reduces tracking, includes scoop, grooved lid, large', '4.4'],
      ['Modkat Flip Litter Box', '$54.99', 'Reusable liner, 3 lid positions, modern design, easy cleaning', '4.3'],
      ['Nature\'s Miracle Hooded Corner Litter Box', '$19.99', 'Corner design saves space, charcoal filter, antimicrobial', '4.2'],
      ['Van Ness Enclosed Cat Litter Pan', '$15.99', 'Odor-controlling door, replaceable filter, easy snap-on hood', '4.3'],
      ['Petmate Booda Dome Cleanstep Litter Box', '$29.99', 'Dome shape, built-in staircase, reduces tracking, charcoal filter', '4.1'],
    ],
    'cat-toys-interactive': [
      ['Catit Senses 2.0 Digger Interactive Cat Toy', '$16.99', 'Stimulates natural foraging, multiple difficulty tubes, easy clean', '4.4'],
      ['SmartyKat Hot Pursuit Cat Toy', '$19.99', 'Concealed motion, erratic movement, 2 speeds, battery operated', '4.3'],
      ['PetFusion Ambush Interactive Cat Toy', '$24.95', 'Electronic feather, random patterns, auto shutoff, timer modes', '4.3'],
      ['Potaroma Flopping Fish Cat Toy', '$11.99', 'USB rechargeable, realistic motion, catnip included, plush', '4.2'],
      ['BENTOPAL Automatic Cat Toy Ball', '$16.99', 'Smart obstacle avoidance, LED light, auto on/off, USB charging', '4.3'],
    ],
    'cat-trees-furniture': [
      ['Frisco 72-Inch Cat Tree with Hammock', '$89.99', 'Multiple platforms, sisal posts, hammock, condo, large cats OK', '4.4'],
      ['Feandrea 56-Inch Multi-Level Cat Tree', '$69.99', 'Plush perches, scratching posts, removable cover, sturdy base', '4.5'],
      ['Go Pet Club 62-Inch Cat Tree', '$64.99', 'Faux fur, sisal rope posts, multiple condos, ladder, budget pick', '4.3'],
      ['Armarkat Classic Cat Tree A7202', '$79.99', 'Pressed wood, faux fleece, multiple levels, 2 condos, durable', '4.4'],
      ['TRIXIE Baza Cat Tree', '$49.99', 'Modern design, sisal wrapped, plush cushion, wall-mountable', '4.2'],
    ],
  };

  const slug = categorySlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const products = fallbackProducts[slug];
  
  if (products && products.length > 0) {
    const rows = products.map(([name, price, features, rating]) => [
      name, price, features, rating, name.replace(/[^a-zA-Z0-9\s]/g, '').split(' ').slice(0, 5).join('+')
    ]);
    return { headers: ['Product Name', 'Price', 'Key Features', 'Rating', 'Amazon Search'], rows };
  }

  const genericProducts = [
    ['Top Rated Cat Product #1', '$24.99', 'Highly rated, vet recommended, premium quality', '4.5'],
    ['Best Value Cat Product', '$14.99', 'Budget-friendly, great reviews, durable design', '4.3'],
    ['Premium Cat Product', '$39.99', 'Professional grade, long-lasting, top seller', '4.6'],
    ['Popular Cat Product Pick', '$19.99', 'Best seller, easy to use, cat-approved', '4.4'],
    ['Editor\'s Choice Cat Product', '$29.99', 'Award-winning, innovative design, highly rated', '4.5'],
  ];
  const keywordTerms = keyword.replace(/[^a-zA-Z0-9\s]/g, '').split(' ').slice(0, 4).join('+');
  const rows = genericProducts.map(([name, price, features, rating]) => [
    name, price, features, rating, keywordTerms
  ]);
  return { headers: ['Product Name', 'Price', 'Key Features', 'Rating', 'Amazon Search'], rows };
}

const NEGATIVE_VIDEO_KEYWORDS = ['insurance', 'sad', 'death', 'died', 'rip', 'abuse', 'rescue abandoned', 'injured', 'scary', 'horror', 'attack', 'fight'];

interface VideoFunnelResult {
  video: YouTubeVideo | undefined;
  level: number;
  searchQuery: string;
  fallbackUsed: boolean;
}

function parseDurationToSeconds(duration: string): number {
  if (!duration) return 0;
  const parts = duration.split(':').reverse();
  let seconds = 0;
  if (parts[0]) seconds += parseInt(parts[0], 10) || 0;
  if (parts[1]) seconds += (parseInt(parts[1], 10) || 0) * 60;
  if (parts[2]) seconds += (parseInt(parts[2], 10) || 0) * 3600;
  return seconds;
}

const DOG_ONLY_REGEX = /\bdog(s)?\b/i;
const CAT_REGEX = /\bcat(s)?\b/i;

function isVideoRelevant(video: YouTubeVideo, category: string): boolean {
  const title = video.title.toLowerCase();
  
  if (category !== 'petinsurance' && (title.includes('insurance') || title.includes('pet insurance'))) {
    return false;
  }
  
  if (DOG_ONLY_REGEX.test(title) && !CAT_REGEX.test(title)) {
    return false;
  }
  
  for (const negWord of NEGATIVE_VIDEO_KEYWORDS) {
    if (category !== 'petinsurance' && negWord === 'insurance') continue;
    if (title.includes(negWord)) {
      return false;
    }
  }
  
  if (video.viewCount && video.viewCount < 500) {
    return false;
  }
  
  const durationSecs = parseDurationToSeconds(video.duration);
  if (durationSecs > 0 && durationSecs < 30) {
    return false;
  }
  
  return true;
}

function isFunnyVideoValid(video: YouTubeVideo): boolean {
  const title = video.title.toLowerCase();
  
  if (title.includes('insurance') || title.includes('pet insurance')) {
    return false;
  }
  
  if (DOG_ONLY_REGEX.test(title) && !CAT_REGEX.test(title)) {
    return false;
  }
  
  for (const negWord of NEGATIVE_VIDEO_KEYWORDS) {
    if (negWord === 'insurance') continue;
    if (title.includes(negWord)) {
      return false;
    }
  }
  
  if (video.viewCount && video.viewCount < 500) {
    return false;
  }
  
  const durationSecs = parseDurationToSeconds(video.duration);
  if (durationSecs > 0 && durationSecs < 30) {
    return false;
  }
  
  return true;
}

async function searchVideoFunnel(keyword: string, category: string): Promise<VideoFunnelResult> {
  const categorySlug = category.toLowerCase().replace(/\s+/g, '-');

  const level1Query = keyword;
  console.log(`[Video Funnel] L1: "${level1Query}"`);
  let result = await searchYouTubeVideo(level1Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 1, searchQuery: level1Query, fallbackUsed: false };
    }
  }

  const categoryTerms = categorySlug.replace(/-/g, ' ');
  const level2Query = `${categoryTerms} ${keyword} review`;
  console.log(`[Video Funnel] L2: "${level2Query}"`);
  result = await searchYouTubeVideo(level2Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 2, searchQuery: level2Query, fallbackUsed: false };
    }
  }

  const categorySearchTerms = CATEGORY_SEARCH_TERMS[categorySlug] || CATEGORY_SEARCH_TERMS['cat-health'] || [`cat care tips ${CURRENT_YEAR}`];
  const level3Query = categorySearchTerms[0];
  console.log(`[Video Funnel] L3: "${level3Query}"`);
  result = await searchYouTubeVideo(level3Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 3, searchQuery: level3Query, fallbackUsed: false };
    }
  }

  let broadTopic = 'cat care';
  if (categorySlug.includes('food') || categorySlug.includes('nutrition')) broadTopic = 'cat feeding guide';
  else if (categorySlug.includes('tree') || categorySlug.includes('furniture') || categorySlug.includes('condo')) broadTopic = 'cat furniture';
  else if (categorySlug.includes('dna') || categorySlug.includes('breed')) broadTopic = 'cat breeds explained';
  else if (categorySlug.includes('health')) broadTopic = 'cat wellness tips';
  else if (categorySlug.includes('groom')) broadTopic = 'cat grooming';

  const level4Query = `${broadTopic} guide ${CURRENT_YEAR}`;
  console.log(`[Video Funnel] L4: "${level4Query}"`);
  result = await searchYouTubeVideo(level4Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 4, searchQuery: level4Query, fallbackUsed: false };
    }
  }

  const contextActions = FUNNY_CAT_CONTEXT_ACTIONS[categorySlug] || FUNNY_CAT_CONTEXT_ACTIONS['DEFAULT'];
  const funnyAction = contextActions[Math.floor(Math.random() * contextActions.length)];
  const level5Query = `funny cat ${funnyAction}`;
  console.log(`[Video Funnel] L5 (funny fallback): "${level5Query}"`);
  result = await searchYouTubeVideo(level5Query);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: level5Query, fallbackUsed: true };
    }
  }

  const ultimateFallback = `funny cats compilation ${CURRENT_YEAR}`;
  console.log(`[Video Funnel] Ultimate fallback: "${ultimateFallback}"`);
  result = await searchYouTubeVideo(ultimateFallback);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: ultimateFallback, fallbackUsed: true };
    }
  }

  const lastResort = 'cute cats being cats';
  console.log(`[Video Funnel] Last resort: "${lastResort}"`);
  result = await searchYouTubeVideo(lastResort);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: lastResort, fallbackUsed: true };
    }
  }

  const viralQueries = [
    'funniest cat videos viral',
    'most viewed cat videos all time',
    'viral cat videos millions views',
    'hilarious cats funny compilation'
  ];

  for (const viralQuery of viralQueries) {
    console.log(`[Video Funnel] 🔥 Viral cat search: "${viralQuery}"`);
    result = await searchYouTubeVideo(viralQuery);
    if (result.success && result.videos?.length) {
      const catVideos = result.videos.filter(v => CAT_REGEX.test(v.title));
      if (catVideos.length > 0) {
        const sortedByViews = catVideos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
        const topVideo = sortedByViews[0];
        console.log(`[Video Funnel] ✅ Found viral cat video: "${topVideo.title}" (${topVideo.viewCount?.toLocaleString() || 'unknown'} views)`);
        return { video: topVideo, level: 6, searchQuery: viralQuery, fallbackUsed: true };
      }
    }
  }

  console.log(`[Video Funnel] ⚠️ No cat video found after all searches - this should never happen`);
  return { video: undefined, level: 0, searchQuery: '', fallbackUsed: false };
}

// Persistent client instance (reused across requests)
let persistentClient: any = null;
let clientStarting = false;

/**
 * Load the @github/copilot-sdk ESM module
 */
async function loadCopilotSDK(): Promise<{ CopilotClient: any; defineTool: any }> {
  if (sdkLoaded) {
    if (sdkError) throw new Error(sdkError);
    return { CopilotClient: CopilotClientClass, defineTool };
  }

  try {
    // Dynamic import for ESM module from CommonJS
    const importFn = new Function('specifier', 'return import(specifier)');
    const sdk = await importFn('@github/copilot-sdk');
    CopilotClientClass = sdk.CopilotClient;
    defineTool = sdk.defineTool;
    sdkLoaded = true;
    console.log('✅ @github/copilot-sdk loaded successfully');
    return { CopilotClient: CopilotClientClass, defineTool };
  } catch (error: any) {
    sdkError = error.message;
    sdkLoaded = true;
    console.error('❌ Failed to load @github/copilot-sdk:', error.message);
    throw error;
  }
}

/**
 * Get or create persistent CopilotClient instance
 * The SDK manages the CLI subprocess internally via JSON-RPC
 */
async function getOrCreateClient(): Promise<any> {
  // Return existing client if running
  if (persistentClient) {
    const state = persistentClient.getState?.();
    if (state === 'connected' || state === 'running') {
      return persistentClient;
    }
  }

  // Prevent concurrent initialization
  if (clientStarting) {
    // Wait for existing initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    return getOrCreateClient();
  }

  clientStarting = true;

  try {
    const { CopilotClient } = await loadCopilotSDK();

    let ghToken: string;
    try {
      const cleanEnv = { ...process.env };
      delete cleanEnv.GITHUB_TOKEN;
      delete cleanEnv.GH_TOKEN;
      delete cleanEnv.COPILOT_GITHUB_TOKEN;

      const { stdout } = await execAsync('gh auth token', {
        encoding: 'utf8',
        env: {
          ...cleanEnv,
          GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || path.join(process.env.HOME || '/home/runner', '.config', 'gh'),
          HOME: process.env.HOME || '/home/runner'
        }
      });
      ghToken = stdout.trim();
      console.log(`🔑 GitHub token acquired (${ghToken.length} chars, starts with ${ghToken.substring(0, 4)})`);
    } catch (e) {
      throw new Error('GitHub auth required. Run: gh auth login');
    }

    // Set environment for the CLI subprocess that SDK spawns
    process.env.GH_TOKEN = ghToken;
    process.env.GITHUB_TOKEN = ghToken;
    process.env.COPILOT_GITHUB_TOKEN = ghToken;
    // Use gh config dir from environment or default to home
    const homeDir = process.env.HOME || '/home/runner';
    process.env.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR || path.join(homeDir, '.config', 'gh');
    process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');

    // Create client - SDK spawns CLI subprocess internally
    persistentClient = new CopilotClient({
      cliPath: process.env.COPILOT_CLI_PATH || 'copilot',
      autoStart: true,
      autoRestart: true,
      logLevel: 'error',
      useStdio: true,
    });

    // Wait for client to be ready
    await persistentClient.start();
    console.log('✅ CopilotClient started (SDK manages CLI via JSON-RPC)');

    return persistentClient;
  } finally {
    clientStarting = false;
  }
}

// Cloudflare KV Configuration (env-configurable, falls back to production defaults)
const CLOUDFLARE_ACCOUNT_ID = secrets.get('CLOUDFLARE_ACCOUNT_ID') || 'bc8e15f958dc350e00c0e39d80ca6941';
const CLOUDFLARE_KV_NAMESPACE_ID = secrets.get('CLOUDFLARE_KV_NAMESPACE_ID') || 'bd3b856b2ae147ada9a8d236dd4baf30';
const CLOUDFLARE_ZONE_ID = secrets.get('CLOUDFLARE_ZONE_ID') || '646da2c86dbbe1dff196c155381b0704';

// V3: Initialize Index Tracker with KV config (lazy init on first use)
let indexTrackerInitialized = false;
async function ensureIndexTrackerInitialized(): Promise<void> {
  if (indexTrackerInitialized) return;
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (cfApiToken) {
    initKVConfig(CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID, cfApiToken);
    await initIndexTracker();
    indexTrackerInitialized = true;
    console.log('[IndexTracker] Initialized with KV config');
  }
}
const CLOUDFLARE_WORKER_NAME = 'petinsurance';

function getZoneAuthHeaders(): Record<string, string> {
  const globalKey = secrets.get('CLOUDFLARE_GLOBAL_API_KEY') || process.env.CLOUDFLARE_GLOBAL_API_KEY || '';
  const email = secrets.get('CLOUDFLARE_EMAIL') || process.env.CLOUDFLARE_EMAIL || '';
  if (globalKey && email) {
    return { 'X-Auth-Email': email, 'X-Auth-Key': globalKey };
  }
  const token = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN || '';
  return { 'Authorization': `Bearer ${token}` };
}

// V3 has its own category tracking, independent from V2
const CATEGORY_STATUS_PREFIX = 'v3:category:status:';

// LEGACY V3 CATEGORIES - kept for route healing reference only
// V3 now uses autonomous Copilot CLI discovery (no static list)
const V3_LEGACY_CATEGORIES = [
  'cat-toys-interactive',
  'cat-grooming-tools',
  'cat-travel-accessories',
  'cat-training-products',
  'cat-senior-care',
  'cat-dental-care',
  'cat-outdoor-enclosures',
  'cat-puzzle-feeders',
  'cat-calming-products',
  'cat-subscription-boxes'
];

// V2 category status prefix - used to check what V2 has completed so V3 avoids overlap
const V2_CATEGORY_STATUS_PREFIX = 'v2:category:status:';

/**
 * Get all V2 completed categories from KV to prevent V3 from overlapping
 */
async function getV2CompletedCategories(): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${V2_CATEGORY_STATUS_PREFIX}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.result || []).map((key: any) => key.name.replace(V2_CATEGORY_STATUS_PREFIX, ''));
  } catch {
    return [];
  }
}

/**
 * Get all V3 categories ever worked on (from KV status keys) - dynamic, not hardcoded
 */
async function getAllV3Categories(): Promise<string[]> {
  return await getAllCategoryStatusKeys();
}

// ============================================================================
// V3 Category Status Tracking (Durable State in KV)
// ============================================================================

interface CategoryStatus {
  category: string;
  status: 'in_progress' | 'completed';
  articleCount: number;
  expectedCount: number;
  avgSeoScore: number;
  startedAt: string;
  completedAt?: string;
}

interface DiscoveredCategory {
  name: string;
  slug: string;
  estimatedKeywords: number;
  affiliatePotential: 'high' | 'medium' | 'low';
  reasoning: string;
}

// NO FALLBACK CATEGORIES - V3 uses fully autonomous discovery via Copilot CLI
// See .github/skills/category-discovery/SKILL.md for discovery prompt standards
// If discovery fails, system enters cooldown and logs error for manual review

const discoveryState = {
  failureCount: 0,
  lastFailure: null as Date | null,
  cooldownUntil: null as Date | null,
  maxRetries: 3,
  cooldownMinutes: 60,
  loaded: false
};

const DISCOVERY_STATE_KEY = 'v3:discovery:state';

async function loadDiscoveryState(): Promise<void> {
  if (discoveryState.loaded) return;
  
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) { discoveryState.loaded = true; return; }
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${DISCOVERY_STATE_KEY}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (res.ok) {
      const saved = JSON.parse(await res.text());
      discoveryState.failureCount = saved.failureCount || 0;
      discoveryState.lastFailure = saved.lastFailure ? new Date(saved.lastFailure) : null;
      discoveryState.cooldownUntil = saved.cooldownUntil ? new Date(saved.cooldownUntil) : null;
    }
  } catch {}
  discoveryState.loaded = true;
}

async function saveDiscoveryState(): Promise<void> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${DISCOVERY_STATE_KEY}`;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        failureCount: discoveryState.failureCount,
        lastFailure: discoveryState.lastFailure?.toISOString() || null,
        cooldownUntil: discoveryState.cooldownUntil?.toISOString() || null
      })
    });
  } catch {}
}

async function saveCategoryStatus(category: string, status: CategoryStatus): Promise<boolean> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.error(`[SEO-V3] ❌ No CLOUDFLARE_API_TOKEN - cannot save category status for ${category}`);
    return false;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${CATEGORY_STATUS_PREFIX}${category}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(status)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      console.error(`[SEO-V3] ❌ KV PUT failed for ${category}: ${res.status} ${res.statusText} - ${errText}`);
      addActivityLog('error', `[V3] KV save failed: ${category} (${res.status})`, { status: status.status });
      return false;
    }
    console.log(`[SEO-V3] ✅ KV confirmed: ${CATEGORY_STATUS_PREFIX}${category} = ${status.status}`);
    addActivityLog('info', `[V3] Category status saved: ${category}`, { status: status.status, articles: status.articleCount });
    return true;
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Failed to save category status for ${category}: ${error.message}`);
    addActivityLog('error', `[V3] KV save error: ${category} - ${error.message}`);
    return false;
  }
}

async function getCategoryStatus(category: string): Promise<CategoryStatus | null> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return null;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${CATEGORY_STATUS_PREFIX}${category}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text) as CategoryStatus;
  } catch {
    return null;
  }
}

async function getCompletedCategories(): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${CATEGORY_STATUS_PREFIX}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as any;
    
    const completed: string[] = [];
    for (const key of data.result || []) {
      const category = key.name.replace(CATEGORY_STATUS_PREFIX, '');
      const status = await getCategoryStatus(category);
      if (status?.status === 'completed') {
        completed.push(category);
      }
    }
    return completed;
  } catch {
    return [];
  }
}

async function countArticlesInCategory(category: string): Promise<number> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return 0;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${category}:`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return 0;
    const data = await res.json() as any;
    return data.result?.length || 0;
  } catch {
    return 0;
  }
}

async function canAttemptDiscovery(): Promise<boolean> {
  if (!discoveryState.loaded) {
    await loadDiscoveryState();
    if (discoveryState.cooldownUntil) {
      discoveryState.failureCount = 0;
      discoveryState.cooldownUntil = null;
      await saveDiscoveryState();
      console.log('[SEO-V3] ✅ Cleared legacy cooldown from KV');
    }
  }
  return true; // Never block — multi-AI cascade handles failures
}

async function recordDiscoveryFailure(): Promise<void> {
  discoveryState.failureCount++;
  discoveryState.lastFailure = new Date();
  // No cooldown — 3-AI cascade handles failures gracefully
}

async function recordDiscoverySuccess(): Promise<void> {
  discoveryState.failureCount = 0;
  discoveryState.lastFailure = null;
  discoveryState.cooldownUntil = null;
  await saveDiscoveryState();
}

async function logDiscoveryError(reason: string): Promise<null> {
  console.error(`[SEO-V3] ❌ Discovery issue: ${reason}`);
  addActivityLog('error', `[V3] Discovery issue: ${reason}`);
  return null;
}

/**
 * Sanitize raw AI output and parse as DiscoveredCategory JSON.
 * Handles control characters that cause JSON.parse crashes.
 */
function sanitizeAndParseDiscoveryJSON(raw: string, allExcluded: string[]): DiscoveredCategory | null {
  // Strip markdown code fences that AIs often wrap JSON in
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  // Remove control chars except \n, \r, \t (which are valid JSON whitespace)
  const sanitized = jsonMatch[0].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  try {
    const cat = JSON.parse(sanitized) as DiscoveredCategory;
    if (!cat.name || !cat.slug) return null;
    if (allExcluded.includes(cat.slug)) {
      console.log(`[SEO-V3] ⚠️ AI suggested already-done category "${cat.slug}" - trying next strategy`);
      return null;
    }
    return cat;
  } catch (e: any) {
    console.log(`[SEO-V3] ⚠️ JSON parse failed after sanitization: ${e.message}`);
    console.log(`[SEO-V3] Raw (first 300 chars): ${sanitized.substring(0, 300)}`);
    return null;
  }
}

/**
 * Compress the full exclusion list into a compact topic-area summary (~2K chars max).
 */
function buildTopicSummary(slugs: string[]): string {
  if (slugs.length === 0) return 'none yet';
  const prefixMap = new Map<string, number>();
  for (const slug of slugs) {
    const parts = slug.split('-');
    const key = parts.slice(0, 3).join('-');
    prefixMap.set(key, (prefixMap.get(key) || 0) + 1);
  }
  const lines = Array.from(prefixMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([prefix, count]) => count > 1 ? `${prefix}-* (${count})` : prefix);
  return `${slugs.length} categories covered. Topic areas:\n${lines.join(', ')}`;
}

/**
 * Build the discovery prompt used by all AI strategies.
 */
function buildDiscoveryPrompt(excludedList: string): string {
  return `You are a cat product SEO researcher. Find the next HIGH-CPC commercial category for catsluvus.com.

COVERED TOPIC AREAS (pick something genuinely different — new product vertical):
${excludedList}

REQUIREMENTS:
1. Must be cat-related (not dogs, not general pets)
2. Must have strong Amazon affiliate potential (physical products)
3. High CPC / commercial intent — buyers searching to purchase
4. Must be a NEW topic area not represented in the covered list above
5. Category slug should be descriptive (e.g., "cat-water-fountains", "cat-beds-blankets")
6. Think about what cat owners actually buy on Amazon

Return ONLY valid JSON (no markdown, no explanation):
{
  "name": "Category Name",
  "slug": "category-slug",
  "estimatedKeywords": 10,
  "affiliatePotential": "high",
  "reasoning": "Brief explanation"
}`;
}

/**
 * Autonomous category discovery via multi-AI cascade.
 * Tries Copilot CLI → Cloudflare AI → OpenRouter. No cooldowns.
 * Discovers the next high-value cat category, excluding:
 * - All V3 completed/in-progress categories
 * - All V2 completed categories (prevents overlap)
 */
async function discoverNextCategory(): Promise<DiscoveredCategory | null> {
  if (!await canAttemptDiscovery()) {
    return logDiscoveryError('Discovery check failed');
  }

  addActivityLog('info', '[V3] Discovering next category (multi-AI cascade)...');

  const v3Completed = await getCompletedCategories();
  const v2Completed = await getV2CompletedCategories();
  const v3InProgress = await getAllCategoryStatusKeys();
  const allExcluded = [...new Set([...v3Completed, ...v2Completed, ...v3InProgress])];
  const excludedList = buildTopicSummary(allExcluded);
  addActivityLog('info', `[V3] Excluding ${allExcluded.length} categories`);

  const prompt = buildDiscoveryPrompt(excludedList);

  // STRATEGY 1: Copilot CLI (GPT-4.1 — best quality)
  try {
    console.log('[SEO-V3] 🔍 Discovery Strategy 1/3: Copilot CLI (GPT-4.1)...');
    const result = await generateWithCopilotCLI(prompt, AI_GENERATION_TIMEOUT_MS, 2);
    const cat = result ? sanitizeAndParseDiscoveryJSON(result, allExcluded) : null;
    if (cat) {
      await recordDiscoverySuccess();
      addActivityLog('success', `[V3] 🎯 Discovered via Copilot: ${cat.name} (${cat.slug})`);
      console.log(`[SEO-V3] ✅ Copilot discovered: ${cat.name} (${cat.slug})`);
      return cat;
    }
    console.log('[SEO-V3] Copilot: no valid category, trying Cloudflare AI...');
  } catch (e: any) {
    console.log(`[SEO-V3] Copilot failed: ${e.message}, trying Cloudflare AI...`);
  }

  // STRATEGY 2: Cloudflare AI (Llama 4 Scout — free, reliable, 4-model cascade)
  try {
    console.log('[SEO-V3] 🔍 Discovery Strategy 2/3: Cloudflare AI...');
    const aiResult = await generateWithClaudeAgentSdk(prompt, { timeout: AI_GENERATION_TIMEOUT_MS });
    const cat = aiResult?.content ? sanitizeAndParseDiscoveryJSON(aiResult.content, allExcluded) : null;
    if (cat) {
      await recordDiscoverySuccess();
      addActivityLog('success', `[V3] 🎯 Discovered via Cloudflare AI: ${cat.name} (${cat.slug})`);
      console.log(`[SEO-V3] ✅ Cloudflare AI discovered: ${cat.name} (${cat.slug})`);
      return cat;
    }
    console.log('[SEO-V3] Cloudflare AI: no valid category, trying OpenRouter...');
  } catch (e: any) {
    console.log(`[SEO-V3] Cloudflare AI failed: ${e.message}, trying OpenRouter...`);
  }

  // STRATEGY 3: OpenRouter (5 free models — Llama, Mistral, Gemma, etc.)
  try {
    console.log('[SEO-V3] 🔍 Discovery Strategy 3/3: OpenRouter (free models)...');
    const result = await generateWithOpenRouter(prompt, AI_GENERATION_TIMEOUT_MS);
    const cat = result ? sanitizeAndParseDiscoveryJSON(result, allExcluded) : null;
    if (cat) {
      await recordDiscoverySuccess();
      addActivityLog('success', `[V3] 🎯 Discovered via OpenRouter: ${cat.name} (${cat.slug})`);
      console.log(`[SEO-V3] ✅ OpenRouter discovered: ${cat.name} (${cat.slug})`);
      return cat;
    }
    console.log('[SEO-V3] OpenRouter: no valid category');
  } catch (e: any) {
    console.log(`[SEO-V3] OpenRouter failed: ${e.message}`);
  }

  // All 3 strategies returned duplicate/failed — retry once with explicit feedback
  const rejectedSlug = await (async () => {
    try {
      const r = await generateWithCopilotCLI(prompt, AI_GENERATION_TIMEOUT_MS, 1);
      return r ? sanitizeAndParseDiscoveryJSON(r, [])?.slug ?? null : null;
    } catch { return null; }
  })();
  if (rejectedSlug) {
    const retryPrompt = buildDiscoveryPrompt(excludedList) +
      `\n\nIMPORTANT: "${rejectedSlug}" was already suggested and is NOT acceptable. Suggest a completely DIFFERENT cat product vertical.`;
    try {
      const r = await generateWithCopilotCLI(retryPrompt, AI_GENERATION_TIMEOUT_MS, 1);
      const cat = r ? sanitizeAndParseDiscoveryJSON(r, allExcluded) : null;
      if (cat) {
        await recordDiscoverySuccess();
        addActivityLog('success', `[V3] 🎯 Scout discovered (retry): ${cat.name} (${cat.slug})`);
        return cat;
      }
    } catch { /* fall through */ }
  }

  addActivityLog('warning', '[V3] Scout could not find a unique category — will retry in 2 minutes');
  console.log('[SEO-V3] ⚠️ All strategies exhausted. Retrying shortly...');
  return null;
}

async function fetchGoogleSuggestions(query: string): Promise<string[]> {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encoded}`;
    
    const req = https.get(url, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
            resolve(parsed[1] as string[]);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
  });
}

async function getGoogleSearchTopics(categoryName: string): Promise<string[]> {
  const seedPhrases = [
    `best ${categoryName} for cats`,
    `cat ${categoryName}`,
    `how to choose ${categoryName} for cats`,
    `${categoryName} cat guide`,
    `${categoryName} for kittens`,
  ];

  addActivityLog('info', `[V3] Fetching real Google search suggestions for "${categoryName}"...`);

  const allSuggestions: string[] = [];
  for (const seed of seedPhrases) {
    const suggestions = await fetchGoogleSuggestions(seed);
    allSuggestions.push(...suggestions);
    await new Promise(r => setTimeout(r, 300));
  }

  const unique = [...new Set(allSuggestions)]
    .filter(s => s.toLowerCase().includes('cat') || s.toLowerCase().includes('kitten'))
    .filter(s => s.split(' ').length >= 3);

  console.log(`[SEO-V3] 🔍 Google suggestions returned ${unique.length} unique topics for "${categoryName}"`);
  return unique;
}

async function generateCategoryKeywords(category: DiscoveredCategory): Promise<string[]> {
  addActivityLog('info', `[V3] Generating keywords for: ${category.name}`);

  const googleTopics = await getGoogleSearchTopics(category.name);

  if (googleTopics.length >= 5) {
    addActivityLog('success', `[V3] Found ${googleTopics.length} real Google search topics for ${category.name} - using as primary source`);

    const prompt = `From these REAL Google search suggestions for the "${category.name}" category, pick the 10 best ones for writing helpful articles on catsluvus.com. If there are fewer than 10 good ones, add a few more based on the patterns you see.

REAL SEARCH SUGGESTIONS FROM GOOGLE:
${googleTopics.map(t => `- ${t}`).join('\n')}

RULES:
1. Prefer specific, actionable topics over vague ones
2. Pick a diverse mix - reviews, how-tos, comparisons
3. Each should work as an article title topic
4. NEVER add marketing terms (affiliate, deals, discount, coupon, etc.)
5. Keep the original phrasing when possible - these are what real people search for

Return ONLY a JSON array of keyword strings:
["keyword one", "keyword two", ...]`;

    try {
      const result = await generateWithCopilotCLI(prompt, AI_GENERATION_TIMEOUT_MS, 2);
      if (result) {
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const keywords = JSON.parse(jsonMatch[0]) as string[];
          console.log(`[SEO-V3] ✅ Generated ${keywords.length} keywords from Google data for ${category.name}`);
          addActivityLog('success', `[V3] Generated ${keywords.length} data-driven keywords for ${category.name}`);
          return keywords;
        }
      }
    } catch (error: any) {
      console.error(`[SEO-V3] ⚠️ Google-based keyword selection failed, falling back: ${error.message}`);
      addActivityLog('warning', `[V3] Google-based selection failed, using AI fallback`);
    }
  } else {
    addActivityLog('info', `[V3] Only ${googleTopics.length} Google suggestions found for "${category.name}" - using AI generation with banned term filter`);
  }

  const prompt = `Generate exactly 10 SEO keywords for the "${category.name}" category on a cat website (catsluvus.com).

REQUIREMENTS:
1. Mix of informational and commercial intent (e.g. "best X for cats", "how to choose X", "X vs Y for cats")
2. Include long-tail keywords (3-5 words)
3. Focus on topics real cat owners actually search for - product reviews, buying guides, how-to guides, comparisons
4. Avoid generic terms like "cat" or "cats" alone
5. Each keyword should be a complete search phrase a real person would type into Google
6. NEVER include marketing/business terms like "affiliate", "deals", "discount", "coupon", "promo", "commission", "revenue", "monetize", "partner program" - these are NOT real search queries
7. Only 10 keywords - quality over quantity, each must be distinct and high-value

Return ONLY a JSON array of keyword strings (no markdown, no explanation):
["keyword one", "keyword two", ...]`;

  try {
    const result = await generateWithCopilotCLI(prompt, AI_GENERATION_TIMEOUT_MS, 2);
    if (result) {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const rawKeywords = JSON.parse(jsonMatch[0]) as string[];
        const bannedTerms = ['affiliate', 'deal', 'deals', 'discount', 'coupon', 'promo', 'commission', 'revenue', 'monetize', 'monetization', 'partner program', 'cashback', 'rebate', 'referral link', 'sponsored', 'advertise'];
        const keywords = rawKeywords.filter(kw => {
          const lower = kw.toLowerCase();
          const hasBanned = bannedTerms.some(term => lower.includes(term));
          if (hasBanned) {
            console.log(`[SEO-V3] 🚫 Filtered spammy keyword: "${kw}"`);
          }
          return !hasBanned;
        });
        const filtered = rawKeywords.length - keywords.length;
        console.log(`[SEO-V3] ✅ AI fallback returned ${rawKeywords.length} keywords for ${category.name}${filtered > 0 ? ` (filtered ${filtered} spammy)` : ''}`);
        addActivityLog('success', `[V3] AI fallback: ${keywords.length} keywords for ${category.name}${filtered > 0 ? ` (removed ${filtered} spammy)` : ''}`);
        return keywords;
      } else {
        console.error(`[SEO-V3] ⚠️ Copilot response had no JSON array for ${category.name}. Response preview: ${result.substring(0, 200)}`);
        addActivityLog('warning', `[V3] Copilot returned non-JSON for ${category.name}`);
      }
    } else {
      console.error(`[SEO-V3] ⚠️ Copilot returned empty response for ${category.name}`);
      addActivityLog('warning', `[V3] Copilot returned empty for ${category.name}`);
    }
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Keyword generation failed for ${category.name}: ${error.message}`);
    addActivityLog('error', `[V3] Keyword generation failed: ${error.message}`);
  }

  console.log(`[SEO-V3] ⚠️ Returning empty keywords for ${category.name} - fallback will be used`);
  return [];
}

// ============================================================================
// Cloudflare Worker Route Auto-Configuration
// ============================================================================

// Cache of configured routes to avoid duplicate API calls
const configuredRoutes: Set<string> = new Set();

// Retry configuration for Worker Route API calls
const WORKER_ROUTE_MAX_RETRIES = 3;
const WORKER_ROUTE_INITIAL_DELAY_MS = 1000;

/**
 * Helper function for exponential backoff retry
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = WORKER_ROUTE_MAX_RETRIES,
  initialDelayMs: number = WORKER_ROUTE_INITIAL_DELAY_MS
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`[SEO-V3] Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Helper to fetch current Worker routes from Cloudflare
 */
async function fetchWorkerRoutes(_cfApiToken?: string): Promise<any[]> {
  const listUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/workers/routes`;
  const listRes = await fetch(listUrl, {
    headers: getZoneAuthHeaders()
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list routes: ${listRes.status} ${listRes.statusText}`);
  }
  return (await listRes.json() as any).result || [];
}

/**
 * Automatically configure a Cloudflare Worker Route for a new V3 category
 * Creates route pattern: catsluvus.com/{category}/* -> petinsurance Worker
 * This enables the public domain to route V3 category URLs to the Worker
 * 
 * Features:
 * - Automatic retry with exponential backoff (3 attempts)
 * - Creates routes for both www and non-www variants
 * - Caches successful configurations to avoid duplicate API calls
 * - Handles 409/conflict errors as success (route already exists)
 * - Re-fetches route list before each create to avoid stale state
 * - Returns partial status when some routes fail
 */
async function ensureWorkerRouteForCategory(category: string): Promise<{ success: boolean; partial?: boolean; error?: string; routeId?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.log('[SEO-V3] No Cloudflare API token - skipping Worker Route configuration');
    addActivityLog('warning', `[V3] Worker Route skipped: No API token`, { category });
    return { success: false, error: 'No API token' };
  }

  // Skip if already configured this session
  if (configuredRoutes.has(category)) {
    console.log(`[SEO-V3] Worker Route already configured for ${category} (cached)`);
    return { success: true };
  }

  const routePattern = `catsluvus.com/${category}/*`;
  const listUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/workers/routes`;
  
  try {
    // First, check if primary route already exists (with retry)
    const existingRoutes = await retryWithBackoff(async () => fetchWorkerRoutes(cfApiToken));
    
    const existingRoute = existingRoutes.find((r: any) => r.pattern === routePattern);
    if (existingRoute) {
      console.log(`[SEO-V3] ✓ Worker Route already exists: ${routePattern} (ID: ${existingRoute.id})`);
      configuredRoutes.add(category);
      return { success: true, routeId: existingRoute.id };
    }

    // Create routes for both catsluvus.com and www.catsluvus.com
    // Also create routes for both /{category}/* and /{category} (index)
    const routePatterns = [
      `catsluvus.com/${category}/*`,
      `catsluvus.com/${category}`,
      `www.catsluvus.com/${category}/*`,
      `www.catsluvus.com/${category}`
    ];
    
    let successCount = 0;
    let failedPatterns: string[] = [];
    let lastRouteId = '';
    
    for (const pattern of routePatterns) {
      // Re-fetch routes before each create to avoid stale state
      let currentRoutes: any[];
      try {
        currentRoutes = await retryWithBackoff(async () => fetchWorkerRoutes(cfApiToken));
      } catch (err: any) {
        console.warn(`[SEO-V3] Failed to refresh route list: ${err.message}, using cached`);
        currentRoutes = existingRoutes;
      }
      
      // Check if this specific pattern already exists
      if (currentRoutes.some((r: any) => r.pattern === pattern)) {
        console.log(`[SEO-V3] ✓ Route already exists: ${pattern}`);
        successCount++;
        continue;
      }
      
      // Create route with retry
      try {
        const result = await retryWithBackoff(async () => {
          console.log(`[SEO-V3] Creating Worker Route: ${pattern} -> ${CLOUDFLARE_WORKER_NAME}`);
          const createRes = await fetch(listUrl, {
            method: 'POST',
            headers: {
              ...getZoneAuthHeaders(),
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              pattern: pattern,
              script: CLOUDFLARE_WORKER_NAME
            })
          });

          const createData = await createRes.json() as any;
          
          // Handle 409 conflict or "route already exists" as success
          if (createRes.status === 409 || 
              createData.errors?.some((e: any) => e.message?.includes('already exists') || e.code === 10020)) {
            console.log(`[SEO-V3] ✓ Route already exists (conflict): ${pattern}`);
            return { id: 'exists', conflict: true };
          }
          
          if (!createRes.ok || !createData.success) {
            const errorMsg = createData.errors?.[0]?.message || `HTTP ${createRes.status}`;
            throw new Error(errorMsg);
          }
          
          return createData.result;
        });
        
        if (result?.conflict) {
          successCount++;
        } else {
          console.log(`[SEO-V3] ✓ Worker Route created: ${pattern} (ID: ${result?.id})`);
          lastRouteId = result?.id || lastRouteId;
          successCount++;
        }
      } catch (error: any) {
        console.error(`[SEO-V3] ⚠️ Failed to create route ${pattern} after ${WORKER_ROUTE_MAX_RETRIES} retries: ${error.message}`);
        failedPatterns.push(pattern);
      }
    }
    
    const totalPatterns = routePatterns.length;
    const isPartial = successCount > 0 && failedPatterns.length > 0;
    const isFullSuccess = successCount === totalPatterns;
    
    if (isFullSuccess) {
      configuredRoutes.add(category);
      addActivityLog('success', `[V3] Worker Routes configured: ${category}`, {
        routesCreated: successCount,
        patterns: routePatterns
      });
      return { success: true, routeId: lastRouteId };
    } else if (isPartial) {
      // Partial success - don't cache, allow retry next time
      addActivityLog('warning', `[V3] Worker Routes partial: ${category}`, {
        routesCreated: successCount,
        routesFailed: failedPatterns.length,
        patterns: routePatterns,
        failedPatterns
      });
      console.warn(`[SEO-V3] ⚠️ Partial success for ${category}: ${successCount}/${totalPatterns} routes created`);
      return { success: true, partial: true, routeId: lastRouteId, error: `${failedPatterns.length} routes failed: ${failedPatterns.join(', ')}` };
    } else {
      addActivityLog('error', `[V3] All Worker Routes failed: ${category}`, {
        failedPatterns,
        lastError: 'All retry attempts exhausted'
      });
      return { success: false, error: `All routes failed after ${WORKER_ROUTE_MAX_RETRIES} retries each` };
    }
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Worker Route error: ${error.message}`);
    addActivityLog('error', `[V3] Worker Route error: ${category}`, { error: error.message });
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Duplicate Tracking - Fetch existing articles from KV
// ============================================================================

// Cache of existing article slugs (refreshed periodically)
let existingArticleSlugs: Set<string> = new Set();
let slugsCacheTime: number = 0;
const SLUGS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all existing article slugs from Cloudflare KV
 * Uses the KV list API to get all keys
 */
async function fetchExistingArticleSlugs(): Promise<Set<string>> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.warn('No Cloudflare API token - cannot check for duplicates');
    return new Set();
  }

  // Return cached if still valid
  if (existingArticleSlugs.size > 0 && Date.now() - slugsCacheTime < SLUGS_CACHE_TTL) {
    return existingArticleSlugs;
  }

  try {
    const slugs = new Set<string>();
    let cursor: string | undefined;

    // Paginate through all KV keys
    do {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch KV keys:', response.status);
        break;
      }

      const data = await response.json() as any;

      // Filter out system keys (sitemap.xml, etc) and add article slugs
      for (const key of data.result || []) {
        const name = key.name;
        // Skip system keys
        if (name === 'sitemap.xml' || name.startsWith('gsc_') || name.startsWith('seo:')) {
          continue;
        }
        slugs.add(name);
      }

      cursor = data.result_info?.cursor;
    } while (cursor);

    existingArticleSlugs = slugs;
    slugsCacheTime = Date.now();

    console.log(`📊 Fetched ${slugs.size} existing article slugs from KV`);
    
    const petinsuranceSlugs = Array.from(slugs).filter(s => !s.includes(':'));
    if (petinsuranceSlugs.length > 0) {
      bulkRegisterArticles(petinsuranceSlugs, 'petinsurance');
    }
    
    return slugs;
  } catch (error: any) {
    console.error('Error fetching KV keys:', error.message);
    return existingArticleSlugs; // Return cached even if stale
  }
}

/**
 * Fetch existing article slugs for V3 category (filtered by kvPrefix)
 */
async function fetchExistingArticleSlugsForCategory(kvPrefix: string): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];

  try {
    const slugs: string[] = [];
    let cursor: string | undefined;

    do {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(kvPrefix)}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) break;

      const data = await response.json() as any;
      for (const key of data.result || []) {
        // Remove the prefix to get just the slug
        const slug = key.name.replace(kvPrefix, '');
        if (slug && !slug.includes(':') && slug !== 'sitemap.xml' && slug !== 'research-output') {
          slugs.push(slug);
        }
      }

      cursor = data.result_info?.cursor;
    } while (cursor);

    if (slugs.length > 0) {
      const category = kvPrefix.replace(':', '').replace(/-/g, '-');
      bulkRegisterArticles(slugs, category || 'cat-trees-condos');
    }
    
    return slugs;
  } catch (error: any) {
    console.error('[SEO-V3] Error fetching V2 slugs:', error.message);
    return [];
  }
}

/**
 * Fetch cross-category articles for internal linking (V3)
 * Returns articles from OTHER V3 categories (not the current one) with full URLs
 * Only links to topically related categories based on shared keywords
 */
async function fetchCrossCategoryArticlesForLinking(currentCategoryKvPrefix: string): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];

  const articlesWithUrls: string[] = [];

  const currentCategoryNormalized = currentCategoryKvPrefix.replace(/:$/, '');

  try {
    const allV3Cats = await getAllCategoryStatusKeys();
    const v3Categories = allV3Cats
      .filter(cat => cat !== currentCategoryNormalized);

    const relatedCategories = getRelatedCategories(currentCategoryNormalized, v3Categories);
    console.log(`[Internal Linking] Related categories for "${currentCategoryNormalized}": ${relatedCategories.slice(0, 5).join(', ')}`);

    for (const category of relatedCategories.slice(0, 5)) {
      const catUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(category + ':')}&limit=20`;
      const catResponse = await fetch(catUrl, {
        headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' }
      });

      if (catResponse.ok) {
        const catData = await catResponse.json() as any;
        const catArticles = (catData.result || [])
          .filter((key: any) => {
            const name = key.name;
            // Skip non-article keys
            return !name.includes('sitemap') && 
                   !name.includes('research') && 
                   !name.includes('status') &&
                   name.includes(':'); // Must be category:slug format
          })
          .slice(0, 10)
          .map((key: any) => {
            const colonIndex = key.name.indexOf(':');
            if (colonIndex === -1) return null;
            const catPrefix = key.name.substring(0, colonIndex);
            const slug = key.name.substring(colonIndex + 1);
            if (!slug || slug.length < 3) return null;
            return `/${catPrefix}/${slug}`;
          })
          .filter((url: string | null) => url !== null);
        
        articlesWithUrls.push(...catArticles);
      }
    }

    console.log(`[Internal Linking] Fetched ${articlesWithUrls.length} V3 cross-category articles (V3-only, no V1 links)`);
    return articlesWithUrls;
  } catch (error: any) {
    console.error('[Internal Linking] Error fetching cross-category articles:', error.message);
    return [];
  }
}

/**
 * Get topically related categories sorted by relevance score.
 * Uses topic cluster mapping + keyword overlap for scoring.
 */
function getRelatedCategories(currentCategory: string, allCategories: string[]): string[] {
  const topicClusters: Record<string, string[]> = {
    'window': ['window', 'screen', 'barrier', 'net', 'mesh', 'guard', 'escape', 'catio', 'balcony', 'perch', 'hammock', 'shelf', 'decal', 'curtain', 'security'],
    'safety': ['escape', 'prevention', 'guard', 'barrier', 'screen', 'net', 'mesh', 'safety', 'security', 'fence', 'gps', 'tracking', 'collar', 'identification', 'microchip'],
    'outdoor': ['outdoor', 'enclosure', 'catio', 'balcony', 'fence', 'gps', 'tracking', 'backpack', 'carrier', 'travel', 'leash', 'harness'],
    'feeding': ['feeder', 'food', 'bowl', 'dish', 'slow', 'puzzle', 'portion', 'timed', 'automatic', 'wet', 'diet', 'topper', 'mix'],
    'grooming': ['grooming', 'brush', 'shedding', 'hair', 'clipper', 'wipe', 'spray', 'mat', 'table', 'tool', 'kit', 'deshedding'],
    'health': ['dental', 'flea', 'hairball', 'allergy', 'senior', 'weight', 'pill', 'recovery', 'first-aid', 'calming', 'anxiety'],
    'furniture': ['bed', 'blanket', 'tower', 'tree', 'house', 'condo', 'shelf', 'perch', 'hammock', 'heating', 'cooling', 'pad'],
    'play': ['toy', 'interactive', 'laser', 'puzzle', 'enrichment', 'mice', 'behavioral'],
    'tech': ['automatic', 'smart', 'wifi', 'gps', 'camera', 'robot', 'self-cleaning', 'tracker'],
    'litter': ['litter', 'box', 'liner', 'mat', 'disposal', 'robot', 'self-cleaning', 'odor', 'stain', 'poop', 'scooper'],
    'travel': ['travel', 'carrier', 'backpack', 'crate', 'kennel', 'boarding'],
  };

  const currentWords = currentCategory.split('-');

  const currentClusters = new Set<string>();
  for (const [cluster, keywords] of Object.entries(topicClusters)) {
    if (keywords.some(kw => currentWords.some(w => w.includes(kw) || kw.includes(w)))) {
      currentClusters.add(cluster);
    }
  }

  const scored = allCategories.map(cat => {
    const catWords = cat.split('-');
    let score = 0;

    for (const [cluster, keywords] of Object.entries(topicClusters)) {
      if (currentClusters.has(cluster) && keywords.some(kw => catWords.some(w => w.includes(kw) || kw.includes(w)))) {
        score += 10;
      }
    }

    const sharedWords = currentWords.filter(w => w.length > 3 && catWords.includes(w));
    score += sharedWords.length * 5;

    return { cat, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.cat);
}

/**
 * Build V3 article HTML with category-specific context
 */
function buildArticleHtml(
  article: ArticleData,
  slug: string,
  keyword: string,
  context: CategoryContext | null,
  video?: YouTubeVideo,
  generatedImages?: GeneratedImage[],
  amazonProductData?: AmazonProductData
): string {
  normalizeKeyTakeawaysArray(article);

  // Robust CategoryContext guards - use safe defaults for all fields
  // CRITICAL: Always prefer niche over hardcoded fallback for dynamic categories
  const safeDomain = context?.domain || 'catsluvus.com';
  const safeCategoryName = context?.categoryName || context?.niche || 'Cat Care';
  // Derive basePath from categorySlug, category, or compute from categoryName
  const derivedSlug = context?.categorySlug || context?.niche?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ||
    (safeCategoryName !== 'Cat Care' ? safeCategoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : 'cat-care');
  const safeBasePath = context?.basePath || `/${derivedSlug}`;
  const safeSiteName = context?.branding?.siteName || 'CatsLuvUs';
  
  // Get category-specific author from CategoryContentData
  const categorySlugForAuthor = context?.categorySlug || context?.niche || 'DEFAULT';
  const categoryContentForAuthor = getCategoryContentData(categorySlugForAuthor);
  
  const author = (context?.authors && context.authors.length > 0 && context.authors[0]) || {
    name: categoryContentForAuthor.author.name,
    title: categoryContentForAuthor.author.title,
    credentials: categoryContentForAuthor.author.credentials,
    bio: categoryContentForAuthor.author.bio,
    image: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=100&h=100&fit=crop'
  };

  const dateNow = new Date().toISOString().split('T')[0];
  const canonicalUrl = `https://${safeDomain}${safeBasePath}/${slug}`;

  // Build FAQ schema
  const faqSchema = article.faqs && article.faqs.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": article.faqs.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer.replace(/<[^>]*>/g, '')
      }
    }))
  } : null;

  // Build Article schema
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": article.title,
    "description": article.metaDescription,
    "datePublished": dateNow,
    "dateModified": dateNow,
    "author": {
      "@type": "Person",
      "name": author.name,
      "jobTitle": author.title,
      "description": author.credentials
    },
    "publisher": {
      "@type": "Organization",
      "name": safeSiteName,
      "logo": {
        "@type": "ImageObject",
        "url": `https://${safeDomain}/logo.png`
      }
    },
    "mainEntityOfPage": canonicalUrl
  };

  // Build VideoObject schema if video exists (use correct YouTubeVideo interface fields)
  const videoSchema = video ? {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": video.title,
    "description": video.description || `Video about ${keyword}`,
    "thumbnailUrl": video.thumbnailUrl,
    "uploadDate": video.publishedISO || video.published || dateNow,
    "contentUrl": video.watchUrl || `https://www.youtube.com/watch?v=${video.videoId}`,
    "embedUrl": video.embedUrl || `https://www.youtube.com/embed/${video.videoId}`,
    "duration": video.durationISO || undefined,
    "interactionStatistic": video.viewCount ? {
      "@type": "InteractionCounter",
      "interactionType": "WatchAction",
      "userInteractionCount": video.viewCount
    } : undefined
  } : null;

  // Build breadcrumb schema
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `https://${safeDomain}` },
      { "@type": "ListItem", "position": 2, "name": safeCategoryName, "item": `https://${safeDomain}${safeBasePath}` },
      { "@type": "ListItem", "position": 3, "name": article.title }
    ]
  };

    // Build Product schema from real Amazon data (preferred) or AI-generated comparison table
  // Priority: 1) Real Amazon products, 2) AI-generated, 3) Category defaults
  const articleComparisonData = article.comparisonTable;
  const categoryContentForProducts = getCategoryContentData(categorySlugForAuthor);

  let productSchema: object | null = null;

  // Use real Amazon product schema if we have it
  if (amazonProductData && amazonProductData.productSchemaItems.length > 0) {
    productSchema = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": `Best ${keyword} Comparison`,
      "description": `Comparison of top ${keyword} products with real Amazon prices and ratings`,
      "itemListElement": amazonProductData.productSchemaItems
    };
    console.log(`[SEO-V3] ✅ Product schema from REAL Amazon data (${amazonProductData.products.length} products with ASINs)`);
  } else if (articleComparisonData && articleComparisonData.rows && articleComparisonData.rows.length > 0) {
    productSchema = generateProductSchema(
      articleComparisonData.headers || [],
      articleComparisonData.rows || [],
      article.externalLinks || categoryContentForProducts.externalLinks || [],
      keyword
    );
    if (productSchema) {
      console.log(`[SEO-V3] ✅ Product schema from AI-generated data (${articleComparisonData.rows.length} products)`);
    }
  } else if (categoryContentForProducts && categoryContentForProducts.comparisonRows && categoryContentForProducts.comparisonRows.length > 0) {
    productSchema = generateProductSchema(
      categoryContentForProducts.comparisonHeaders || [],
      categoryContentForProducts.comparisonRows || [],
      categoryContentForProducts.externalLinks || [],
      keyword
    );
    if (productSchema) {
      console.log(`[SEO-V3] ⚠️ Product schema from category defaults (${categoryContentForProducts.comparisonRows.length} products)`);
    }
  }

  // Build comparison table HTML with Amazon affiliate links
  const amazonTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
  let comparisonTableHtml = '';
  if (article.comparisonTable && article.comparisonTable.headers && article.comparisonTable.rows) {
    // Check if last column is Amazon Search - replace with clickable link
    const hasAmazonColumn = article.comparisonTable.headers.some(h => 
      h.toLowerCase().includes('amazon') || h.toLowerCase().includes('buy') || h.toLowerCase().includes('link')
    );
    
    // Build headers - replace Amazon Search with "View on Amazon" column
    const displayHeaders = hasAmazonColumn 
      ? [...article.comparisonTable.headers.slice(0, -1), 'View on Amazon']
      : article.comparisonTable.headers;
    
    const pickItems = article.comparisonTable.rows.map((row: any, idx: number) => {
      const rowArray = Array.isArray(row) ? row : (typeof row === 'string' ? [row] : Object.values(row || {}));
      if (!rowArray.length) return '';

      // Truncate product name to first meaningful part (before "by BRAND" or after 80 chars)
      let productName = String(rowArray[0] || '').replace(/\.{3,}$/, '');
      if (productName.length > 80) {
        const byIdx = productName.indexOf(' by ');
        productName = byIdx > 20 ? productName.substring(0, byIdx) : productName.substring(0, 80).replace(/\s+\S*$/, '…');
      }
      const price = String(rowArray[1] || '');
      // Truncate features: take first sentence/phrase, max 120 chars
      let features = String(rowArray[2] || '');
      if (features.length > 120) {
        // Split on semicolons (Amazon feature separators) and take first one
        const firstFeature = features.split(/[;]/)[0].trim();
        features = firstFeature.length > 120 ? firstFeature.substring(0, 120).replace(/\s+\S*$/, '…') : firstFeature;
      }
      const rating = String(rowArray[3] || '');

      let amazonBtnHtml = '';
      const matchedProduct = amazonProductData?.products?.[idx];
      if (matchedProduct?.asin) {
        const amazonUrl = 'https://www.amazon.com/dp/' + matchedProduct.asin + '?tag=' + amazonTag;
        amazonBtnHtml = '<a href="' + amazonUrl + '" target="_blank" rel="nofollow sponsored" class="amazon-btn">View on Amazon</a>';
      } else {
        const lastCol = String(rowArray[rowArray.length - 1] || '');
        const lastColLooksLikeSearch = lastCol.includes('+') && !lastCol.includes('/5') && lastCol.length > 5;
        if (hasAmazonColumn && rowArray.length >= 5) {
          const amazonSearch = lastCol || String(rowArray[0]).replace(/\s+/g, '+');
          const amazonUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(String(amazonSearch).replace(/\+/g, ' ')) + '&tag=' + amazonTag;
          amazonBtnHtml = '<a href="' + amazonUrl + '" target="_blank" rel="nofollow sponsored" class="amazon-btn">View on Amazon</a>';
        } else if (lastColLooksLikeSearch && rowArray.length >= 4) {
          const amazonSearch = lastCol;
          const amazonUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(String(amazonSearch).replace(/\+/g, ' ')) + '&tag=' + amazonTag;
          amazonBtnHtml = '<a href="' + amazonUrl + '" target="_blank" rel="nofollow sponsored" class="amazon-btn">View on Amazon</a>';
        } else if (rowArray.length >= 2) {
          const amazonSearch = String(rowArray[0]).replace(/[^a-zA-Z0-9\s]/g, '').split(' ').slice(0, 5).join('+');
          const amazonUrl = 'https://www.amazon.com/s?k=' + encodeURIComponent(amazonSearch.replace(/\+/g, ' ')) + '&tag=' + amazonTag;
          amazonBtnHtml = '<a href="' + amazonUrl + '" target="_blank" rel="nofollow sponsored" class="amazon-btn">View on Amazon</a>';
        }
      }

      const ratingNum = Math.min(parseFloat(rating) || 0, 5);
      const fullStars = Math.floor(ratingNum);
      const emptyStars = Math.max(0, 5 - Math.ceil(ratingNum));
      const starsHtml = '\u2605'.repeat(fullStars) + (ratingNum % 1 >= 0.5 ? '\u00BD' : '') + '\u2606'.repeat(emptyStars);

      const ratingHtml = ratingNum > 0 ? '<span class="pick-rating"><span class="stars">' + starsHtml + '</span> ' + rating + '</span>' : '';
      const featuresHtml = features && features !== 'Premium quality' ? '<span class="pick-features">' + features + '</span>' : '';

      // Product image with descriptive alt text (from real Amazon data)
      let productImageHtml = '';
      if (matchedProduct?.imageUrl) {
        const imgAlt = productName.replace(/"/g, '&quot;') + ' - product image';
        productImageHtml = '<img src="' + matchedProduct.imageUrl + '" alt="' + imgAlt + '" class="pick-image" loading="lazy" width="80" height="80">';
      }

      return '<li class="top-pick-item">' +
        '<span class="pick-rank">' + (idx + 1) + '</span>' +
        productImageHtml +
        '<div class="pick-info">' +
          '<p class="pick-name">' + productName + '</p>' +
          '<div class="pick-meta">' + ratingHtml + featuresHtml + '</div>' +
        '</div>' +
        amazonBtnHtml +
      '</li>';
    }).join('');

    comparisonTableHtml = '<div class="top-picks">' +
      '<div class="top-picks-header">' +
        '<span class="picks-icon">\uD83C\uDFC6</span>' +
        '<h2 class="top-picks-title">Our Top Picks</h2>' +
      '</div>' +
      '<ul class="top-picks-list">' + pickItems + '</ul>' +
    '</div>';
  }

  // Helper function to build image HTML with ImageObject schema
  // Uses intrinsic sizing (width/height for aspect ratio) with responsive CSS override
  // isHero=true uses fetchpriority="high" + eager loading for LCP optimization
  const buildImageHtml = (image: GeneratedImage, isHero = false): string => {
    return `
      <figure class="article-image" itemscope itemtype="https://schema.org/ImageObject">
        <img
          src="${image.url}"
          alt="${image.alt.replace(/"/g, '&quot;')}"
          width="${image.width}"
          height="${image.height}"
          style="width: 100%; height: auto; max-width: 100%;"
          ${isHero ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"'}
          decoding="async"
          itemprop="contentUrl"
        >
        <figcaption itemprop="caption">${image.caption}</figcaption>
        <meta itemprop="width" content="${image.width}">
        <meta itemprop="height" content="${image.height}">
      </figure>
    `;
  };

  // Get hero image (always generated) - uses fetchpriority="high" for LCP
  const heroImage = generatedImages?.find(img => img.imageType === 'hero');
  const heroImageHtml = heroImage ? buildImageHtml(heroImage, true) : '';

  // Note: Closing images removed per SEO best practices (1-2 images max)
  // Only hero + optional mid-article section image are generated now

  // Build sections HTML with AI-generated images after each H2
  let sectionsHtml = '';
  if (article.sections && Array.isArray(article.sections)) {
    sectionsHtml = article.sections.map((section, index) => {
      // Find matching section image (sectionIndex is 1-based)
      const sectionImage = generatedImages?.find(
        img => img.imageType === 'section' && img.sectionIndex === index + 1
      );
      const sectionImageHtml = sectionImage ? buildImageHtml(sectionImage) : '';

      // Strip AI-generated comparison tables from section content when we have a real one
      let sectionContent = section.content;
      if (comparisonTableHtml) {
        // Remove markdown-style tables (| ... | ... |) with surrounding text like "Here's a comparison..."
        sectionContent = sectionContent.replace(/(?:<p>)?[^<]*(?:comparison|comparing|top[- ]rated)[^<]*(?:<\/p>)?\s*(?:<table[\s\S]*?<\/table>|\|[\s\S]*?\|\s*(?:\n|$)(?:\|[\s\S]*?\|\s*(?:\n|$))*)/gi, '');
        // Remove any leftover "These products are highly rated..." filler after the stripped table
        sectionContent = sectionContent.replace(/(?:<p>)?These products are (?:highly rated|top[- ]rated)[\s\S]*?(?:<\/p>|$)/gi, '');
      }

      sectionContent = stripEmptyProductReviewLabels(sectionContent);

      const subsectionsHtml = (section.subsections || [])
        .map(sub => {
          const subBody = stripEmptyProductReviewLabels(sub.content || '');
          if (!sub.heading?.trim() && !subBody.trim()) return '';
          const subHeading = sub.heading?.trim()
            ? `<h3 class="article-subsection-heading">${escapeHtmlText(sub.heading)}</h3>\n`
            : '';
          return `${subHeading}${subBody}`;
        })
        .filter(Boolean)
        .join('\n');

      return `
        <section id="section-${index + 1}">
          <h2>${section.heading}</h2>
          ${sectionImageHtml}
          ${sectionContent}
          ${subsectionsHtml}
        </section>
      `;
    }).join('');
  }

  // Build Table of Contents from sections
  let tocHtml = '';
  if (article.sections && article.sections.length > 1) {
    const tocItems = article.sections.map((section, index) =>
      `<li><a href="#section-${index + 1}">${section.heading}</a></li>`
    ).join('');
    tocHtml = `
      <nav class="toc" aria-label="Table of Contents">
        <strong>In This Article</strong>
        <ol>
          ${tocItems}
          ${article.faqs && article.faqs.length > 0 ? '<li><a href="#faq-section">Frequently Asked Questions</a></li>' : ''}
        </ol>
      </nav>
    `;
  }

  // Build FAQ HTML
  let faqHtml = '';
  if (article.faqs && article.faqs.length > 0) {
    faqHtml = `
      <section class="faqs" id="faq-section">
        <h2>Frequently Asked Questions About ${escapeHtmlText(toTopicPhraseCase(keyword))}</h2>
        ${article.faqs.map(faq => `
          <div class="faq-item">
            <h3>${escapeHtmlText(faq.question)}</h3>
            <p>${faq.answer}</p>
          </div>
        `).join('')}
      </section>
    `;
  }

  // Build video hero HTML - lite-youtube facade for performance (no iframe until click)
  let videoHeroHtml = '';
  if (video) {
    const vid = video.videoId;
    videoHeroHtml = `
      <section class="video-hero" id="video">
        <p class="video-hero-title">Watch: Expert Guide on ${keyword}</p>
        <div class="video-container">
          <lite-youtube videoid="${vid}" style="background-image: url('https://img.youtube.com/vi/${vid}/hqdefault.jpg');" title="${video.title}"></lite-youtube>
        </div>
        <p class="video-hero-meta"><strong>${video.channel}</strong> • ${video.duration || ''} • ${video.views || ''}</p>
        <p class="video-hero-cta">Continue reading below for our complete written guide with pricing, comparisons, and FAQs.</p>
      </section>
    `;
  }
  // Lite-youtube inline script (only loads iframe on click - saves ~500KB initial load)
  const liteYoutubeScript = video ? `<script>if(!window.liteYT){window.liteYT=1;document.head.insertAdjacentHTML('beforeend','<style>lite-youtube{display:block;position:relative;width:100%;padding-bottom:56.25%;background-size:cover;background-position:center;cursor:pointer;border-radius:8px}lite-youtube::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;background:url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 68 48\\'%3E%3Cpath fill=\\'%23f00\\' d=\\'M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z\\'/%3E%3Cpath fill=\\'%23fff\\' d=\\'M45 24L27 14v20z\\'/%3E%3C/svg%3E") center/contain no-repeat}lite-youtube:hover::before{filter:brightness(1.1)}</style>');document.addEventListener('click',e=>{const t=e.target.closest('lite-youtube');if(t){const v=t.getAttribute('videoid');t.outerHTML='<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="https://www.youtube.com/embed/'+v+'?autoplay=1&rel=0" frameborder="0" allow="autoplay;encrypted-media;picture-in-picture" allowfullscreen title="YouTube video player" style="position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px"></iframe></div>'}})}</script>` : '';

  // NOTE: Navigation menu items now handled by Worker HTMLRewriter injection

  const currentYear = new Date().getFullYear();

  // Related articles section: handled by Worker HTMLRewriter injection (image-based cards)
  const relatedArticlesHtml = '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<meta name="description" content="${article.metaDescription}">
<link rel="canonical" href="${canonicalUrl}">
<link rel="preconnect" href="https://pub.catsluvus.com" crossorigin>
<link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
<link rel="dns-prefetch" href="https://pagead2.googlesyndication.com">
<link rel="dns-prefetch" href="https://www.googletagmanager.com">
<link rel="icon" href="https://${safeDomain}/favicon.ico" type="image/x-icon">
<link rel="apple-touch-icon" href="https://${safeDomain}/apple-touch-icon.png">
<!-- Google AdSense (deferred) -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9364522191686432" crossorigin="anonymous"></script>
<meta property="og:title" content="${article.title}">
<meta property="og:description" content="${article.metaDescription}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="article">
<meta property="og:image" content="${(heroImage?.url?.startsWith('http') ? heroImage.url : null) || `https://${safeDomain}/img${safeBasePath}/${slug}/hero.png`}">
<meta property="og:image:width" content="${heroImage?.width || 672}">
<meta property="og:image:height" content="${heroImage?.height || 504}">
<meta property="og:site_name" content="${safeSiteName}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${article.title}">
<meta name="twitter:description" content="${article.metaDescription}">
<meta name="twitter:image" content="${(heroImage?.url?.startsWith('http') ? heroImage.url : null) || `https://${safeDomain}/img${safeBasePath}/${slug}/hero.png`}">
<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ''}
${videoSchema ? `<script type="application/ld+json">${JSON.stringify(videoSchema)}</script>` : ''}
${productSchema ? `<script type="application/ld+json">${JSON.stringify(productSchema)}</script>` : ''}
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-KPSXGQWC');</script>
<style>
/* CSS Custom Properties */
:root {
  --wc-color-primary: #326891;
  --wc-color-primary-dark: #265073;
  --wc-color-text: #121212;
  --wc-color-text-secondary: #555555;
  --wc-color-border: #e2e2e2;
  --wc-color-bg: #ffffff;
  --wc-color-bg-hover: #f8f8f8;
  --wc-transition-speed: 300ms;
}

/* Reset & Base */
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow-x:hidden;width:100%;max-width:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.8;color:var(--wc-color-text);background:var(--wc-color-bg)}

/* Skip Link for Accessibility */
.skip-link{position:absolute;top:-40px;left:0;background:#333;color:#fff;padding:8px 16px;text-decoration:none;border-radius:0 0 4px 0;z-index:99999}
.skip-link:focus{top:0}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* NOTE: Navigation chrome (hamburger, nav, footer) injected by Worker HTMLRewriter */

/* Main Content */
main{padding-top:0;overflow-x:hidden}
.container{max-width:720px;margin:0 auto;padding:40px 24px;overflow-wrap:break-word;word-wrap:break-word;overflow-x:hidden}

/* Typography */
body{font-size:18px;line-height:1.75;letter-spacing:-0.01em}
article{font-size:18px;line-height:1.8;color:#1a1a1a;overflow-wrap:break-word;word-wrap:break-word}
article p{margin-bottom:1.5em;text-align:left;word-spacing:0.05em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
h1{font-size:2rem;margin-bottom:20px;color:var(--wc-color-primary);line-height:1.3;letter-spacing:-0.02em}
h2{font-size:1.4rem;margin:48px 0 24px;border-bottom:2px solid var(--wc-color-border);padding-bottom:12px;line-height:1.4}
h3{font-size:1.15rem;margin:32px 0 16px;line-height:1.4}
p{margin-bottom:1.25em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
ul,ol{margin:1.25em 0 1.5em 1.5em;line-height:1.7}
li{margin-bottom:0.5em;overflow-wrap:break-word}
a{color:var(--wc-color-primary)}

/* Prevent content overflow */
article img,article video,article iframe,article embed,article object{max-width:100%;height:auto;display:block}
article pre,article code{overflow-x:auto;max-width:100%;white-space:pre-wrap;word-wrap:break-word}
a{overflow-wrap:break-word;word-break:break-all}
article *{max-width:100%}

/* Breadcrumb */
.breadcrumb{font-size:14px;margin-bottom:20px;padding-top:10px}
.breadcrumb a{color:#0277BD;text-decoration:none}

/* Article Images */
.article-image{margin:30px 0;text-align:center}
.article-image img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.article-image figcaption{font-size:14px;color:#666;margin-top:10px;font-style:italic}

/* Author Box */
.author-box{display:flex;gap:16px;padding:20px;background:#f8f9fa;border-radius:8px;margin:24px 0;border-left:4px solid var(--wc-color-primary)}
.author-box img{width:80px;height:80px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author-name{margin:0 0 4px;color:var(--wc-color-primary);font-size:1.1em;font-weight:700}
.author-info .written-by{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#595959;margin:0 0 2px}
.author-info .credentials{font-size:14px;color:#555;margin-bottom:8px}
.author-info .bio{font-size:15px;line-height:1.6}
.author-info .date-info{font-size:13px;color:#595959;margin-top:6px}
.trusted-sources{margin:40px 0;padding:24px;background:#f0f7f4;border-radius:8px;border-left:4px solid #2d6a4f}
.trusted-sources h2{color:#2d6a4f;font-size:20px;margin-bottom:12px}
.trusted-sources ul{list-style:none;padding:0;margin:0}
.trusted-sources li{padding:6px 0}
.trusted-sources a{color:#2d6a4f;text-decoration:underline;font-weight:500}

/* Quick Answer Box */
.quick-answer{background:#fff3cd;border:2px solid #ffc107;border-radius:8px;padding:20px 25px;margin:20px 0 30px 0;font-size:1.1em;line-height:1.7}
.quick-answer strong{color:#856404;display:block;margin-bottom:8px;font-size:0.95em;text-transform:uppercase;letter-spacing:0.5px}

/* Key Takeaways */
.key-takeaways{background:linear-gradient(135deg,#e8f4f8 0%,#d4e8ed 100%);border-left:4px solid var(--wc-color-primary);padding:20px 25px;border-radius:0 8px 8px 0;margin:30px 0}
.key-takeaways h2,.key-takeaways strong{font-size:1.2rem;margin:0 0 15px 0;color:var(--wc-color-primary)}
.key-takeaways ul{margin:0;padding-left:20px}
.key-takeaways li{margin:8px 0;line-height:1.6}

/* Our Top Picks - Wirecutter Style */
.top-picks{margin:32px 0;border:2px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}
.top-picks-header{background:linear-gradient(135deg,#1a365d 0%,#2d3748 100%);padding:16px 24px;display:flex;align-items:center;gap:10px}
.top-picks-header h2.top-picks-title,.top-picks-header h3{margin:0;color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.3px}
.top-picks-header .picks-icon{font-size:22px}
.top-picks-list{padding:0;margin:0;list-style:none}
.top-pick-item{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #e2e8f0;gap:16px;transition:background 0.2s ease}
.top-pick-item:last-child{border-bottom:none}
.top-pick-item:hover{background:#f7fafc}
.pick-rank{flex-shrink:0;width:32px;height:32px;background:#edf2f7;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#2d3748}
.pick-info{flex:1;min-width:0}
.pick-name{font-weight:700;font-size:15px;color:#1a202c;margin:0 0 4px 0;line-height:1.3}
.pick-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.pick-rating{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:#92400e;font-weight:600}
.pick-rating .stars{color:#92400e}
.pick-features{font-size:13px;color:#4a5568}
.amazon-btn{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(180deg,#ff9900 0%,#e47911 100%);color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;border:none;box-shadow:0 3px 10px rgba(255,153,0,0.3);transition:all 0.3s ease;white-space:nowrap;flex-shrink:0}
.amazon-btn:hover{background:linear-gradient(180deg,#ffad33 0%,#ff9900 100%);transform:translateY(-1px);box-shadow:0 5px 16px rgba(255,153,0,0.4);text-decoration:none;color:#fff}
.amazon-btn::before{content:'';display:inline-block;width:18px;height:18px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z'/%3E%3C/svg%3E");background-size:contain;background-repeat:no-repeat}
.amazon-btn:active{transform:translateY(0);box-shadow:0 2px 8px rgba(255,153,0,0.3)}
@media(max-width:640px){.top-pick-item{flex-wrap:wrap;gap:12px;padding:14px 16px}.pick-rank{width:28px;height:28px;font-size:12px}.amazon-btn{width:100%;justify-content:center;padding:12px}}

/* FAQ Section */
.faqs{background:#f8f8f8;padding:24px;border-radius:8px;margin:40px 0}
.faq-item{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--wc-color-border)}
.faq-item:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.faq-item h3{color:var(--wc-color-primary);margin-bottom:8px;margin-top:0}

/* Video Hero Section */
.video-hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px;border-radius:12px;margin:20px 0 32px;box-shadow:0 8px 32px rgba(0,0,0,0.15)}
.video-hero-title{color:#fff;font-size:1.1rem;margin:0 0 16px;font-weight:600;display:flex;align-items:center;gap:8px}
.video-hero-title::before{content:'▶';color:#ff6b35;font-size:0.9rem}
.video-hero .video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.video-hero .video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:8px}
.video-hero-meta{color:#b8b8b8;font-size:14px;margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.video-hero-meta strong{color:#fff}
.video-hero-cta{color:#ff6b35;font-size:13px;margin-top:12px;font-style:italic}

/* Video Container (fallback) */
.video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin-bottom:12px}
.video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px}

/* Conclusion */
.conclusion{background:linear-gradient(135deg,#326891,#265073);color:#fff;padding:24px;border-radius:8px;margin:40px 0}
.conclusion h2{color:#fff;border-bottom-color:rgba(255,255,255,0.3)}

/* Disclaimer */
.disclaimer{background:#f8f9fa;padding:12px 20px;text-align:center;font-size:14px;border-bottom:1px solid #e5e5e5}
.disclaimer a{color:#b5286e;text-decoration:none}

/* Accessibility Contrast Overrides - article-scoped only (Worker overrides are in end-of-body block) */
.written-by,.date-info,.date-info time{color:#595959 !important}
.pick-rating,.stars{color:#92400E !important}
.breadcrumb a{color:#0277BD !important}
.pick-features{color:#4A5568 !important}
.disclaimer a{color:#B5286E !important}

/* Footer */
.site-footer{background:#1a1a1a;color:#fff;padding:60px 20px 40px;margin-top:60px}
.footer-content{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:40px}
.footer-section h4{font-size:16px;margin-bottom:16px;color:#fff}
.footer-section ul{list-style:none;padding:0;margin:0}
.footer-section li{margin-bottom:8px}
.footer-section a{color:#aaa;text-decoration:none;font-size:14px}
.footer-section a:hover{color:#fff}
.footer-bottom{max-width:1200px;margin:40px auto 0;padding-top:20px;border-top:1px solid #333;text-align:center;color:#9CA3AF;font-size:13px}
.footer-bottom a{color:#9CA3AF;text-decoration:none;margin:0 12px}

/* Responsive */
@media (max-width:768px){
  body{font-size:17px}
  article{font-size:17px;line-height:1.75}
  h1{font-size:1.6rem}
  h2{font-size:1.25rem;margin:36px 0 18px}
  h3{font-size:1.1rem}
  .container{padding:32px 20px}
  .author-box{flex-direction:column;text-align:center}
  .author-box img{margin:0 auto}
  .footer-content{grid-template-columns:1fr 1fr}
}
@media (max-width:480px){
  body{font-size:16px}
  article{font-size:16px;line-height:1.7}
  h1{font-size:1.4rem}
  .container{padding:24px 16px}
  .footer-content{grid-template-columns:1fr}
  .key-takeaways{padding:16px 18px}
  .faqs{padding:18px}
  .conclusion{padding:18px}
}

/* Reduced Motion */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important}
}

/* Table of Contents */
.toc{background:#f8f9fa;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0}
.toc strong{display:block;font-size:1.1em;margin-bottom:12px;color:var(--wc-color-primary-dark)}
.toc ol{margin:0;padding-left:20px}
.toc li{margin-bottom:6px;line-height:1.5}
.toc a{color:var(--wc-color-primary);text-decoration:none;border-bottom:1px dotted var(--wc-color-primary)}
.toc a:hover{color:var(--wc-color-primary-dark);border-bottom-style:solid}

/* Accessibility: placeholder contrast fix (WCAG AA 4.5:1 minimum) */
::placeholder{color:#767676 !important}
input::placeholder{color:#767676 !important}

/* Print - hide chrome elements injected by Worker */
@media print{
  .hamburger-menu,.nav-menu,.universal-footer,.skip-link{display:none !important}
  body{padding-top:0}
}
</style>
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KPSXGQWC" height="0" width="0" style="display:none;visibility:hidden" title="Google Tag Manager"></iframe></noscript>

<!-- A11y fixes for Worker-injected navigation (must run early for Lighthouse) -->
<script>
(function(){
var o=new MutationObserver(function(mutations){
mutations.forEach(function(m){
m.addedNodes.forEach(function(n){
if(n.nodeType!==1)return;
if(n.matches&&n.matches('nav:not([aria-label])')){
var cls=n.className||'';
if(cls.indexOf('navbar-sub')>-1)n.setAttribute('aria-label','Secondary navigation');
else if(cls.indexOf('mobile')>-1)n.setAttribute('aria-label','Mobile navigation');
else n.setAttribute('aria-label','Site navigation');
}
var navs=n.querySelectorAll?n.querySelectorAll('nav:not([aria-label])'):[]; 
navs.forEach(function(nav,i){
var c=nav.className||'';
if(c.indexOf('navbar-sub')>-1)nav.setAttribute('aria-label','Secondary navigation');
else if(c.indexOf('mobile')>-1)nav.setAttribute('aria-label','Mobile navigation');
else nav.setAttribute('aria-label','Site navigation');
});
var inputs=n.querySelectorAll?n.querySelectorAll('input[type="text"]:not([aria-label])'):[]; 
inputs.forEach(function(inp){inp.setAttribute('aria-label',inp.placeholder||'Search');});
if(n.matches&&n.matches('input[type="text"]:not([aria-label])'))n.setAttribute('aria-label',n.placeholder||'Search');
});
});
});
o.observe(document.documentElement,{childList:true,subtree:true});
})();
</script>

<!-- NOTE: Navigation chrome (hamburger, nav, footer) injected by Worker HTMLRewriter -->

<!-- Disclaimer Banner -->
<div class="disclaimer">
  We independently review everything we recommend. When you buy through our links, we may earn a commission.
  <a href="https://${safeDomain}/affiliate-disclosure/">Learn more ›</a>
</div>

<main id="main-content">
<div class="container">
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="https://${safeDomain}">Home</a> ›
  <a href="https://${safeDomain}${safeBasePath}">${safeCategoryName}</a> ›
  ${article.title}
</nav>

<article itemscope itemtype="https://schema.org/Article">
  <h1 itemprop="headline">${article.title}</h1>

  ${videoHeroHtml}

  <div class="author-box" itemprop="author" itemscope itemtype="https://schema.org/Person">
    <img src="${author.image || 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=100&h=100&fit=crop'}" alt="${author.name}, ${author.title}" itemprop="image" loading="lazy">
    <div class="author-info">
      <p class="written-by">Written by</p>
      <p class="author-name" itemprop="name">${author.name}</p>
      <p class="credentials" itemprop="jobTitle">${author.title} | ${author.credentials}</p>
      <p class="bio">${author.bio || ''}</p>
      <p class="date-info">Last Updated: <time itemprop="dateModified" datetime="${dateNow}">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</time></p>
    </div>
  </div>

  <p class="disclosure">Disclosure: This article may contain affiliate links. We may earn a commission when you purchase through our links at no extra cost to you.</p>

  ${article.quickAnswer ? `
    <div class="quick-answer" itemprop="description">
      <strong>Quick Answer:</strong> ${article.quickAnswer}
    </div>
  ` : ''}

  ${article.keyTakeaways && article.keyTakeaways.length > 0 ? `
    <div class="key-takeaways">
      <strong>Key Takeaways:</strong>
      <ul>
        ${article.keyTakeaways.map(t => `<li>${escapeHtmlText(t)}</li>`).join('')}
      </ul>
    </div>
  ` : ''}

  ${comparisonTableHtml}

  ${tocHtml}

  ${heroImageHtml}

  <div class="introduction" itemprop="articleBody">
    ${article.introduction || ''}
  </div>

  ${sectionsHtml}

  ${faqHtml}

  <section class="conclusion">
    <h2>Conclusion</h2>
    ${article.conclusion || ''}
  </section>

  <section class="trusted-sources">
    <h2>Trusted Sources & References</h2>
    <ul>
      ${UNIVERSAL_AUTHORITY_LINKS.slice(0, 3).map(link => 
        `<li><a href="${link.url}" target="_blank" rel="noopener noreferrer">${link.text}</a></li>`
      ).join('\n      ')}
    </ul>
  </section>

  ${relatedArticlesHtml}
</article>
</div>
</main>
<!-- NOTE: Footer and menu JS injected by Worker HTMLRewriter -->
${liteYoutubeScript}
<style id="a11y-overrides">
body .clu-search-form input::placeholder{color:#767676 !important}
body .clu-search-form button svg{fill:#767676 !important}
body .clu-mobile-search input::placeholder{color:#767676 !important}
body .related-articles-error{color:#595959 !important}
body .footer-bottom,body .footer-bottom *{color:#9CA3AF !important}
body .footer-bottom a{color:#9CA3AF !important}
body .clu-infobar-contact a{color:#0277BD !important}
body .footer-section a{color:#b0b0b0 !important}
body .footer-section p{color:#b0b0b0 !important}
body input::placeholder{color:#767676 !important}
body .clu-mobile-menu-header h3{font-size:1.1rem;margin:0}
</style>
<script>
(function(){
document.querySelectorAll('.clu-mobile-menu-header h3, .footer-section h3').forEach(function(el){
var p=document.createElement('p');
p.className=el.className;p.innerHTML=el.innerHTML;
p.setAttribute('role','heading');p.setAttribute('aria-level','2');
p.style.cssText=el.style.cssText+'font-size:'+getComputedStyle(el).fontSize+';font-weight:700;margin:0;color:inherit';
el.parentNode.replaceChild(p,el);
});
document.querySelectorAll('a[href="#"]').forEach(function(a){a.setAttribute('role','button')});
})();
</script>
</body>
</html>`;
}

/**
 * Update V3 sitemap with new article
 */
async function updateSitemap(slug: string, context: CategoryContext | null): Promise<void> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return;

  const categorySlug = context?.categorySlug || 'v3-articles';

  try {
    // Invalidate the cached sitemap for this category so the Worker regenerates it
    // dynamically from KV keys on the next request
    const cacheKey = `sitemap:${categorySlug}`;
    const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(cacheKey)}`;

    await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${cfApiToken}` }
    });

    console.log(`[SEO-V3] 🗺️ Sitemap cache invalidated for ${categorySlug} (new article: ${slug})`);

    // Purge Cloudflare CDN cache for the sitemap URL
    await purgeSitemapCache(cfApiToken, categorySlug);
  } catch (error: any) {
    console.error('[SEO-V3] Sitemap cache invalidation error:', error.message);
  }
}

/**
 * Check if an article already exists in KV
 */
async function articleExists(slug: string): Promise<boolean> {
  const slugs = await fetchExistingArticleSlugs();
  return slugs.has(slug);
}

/**
 * Get the next prioritized keyword that hasn't been generated yet
 * ATOMIC: Immediately adds the returned keyword to keywordsInProgress to prevent race conditions
 */
async function getNextPrioritizedKeyword(): Promise<PrioritizedKeyword | null> {
  const existingSlugs = await fetchExistingArticleSlugs();
  // Merge existing slugs with in-progress slugs to avoid duplicates between workers
  const excludeSlugs = new Set([...existingSlugs, ...keywordsInProgress]);
  const nextKeyword = getNextKeyword(excludeSlugs);
  
  // ATOMIC: Lock the keyword immediately to prevent race conditions between workers
  if (nextKeyword) {
    keywordsInProgress.add(nextKeyword.slug);
  }
  
  return nextKeyword;
}

/**
 * Get generation queue status
 */
async function getGenerationQueueStatus(): Promise<{
  totalKeywords: number;
  generated: number;
  remaining: number;
  percentComplete: string;
  nextKeyword: PrioritizedKeyword | null;
  topPending: { high: number; medium: number; low: number };
}> {
  const existingSlugs = await fetchExistingArticleSlugs();
  const allKeywords = getPrioritizedKeywords();

  let highPending = 0, mediumPending = 0, lowPending = 0;
  let v3Generated = 0;

  for (const kw of allKeywords) {
    if (!existingSlugs.has(kw.slug)) {
      if (kw.priority === 'high') highPending++;
      else if (kw.priority === 'medium') mediumPending++;
      else lowPending++;
    } else {
      v3Generated++;
    }
  }

  const remaining = allKeywords.length - v3Generated;

  // Also count V3 category articles from KV (category:slug format)
  const v3CategoryArticles = Array.from(existingSlugs).filter(s => s.includes(':')).length;
  const totalV3Generated = Math.max(v3Generated, v3CategoryArticles);

  return {
    totalKeywords: allKeywords.length || totalV3Generated,
    generated: totalV3Generated,
    remaining: Math.max(0, remaining),
    percentComplete: allKeywords.length > 0 
      ? Math.min(100, (totalV3Generated / allKeywords.length) * 100).toFixed(2)
      : '0.00',
    nextKeyword: getNextKeyword(existingSlugs),
    topPending: { high: highPending, medium: mediumPending, low: lowPending }
  };
}

/**
 * Direct CLI invocation using spawn with -p flag
 * This uses the official GitHub Copilot CLI directly (what the SDK wraps)
 * The SDK's session management has issues, but the CLI's -p flag works correctly
 */
async function generateWithCopilotCLI(prompt: string, timeout: number = 600000, maxRetries: number = 3): Promise<string> {
  console.log(`🤖 [Claude Agent SDK] Generating response (timeout: ${timeout}ms, maxRetries: ${maxRetries})...`);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🚀 Attempt ${attempt}/${maxRetries} via Claude Agent SDK...`);
      const result = await claudeAgentGenerate(prompt);
      console.log(`✅ Got response (${result.length} chars)`);
      return result;
    } catch (error: any) {
      console.error(`❌ Claude Agent SDK Error (attempt ${attempt}):`, error.message);
      lastError = error;

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        console.log(`🔄 Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Claude Agent SDK failed after all retries');
}

/**
 * OpenRouter Free Model Generation
 * Uses verified free models - prioritizing NON-reasoning models for JSON output
 */
async function generateWithOpenRouter(prompt: string, timeout: number = 600000): Promise<string> {
  const apiKey = secrets.get('OPENROUTER_API_KEY');
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not found in Doppler secrets');
  }

  // Use verified AVAILABLE free models (from OpenRouter API Jan 2026)
  // Prioritizing non-reasoning models that output JSON cleanly
  // openrouter/free auto-routes to best available free model (Feb 2026, 200K ctx)
  const freeModels = [
    'openrouter/free',                                    // primary: auto-selects best free model
    'openrouter/free',                                    // retry: picks a different underlying model on 429
    'meta-llama/llama-3.3-70b-instruct:free',            // explicit fallback
    'google/gemma-3-27b-it:free',                        // explicit fallback
    'deepseek/deepseek-chat:free',                        // additional fallback
    'mistralai/mistral-7b-instruct:free',                // additional fallback
    'qwen/qwen-2-7b-instruct:free',                      // additional fallback
    'openrouter/free',                                    // final retry after waiting
  ];
  
  let lastError: Error | null = null;
  let consecutiveRateLimits = 0;
  
  for (const model of freeModels) {
    try {
      // On consecutive 429s, wait before retrying
      if (consecutiveRateLimits > 0) {
        const waitMs = Math.min(consecutiveRateLimits * 5000, 30000);
        console.log(`⏳ [OpenRouter] Rate limited ${consecutiveRateLimits}x, waiting ${waitMs/1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      
      console.log(`🌐 [OpenRouter] Trying ${model}...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://catsluvus.com',
          'X-Title': 'CatsLuvUs SEO Generator'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 16000,
          temperature: 0.7
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`⚠️ [OpenRouter] ${model} failed: ${response.status} - ${errorText.substring(0, 200)}`);
        lastError = new Error(`OpenRouter ${model}: ${response.status}`);
        if (response.status === 429) consecutiveRateLimits++;
        else consecutiveRateLimits = 0;
        continue;
      }
      consecutiveRateLimits = 0;
      
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content;
      
      if (!content) {
        console.log(`⚠️ [OpenRouter] ${model} returned empty content`);
        lastError = new Error(`OpenRouter ${model}: empty response`);
        continue;
      }
      
      // Strip reasoning tokens from models like DeepSeek-R1 that output <think>...</think>
      let cleanContent = content;
      if (content.includes('<think>')) {
        cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        console.log(`🧠 [OpenRouter] Stripped reasoning tokens (${content.length} -> ${cleanContent.length} chars)`);
      }
      
      console.log(`✅ [OpenRouter] Got response from ${model} (${cleanContent.length} chars)`);
      return cleanContent;
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log(`⚠️ [OpenRouter] ${model} timed out`);
        lastError = new Error(`OpenRouter ${model}: timeout`);
      } else {
        console.log(`⚠️ [OpenRouter] ${model} error: ${error.message}`);
        lastError = error;
      }
      continue;
    }
  }
  
  throw lastError || new Error('All OpenRouter free models failed');
}

// Track which worker generated each article for A/B comparison
let workerStats = {
  copilot: { count: 0, totalScore: 0, avgScore: 0 },
  cloudflare: { count: 0, totalScore: 0, avgScore: 0 }
};

function updateWorkerStats(worker: 'copilot' | 'cloudflare', seoScore: number) {
  workerStats[worker].count++;
  workerStats[worker].totalScore += seoScore;
  workerStats[worker].avgScore = Math.round(workerStats[worker].totalScore / workerStats[worker].count);
}

async function generateWithCopilotCLISpawn(prompt: string, timeout: number = 600000): Promise<string> {

  let ghToken: string;
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.GITHUB_TOKEN;
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.COPILOT_GITHUB_TOKEN;

    const { stdout } = await execAsync('gh auth token', {
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || path.join(process.env.HOME || '/home/runner', '.config', 'gh'),
        HOME: process.env.HOME || '/home/runner'
      }
    });
    ghToken = stdout.trim();
    console.log(`🔑 Got GitHub token (${ghToken.length} chars, starts with ${ghToken.substring(0, 4)})`);
  } catch (e) {
    throw new Error('GitHub auth required. Run: gh auth login');
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cli.kill('SIGKILL');
      reject(new Error(`CLI timeout after ${timeout}ms`));
    }, timeout);

    // Spawn with proper environment - all env vars must be in env object
    const cli = spawn('npx', [
      'copilot',
      '-p', prompt,
      '--model', 'gpt-4.1',
      '--allow-all-tools',
      '--no-ask-user'
    ], {
      shell: false,
      env: {
        // Include PATH and other essentials
        PATH: process.env.PATH,
        HOME: process.env.HOME || '/home/runner',
        USER: 'runner',
        // GitHub authentication
        GH_TOKEN: ghToken,
        GITHUB_TOKEN: ghToken,
        COPILOT_GITHUB_TOKEN: ghToken,
        // Use the WORKSPACE config dir where gh is actually authenticated
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || path.join(process.env.HOME || '/home/runner', '.config', 'gh'),
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '/home/runner', '.config'),
        // Node related
        NODE_PATH: process.env.NODE_PATH,
        npm_config_prefix: process.env.npm_config_prefix
      },
      cwd: path.resolve(__dirname, '../../..')
    });

    let stdout = '';
    let stderr = '';

    cli.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    cli.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    cli.on('close', (code: number) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`CLI exited with code ${code}: ${stderr}`));
      }
    });

    cli.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * SEO Article Generator API Routes
 * Uses OpenRouter API for AI-powered content generation
 * Deploys generated articles to Cloudflare KV for live serving
 * Routes namespaced under /api/seo-generator/*
 */

interface ArticleData {
  title: string;
  metaDescription: string;
  quickAnswer?: string;
  definitionSnippet?: string;  // AEO: Clear definition for featured snippets & AI citation
  keyFacts?: string[];          // GEO: Specific facts/stats for AI to cite
  keyTakeaways?: string[];
  introduction: string;
  sections: Array<{ heading: string; content: string; subsections?: Array<{ heading: string; content: string }> }>;
  faqs: Array<{ question: string; answer: string }>;
  comparisonTable?: { headers: string[]; rows: string[][] };
  conclusion: string;
  wordCount: number;
  images?: Array<{ url: string; alt: string; caption: string }>;
  externalLinks?: Array<{ url: string; text: string; context: string }>;
  internalLinks?: Array<{ url?: string; slug?: string; anchorText: string; context: string }>;
  providerProsCons?: Array<{ provider: string; pros: string[]; cons: string[] }>;
}

/**
 * Normalize article content fields into proper HTML paragraphs.
 *
 * AI models return plain text strings in JSON. After JSON.parse() the content may contain:
 *   1. Real newlines (\n) — the most common case
 *   2. Literal escaped sequences (the two-char text \n) — from double-escaping bugs
 *   3. No newlines at all — one giant block of text
 *
 * This function handles all three cases and wraps the result in <p> tags so the
 * HTML template doesn't need to. Every long-form content field gets proper paragraphs.
 */

/** Escape text for safe insertion inside HTML text nodes (e.g. list items). */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Remove orphan "Best for:" / Pros / Cons labels when the model left no list or text (avoids empty UI blocks).
 * Safe for HTML fragments (section bodies). Uses cheerio for structure-aware removal.
 */
function stripEmptyProductReviewLabels(html: string): string {
  if (!html || html.length < 15) return html;
  try {
    const wrapped = `<div class="strip-root">${html}</div>`;
    const $ = cheerio.load(wrapped);
    const root = $('.strip-root');

    root.find('p').each((_, el) => {
      const $p = $(el);
      const text = $p.text().replace(/\s+/g, ' ').trim();
      if (/^best for:\s*$/i.test(text)) {
        $p.remove();
        return;
      }
      if (/^(pros|cons)\s*$/i.test(text)) {
        const $next = $p.next();
        if ($next.length && $next.is('ul') && $next.find('li').length > 0) return;
        $p.remove();
      }
    });

    root.find('h1, h2, h3, h4, h5').each((_, el) => {
      const $h = $(el);
      const text = $h.text().replace(/\s+/g, ' ').trim();
      if (!/^(pros|cons)$/i.test(text)) return;
      const $next = $h.next();
      if ($next.length && $next.is('ul')) {
        if ($next.find('li').length === 0) {
          $h.remove();
          $next.remove();
        }
        return;
      }
      $h.remove();
    });

    root.find('ul').each((_, el) => {
      const $ul = $(el);
      if ($ul.find('li').length === 0) $ul.remove();
    });

    return root.html() ?? html;
  } catch {
    return html;
  }
}

/** Same as stripEmptyProductReviewLabels but applied to <article> inner HTML only (KV / optimize pass). Regex-based so we do not re-serialize the full document. */
function stripEmptyProductReviewLabelsInDocument(html: string): string {
  if (!html || !/<article[\s>]/i.test(html)) return html;
  return html.replace(/<article([^>]*)>([\s\S]*?)<\/article>/gi, (_m, attrs: string, inner: string) => {
    return `<article${attrs}>${stripEmptyProductReviewLabels(inner)}</article>`;
  });
}

/**
 * Models sometimes emit each takeaway as a JSON string {"takeaway":"..."} or as an object.
 * Normalize to plain display strings for the template.
 */
function normalizeKeyTakeawayItem(raw: unknown): string | null {
  if (raw == null) return null;
  const cleanWs = (x: string) =>
    x.replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' ').replace(/\s+/g, ' ').trim();

  const fromRecord = (o: Record<string, unknown>): string | null => {
    const tw = o.takeaway ?? o.text;
    const det = o.detail;
    if (typeof tw === 'string' && tw.trim()) {
      const a = cleanWs(tw);
      if (!a) return null;
      if (typeof det === 'string' && det.trim()) return `${a} — ${cleanWs(det)}`;
      return a;
    }
    return null;
  };

  const looksLikeTakeawayObject = (s: string) =>
    s.startsWith('{') &&
    (s.includes('"takeaway"') || s.includes("'takeaway'") || s.includes('"text"'));

  if (typeof raw === 'string') {
    let s = raw.trim();
    if (!s) return null;
    if (looksLikeTakeawayObject(s)) {
      try {
        const got = fromRecord(JSON.parse(s) as Record<string, unknown>);
        if (got) return got;
      } catch {
        /* try repair + regex */
      }
      try {
        const repaired = repairJson(s, { returnObjects: true }) as unknown;
        if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
          const got = fromRecord(repaired as Record<string, unknown>);
          if (got) return got;
        }
      } catch {
        /* fall through */
      }
      const m = s.match(/"takeaway"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m?.[1]) {
        const unescaped = m[1].replace(/\\(.)/g, (_ch, g: string) => {
          if (g === 'n') return ' ';
          if (g === 'r' || g === 't') return ' ';
          return g;
        });
        const dm = s.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const detail = dm?.[1]
          ? dm[1].replace(/\\(.)/g, (_ch, g: string) => {
              if (g === 'n') return ' ';
              if (g === 'r' || g === 't') return ' ';
              return g;
            })
          : '';
        const head = cleanWs(unescaped);
        if (head) return detail ? `${head} — ${cleanWs(detail)}` : head;
      }
      return null;
    }
    return cleanWs(s) || null;
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return fromRecord(raw as Record<string, unknown>);
  }
  return null;
}

function normalizeKeyTakeawaysArray(article: ArticleData): void {
  const kt = article.keyTakeaways as unknown;
  if (!kt) return;
  if (typeof kt === 'string') {
    // Free models sometimes return a newline/comma-delimited string
    const items = (kt as string).split(/\n|,\s*/).map(s => s.trim()).filter(Boolean);
    article.keyTakeaways = items.length > 0 ? items : undefined;
    return;
  }
  if (!Array.isArray(kt)) {
    article.keyTakeaways = undefined;
    return;
  }
  const out: string[] = [];
  for (const item of kt) {
    const s = normalizeKeyTakeawayItem(item);
    if (s) out.push(s);
  }
  article.keyTakeaways = out.length > 0 ? out : undefined;
}

/** Escape special regex characters for safe RegExp construction. */
function escapeRegexChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Topic / heading phrase: first word capitalized, other words lowercase (e.g. "Cat water fountain").
 * Preserves short all-caps tokens (GPS, UK) as-is.
 */
function toTopicPhraseCase(phrase: string): string {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return phrase.trim();
  return words.map((word, idx) => {
    if (/^[A-Z]{2,5}$/.test(word)) return word;
    const lower = word.toLowerCase();
    if (idx === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
    return lower;
  }).join(' ');
}

/**
 * FAQ question hygiene: sentence case at start; normalize topic keyword phrase when present.
 */
function normalizeFaqQuestionCasing(question: string, topicKeyword?: string): string {
  let q = question.trim();
  if (!q) return question;
  q = q.charAt(0).toUpperCase() + q.slice(1);
  const kw = topicKeyword?.trim();
  if (kw && kw.length > 1) {
    const proper = toTopicPhraseCase(kw);
    try {
      if (!/\s/.test(kw)) {
        q = q.replace(new RegExp(`\\b${escapeRegexChars(kw)}\\b`, 'gi'), proper);
      } else {
        q = q.replace(new RegExp(escapeRegexChars(kw), 'gi'), proper);
      }
    } catch {
      /* ignore */
    }
  }
  return q;
}

function normalizeArticleContent(article: ArticleData, opts?: { topicKeyword?: string }): ArticleData {
  const toParagraphs = (s: string): string => {
    if (!s || s.length < 20) return s;

    // If content already contains <p> tags, leave it alone
    if (/<p[\s>]/i.test(s)) return s;

    let text = s
      // Step 1: Normalize literal escape sequences (double-escaped by AI)
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, ' ')
      // Step 2: Normalize real carriage returns
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '');

    // Step 3: Split on double+ newlines into paragraphs
    const paragraphs = text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    // If we only got 1 chunk but it's long (500+ chars), try splitting on single
    // newlines as a fallback — many AI models use single newlines between paragraphs
    if (paragraphs.length === 1 && paragraphs[0].length > 500) {
      const singleSplit = text
        .split(/\n/)
        .map(p => p.trim())
        .filter(p => p.length > 30); // Only keep substantial lines
      if (singleSplit.length > 1) {
        return singleSplit.map(p => `<p>${p}</p>`).join('\n');
      }
    }

    // If still just one big block (no newlines at all), try splitting on sentence
    // boundaries to create ~150-word paragraphs for readability
    if (paragraphs.length === 1 && paragraphs[0].length > 800) {
      const words = paragraphs[0].split(/\s+/);
      const chunks: string[] = [];
      let current: string[] = [];
      for (const word of words) {
        current.push(word);
        // Break at sentence boundaries near 120-180 word marks
        if (current.length >= 120 && /[.!?]$/.test(word)) {
          chunks.push(current.join(' '));
          current = [];
        }
      }
      if (current.length > 0) chunks.push(current.join(' '));
      if (chunks.length > 1) {
        return chunks.map(p => `<p>${p}</p>`).join('\n');
      }
    }

    return paragraphs.map(p => `<p>${p}</p>`).join('\n');
  };

  if (article.introduction) article.introduction = toParagraphs(article.introduction);
  if (article.conclusion) article.conclusion = toParagraphs(article.conclusion);
  if (article.quickAnswer) article.quickAnswer = toParagraphs(article.quickAnswer);
  if (article.definitionSnippet) article.definitionSnippet = toParagraphs(article.definitionSnippet);
  if (article.sections) article.sections.forEach(s => {
    s.content = stripEmptyProductReviewLabels(toParagraphs(s.content));
    if (s.subsections) {
      s.subsections.forEach(sub => {
        sub.content = stripEmptyProductReviewLabels(toParagraphs(sub.content));
      });
    }
  });
  if (article.faqs) {
    article.faqs.forEach(f => {
      f.question = normalizeFaqQuestionCasing(f.question, opts?.topicKeyword);
      f.answer = toParagraphs(f.answer);
    });
  }
  normalizeKeyTakeawaysArray(article);
  if (article.keyFacts) article.keyFacts = article.keyFacts.map(t => t.replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' '));
  return article;
}

// ---------------------------------------------------------------------------
// Post-parse output quality validation + optional LLM repair (generateV3Article)
// ---------------------------------------------------------------------------

function collectArticleTextForQualityScan(article: ArticleData): string {
  const parts: string[] = [];
  if (article.title) parts.push(article.title);
  if (article.metaDescription) parts.push(article.metaDescription);
  if (article.quickAnswer) parts.push(article.quickAnswer);
  if (article.definitionSnippet) parts.push(article.definitionSnippet);
  if (article.introduction) parts.push(article.introduction);
  if (article.conclusion) parts.push(article.conclusion);
  if (article.keyTakeaways) parts.push(...article.keyTakeaways);
  if (article.keyFacts) parts.push(...article.keyFacts);
  for (const s of article.sections || []) {
    if (s.heading) parts.push(s.heading);
    if (s.content) parts.push(s.content);
    for (const sub of s.subsections || []) {
      if (sub.heading) parts.push(sub.heading);
      if (sub.content) parts.push(sub.content);
    }
  }
  for (const f of article.faqs || []) {
    if (f.question) parts.push(f.question);
    if (f.answer) parts.push(f.answer);
  }
  return parts.join('\n');
}

const OUTPUT_QUALITY_BAD_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bhighly for\b/i, label: 'highly for (missing word before "for")' },
  { pattern: /\bthe most factor\b/i, label: 'the most factor' },
  { pattern: /\bpraise its for\b/i, label: 'praise its for' },
  { pattern: /\baddresses the of\b/i, label: 'addresses the of' },
  { pattern: /\bjustify the for\b/i, label: 'justify the for' },
  { pattern: /\bserves as an for\b/i, label: 'serves as an for' },
  { pattern: /households\.Best/i, label: 'merged text households.Best' },
];

function validateArticleOutputQuality(article: ArticleData): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const text = collectArticleTextForQualityScan(article);

  for (const { pattern, label } of OUTPUT_QUALITY_BAD_PATTERNS) {
    if (pattern.test(text)) issues.push(`Pattern: ${label}`);
  }

  if (!article.title?.trim()) issues.push('Missing title');
  if (!article.metaDescription?.trim()) issues.push('Missing metaDescription');
  if (!article.introduction?.trim() || article.introduction.trim().length < 80) {
    issues.push('Introduction missing or shorter than 80 characters');
  }
  if (!article.conclusion?.trim() || article.conclusion.trim().length < 40) {
    issues.push('Conclusion missing or shorter than 40 characters');
  }

  const sections = article.sections || [];
  if (sections.length < 3) issues.push(`sections: only ${sections.length} (need at least 3)`);
  sections.forEach((s, i) => {
    if (!s.heading?.trim()) issues.push(`Section ${i + 1}: empty heading`);
    const contentStr = typeof s.content === 'string' ? s.content : Array.isArray(s.content) ? (s.content as string[]).join('\n') : String(s.content || '');
    if (!contentStr.trim() || contentStr.trim().length < 60) {
      issues.push(`Section ${i + 1}: content missing or shorter than 60 characters`);
    }
  });

  const faqs = article.faqs || [];
  if (faqs.length < 4) issues.push(`FAQs: only ${faqs.length} (need at least 4)`);
  faqs.forEach((f, i) => {
    if (!f.question?.trim()) issues.push(`FAQ ${i + 1}: empty question`);
    const answerStr = typeof f.answer === 'string' ? f.answer : Array.isArray(f.answer) ? (f.answer as string[]).join('\n') : String(f.answer || '');
    if (!answerStr.trim() || answerStr.trim().length < 40) {
      issues.push(`FAQ ${i + 1}: answer missing or shorter than 40 characters`);
    }
  });

  return { ok: issues.length === 0, issues };
}

async function repairArticleJsonWithIssues(
  article: ArticleData,
  issues: string[],
  keywordKeyword: string
): Promise<ArticleData | null> {
  const prompt = `You are an expert editor. Fix ONLY the issues listed. Return ONLY a JSON object with the same keys and structure as the input article. No markdown fences, no markdown, no text before or after the JSON.

KEYWORD/TOPIC: ${keywordKeyword}

ISSUES TO FIX:
${issues.map((x, i) => `${i + 1}. ${x}`).join('\n')}

CURRENT ARTICLE (JSON):
${JSON.stringify(article)}

RULES: Write complete sentences with subjects and finite verbs; remove TODO/TBD/lorem stubs only; keep image license/attribution lines when present; fix merged headings (e.g. households. Best); keep product names accurate; preserve internalLinks and externalLinks arrays; keep the same schema.`;

  try {
    const aiResult = await generateWithClaudeAgentSdk(prompt, { maxTokens: 16000 });
    if (!aiResult?.content) return null;
    let raw = aiResult.content;
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) raw = fenceMatch[1].trim();
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    const jsonStr = raw.substring(firstBrace, lastBrace + 1);
    let repaired: ArticleData;
    try {
      repaired = JSON.parse(jsonStr) as ArticleData;
    } catch {
      const fixed = repairJson(jsonStr, { returnObjects: false }) as string;
      repaired = JSON.parse(fixed) as ArticleData;
    }
    if (!repaired.title || !repaired.sections?.length) return null;
    return repaired;
  } catch (e: any) {
    console.warn(`[SEO-V3] Article repair pass failed: ${e.message}`);
    return null;
  }
}

/**
 * Run Harper grammar checker on article text fields before HTML assembly.
 * Auto-applies the first suggestion for each error (spelling, grammar, punctuation).
 * Harper is rule-based (not AI), runs via WASM, <10ms per field, zero network calls.
 *
 * IMPORTANT: Harper must run BEFORE normalizeArticleContent wraps text in <p> tags,
 * because Harper's span positions are for plain text, not HTML.
 */
let _harperLinter: any = null;
let _harperInitFailed = false;
async function getHarperLinter() {
  // If init already failed, don't retry every article — log once and skip
  if (_harperInitFailed) return null;

  if (!_harperLinter) {
    try {
      const harper = await import('harper.js');
      if (!harper.LocalLinter) {
        throw new Error('harper.js module loaded but LocalLinter export is missing');
      }
      if (!harper.binary) {
        throw new Error('harper.js module loaded but binary (WASM) export is missing');
      }
      _harperLinter = new harper.LocalLinter({
        binary: harper.binary,
        dialect: harper.Dialect?.American ?? 0,
      });
      // Pre-warm the WASM module so first lint isn't slow
      await _harperLinter.setup();
      console.log('[Harper] ✅ Grammar checker initialized (WASM loaded)');
    } catch (initError: any) {
      _harperInitFailed = true;
      console.error(`[Harper] ❌ Initialization FAILED — grammar checking disabled for this process`);
      console.error(`[Harper] Error: ${initError.message}`);
      console.error(`[Harper] Stack: ${initError.stack?.split('\n').slice(0, 3).join('\n')}`);
      return null;
    }
  }
  return _harperLinter;
}

let _lastGrammarFixCount = 0;
function getLastGrammarFixCount(): number { return _lastGrammarFixCount; }

async function grammarCheckArticle(article: ArticleData): Promise<ArticleData> {
  // Unwrap {"takeaway":"..."} shapes before Harper (expects strings per item).
  normalizeKeyTakeawaysArray(article);

  const linter = await getHarperLinter();
  if (!linter) return article; // Harper unavailable — skip silently (already logged at init)

  let totalFixes = 0;
  _lastGrammarFixCount = 0;

  const fixText = async (text: string): Promise<string> => {
    if (!text || text.length < 10) return text;

    // Strip HTML tags before linting so span positions match the plain text.
    // After fixing, we put the tags back by operating on the original.
    const plainText = text.replace(/<[^>]*>/g, '');
    if (plainText.length < 10) return text;

    try {
      const lints = await linter.lint(plainText);
      if (!lints || lints.length === 0) return text;

      // Apply fixes in reverse order so span positions stay valid
      const fixes = lints
        .filter((l: any) => {
          try { return l.suggestion_count() > 0; } catch { return false; }
        })
        .map((l: any) => {
          try {
            return {
              start: l.span().start,
              end: l.span().end,
              replacement: l.suggestions()[0].get_replacement_text(),
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.start - a.start);

      if (fixes.length === 0) return text;

      // If text has no HTML, apply directly
      if (text === plainText) {
        let result = text;
        for (const fix of fixes) {
          result = result.slice(0, fix!.start) + fix!.replacement + result.slice(fix!.end);
          totalFixes++;
        }
        return result;
      }

      // Text has HTML — apply fixes to plain text, then return fixed version
      // (we can't perfectly map spans back to HTML, so lint the plain version)
      let result = plainText;
      for (const fix of fixes) {
        result = result.slice(0, fix!.start) + fix!.replacement + result.slice(fix!.end);
        totalFixes++;
      }
      return result;
    } catch (lintError: any) {
      console.warn(`[Harper] ⚠️ Lint failed on text (${text.length} chars): ${lintError.message}`);
      return text; // Return original on per-field failure
    }
  };

  try {
    if (article.introduction) article.introduction = await fixText(article.introduction);
    if (article.conclusion) article.conclusion = await fixText(article.conclusion);
    if (article.quickAnswer) article.quickAnswer = await fixText(article.quickAnswer);
    if (article.definitionSnippet) article.definitionSnippet = await fixText(article.definitionSnippet);
    if (article.sections) {
      for (const s of article.sections) {
        s.content = await fixText(s.content);
        if (s.subsections) {
          for (const sub of s.subsections) {
            sub.content = await fixText(sub.content);
          }
        }
      }
    }
    if (article.faqs) {
      for (const f of article.faqs) {
        f.answer = await fixText(f.answer);
      }
    }
    if (article.keyTakeaways) {
      article.keyTakeaways = await Promise.all(article.keyTakeaways.map(fixText));
    }
    if (article.keyFacts) {
      article.keyFacts = await Promise.all(article.keyFacts.map(fixText));
    }

    _lastGrammarFixCount = totalFixes;
    if (totalFixes > 0) {
      console.log(`[Harper] ✅ Auto-fixed ${totalFixes} grammar/spelling issues`);
    } else {
      console.log(`[Harper] ✓ No grammar issues found`);
    }
  } catch (error: any) {
    console.error(`[Harper] ❌ Grammar check failed: ${error.message}`);
    console.error(`[Harper] Stack: ${error.stack?.split('\n').slice(0, 3).join('\n')}`);
  }
  return article;
}

/**
 * SEO Tools for Copilot SDK Agent (using JSON Schema for parameters)
 */
async function getSEOTools() {
  const { defineTool } = await loadCopilotSDK();

  return [
    defineTool('analyze_serp', {
      description: 'Analyze Google SERP for a keyword to understand competitor content and identify gaps',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'The keyword to analyze SERP for' }
        },
        required: ['keyword']
      },
      handler: async (args: { keyword: string }) => {
        const result = await analyzeSERP(args.keyword);
        return JSON.stringify(result, null, 2);
      }
    }),

    defineTool('get_keyword_data', {
      description: 'Get keyword data including related entities and SEO thresholds',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'The keyword to get data for' }
        },
        required: ['keyword']
      },
      handler: async (args: { keyword: string }) => {
        const lower = args.keyword.toLowerCase();
        const isDog = lower.includes('dog') || lower.includes('puppy');
        const isCat = lower.includes('cat') || lower.includes('kitten');

        return JSON.stringify({
          keyword: args.keyword,
          slug: keywordToSlug(args.keyword),
          entities: {
            base: ENTITIES.base,
            specific: isDog ? ENTITIES.dog : isCat ? ENTITIES.cat : []
          },
          thresholds: SEO_THRESHOLDS,
          credibleSources: Object.values(CREDIBLE_SOURCES)
        }, null, 2);
      }
    }),

    defineTool('get_expert_author', {
      description: 'Get an EEAT expert author for a topic',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic/title to get an author for' }
        },
        required: ['topic']
      },
      handler: async (args: { topic: string }) => {
        const author = getAuthorForTopic(args.topic);
        return JSON.stringify(author, null, 2);
      }
    }),

    defineTool('deploy_to_cloudflare', {
      description: 'Deploy article HTML to Cloudflare KV for live serving',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'URL slug for the article' },
          html: { type: 'string', description: 'Full HTML content to deploy' },
          category: { type: 'string', description: 'Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance".' }
        },
        required: ['slug', 'html']
      },
      handler: async (args: { slug: string; html: string; category?: string }) => {
        const category = args.category || 'petinsurance';
        const result = await deployToCloudflareKV(args.slug, args.html, category);
        return JSON.stringify({
          ...result,
          liveUrl: result.success ? `https://catsluvus.com/${category}/${args.slug}` : null
        });
      }
    }),

    defineTool('build_article_html', {
      description: 'Build full SEO-optimized HTML from article JSON data',
      parameters: {
        type: 'object',
        properties: {
          article: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              metaDescription: { type: 'string' },
              introduction: { type: 'string' },
              sections: { type: 'array' },
              faqs: { type: 'array' },
              comparisonTable: { 
                type: 'object',
                properties: {
                  headers: { type: 'array', items: { type: 'string' }, description: 'Table headers: Product, Features, Pros, Cons, Amazon Search' },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Table rows with 5 columns each, last column is product name for Amazon search' }
                },
                required: ['headers', 'rows']
              },
              conclusion: { type: 'string' },
              wordCount: { type: 'number' }
            },
            required: ['title', 'metaDescription', 'introduction', 'sections', 'faqs', 'comparisonTable', 'conclusion', 'wordCount']
          },
          slug: { type: 'string' },
          keyword: { type: 'string' }
        },
        required: ['article', 'slug', 'keyword']
      },
      handler: async (args: { article: ArticleData; slug: string; keyword: string }) => {
        const html = buildArticleHtml(args.article, args.slug, args.keyword, activeCategoryContext, undefined, undefined, undefined);
        return html.substring(0, 500) + '... [HTML built successfully, ' + html.length + ' chars]';
      }
    })
  ];
}

/**
 * Generate article using GitHub Copilot CLI directly
 * Uses npx copilot -p (official CLI prompt mode that actually works)
 */
// ============================================================================
// MOCK RESPONSE FOR DEVELOPMENT (when API keys are placeholder)
// ============================================================================

async function getMockArticleResponse(keyword: string, slug: string): Promise<{
  success: boolean;
  article?: ArticleData;
  slug?: string;
  deployed?: boolean;
  liveUrl?: string | null;
  serpAnalysis?: any;
  error?: string;
}> {
  console.log(`🎭 [MOCK] Generating mock article for "${keyword}"`);

  const mockArticle: ArticleData = {
    title: `Best ${keyword} Plans ${CURRENT_YEAR}: Complete Guide & Reviews`,
    metaDescription: `Compare the best ${keyword} options for ${CURRENT_YEAR}. Expert reviews, pricing, coverage details, and FAQs to help you choose the right plan for your pet.`,
    quickAnswer: `The best ${keyword} depends on your needs, but Lemonade offers excellent coverage starting at $15/month with fast claims processing. For comprehensive protection, consider Trupanion with 90% reimbursement rates.`,
    keyTakeaways: [
      `Lemonade provides affordable ${keyword} starting at $15/month with AI-powered claims`,
      "Trupanion offers 90% reimbursement with direct vet payments",
      "Healthy Paws has unlimited annual payouts with no caps on claims",
      "ASPCA offers flexible deductibles with good preventive care coverage",
      "Compare at least 3 providers before choosing a plan"
    ],
    introduction: `<p>Finding the right ${keyword} can be overwhelming with so many options available. This comprehensive guide compares the top providers, their coverage details, pricing, and customer reviews to help you make an informed decision for your pet's healthcare needs.</p>`,
    sections: [
      {
        heading: `What is ${keyword}?`,
        content: `<p>${keyword} provides financial protection for unexpected veterinary expenses. Unlike traditional pet insurance, these plans typically cover accidents, illnesses, and wellness care with varying reimbursement rates and deductibles.</p>`,
        subsections: []
      },
      {
        heading: "Top 5 Best Pet Insurance Providers",
        content: `<p>Based on customer reviews, coverage options, and claims processing speed, here are the top ${keyword} providers:</p>`,
        subsections: [
          {
            heading: "1. Lemonade Pet Insurance",
            content: `<p>Lemonade offers modern ${keyword} with AI-powered claims processing. Key features include:</p><ul><li>Starting at $15/month</li><li>Up to 90% reimbursement</li><li>Fast claims processing (minutes)</li><li>Covers accidents and illnesses</li></ul>`
          },
          {
            heading: "2. Trupanion",
            content: `<p>Trupanion provides comprehensive ${keyword} with direct vet payments. Benefits include:</p><ul><li>90% reimbursement rate</li><li>Direct payment to vets</li><li>No annual payout limits</li><li>24/7 customer support</li></ul>`
          }
        ]
      },
      {
        heading: "How to Choose the Right Pet Insurance",
        content: `<p>When selecting ${keyword}, consider these important factors:</p><ul><li><strong>Coverage type:</strong> Accident-only vs comprehensive</li><li><strong>Reimbursement rate:</strong> 70%, 80%, or 90%</li><li><strong>Deductible amount:</strong> $100-$500 annually</li><li><strong>Claims process:</strong> Direct payment vs reimbursement</li></ul>`,
        subsections: []
      }
    ],
    faqs: [
      {
        question: `What does ${keyword} typically cover?`,
        answer: `${keyword} usually covers accidents, illnesses, emergency care, and sometimes preventive care like vaccinations and dental cleanings.`
      },
      {
        question: "How much does pet insurance cost?",
        answer: `${keyword} premiums typically range from $15-$50 per month depending on your pet's age, breed, and coverage level.`
      },
      {
        question: "When should I get pet insurance?",
        answer: "It's best to get pet insurance when your pet is young and healthy, before any pre-existing conditions develop."
      }
    ],
    conclusion: `<p>Choosing the right ${keyword} requires careful consideration of your pet's needs, your budget, and the coverage options available. Lemonade and Trupanion consistently rank among the top providers for their comprehensive coverage and customer service. Compare multiple options and read recent reviews before making your decision.</p>`,
    comparisonTable: {
      headers: ['Provider', 'Monthly Cost', 'Reimbursement', 'Deductible', 'Rating'],
      rows: [
        ['Lemonade', '$15-30', 'Up to 90%', '$100-500', '4.6/5'],
        ['Trupanion', '$25-45', '90%', '$0-500', '4.5/5'],
        ['Healthy Paws', '$20-40', 'Unlimited', '$100-250', '4.7/5'],
        ['ASPCA', '$18-35', 'Up to 90%', '$100-500', '4.4/5'],
        ['Embrace', '$22-42', '80-90%', '$200-500', '4.3/5']
      ]
    },
    externalLinks: [
      { url: 'https://www.aspca.org/pet-care/general-pet-care/pet-insurance', text: 'ASPCA Pet Insurance Guide', context: 'General pet insurance information' },
      { url: 'https://www.avma.org/resources-tools/pet-owners/petcare/pet-insurance', text: 'AVMA Pet Insurance Resources', context: 'Veterinary perspective on pet insurance' }
    ],
    wordCount: 2500
  };

  return {
    success: true,
    article: mockArticle,
    slug: slug,
    deployed: false,
    liveUrl: null,
    serpAnalysis: {
      targetWordCount: 2500,
      avgWordCount: 2200,
      commonTopics: ['coverage options', 'pricing', 'claims process', 'customer reviews'],
      contentGaps: ['2026 updates', 'new providers', 'cost analysis'],
      competitorHeadings: ['What is Pet Insurance?', 'Top Providers', 'Coverage Comparison', 'How to Choose'],
      competitorFAQs: [`What does ${keyword} cover?`, 'How much does it cost?', 'Which is best?'],
      competitorEntities: ['Lemonade', 'Trupanion', 'Healthy Paws', 'ASPCA']
    }
  };
}

async function generateWithCopilotSDK(keyword: string): Promise<{
  success: boolean;
  article?: ArticleData;
  slug?: string;
  deployed?: boolean;
  liveUrl?: string | null;
  serpAnalysis?: any;
  error?: string;
}> {
  const slug = keywordToSlug(keyword);

  // CHECK FOR MOCK MODE - Return mock data immediately if API keys are placeholder
  const anthropicKey = secrets.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
  const isMockMode = !anthropicKey || anthropicKey === 'your-anthropic-api-key-here' || anthropicKey.startsWith('sk-ant-placeholder');
  
  if (isMockMode) {
    console.log(`🎭 [MOCK MODE] Using mock response for "${keyword}" (placeholder API keys detected)`);
    return await getMockArticleResponse(keyword, slug);
  }

  try {
    console.log(`🤖 [Copilot CLI] Generating article for: "${keyword}"`);

    // SERP Analysis - Analyze what's ranking #1-10 to beat competitors
    console.log(`🔍 [SERP] Analyzing top 10 Google results for: "${keyword}"`);
    const serpAnalysis = await analyzeSERP(keyword);
    
    // Build SERP insights for the prompt with competitor headings, FAQs, and entities
    const competitorHeadingsText = serpAnalysis.competitorHeadings.length > 0
      ? `\nCompetitor H2/H3 headings (COVER ALL these topics): ${serpAnalysis.competitorHeadings.slice(0, 12).join(' | ')}`
      : '';
    const competitorFAQsText = serpAnalysis.competitorFAQs.length > 0
      ? `\nCompetitor FAQ questions (ANSWER ALL these): ${serpAnalysis.competitorFAQs.slice(0, 8).join(' | ')}`
      : '';
    const competitorEntitiesText = serpAnalysis.competitorEntities && serpAnalysis.competitorEntities.length > 0
      ? `\nKey entities/brands competitors mention (MUST REFERENCE): ${serpAnalysis.competitorEntities.slice(0, 10).join(', ')}`
      : '';

    const serpInsights = serpAnalysis.topResults.length > 0 
      ? `\n\nCOMPETITOR ANALYSIS (Based on scraping top 10 Google results):
Top-ranking titles: ${serpAnalysis.topResults.slice(0, 5).map(r => `"${r.title}"`).join(', ')}
Topics ALL competitors cover (MUST INCLUDE): ${serpAnalysis.commonTopics.join(', ')}${competitorHeadingsText}${competitorFAQsText}${competitorEntitiesText}
Content gaps to exploit (UNIQUE ANGLES to beat competitors): ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount} words (match #1 competitor length, competitors average ${serpAnalysis.avgWordCount} words)
Average competitor title length: ${Math.round(serpAnalysis.avgTitleLength)} characters

CRITICAL: Your article MUST cover every topic/heading listed above, answer every FAQ question, and reference key entities/brands competitors mention. This ensures comprehensive coverage that Google rewards with Position 1.\n`
      : `\n\nCOMPETITOR ANALYSIS:
Topics to cover: ${serpAnalysis.commonTopics.join(', ')}
Content gaps to exploit: ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount} words\n`;

    // Fetch existing articles for internal linking
    const existingSlugs = await fetchExistingArticleSlugs();
    const existingArticlesList = Array.from(existingSlugs).slice(0, 100).join(', ');

    // Fetch real People Also Ask questions from Google (FREE)
    const paaQuestions = await fetchPAAQuestions(keyword);
    const paaQuestionsText = paaQuestions.length > 0 
      ? `\n\nPEOPLE ALSO ASK (Use these EXACT questions as your FAQs - they are real Google search queries):\n${paaQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n`
      : '';

    const prompt = `You are an expert SEO content writer for pet insurance. Generate an SEO article about "${keyword}" optimized for Google Featured Snippets (Position 0).
${serpInsights}
${paaQuestionsText}
Requirements:
- STRICT WORD COUNT: Write EXACTLY ${serpAnalysis.targetWordCount} words (±15%). Do NOT exceed ${Math.round(serpAnalysis.targetWordCount * 1.15)} words. This target matches the #1 ranking competitor. Longer is NOT better — Google rewards concise, focused content that matches search intent.
- Use "${keyword}" naturally 8-12 times throughout
- Include comparison table with real data for: Lemonade, Healthy Paws, Trupanion, ASPCA
- Include ${Math.max(6, serpAnalysis.competitorFAQs.length || 6)} FAQs optimized for Google Featured Snippets and People Also Ask (USE THE "PEOPLE ALSO ASK" QUESTIONS ABOVE if provided)
- FAQ ANSWER FORMAT (CRITICAL FOR FEATURED SNIPPETS):
  * First sentence: Direct answer in 40-60 words. This is what Google extracts for Position 0. Start with the answer, not context.
  * Then: 2-3 sentences of supporting detail with specific data, prices, or examples (60-100 words)
  * Total per FAQ: 100-160 words MAX. Concise beats comprehensive for snippet capture.
  * Use bullet points or numbered lists within answers when listing options, steps, or comparisons.
- Include expert quotes and real pricing data
- Write in an authoritative, trustworthy tone
- Include 3-5 external authority links naturally in the content (official insurance provider sites, veterinary associations like AVMA, state insurance regulators, or other relevant .gov/.org sources)

INTERNAL LINKING (Critical for SEO):
Add 3-5 internal links to related articles from our existing content. Select the most relevant slugs from this list:
${existingArticlesList}

Use descriptive anchor text (not "click here"). Insert links naturally within the content where they add value.

CRITICAL FOR RANKING #1 - Featured Snippet Optimization:
1. quickAnswer: A 40-60 word DIRECT answer that Google can extract for Position 0. Start with "The [keyword] is..." format.
2. keyTakeaways: 4-5 bullet points (each 15-25 words) that summarize the key information. MUST be an array of plain strings only — each element is the sentence text itself, NOT an object and NOT a JSON string like {"takeaway":"..."}.
3. FAQs must have a direct answer as the first sentence (40-60 words) that Google can pull for Position 0 / People Also Ask. Then add 2-3 supporting sentences. Keep total answer under 160 words. Each FAQ *question* must start with a capital letter and use sentence-style casing for the topic (e.g. "Cat insurance" / "Pet insurance deductible" — not all-lowercase topic phrases).
4. images: 3 relevant Unsplash stock photo URLs with SEO alt text and captions.
5. externalLinks: 3-5 authority links with full URLs to official sources relevant to the topic (insurance providers, veterinary organizations, government regulators).

STRICT SEO REQUIREMENTS FOR 100/100 SCORE (CRITICAL - COUNT CHARACTERS):
**TITLE: EXACTLY 50-55 CHARACTERS (not 56+, not 49-)**
- Count EVERY character including spaces before outputting
- Example: "Best Cat Insurance Plans 2026: Expert Buyer Guide" = 50 chars ✓
- Use shorter words: "vs" not "versus", "&" not "and"

**META DESCRIPTION: EXACTLY 145-155 CHARACTERS (not 156+, not 144-)**
- Count EVERY character before outputting
- Include primary keyword naturally once
- Include call-to-action (Discover, Compare, Learn)

**KEYWORD DENSITY: 1.0-1.5%** (For ${serpAnalysis.targetWordCount} words = use keyword ${Math.round(serpAnalysis.targetWordCount * 0.01)}-${Math.round(serpAnalysis.targetWordCount * 0.015)} times)
**HEADINGS: 4-8 unique H2s** - No duplicates, keyword in 2+ H2s
**LINKS: 3-5 internal + 2-3 external authority links**

AI WRITING DETECTION AVOIDANCE (CRITICAL FOR SEO - from marketing-psychology skill):
Avoid these patterns that trigger AI detection algorithms:
- NEVER use em dashes (—). Use commas, colons, or parentheses instead.
- AVOID verbs: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, enhance, endeavour, embark, unravel
- AVOID adjectives: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking, seamless, nuanced, holistic, innovative, multifaceted
- AVOID phrases: "In today's fast-paced world", "It's important to note", "Let's delve into", "That being said", "At its core", "In the realm of", "It goes without saying"
- AVOID filler words: absolutely, actually, basically, certainly, essentially, extremely, fundamentally, incredibly, naturally, obviously, significantly, truly, ultimately
- Use varied sentence lengths and natural conversational tone
- Include contractions (don't, can't, won't) for natural voice
- Start some sentences with "And" or "But" for human-like flow
- Write like a human expert, not an AI

Return ONLY valid JSON (no markdown code blocks, no explanation before/after):
{
  "title": "[MAX 55 CHARS - SHORTER IS BETTER] SEO title with '${keyword}'",
  "metaDescription": "[MAX 155 CHARS] Description with '${keyword}'",
  "quickAnswer": "40-60 word direct answer starting with 'The ${keyword}...' that Google can pull for Featured Snippet Position 0. Include the top recommendation and key facts.",
  "keyTakeaways": [
    "First key point in 15-25 words with specific data",
    "Second key point about costs or coverage",
    "Third key point about best provider",
    "Fourth key point about what to avoid",
    "Fifth key point with actionable advice"
  ],
  "images": [
    {"url": "https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80", "alt": "Dog at veterinarian for ${keyword}", "caption": "Understanding your pet insurance options is key to protecting your furry family member."},
    {"url": "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800&q=80", "alt": "Cat receiving medical care for ${keyword}", "caption": "Quality pet insurance ensures your cat gets the care they need."},
    {"url": "https://images.unsplash.com/photo-1450778869180-41d0601e046e?w=800&q=80", "alt": "Happy pet owner with dog discussing ${keyword}", "caption": "The right insurance plan gives pet owners peace of mind."}
  ],
  "introduction": "400+ words introducing the topic, establishing expertise",
  "sections": [
    {"heading": "UNIQUE H2 heading about coverage basics (no duplicates)", "content": "500+ words of detailed content"},
    {"heading": "DIFFERENT H2 about cost analysis (must be unique)", "content": "500+ words"},
    {"heading": "DISTINCT H2 comparing providers (all headings unique)", "content": "500+ words"},
    {"heading": "SEPARATE H2 on claims process (no repeated text)", "content": "500+ words"}
  ],
  "comparisonTable": {
    "headers": ["Provider", "Monthly Cost", "Deductible", "Reimbursement", "Annual Limit"],
    "rows": [
      ["Lemonade", "$15-40", "$100-500", "70-90%", "$5k-100k"],
      ["Healthy Paws", "$20-50", "$100-500", "70-90%", "Unlimited"],
      ["Trupanion", "$30-70", "$0-1000", "90%", "Unlimited"],
      ["ASPCA", "$18-45", "$100-500", "70-90%", "$5k-10k"]
    ]
  },
  "faqs": [
    {"question": "What is the ${keyword}?", "answer": "Direct 40-60 word answer first. Then 2-3 sentences with specifics. Total: 100-160 words max."},
    {"question": "How much does ${keyword} cost?", "answer": "Lead with specific price range in first sentence. Then 2-3 supporting details. Total: 100-160 words max."},
    {"question": "Which provider offers the ${keyword}?", "answer": "Name the top provider immediately. Then brief comparison. Total: 100-160 words max."},
    {"question": "Is ${keyword} worth it?", "answer": "Start with Yes/No and one-line reason. Then supporting evidence. Total: 100-160 words max."},
    {"question": "Claims process question?", "answer": "Direct answer first, then steps or details. 100-160 words max."},
    {"question": "Provider comparison question?", "answer": "Name best option first, then compare. 100-160 words max."},
    {"question": "Waiting period question?", "answer": "State the timeframe first, then explain. 100-160 words max."},
    {"question": "Pre-existing conditions question?", "answer": "Direct policy answer first, then details. 100-160 words max."}
  ],
  "conclusion": "300+ words summarizing key points and call to action",
  "externalLinks": [
    {"url": "https://example-provider.com", "text": "anchor text", "context": "sentence where link appears naturally"},
    {"url": "https://example-authority.org", "text": "anchor text", "context": "sentence where link appears naturally"}
  ],
  "internalLinks": [
    {"url": "/category/related-article-slug", "anchorText": "descriptive anchor text", "context": "sentence where internal link should appear naturally in the content"}
  ],
  "providerProsCons": [
    {"provider": "Lemonade", "pros": ["Low monthly premiums starting at $15", "Fast AI-powered claims processing", "User-friendly mobile app"], "cons": ["Lower annual limits than competitors", "No wellness add-on available", "Limited coverage for older pets"]},
    {"provider": "Healthy Paws", "pros": ["Unlimited annual payouts", "No caps on claims", "Fast reimbursement"], "cons": ["Higher premiums for comprehensive coverage", "No wellness coverage option", "Premiums increase with age"]},
    {"provider": "Trupanion", "pros": ["90% reimbursement rate", "Direct vet payment option", "Covers hereditary conditions"], "cons": ["Higher monthly costs", "Only one reimbursement tier", "Longer waiting periods"]},
    {"provider": "ASPCA", "pros": ["Flexible deductible options", "Wellness add-ons available", "Good for preventive care"], "cons": ["Lower annual limits", "Customer service complaints", "Slower claims processing"]}
  ],
  "wordCount": ${serpAnalysis.targetWordCount}
}`;

    // Use direct CLI invocation (10 minute timeout for long articles)
    const content = await generateWithCopilotCLI(prompt, 600000);
    console.log(`🤖 [Copilot CLI] Received response (${content.length} chars)`);

    // Extract JSON from response (supports fenced markdown and non-strict field order)
    let raw = content;
    const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      raw = fenceMatch[1].trim();
    }

    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      console.log('⚠️ [Copilot CLI] No JSON object found. Response preview:', content.substring(0, 500));
      throw new Error('No article JSON in Copilot response');
    }

    // Sanitize JSON: remove control characters that break parsing
    const sanitizedJson = raw.substring(firstBrace, lastBrace + 1)
      .replace(/[\x00-\x1F\x7F]/g, (char) => {
        // Preserve valid JSON whitespace: tab, newline, carriage return
        if (char === '\t' || char === '\n' || char === '\r') return char;
        // Remove other control characters
        return '';
      })
      .replace(/\n\s*\n/g, '\n'); // Collapse multiple newlines

    if (!sanitizedJson.includes('"title"')) {
      console.log('⚠️ [Copilot CLI] JSON block missing title. Response preview:', content.substring(0, 500));
      throw new Error('No article JSON in Copilot response (missing title)');
    }
    
    let article: ArticleData;
    try {
      article = JSON.parse(sanitizedJson) as ArticleData;
    } catch (parseErr: any) {
      console.log(`⚠️ [Copilot CLI] JSON.parse failed: ${parseErr.message}, attempting json-repair...`);
      const repaired = repairJson(sanitizedJson, { returnObjects: false }) as string;
      article = JSON.parse(repaired) as ArticleData;
      console.log(`✅ [Copilot CLI] json-repair recovered article successfully`);
    }
    article = await grammarCheckArticle(article);  // Harper runs first on plain text
    article = normalizeArticleContent(article, { topicKeyword: keyword });     // Then wrap in <p> tags
    console.log(`✅ [Copilot CLI] Generated: ${article.title}`);

    // Enforce SEO limits - truncate title and meta description
    const seoLimits = enforceSEOLimits(article);
    article.title = seoLimits.title;
    article.metaDescription = seoLimits.metaDescription;

    // Search for relevant YouTube video
    let video: YouTubeVideo | undefined;
    try {
      const videoResult = await searchYouTubeVideo(keyword);
      if (videoResult.success && videoResult.videos && videoResult.videos.length > 0) {
        video = videoResult.videos[0];
        console.log(`🎬 [YouTube] Found video: "${video.title}" by ${video.channel}`);
      }
    } catch (err: any) {
      console.log(`⚠️ [YouTube] Search skipped: ${err.message}`);
    }

    // Build HTML and deploy to Cloudflare KV - pass activeCategoryContext for dynamic breadcrumbs/URLs
    const html = buildArticleHtml(article, slug, keyword, activeCategoryContext, video, undefined, undefined);
    
    // Calculate SEO score using seord library
    const seoScore = await calculateSEOScore(html, keyword, article.title, article.metaDescription, serpAnalysis.targetWordCount);
    console.log(`📊 [SEO Score] ${slug}: ${seoScore.score}/100`);
    
    // Track worker stats
    updateWorkerStats('copilot', seoScore.score);
    
    const deployCategory = activeCategoryContext?.basePath?.replace(/^\//, '') || 'petinsurance';
    const deployResult = await deployToCloudflareKV(slug, html, deployCategory, article.title);

    if (deployResult.success) {
      console.log(`☁️ [Copilot CLI] Deployed to KV: ${slug}`);
    }

    // Use dynamic category context for liveUrl
    const categoryPath = activeCategoryContext?.basePath || '/petinsurance';
    const categoryDomainForUrl = activeCategoryContext?.domain || 'catsluvus.com';
    
    return {
      success: true,
      article,
      slug,
      deployed: deployResult.success,
      liveUrl: deployResult.success ? `https://${categoryDomainForUrl}${categoryPath}/${slug}` : null,
      seoScore: seoScore.score,
      worker: 'copilot' as const,
      serpAnalysis: {
        competitorsAnalyzed: serpAnalysis.topResults.length,
        topicsFound: serpAnalysis.commonTopics,
        competitorHeadings: serpAnalysis.competitorHeadings.slice(0, 10),
        competitorFAQs: serpAnalysis.competitorFAQs.slice(0, 8),
        competitorEntities: serpAnalysis.competitorEntities?.slice(0, 10) || [],
        contentGaps: serpAnalysis.contentGaps,
        targetWordCount: serpAnalysis.targetWordCount,
        avgCompetitorWordCount: serpAnalysis.avgWordCount
      }
    } as any;

  } catch (error: any) {
    console.error(`❌ [Copilot CLI] Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Apply performance optimizations to HTML before deployment
 * Adds preconnect hints, lazy loading, and other PageSpeed improvements
 */
function optimizeHtmlForPerformance(html: string): string {
  let optimized = html;
  
  // 1. Add preconnect hints for common CDNs (insert after <head>)
  const preconnectHints = `
    <link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preconnect" href="https://www.youtube.com" crossorigin>
    <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>
    <link rel="dns-prefetch" href="https://www.googletagmanager.com">
  `;
  
  if (!optimized.includes('rel="preconnect"')) {
    optimized = optimized.replace(/<head>/i, `<head>${preconnectHints}`);
  }
  
  // 2. Add loading="lazy" to images that don't have it
  optimized = optimized.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" ');
  
  // 3. Add decoding="async" to images
  optimized = optimized.replace(/<img(?![^>]*decoding=)/gi, '<img decoding="async" ');
  
  // 4. Convert YouTube embeds to lite-youtube facade for massive performance boost
  const youtubeRegex = /<iframe[^>]*src="https?:\/\/(?:www\.)?youtube\.com\/embed\/([^"?]+)[^"]*"[^>]*><\/iframe>/gi;
  optimized = optimized.replace(youtubeRegex, (match, videoId) => {
    return `<lite-youtube videoid="${videoId}" style="background-image: url('https://img.youtube.com/vi/${videoId}/hqdefault.jpg');"></lite-youtube>
    <script>if(!window.liteYT){window.liteYT=1;document.head.insertAdjacentHTML('beforeend','<style>lite-youtube{display:block;position:relative;width:100%;padding-bottom:56.25%;background-size:cover;background-position:center;cursor:pointer}lite-youtube::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;background:url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 68 48\\'%3E%3Cpath fill=\\'%23f00\\' d=\\'M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z\\'/%3E%3Cpath fill=\\'%23fff\\' d=\\'M45 24L27 14v20z\\'/%3E%3C/svg%3E") center/contain no-repeat}lite-youtube:hover::before{filter:brightness(1.1)}</style>');document.addEventListener('click',e=>{const t=e.target.closest('lite-youtube');if(t){const v=t.getAttribute('videoid');t.outerHTML='<iframe src="https://www.youtube.com/embed/'+v+'?autoplay=1" frameborder="0" allow="autoplay;encrypted-media" allowfullscreen style="position:absolute;top:0;left:0;width:100%;height:100%"></iframe>'}})}</script>`;
  });
  
  // 5. Defer non-critical scripts
  optimized = optimized.replace(/<script(?![^>]*(?:defer|async|type="application\/ld\+json"))/gi, '<script defer ');
  
  // 6. Add fetchpriority="high" to hero images (first image)
  let firstImageReplaced = false;
  optimized = optimized.replace(/<img/i, (match) => {
    if (!firstImageReplaced) {
      firstImageReplaced = true;
      return '<img fetchpriority="high" ';
    }
    return match;
  });
  
  console.log(`[Perf] Applied HTML optimizations (preconnect, lazy load, YouTube facade, defer scripts)`);
  return optimized;
}

/**
 * Deploy article HTML to Cloudflare KV
 * @param slug - Article slug (e.g., "best-cat-dna-tests")
 * @param html - Article HTML content
 * @param category - Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance" for V1 compatibility.
 */
async function deployToCloudflareKV(slug: string, html: string, category: string = 'petinsurance', title?: string): Promise<{ success: boolean; error?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { success: false, error: 'Cloudflare API token not configured' };
  }

  // Apply performance optimizations before deploying
  const optimizedHtml = optimizeHtmlForPerformance(html);

  try {
    // Use category:slug format for KV key (Worker expects this format for routing)
    const kvKey = `${category}:${slug}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(kvKey)}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'text/html'
      },
      body: optimizedHtml
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Cloudflare KV Error:', errorText);
      return { success: false, error: `KV deployment failed: ${response.status}` };
    }

    console.log(`☁️ Deployed to Cloudflare KV: ${kvKey}`);

    // Store article metadata in category index for real titles in Related Articles
    try {
      const indexKey = `articles-index:${category}`;
      const indexUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(indexKey)}`;

      // Read existing index
      const indexResp = await fetch(indexUrl, {
        headers: { 'Authorization': `Bearer ${cfApiToken}` }
      });
      let articles: Array<{ title: string; slug: string; category: string; publishDate: string }> = [];
      if (indexResp.ok) {
        try { articles = JSON.parse(await indexResp.text()); } catch {}
      }

      // Derive title from HTML <title> tag if not provided
      const articleTitle = title || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|.*$/, '').trim()) || slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      // Remove existing entry for this slug (handles re-deploys)
      articles = articles.filter(a => a.slug !== slug);

      // Append new entry
      articles.push({
        title: articleTitle,
        slug,
        category,
        publishDate: new Date().toISOString().split('T')[0]
      });

      // Write updated index back
      await fetch(indexUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(articles)
      });

      console.log(`📋 Updated articles-index:${category} (${articles.length} articles)`);
    } catch (indexErr: any) {
      // Non-fatal: article is already deployed, index update is best-effort
      console.log(`⚠️ Articles index update failed (non-fatal): ${indexErr.message}`);
    }

    // Automatically update sitemap with new article
    await updateSitemapWithArticle(slug, category);

    // Notify Google Search Console of new article
    const articleUrl = `https://catsluvus.com/${category}/${slug}`;
    notifyGoogleOfNewArticle(articleUrl).then(() => {
      addActivityLog('success', `🔔 GSC: Indexing requested`, { keyword: slug, url: articleUrl });
    }).catch(err => {
      console.log(`[GSC] Background notification failed: ${err.message}`);
      addActivityLog('info', `⚠️ GSC: ${err.message}`, { keyword: slug });
    });

    // V3: Track article for autonomous indexing verification
    ensureIndexTrackerInitialized().then(() => trackNewArticle(articleUrl, slug, category)).then(() => {
      addActivityLog('info', `📊 Index tracking started`, { keyword: slug, url: articleUrl });
    }).catch(err => {
      console.log(`[IndexTracker] Failed to track: ${err.message}`);
    });

    // Validate rich results using URL Inspection API (run in background)
    validateArticleRichResults(articleUrl).then(result => {
      const richResultsTestUrl = `https://search.google.com/test/rich-results?url=${encodeURIComponent(articleUrl)}`;
      if (result.valid) {
        const types = result.detectedTypes.join(', ');
        addActivityLog('success', `🎯 Rich Results: Valid (${types})`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      } else if (result.errors.length > 0) {
        addActivityLog('error', `❌ Rich Results: ${result.errors.length} errors - ${result.errors[0]}`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      } else if (result.warnings.length > 0) {
        addActivityLog('info', `⚠️ Rich Results: ${result.warnings.length} warnings`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      }
    }).catch(err => {
      console.log(`[Rich Results] Background validation failed: ${err.message}`);
    });

    return { success: true };
  } catch (error: any) {
    console.error('Cloudflare deployment error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Save research phase output and CategoryContext to KV for persistence
 */
async function saveResearchToKV(researchOutput: ResearchPhaseOutput, categoryContext: CategoryContext | null): Promise<{ success: boolean; error?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { success: false, error: 'Cloudflare API token not configured' };
  }

  try {
    const kvPrefix = categoryContext?.kvPrefix || 'research:';
    const researchKey = `${kvPrefix}research-output`;
    const contextKey = `${kvPrefix}category-context`;

    const researchUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(researchKey)}`;

    await fetch(researchUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(researchOutput)
    });

    if (categoryContext) {
      const contextUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(contextKey)}`;

      await fetch(contextUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(categoryContext)
      });
    }

    console.log(`☁️ Research saved to KV: ${researchKey}`);
    return { success: true };
  } catch (error: any) {
    console.error('Failed to save research to KV:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Load research phase output and CategoryContext from KV
 */
async function loadResearchFromKV(kvPrefix: string): Promise<{ researchOutput: ResearchPhaseOutput | null; categoryContext: CategoryContext | null }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { researchOutput: null, categoryContext: null };
  }

  try {
    const researchKey = `${kvPrefix}research-output`;
    const contextKey = `${kvPrefix}category-context`;

    const researchUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(researchKey)}`;
    const contextUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(contextKey)}`;

    const [researchRes, contextRes] = await Promise.all([
      fetch(researchUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } }),
      fetch(contextUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } })
    ]);

    let researchOutput: ResearchPhaseOutput | null = null;
    let categoryContext: CategoryContext | null = null;

    if (researchRes.ok) {
      researchOutput = await researchRes.json() as ResearchPhaseOutput;
    }
    if (contextRes.ok) {
      categoryContext = await contextRes.json() as CategoryContext;
    }

    return { researchOutput, categoryContext };
  } catch (error: any) {
    console.error('Failed to load research from KV:', error);
    return { researchOutput: null, categoryContext: null };
  }
}

/**
 * Fetch current sitemap from public URL (the worker serves it)
 * @param categorySlug - Category slug for dynamic sitemap URL (defaults to current context)
 */
async function fetchCurrentSitemap(categorySlug?: string): Promise<string | null> {
  try {
    // Use category from context or parameter for dynamic sitemap URL
    const category = categorySlug || v3CategoryContext?.categorySlug || 'petinsurance';
    const sitemapUrl = `https://catsluvus.com/${category}/sitemap.xml`;
    const response = await fetch(sitemapUrl, {
      headers: {
        'User-Agent': 'SitemapUpdater/1.0'
      }
    });

    if (!response.ok) {
      console.log('Could not fetch existing sitemap from public URL');
      return null;
    }

    const sitemap = await response.text();
    // Verify it's valid XML
    if (!sitemap.includes('<?xml') || !sitemap.includes('<urlset')) {
      console.log('Invalid sitemap format received');
      return null;
    }

    return sitemap;
  } catch (error) {
    console.error('Error fetching sitemap:', error);
    return null;
  }
}

/**
 * Update sitemap with a new article URL
 * @param slug - Article slug
 * @param category - Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance".
 */
async function updateSitemapWithArticle(slug: string, category: string = 'petinsurance'): Promise<boolean> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.error('Cannot update sitemap: No Cloudflare API token');
    return false;
  }

  try {
    // Invalidate the cached sitemap for this category so the Worker regenerates it
    // dynamically from KV keys on the next request (the article KV key already exists)
    const cacheKey = `sitemap:${category}`;
    const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(cacheKey)}`;

    await fetch(deleteUrl, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${cfApiToken}` }
    });

    console.log(`🗺️ Sitemap cache invalidated for ${category} (new article: ${slug})`);
    addActivityLog('success', `🗺️ Sitemap: Cache invalidated for ${category}`, { keyword: slug, url: `https://catsluvus.com/${category}/${slug}` });

    // Purge Cloudflare CDN cache for the sitemap URL
    await purgeSitemapCache(cfApiToken, category);

    return true;
  } catch (error) {
    console.error('Error invalidating sitemap cache:', error);
    return false;
  }
}

/**
 * Purge Cloudflare cache for the sitemap URL
 * Supports both Global API Key (full access) and API Token authentication
 * @param cfApiToken - Cloudflare API token
 * @param categorySlug - Category slug for dynamic sitemap URL (defaults to current context)
 */
async function purgeSitemapCache(cfApiToken: string, categorySlug?: string): Promise<boolean> {
  try {
    const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`;

    const headers: Record<string, string> = {
      ...getZoneAuthHeaders(),
      'Content-Type': 'application/json'
    };

    // Use dynamic category for sitemap URL
    const category = categorySlug || v3CategoryContext?.categorySlug || 'petinsurance';
    const response = await fetch(purgeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        files: [
          `https://catsluvus.com/${category}/sitemap.xml`,
          `https://www.catsluvus.com/${category}/sitemap.xml`
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.errors?.[0]?.code === 10000) {
        console.warn('⚠️ Cache purge skipped: API token lacks cache purge permission.');
        console.warn('   Add CLOUDFLARE_GLOBAL_API_KEY to Doppler for instant cache purge.');
        console.warn('   Sitemap will update within 1 hour via normal cache expiry.');
        return false;
      }
      console.error('Cache purge error:', JSON.stringify(errorData));
      return false;
    }

    console.log('🧹 Sitemap cache purged - changes visible immediately');
    return true;
  } catch (error) {
    console.error('Error purging cache:', error);
    return false;
  }
}

// In-memory storage for recent articles (in production, use database)
let recentArticles: Array<{
  keyword: string;
  slug: string;
  title: string;
  wordCount: number;
  date: string;
  deployed: boolean;
  liveUrl: string | null;
  skillScore?: number;
  deployAction?: 'deploy' | 'review' | 'optimize' | 'reject';
  category?: string;
}> = [];
let recentArticlesHydrated = false;

// Cache for all-articles endpoint (avoid hammering KV)
let allArticlesCache: { data: any; timestamp: number } | null = null;
const ALL_ARTICLES_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

// Cache for sitemap-all endpoint
let sitemapAllCache: { data: any; timestamp: number } | null = null;
const SITEMAP_ALL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Activity log for detailed real-time updates
// Persisted to JSONL file so it survives server restarts
interface ActivityLogEntry {
  id: number;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'generating' | 'deployed' | 'queue' | 'warning';
  message: string;
  details?: Record<string, any>;
}

const ACTIVITY_LOG_FILE = '/tmp/v3-activity-log.jsonl';
const ACTIVITY_LOG_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB, then rotate
const ACTIVITY_LOG_MEM_CAP = 500; // in-memory cap for fast polling

let activityLog: ActivityLogEntry[] = [];
let activityLogId = 0;

// Load previous entries from file on startup (survives restarts)
try {
  if (fs.existsSync(ACTIVITY_LOG_FILE)) {
    const raw = fs.readFileSync(ACTIVITY_LOG_FILE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    // Parse last ACTIVITY_LOG_MEM_CAP lines (newest at end of file)
    const recent = lines.slice(-ACTIVITY_LOG_MEM_CAP);
    const restored: ActivityLogEntry[] = [];
    for (const line of recent) {
      try { restored.push(JSON.parse(line)); } catch {}
    }
    // Newest first in memory
    activityLog = restored.reverse();
    activityLogId = activityLog[0]?.id || 0;
    console.log(`[Activity Log] Restored ${activityLog.length} entries from disk (latest ID: ${activityLogId})`);
  }
} catch (err: any) {
  console.warn(`[Activity Log] Could not restore from file: ${err.message}`);
}

function addActivityLog(
  type: ActivityLogEntry['type'],
  message: string,
  details?: ActivityLogEntry['details']
) {
  const entry: ActivityLogEntry = {
    id: ++activityLogId,
    timestamp: new Date().toISOString(),
    type,
    message,
    details
  };
  activityLog.unshift(entry);
  // Keep in-memory array capped
  if (activityLog.length > ACTIVITY_LOG_MEM_CAP) {
    activityLog.length = ACTIVITY_LOG_MEM_CAP;
  }
  console.log(`[SEO-GEN] ${type.toUpperCase()}: ${message}`, details || '');

  // Persist to file (append-only JSONL)
  try {
    // Rotate if file exceeds max size
    if (fs.existsSync(ACTIVITY_LOG_FILE)) {
      const stat = fs.statSync(ACTIVITY_LOG_FILE);
      if (stat.size > ACTIVITY_LOG_MAX_FILE_SIZE) {
        const rotated = ACTIVITY_LOG_FILE + '.prev';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(ACTIVITY_LOG_FILE, rotated);
      }
    }
    fs.appendFileSync(ACTIVITY_LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// Stats tracking (dynamic — updated from KV categories)
let stats = {
  totalKeywords: 0,
  generated: 0,
  pending: 0,
  percentComplete: '0.0',
  categoriesComplete: 0,
  categoriesTotal: 0,
};

// Add startup log entry so the activity log is never blank after restart
addActivityLog('info', `V3 Engine started at ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, {
  totalKeywords: 0,
  version: 'V3'
});

// Session Health tracking (cockpit banner data)
interface SessionHealth {
  sessionStartTime: number | null;
  articlesGenerated: number;
  articlesFailed: number;
  articlesDeployed: number;
  totalSeoScore: number;
  seoScoreCount: number;
  currentKeyword: string | null;
  currentStage: string | null;
  currentStageStartTime: number | null;
  lastArticleTime: number | null;
  avgGenerationMs: number;
  generationTimes: number[];
  consecutiveErrors: number;
  lastError: string | null;
}

let sessionHealth: SessionHealth = {
  sessionStartTime: null, articlesGenerated: 0, articlesFailed: 0,
  articlesDeployed: 0, totalSeoScore: 0, seoScoreCount: 0,
  currentKeyword: null, currentStage: null, currentStageStartTime: null,
  lastArticleTime: null, avgGenerationMs: 0, generationTimes: [],
  consecutiveErrors: 0, lastError: null
};

function resetSessionHealth() {
  sessionHealth = {
    sessionStartTime: Date.now(), articlesGenerated: 0, articlesFailed: 0,
    articlesDeployed: 0, totalSeoScore: 0, seoScoreCount: 0,
    currentKeyword: null, currentStage: null, currentStageStartTime: null,
    lastArticleTime: null, avgGenerationMs: 0, generationTimes: [],
    consecutiveErrors: 0, lastError: null
  };
}

function updateSessionStage(keyword: string, stage: string) {
  sessionHealth.currentKeyword = keyword;
  sessionHealth.currentStage = stage;
  sessionHealth.currentStageStartTime = Date.now();
}

function recordSessionSuccess(deployed: boolean, durationMs: number) {
  sessionHealth.articlesGenerated++;
  if (deployed) sessionHealth.articlesDeployed++;
  sessionHealth.lastArticleTime = Date.now();
  sessionHealth.consecutiveErrors = 0;
  sessionHealth.currentKeyword = null;
  sessionHealth.currentStage = null;
  sessionHealth.currentStageStartTime = null;
  // Rolling average of last 20 generation times
  sessionHealth.generationTimes.push(durationMs);
  if (sessionHealth.generationTimes.length > 20) sessionHealth.generationTimes.shift();
  sessionHealth.avgGenerationMs = Math.round(
    sessionHealth.generationTimes.reduce((a, b) => a + b, 0) / sessionHealth.generationTimes.length
  );
}

function recordSessionError(message: string) {
  sessionHealth.articlesFailed++;
  sessionHealth.consecutiveErrors++;
  sessionHealth.lastError = message;
  sessionHealth.currentKeyword = null;
  sessionHealth.currentStage = null;
  sessionHealth.currentStageStartTime = null;
}

let statusCache: { data: any; timestamp: number } | null = null;
const STATUS_CACHE_TTL = 60_000;

async function fetchV3StatusFromKV(): Promise<any> {
  if (statusCache && Date.now() - statusCache.timestamp < STATUS_CACHE_TTL) {
    return statusCache.data;
  }

  let totalKeywords = 0;
  let generated = 0;
  let categoriesComplete = 0;
  let categoriesTotal = 0;
  const categoryBreakdown: Record<string, { total: number; completed: number; status: string }> = {};

  const cfToken = process.env.CLOUDFLARE_API_TOKEN || '';

  const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=v3%3Acategory%3Astatus%3A&per_page=100`;
  const kvResp = await fetch(kvUrl, {
    headers: { 'Authorization': `Bearer ${cfToken}` }
  });
  if (!kvResp.ok) throw new Error(`KV keys fetch failed: ${kvResp.status}`);

  const kvData = await kvResp.json() as any;
  const categoryKeys: string[] = (kvData.result || []).map((k: any) => k.name);
  categoriesTotal = categoryKeys.length;

  const batchSize = 10;
  for (let i = 0; i < categoryKeys.length; i += batchSize) {
    const batch = categoryKeys.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (key) => {
      const valUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
      const valResp = await fetch(valUrl, {
        headers: { 'Authorization': `Bearer ${cfToken}` }
      });
      if (!valResp.ok) return null;
      const catData = await valResp.json() as any;
      const catSlug = key.replace('v3:category:status:', '');
      const total = catData.expectedCount || catData.articleCount || 0;
      const completed = catData.articleCount || 0;
      const catStatus = catData.status || 'unknown';
      return { catSlug, total, completed, catStatus };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const { catSlug, total, completed, catStatus } = r.value;
        totalKeywords += total;
        generated += completed;
        if (catStatus === 'completed') categoriesComplete++;
        categoryBreakdown[catSlug] = { total, completed, status: catStatus };
      }
    }
  }

  const pending = totalKeywords - generated;
  const percentComplete = totalKeywords > 0 ? ((generated / totalKeywords) * 100).toFixed(1) : '0.0';

  stats.totalKeywords = totalKeywords;
  stats.generated = generated;
  stats.pending = pending;
  stats.percentComplete = percentComplete;
  stats.categoriesComplete = categoriesComplete;
  stats.categoriesTotal = categoriesTotal;

  const data = {
    totalKeywords,
    pagesComplete: generated,
    pagesNeeded: pending,
    percentComplete,
    categoriesComplete,
    categoriesTotal,
    categoryBreakdown,
    lastUpdated: new Date().toISOString(),
    version: 'v3',
    skillsEnabled: true
  };

  statusCache = { data, timestamp: Date.now() };
  return data;
}

/**
 * Get generator status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const data = await fetchV3StatusFromKV();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get status'
    });
  }
});

// ============================================================================
// V3: SKILL-BASED ENDPOINTS
// ============================================================================

/**
 * V3: Validate article content with skill-based rules
 */

/**
 * Generate Product schema from comparison table
 * Helps Google display rich product results in search
 * Uses Amazon affiliate links for product URLs
 */
function generateProductSchema(
  comparisonHeaders: string[],
  comparisonRows: string[][],
  externalLinks: Array<{url: string, text: string, context?: string}>,
  keyword: string
): object | null {
  
  if (!comparisonRows || comparisonRows.length === 0) {
    return null;
  }
  
  const amazonTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
  
  const products = comparisonRows.map((row, index) => {
    // Normalize row to array (AI sometimes returns strings or objects)
    const rowArray: string[] = Array.isArray(row) ? row : (typeof row === 'string' ? [row] : Object.values(row || {}));
    if (!rowArray.length) return null;

    const productName = rowArray[0] || 'Unknown Product'; // First column is product name
    const priceStr = rowArray[1] || '$0'; // Second column is price

    // Extract numeric price (remove $, commas, handle ranges by taking first number)
    const priceMatch = String(priceStr).match(/\$?(\d+)/);
    const priceValue = priceMatch ? priceMatch[1] : '0';

    // Check if last column contains Amazon search query
    const lastCol = rowArray[rowArray.length - 1] || '';
    const isAmazonSearch = String(lastCol).includes('+') || comparisonHeaders[comparisonHeaders.length - 1]?.toLowerCase().includes('amazon');

    // Build Amazon affiliate URL
    const searchQuery = isAmazonSearch
      ? String(lastCol).replace(/\+/g, ' ')
      : productName;
    const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(searchQuery)}&tag=${amazonTag}`;

    // Build description from middle columns (skip first=name, last=amazon search)
    const featureColumns = isAmazonSearch ? rowArray.slice(2, -1) : rowArray.slice(2);
    const featureHeaders = isAmazonSearch ? comparisonHeaders.slice(2, -1) : comparisonHeaders.slice(2);
    const features = featureColumns.map((val, i) =>
      `${featureHeaders[i] || 'Feature'}: ${val}`
    ).join(', ');
    
    const description = features ? `${productName} - ${features}` : productName;
    
    return {
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Product",
        "name": productName.length > 70 ? productName.substring(0, 67) + '...' : productName,
        "description": description,
        "offers": {
          "@type": "Offer",
          "price": priceValue,
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": amazonUrl,
          "shippingDetails": {
            "@type": "OfferShippingDetails",
            "shippingDestination": {
              "@type": "DefinedRegion",
              "addressCountry": "US"
            },
            "deliveryTime": {
              "@type": "ShippingDeliveryTime",
              "businessDays": {
                "@type": "QuantitativeValue",
                "minValue": 1,
                "maxValue": 5
              }
            },
            "shippingRate": {
              "@type": "MonetaryAmount",
              "value": "5.99",
              "currency": "USD"
            }
          },
          "hasMerchantReturnPolicy": {
            "@type": "MerchantReturnPolicy",
            "applicableCountry": "US",
            "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
            "merchantReturnDays": 30,
            "returnMethod": "https://schema.org/ReturnByMail",
            "returnFees": "https://schema.org/FreeReturn"
          }
        }
      }
    };
  });
  
  // Filter out null products (from invalid rows)
  const validProducts = products.filter(p => p !== null);

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Best ${keyword} Comparison`,
    "description": `Comparison of top ${keyword} products`,
    "itemListElement": validProducts
  };
}


router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { html, keyword, profile = 'comprehensive' } = req.body;

    if (!html || !keyword) {
      return res.status(400).json({ error: 'Missing required fields: html, keyword' });
    }

    const engine = SkillEngine.fromProfile(profile);
    const validation = engine.validateContent(html, keyword);
    const recommendation = getDeploymentRecommendation(validation.score);

    res.json({
      success: true,
      validation,
      recommendation,
      loadedSkills: engine.getLoadedSkills(),
      profile
    });
  } catch (error: any) {
    console.error('[V3 Validate] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Comprehensive audit of article content
 */
router.post('/audit', async (req: Request, res: Response) => {
  try {
    const { html, keyword, profile = 'comprehensive' } = req.body;

    if (!html || !keyword) {
      return res.status(400).json({ error: 'Missing required fields: html, keyword' });
    }

    const engine = SkillEngine.fromProfile(profile);
    const audit = engine.auditContent(html, keyword);
    const recommendation = getDeploymentRecommendation(audit.overallScore);

    res.json({
      success: true,
      audit,
      recommendation,
      loadedSkills: engine.getLoadedSkills(),
      qualityGates: QUALITY_GATES,
      profile
    });
  } catch (error: any) {
    console.error('[V3 Audit] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Get available skill profiles
 */
router.get('/skills/profiles', async (_req: Request, res: Response) => {
  try {
    const { SEO_SKILL_PROFILES, QUALITY_GATES } = await import('../config/seo-skills');

    // Return profiles as object with profile IDs as keys (for easy lookup)
    res.json({
      profiles: SEO_SKILL_PROFILES,
      qualityGates: QUALITY_GATES
    });
  } catch (error: any) {
    console.error('[V3 Skills] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Get best practices for a profile (for prompt enhancement)
 */
router.get('/skills/best-practices', async (req: Request, res: Response) => {
  try {
    const profile = (req.query.profile as string) || 'comprehensive';
    const engine = SkillEngine.fromProfile(profile);
    const bestPractices = engine.getBestPracticesForPrompt();

    res.json({
      success: true,
      profile,
      loadedSkills: engine.getLoadedSkills(),
      bestPractices,
      skillCount: engine.getLoadedSkills().length
    });
  } catch (error: any) {
    console.error('[V3 Best Practices] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Simple in-memory cache for SERP analysis (expires after 1 hour)
const serpCache = new Map<string, { data: any; timestamp: number }>();
const SERP_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Analyze Google SERP for a keyword to understand what's ranking
 * Includes caching to avoid repeated API calls
 */
async function analyzeSERP(keyword: string): Promise<{
  topResults: Array<{ title: string; description: string; url: string }>;
  avgTitleLength: number;
  commonTopics: string[];
  contentGaps: string[];
  targetWordCount: number;
  competitorHeadings: string[];
  competitorFAQs: string[];
  competitorEntities: string[];
  avgWordCount: number;
}> {
  // Check cache first
  const cacheKey = keyword.toLowerCase().trim();
  const cached = serpCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SERP_CACHE_TTL) {
    console.log(`📦 [SERP Cache] Using cached analysis for: "${keyword}"`);
    return cached.data;
  }

  try {
    // SERP API priority: Serper (2500 free/month) > Google CSE (100/day) > Outscraper > DuckDuckGo
    const serperKey = process.env.SERPER_API_KEY;
    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId = process.env.GOOGLE_CSE_ID;
    const outscraperKey = process.env.OUTSCRAPER_API_KEY;

    let results: any[] = [];

    // Try Serper first (best free tier: 2500 queries/month)
    if (serperKey) {
      console.log('🔍 [SERP] Using Serper.dev API');
      try {
        const serperResponse = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': serperKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            q: keyword,
            gl: 'us',
            hl: 'en',
            num: 10
          })
        });

        if (serperResponse.ok) {
          const serperData = await serperResponse.json() as any;
          results = (serperData?.organic || []).map((item: any) => ({
            title: item.title || '',
            description: item.snippet || '',
            link: item.link || ''
          }));
          console.log(`✅ [SERP] Serper returned ${results.length} results`);
        } else {
          console.log(`⚠️ [SERP] Serper failed (${serperResponse.status}), trying fallback...`);
        }
      } catch (serperErr: any) {
        console.log(`⚠️ [SERP] Serper error: ${serperErr.message}`);
      }
    }

    // Fallback to Google CSE
    if (results.length === 0 && googleApiKey && googleCseId) {
      console.log('🔍 [SERP] Using Google Custom Search API');
      const googleResponse = await fetch(
        `https://www.googleapis.com/customsearch/v1?` + new URLSearchParams({
          key: googleApiKey,
          cx: googleCseId,
          q: keyword,
          num: '10',
          gl: 'us',
          hl: 'en'
        })
      );

      if (googleResponse.ok) {
        const googleData = await googleResponse.json() as any;
        results = (googleData?.items || []).map((item: any) => ({
          title: item.title || '',
          description: item.snippet || '',
          link: item.link || ''
        }));
        console.log(`✅ [SERP] Google CSE returned ${results.length} results`);
      } else {
        console.log(`⚠️ [SERP] Google CSE failed (${googleResponse.status}), trying fallback...`);
      }
    }

    // Fallback to Outscraper
    if (results.length === 0 && outscraperKey) {
      console.log('🔍 [SERP] Falling back to Outscraper API');
      const response = await fetch('https://api.app.outscraper.com/google-search-v3?' + new URLSearchParams({
        query: keyword,
        language: 'en',
        region: 'US',
        limit: '10'
      }), {
        headers: {
          'X-API-KEY': outscraperKey
        }
      });

      if (response.ok) {
        const data = await response.json() as any;
        results = (data?.data?.[0]?.organic_results || []).map((r: any) => ({
          title: r.title || '',
          description: r.description || '',
          link: r.link || ''
        }));
      }
    }

    // Fallback to DuckDuckGo HTML search (FREE, no API key, returns REAL search results)
    if (results.length === 0) {
      console.log('🦆 [SERP] Scraping DuckDuckGo HTML search results...');
      try {
        const ddgController = new AbortController();
        const ddgTimeout = setTimeout(() => ddgController.abort(), 8000);
        const ddgResponse = await fetch(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: ddgController.signal,
          }
        );
        clearTimeout(ddgTimeout);
        if (ddgResponse.ok) {
          const ddgHtml = await ddgResponse.text();
          const $ddg = cheerio.load(ddgHtml);
          $ddg('.result').each((i, el) => {
            if (i >= 10) return false;
            const titleEl = $ddg(el).find('.result__a');
            const snippetEl = $ddg(el).find('.result__snippet');
            const title = titleEl.text().trim();
            let link = titleEl.attr('href') || '';
            if (link.startsWith('//duckduckgo.com/l/?uddg=')) {
              try {
                const parsed = new URL('https:' + link);
                link = decodeURIComponent(parsed.searchParams.get('uddg') || link);
              } catch { /* keep original */ }
            }
            const description = snippetEl.text().trim();
            if (title && link && !link.includes('duckduckgo.com')) {
              results.push({ title, description, link });
            }
          });
          if (results.length > 0) {
            console.log(`✅ [SERP] DuckDuckGo HTML returned ${results.length} real search results`);
          } else {
            console.log('⚠️ [SERP] DuckDuckGo HTML returned 0 parseable results');
          }
        } else {
          console.log(`⚠️ [SERP] DuckDuckGo HTML failed: ${ddgResponse.status}`);
        }
      } catch (ddgError: any) {
        console.log(`⚠️ [SERP] DuckDuckGo HTML scrape failed: ${ddgError.message}`);
      }
    }

    // If all APIs failed, use defaults
    if (results.length === 0) {
      console.log('⚠️ No SERP API available - using default analysis');
      return getDefaultSERPAnalysis(keyword);
    }

    const topResults = results.slice(0, 10).map((r: any) => ({
      title: r.title || '',
      description: r.description || '',
      url: r.link || r.url || ''
    }));

    // Analyze patterns from top results
    const titles = topResults.map((r: { title: string }) => r.title);
    const avgTitleLength = titles.length > 0 ? titles.reduce((sum: number, t: string) => sum + t.length, 0) / titles.length : 55;

    // Extract common topics from titles and descriptions
    const allText = topResults.map((r: { title: string; description: string }) => `${r.title} ${r.description}`).join(' ').toLowerCase();
    const commonTopics = extractTopics(allText, keyword);

    // Identify content gaps - topics competitors might be missing
    const contentGaps = identifyContentGaps(keyword, commonTopics);

    // Scrape competitor pages for headings, FAQs, and word counts
    const competitorUrls = topResults.map((r: { url: string }) => r.url).filter((u: string) => u);
    const competitorAnalysis = await analyzeCompetitorPages(competitorUrls);

    const targetWordCount = Math.max(1500, competitorAnalysis.topCompetitorWordCount);

    console.log(`🔍 SERP Analysis: ${topResults.length} competitors, avg title ${Math.round(avgTitleLength)} chars`);
    console.log(`📊 Topics: ${commonTopics.slice(0, 5).join(', ')}`);
    console.log(`📑 Competitor headings: ${competitorAnalysis.allHeadings.length} found - ${competitorAnalysis.allHeadings.slice(0, 5).join(' | ')}`);
    console.log(`❓ Competitor FAQs: ${competitorAnalysis.allFAQs.length} found - ${competitorAnalysis.allFAQs.slice(0, 3).join(' | ')}`);
    console.log(`🎯 Gaps to exploit: ${contentGaps.slice(0, 3).join(', ')}`);
    console.log(`📝 Target word count: ${targetWordCount} (#1 competitor: ${competitorAnalysis.topCompetitorWordCount}, avg: ${competitorAnalysis.avgWordCount})`);

    // Telemetry: Log extraction quality
    const extractionQuality = {
      headingsFound: competitorAnalysis.allHeadings.length,
      faqsFound: competitorAnalysis.allFAQs.length,
      entitiesFound: competitorAnalysis.allEntities.length,
      pagesScraped: competitorUrls.length,
      avgWordCount: competitorAnalysis.avgWordCount
    };
    console.log(`📈 [SERP Telemetry] Extraction quality:`, JSON.stringify(extractionQuality));

    const result = { 
      topResults, 
      avgTitleLength, 
      commonTopics, 
      contentGaps, 
      targetWordCount,
      competitorHeadings: competitorAnalysis.allHeadings,
      competitorFAQs: competitorAnalysis.allFAQs,
      competitorEntities: competitorAnalysis.allEntities,
      avgWordCount: competitorAnalysis.avgWordCount
    };

    // Cache the result
    serpCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`💾 [SERP Cache] Cached analysis for: "${keyword}"`);

    return result;

  } catch (error: any) {
    console.log('⚠️ SERP analysis error:', error.message);
    return getDefaultSERPAnalysis(keyword);
  }
}

function getDefaultSERPAnalysis(keyword: string) {
  return {
    topResults: [],
    avgTitleLength: 55,
    commonTopics: ['cost', 'coverage', 'best providers', 'comparison', 'reviews', 'deductible', 'claims'],
    contentGaps: ['real claim payout data', 'veterinarian expert quotes', 'breed-specific pricing', 'state-by-state cost comparison', 'hidden exclusions exposed'],
    targetWordCount: 2500,
    competitorHeadings: [] as string[],
    competitorFAQs: [] as string[],
    competitorEntities: ['Lemonade', 'Healthy Paws', 'Trupanion', 'ASPCA', 'deductible', 'reimbursement', 'waiting period'] as string[],
    avgWordCount: 2500
  };
}

/**
 * Scrape a competitor page to extract H2/H3 headings, FAQs, entities, and word count
 * Uses cheerio for reliable DOM parsing
 */
async function scrapeCompetitorPage(url: string): Promise<{
  headings: string[];
  faqs: string[];
  entities: string[];
  wordCount: number;
}> {
  try {
    // Skip non-article URLs (PDFs, images, etc.)
    if (url.match(/\.(pdf|jpg|png|gif|mp4)$/i)) {
      return { headings: [], faqs: [], entities: [], wordCount: 0 };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout per page

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { headings: [], faqs: [], entities: [], wordCount: 0 };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract H2 and H3 headings using DOM
    const headings: string[] = [];
    $('h2, h3').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 100) {
        headings.push(text);
      }
    });

    // Extract FAQ questions from multiple sources
    const faqs: string[] = [];
    
    // 1. Questions in any heading (h1-h6)
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('?') && text.length > 10 && text.length < 200) {
        if (!faqs.includes(text)) faqs.push(text);
      }
    });

    // 2. JSON-LD FAQ Schema
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '');
        const extractFAQs = (obj: any) => {
          if (obj['@type'] === 'Question' && obj.name) {
            if (!faqs.includes(obj.name)) faqs.push(obj.name);
          }
          if (obj['@type'] === 'FAQPage' && obj.mainEntity) {
            (Array.isArray(obj.mainEntity) ? obj.mainEntity : [obj.mainEntity]).forEach((q: any) => {
              if (q.name && !faqs.includes(q.name)) faqs.push(q.name);
            });
          }
          if (obj['@graph']) obj['@graph'].forEach(extractFAQs);
        };
        extractFAQs(json);
      } catch (e) { /* ignore parse errors */ }
    });

    // 3. FAQ elements by class/id
    $('[class*="faq"], [id*="faq"], [class*="question"], [id*="question"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('?') && text.length > 10 && text.length < 200) {
        if (!faqs.includes(text)) faqs.push(text);
      }
    });

    // Extract key entities (brand names, product names, industry terms)
    const entities: string[] = [];
    const entityPatterns = [
      'PetSafe', 'Catit', 'SureFeed', 'Cat Mate', 'Petlibro', 'WOpet', 'HoneyGuaridan',
      'Litter-Robot', 'Modkat', 'PetKit', 'Feliway', 'Jackson Galaxy', 'Frisco',
      'Chewy', 'Purina', 'Royal Canin', 'Hill\'s', 'Blue Buffalo', 'Fancy Feast',
      'BPA-free', 'stainless steel', 'programmable', 'smart', 'WiFi', 'app-controlled',
      'portion control', 'timer', 'battery backup', 'dishwasher safe', 'BPA free',
      'veterinarian', 'ASPCA', 'microchip', 'GPS', 'calming', 'anxiety',
      'Lemonade', 'Healthy Paws', 'Trupanion', 'Embrace', 'Nationwide', 'Pets Best',
      'Figo', 'MetLife', 'Spot', 'Pumpkin', 'Fetch', 'ManyPets', 'Pawlicy'
    ];
    const bodyText = $('body').text().toLowerCase();
    entityPatterns.forEach(entity => {
      if (bodyText.includes(entity.toLowerCase())) {
        entities.push(entity);
      }
    });

    // Estimate word count from main content
    const mainContent = $('article, main, .content, .post, [role="main"]').first();
    const contentText = mainContent.length ? mainContent.text() : $('body').text();
    const wordCount = contentText.split(/\s+/).filter(w => w.length > 2).length;

    return { 
      headings: headings.slice(0, 15), 
      faqs: faqs.slice(0, 10), 
      entities: entities.slice(0, 15),
      wordCount 
    };

  } catch (error: any) {
    // Silently fail for individual pages - don't block the whole analysis
    return { headings: [], faqs: [], entities: [], wordCount: 0 };
  }
}

/**
 * Analyze multiple competitor pages in parallel (with limit)
 */
async function analyzeCompetitorPages(urls: string[]): Promise<{
  allHeadings: string[];
  allFAQs: string[];
  allEntities: string[];
  avgWordCount: number;
  topCompetitorWordCount: number;
}> {
  const topUrls = urls.slice(0, 5);

  console.log(`📄 Scraping ${topUrls.length} competitor pages for headings/FAQs/entities...`);

  const results = await Promise.all(topUrls.map(url => scrapeCompetitorPage(url)));

  const allHeadings = new Set<string>();
  const allFAQs = new Set<string>();
  const allEntities = new Set<string>();
  const wordCounts: number[] = [];

  results.forEach(r => {
    r.headings.forEach(h => allHeadings.add(h));
    r.faqs.forEach(f => allFAQs.add(f));
    r.entities.forEach(e => allEntities.add(e));
    if (r.wordCount > 500) wordCounts.push(r.wordCount);
  });

  const avgWordCount = wordCounts.length > 0 
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 2500;

  const topCompetitorWordCount = wordCounts.length > 0
    ? wordCounts[0]
    : 2500;

  console.log(`📊 Found ${allHeadings.size} headings, ${allFAQs.size} FAQs, ${allEntities.size} entities`);
  console.log(`📊 #1 competitor: ${topCompetitorWordCount} words, avg: ${avgWordCount} words`);

  return {
    allHeadings: Array.from(allHeadings),
    allFAQs: Array.from(allFAQs),
    allEntities: Array.from(allEntities),
    avgWordCount,
    topCompetitorWordCount
  };
}

function extractTopics(text: string, keyword: string): string[] {
  const topics = new Set<string>();
  const patterns = [
    'cost', 'price', 'cheap', 'affordable', 'expensive', 'worth it', 'budget',
    'best', 'top', 'review', 'comparison', 'vs', 'rated', 'recommended',
    'how to', 'guide', 'tips', 'step by step', 'tutorial', 'setup',
    'pros and cons', 'benefits', 'features', 'specifications', 'dimensions',
    'indoor', 'outdoor', 'kitten', 'senior cat', 'multi-cat', 'large cat',
    'automatic', 'smart', 'wifi', 'app', 'programmable', 'timer',
    'cleaning', 'maintenance', 'durable', 'safe', 'bpa free', 'stainless steel',
    'amazon', 'chewy', 'walmart', 'where to buy', 'discount', 'sale',
    'veterinarian', 'vet recommended', 'safety', 'health', 'anxiety', 'stress',
    'petSafe', 'catit', 'litter-robot', 'feliway', 'frisco',
    'coverage', 'deductible', 'premium', 'reimbursement', 'wellness',
    'lemonade', 'healthy paws', 'trupanion', 'embrace', 'nationwide'
  ];

  patterns.forEach(p => {
    if (text.includes(p)) topics.add(p);
  });

  return Array.from(topics);
}

function identifyContentGaps(keyword: string, existingTopics: string[]): string[] {
  const kw = keyword.toLowerCase();
  const isInsurance = kw.includes('insurance') || kw.includes('coverage') || kw.includes('policy');
  
  const allPossibleTopics = isInsurance ? [
    'actual customer claim amounts with real dollar figures',
    'veterinarian expert recommendations and quotes',
    'breed-specific pricing data tables',
    'state-by-state cost comparison data',
    'hidden exclusions and gotchas to avoid',
    'claim denial rate statistics by provider',
    'step-by-step claim filing walkthrough',
    'multi-pet discount calculator',
    'annual vs per-incident deductible math examples',
    'real customer testimonials with specific outcomes',
    'emergency vet cost breakdown by procedure',
    'waiting period comparison chart',
    'pre-existing condition workarounds'
  ] : [
    'detailed product comparison table with specs and prices',
    'real customer reviews and common complaints',
    'veterinarian or expert recommendations',
    'step-by-step setup and installation guide',
    'maintenance and cleaning instructions',
    'safety considerations and potential hazards',
    'best options for multi-cat households',
    'budget-friendly alternatives under $30',
    'premium options with smart features and WiFi',
    'size guide for kittens vs large breed cats',
    'common problems and troubleshooting fixes',
    'where to buy for best price with discount codes',
    'durability and long-term value assessment'
  ];

  // Return topics not well covered by competitors
  return allPossibleTopics.filter(t =>
    !existingTopics.some(et => t.toLowerCase().includes(et))
  ).slice(0, 6);
}

/**
 * Test endpoint - verify Copilot CLI connectivity
 * Uses direct CLI invocation with -p flag (what the SDK wraps internally)
 */
router.get('/test-sdk', async (_req: Request, res: Response) => {
  try {
    console.log('🧪 [CLI Test] Starting Copilot CLI test...');

    // Simple prompt without quotes to avoid escaping issues
    const response = await generateWithCopilotCLI(
      'What is 2 plus 2? Reply with just the number.',
      30000 // 30 second timeout
    );

    console.log(`🧪 [CLI Test] Response: ${response}`);

    res.json({
      success: true,
      response: response.trim(),
      message: 'GitHub Copilot CLI is working!'
    });
  } catch (error: any) {
    console.error('🧪 [CLI Test] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check GitHub Copilot enablement at https://github.com/settings/copilot'
    });
  }
});

/**
 * V3: Generate a single article with skill-enhanced pipeline
 * Integrates skill engine for post-generation auditing and quality gates
 * Uses Cloudflare AI for content generation
 */
router.post('/generate', async (req: Request, res: Response) => {
  const { keyword, skillProfile = 'comprehensive' } = req.body;

  if (!keyword || typeof keyword !== 'string') {
    return res.status(400).json({ error: 'Keyword is required' });
  }

  try {
    console.log(`🤖 V3 Skill-Enhanced generation: ${keyword} (profile: ${skillProfile})`);

    // V3: Initialize skill engine for post-generation audit
    const skillEngine = SkillEngine.fromProfile(skillProfile);
    const loadedSkills = skillEngine.getLoadedSkills();
    console.log(`📚 Loaded ${loadedSkills.length} skills: ${loadedSkills.join(', ')}`);

    // Log generation start to activity log
    addActivityLog('generating', `Generating: "${keyword}" (V3 with ${loadedSkills.length} skills)`, { keyword, skillProfile });

    const result = await generateWithCopilotSDK(keyword);

    if (!result.success) {
      // Check if it's a Copilot policy error
      if (result.error?.includes('No model available') || result.error?.includes('policy enablement')) {
        return res.status(503).json({
          error: 'GitHub Copilot is not enabled',
          message: 'Enable Copilot at https://github.com/settings/copilot for account: techfundoffice',
          details: result.error
        });
      }
      return res.status(500).json({ error: result.error });
    }

    const slug = keywordToSlug(keyword);

    // V3: Run post-generation skill audit
    let skillAudit = null;
    let deploymentRecommendation = null;
    if (result.liveUrl) {
      try {
        // Fetch the deployed HTML for auditing
        const response = await fetch(result.liveUrl);
        if (response.ok) {
          const deployedHtml = await response.text();
          skillAudit = skillEngine.auditContent(deployedHtml, keyword);
          deploymentRecommendation = getDeploymentRecommendation(skillAudit.overallScore);
          console.log(`📊 V3 Skill Audit: ${skillAudit.overallScore}/100 - ${deploymentRecommendation.action}`);
        }
      } catch (auditErr: any) {
        console.log(`⚠️ Skill audit skipped: ${auditErr.message}`);
      }
    }

    // Update stats
    stats.generated++;
    stats.pending = Math.max(0, stats.pending - 1);
    stats.percentComplete = ((stats.generated / stats.totalKeywords) * 100).toFixed(2);

    console.log(`✅ V3 Generated: ${slug}`);

    if (result.deployed) {
      console.log(`🌐 Live at: ${result.liveUrl}`);
    }

    // Store in recent articles with skill audit data
    recentArticles.unshift({
      keyword,
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      date: new Date().toISOString(),
      deployed: result.deployed || false,
      liveUrl: result.liveUrl || null,
      skillScore: skillAudit?.overallScore,
      deployAction: deploymentRecommendation?.action
    });
    recentArticles = recentArticles.slice(0, 50);

    // Log to activity log with skill audit info
    const manualSeoScore = (result as any).seoScore || 0;
    const skillScore = skillAudit?.overallScore || 0;
    const scoreDisplay = skillScore > 0
      ? `| SEO: ${manualSeoScore}/100 | Skills: ${skillScore}/100`
      : `| SEO: ${manualSeoScore}/100`;
    addActivityLog('success', `Generated: "${result.article!.title}" ${scoreDisplay}`, {
      keyword,
      slug,
      seoScore: manualSeoScore,
      skillScore,
      wordCount: result.article!.wordCount || 3500,
      url: result.liveUrl || undefined,
      deployAction: deploymentRecommendation?.action
    });

    if (result.deployed) {
      addActivityLog('deployed', `Deployed to Cloudflare KV ${deploymentRecommendation ? `(${deploymentRecommendation.action})` : ''}`, {
        keyword,
        slug,
        url: result.liveUrl || `https://catsluvus.com/petinsurance/${slug}`,
        skillScore
      });
    }

    return res.json({
      success: true,
      engine: 'cloudflare-ai-v3',
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      seoScore: manualSeoScore,
      preview: `<h1>${result.article!.title}</h1><p>${result.article!.introduction?.substring(0, 500)}...</p>`,
      deployed: result.deployed,
      liveUrl: result.liveUrl,
      serpAnalysis: result.serpAnalysis,
      // V3: Skill audit results
      skillAudit: skillAudit ? {
        overallScore: skillAudit.overallScore,
        categories: skillAudit.categories,
        issueCount: skillAudit.issues.length,
        issues: skillAudit.issues.slice(0, 10), // Top 10 issues
        recommendations: skillAudit.recommendations.slice(0, 5)
      } : null,
      deploymentRecommendation: deploymentRecommendation ? {
        action: deploymentRecommendation.action,
        message: deploymentRecommendation.message,
        qualityGates: QUALITY_GATES
      } : null,
      skillProfile,
      skillsLoaded: loadedSkills
    });

  } catch (error: any) {
    console.error('V3 Generation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate article' });
  }
});

/**
 * Run batch generation
 */
router.post('/batch', async (req: Request, res: Response) => {
  const { count = 50 } = req.body;

  try {
    res.json({
      success: true,
      message: `Batch generation started for ${count} articles`,
      generated: 0,
      queued: count
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Batch generation failed'
    });
  }
});

/**
 * Get recent articles - hydrates from KV on first call if empty
 */
router.get('/recent', async (_req: Request, res: Response) => {
  // Hydrate from KV on first call after restart
  if (recentArticles.length === 0 && !recentArticlesHydrated) {
    recentArticlesHydrated = true;
    try {
      const allCategories = await getAllV3Categories();
      const hydrated: typeof recentArticles = [];

      // Fetch from each category (batches of 5)
      const batchSize = 5;
      for (let i = 0; i < allCategories.length; i += batchSize) {
        const batch = allCategories.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async (category) => {
            const kvPrefix = `${category}:`;
            const slugs = await fetchExistingArticleSlugsForCategory(kvPrefix);
            return slugs.map(slug => ({
              keyword: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
              slug,
              title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
              wordCount: 0,
              date: new Date().toISOString(),
              deployed: true,
              liveUrl: `https://catsluvus.com/${category}/${slug}`,
              category
            }));
          })
        );
        for (const categoryArticles of results) {
          hydrated.push(...categoryArticles);
        }
      }

      // Take the most recent 50 (reverse so newest categories appear first)
      recentArticles = hydrated.slice(0, 50);
      addActivityLog('info', `Hydrated ${hydrated.length} articles from ${allCategories.length} categories in KV`, {
        categories: allCategories.length,
        articles: hydrated.length
      });
    } catch (error: any) {
      console.error('[SEO-V3] Failed to hydrate recent articles from KV:', error.message);
    }
  }

  res.json({
    articles: recentArticles,
    count: recentArticles.length
  });
});

/**
 * Get activity log for real-time updates
 */
router.get('/activity-log', async (req: Request, res: Response) => {
  const { since, limit = 50 } = req.query;

  let logs = activityLog;

  // Filter by since ID if provided
  if (since) {
    const sinceId = Number(since);
    logs = logs.filter(entry => entry.id > sinceId);
  }

  // Limit results
  logs = logs.slice(0, Number(limit));

  res.json({
    logs,
    count: logs.length,
    totalLogs: activityLog.length,
    latestId: activityLog[0]?.id || 0
  });
});

/**
 * Get sitemap URLs - fetches sitemap.xml and parses URLs for display
 * Uses current category context for dynamic sitemap URL
 */
router.get('/sitemap', async (_req: Request, res: Response) => {
  try {
    // Get category from current context or default
    const category = v3CategoryContext?.categorySlug || 'petinsurance';
    const sitemap = await fetchCurrentSitemap(category);

    if (!sitemap) {
      return res.json({
        urls: [],
        count: 0,
        error: 'Could not fetch sitemap'
      });
    }

    // Parse URLs from sitemap XML
    const urlMatches = sitemap.match(/<loc>([^<]+)<\/loc>/g) || [];
    const urls = urlMatches.map(match => {
      const url = match.replace(/<\/?loc>/g, '');
      // Extract slug from URL - use dynamic category pattern
      const slugMatch = url.match(new RegExp(`\\/${category}\\/([^/]+)\\/?$`));
      const slug = slugMatch ? slugMatch[1] : url;

      // Try to extract lastmod if present
      return {
        url,
        slug,
        title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      };
    });

    // Sort by slug alphabetically
    urls.sort((a, b) => a.slug.localeCompare(b.slug));

    res.json({
      urls,
      count: urls.length,
      source: `https://catsluvus.com/${category}/sitemap.xml`,
      fetchedAt: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to fetch sitemap',
      urls: [],
      count: 0
    });
  }
});

/**
 * Get all articles from ALL V3 categories in KV
 * Returns article slugs with category, URL, and title
 */
router.get('/all-articles', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    // Check cache
    if (allArticlesCache && (Date.now() - allArticlesCache.timestamp) < ALL_ARTICLES_CACHE_TTL) {
      const cached = allArticlesCache.data;
      return res.json({
        articles: cached.articles.slice(0, limit),
        total: cached.total,
        categories: cached.categories,
        cached: true
      });
    }

    const allCategories = await getAllV3Categories();
    const articles: Array<{ category: string; slug: string; title: string; url: string }> = [];

    // Fetch slugs from each category in parallel (batches of 5 to avoid rate limits)
    const batchSize = 5;
    for (let i = 0; i < allCategories.length; i += batchSize) {
      const batch = allCategories.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (category) => {
          const kvPrefix = `${category}:`;
          const slugs = await fetchExistingArticleSlugsForCategory(kvPrefix);
          return slugs.map(slug => ({
            category,
            slug,
            title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            url: `https://catsluvus.com/${category}/${slug}`
          }));
        })
      );
      for (const categoryArticles of results) {
        articles.push(...categoryArticles);
      }
    }

    // Sort by category then slug
    articles.sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

    const result = {
      articles,
      total: articles.length,
      categories: allCategories
    };

    // Cache result
    allArticlesCache = { data: result, timestamp: Date.now() };

    res.json({
      articles: articles.slice(0, limit),
      total: articles.length,
      categories: allCategories,
      cached: false
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to fetch all articles',
      articles: [],
      total: 0,
      categories: []
    });
  }
});

/**
 * Get sitemap URLs from ALL V3 categories (not just the active one)
 * Fetches and combines sitemaps from all discovered categories
 */
router.get('/sitemap-all', async (_req: Request, res: Response) => {
  try {
    // Check cache
    if (sitemapAllCache && (Date.now() - sitemapAllCache.timestamp) < SITEMAP_ALL_CACHE_TTL) {
      return res.json({ ...sitemapAllCache.data, cached: true });
    }

    const allCategories = await getAllV3Categories();
    const allUrls: Array<{ url: string; slug: string; title: string; category: string }> = [];

    // Fetch sitemaps in parallel (batches of 5)
    const batchSize = 5;
    for (let i = 0; i < allCategories.length; i += batchSize) {
      const batch = allCategories.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (category) => {
          try {
            const sitemap = await fetchCurrentSitemap(category);
            if (!sitemap) return [];

            const urlMatches = sitemap.match(/<loc>([^<]+)<\/loc>/g) || [];
            return urlMatches.map(match => {
              const url = match.replace(/<\/?loc>/g, '');
              const slugMatch = url.match(new RegExp(`\\/${category}\\/([^/]+)\\/?$`));
              const slug = slugMatch ? slugMatch[1] : url;
              return {
                url,
                slug,
                title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
                category
              };
            });
          } catch {
            return [];
          }
        })
      );
      for (const categoryUrls of results) {
        allUrls.push(...categoryUrls);
      }
    }

    // Sort by category then slug
    allUrls.sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

    const result = {
      urls: allUrls,
      count: allUrls.length,
      categories: allCategories,
      fetchedAt: new Date().toISOString()
    };

    // Cache result
    sitemapAllCache = { data: result, timestamp: Date.now() };

    res.json({ ...result, cached: false });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to fetch all sitemaps',
      urls: [],
      count: 0,
      categories: []
    });
  }
});

/**
 * Get all keywords (paginated)
 */
router.get('/keywords', async (req: Request, res: Response) => {
  const { limit = 100, offset = 0, search } = req.query;

  try {
    let keywords = ALL_KEYWORDS;

    // Filter by search if provided
    if (search && typeof search === 'string') {
      const searchLower = search.toLowerCase();
      keywords = keywords.filter(kw => kw.toLowerCase().includes(searchLower));
    }

    const start = Number(offset);
    const end = start + Number(limit);
    const paginatedKeywords = keywords.slice(start, end);

    res.json({
      keywords: paginatedKeywords,
      total: keywords.length,
      offset: start,
      limit: Number(limit)
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to load keywords'
    });
  }
});

/**
 * Get keyword stats
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const keywordStats = getKeywordStats();
    res.json({
      keywords: keywordStats,
      authors: EXPERT_AUTHORS.map(a => ({ name: a.name, credentials: a.credentials, expertise: a.expertise })),
      sources: Object.keys(CREDIBLE_SOURCES).length,
      thresholds: SEO_THRESHOLDS,
      entities: {
        base: ENTITIES.base.length,
        dog: ENTITIES.dog.length,
        cat: ENTITIES.cat.length
      },
      generated: stats.generated,
      pending: stats.pending
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get stats'
    });
  }
});

/**
 * Get AI image generation quota status
 */
router.get('/image-quota', async (_req: Request, res: Response) => {
  try {
    const quota = getImageQuotaStatus();
    res.json({
      success: true,
      quota: {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
        resetDate: quota.resetDate,
        percentUsed: Math.round((quota.used / quota.limit) * 100)
      },
      info: {
        model: 'FLUX.1 schnell',
        resolution: '672x504',
        neuronsPerImage: 58,
        dailyNeuronBudget: 10000
      }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get image quota'
    });
  }
});

/**
 * Get random keywords for batch processing
 */
router.get('/keywords/random', async (req: Request, res: Response) => {
  const { count = 10 } = req.query;

  try {
    const shuffled = [...ALL_KEYWORDS].sort(() => 0.5 - Math.random());
    const randomKeywords = shuffled.slice(0, Number(count));

    res.json({
      keywords: randomKeywords,
      count: randomKeywords.length
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get random keywords'
    });
  }
});

// Autonomous mode state - runs continuously at max speed (no interval delay)
let autonomousRunning = false;

// V3 Research Phase State - must complete before generation can start
let researchEngine: ResearchEngine | null = null;
let researchPhaseOutput: ResearchPhaseOutput | null = null;
let activeCategoryContext: CategoryContext | null = null;
let researchPhaseStatus: ResearchPhaseStatus = 'idle';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m'
};

// Create clickable hyperlink for terminals that support OSC 8
function hyperlink(url: string, text?: string): string {
  const displayText = text || url;
  return `\x1b]8;;${url}\x07${colors.cyan}${colors.bold}${displayText}${colors.reset}\x1b]8;;\x07`;
}

// Color-coded SEO score based on value
function coloredScore(score: number): string {
  if (score >= 90) return `${colors.bgGreen}${colors.bold} ${score}/100 ${colors.reset}`;
  if (score >= 80) return `${colors.green}${colors.bold}${score}/100${colors.reset}`;
  if (score >= 70) return `${colors.yellow}${colors.bold}${score}/100${colors.reset}`;
  return `${colors.red}${colors.bold}${score}/100${colors.reset}`;
}

// Heartbeat stats for 1-minute status logs
let heartbeatInterval: NodeJS.Timeout | null = null;
let lastHeartbeatTime = Date.now();
let articlesThisMinute = 0;
let recentSeoScores: number[] = [];
let lastGeneratedSlug = '';
const HEARTBEAT_INTERVAL_MS = 60000; // 1 minute

function startHeartbeat() {
  if (heartbeatInterval) return; // Already running
  
  lastHeartbeatTime = Date.now();
  articlesThisMinute = 0;
  recentSeoScores = [];
  
  heartbeatInterval = setInterval(() => {
    const avgScore = recentSeoScores.length > 0 
      ? Math.round(recentSeoScores.reduce((a, b) => a + b, 0) / recentSeoScores.length)
      : 0;
    
    const statusColor = autonomousRunning ? colors.bgGreen : colors.bgRed;
    const statusText = autonomousRunning ? ' RUNNING ' : ' STOPPED ';
    const rate = articlesThisMinute;
    const progress = `${stats.generated}/${ALL_KEYWORDS.length}`;
    const percent = stats.percentComplete;
    
    const lastUrl = lastGeneratedSlug 
      ? hyperlink(`https://catsluvus.com/petinsurance/${lastGeneratedSlug}`, lastGeneratedSlug)
      : 'none yet';
    
    // Worker stats display
    const copilotStats = workerStats.copilot.count > 0 
      ? `${workerStats.copilot.count} articles, avg ${workerStats.copilot.avgScore}/100`
      : 'not started';
    const cloudflareStats = workerStats.cloudflare.count > 0 
      ? `${workerStats.cloudflare.count} articles, avg ${workerStats.cloudflare.avgScore}/100`
      : 'not started';
    
    console.log(`\n${colors.cyan}${'═'.repeat(70)}${colors.reset}`);
    console.log(`${colors.bold}📊 HEARTBEAT${colors.reset} ${statusColor}${colors.bold}${statusText}${colors.reset} ${colors.dim}${new Date().toLocaleTimeString()}${colors.reset}`);
    console.log(`${colors.cyan}${'─'.repeat(70)}${colors.reset}`);
    console.log(`   ${colors.green}📈 Progress:${colors.reset}    ${colors.bold}${progress}${colors.reset} ${colors.dim}(${percent}%)${colors.reset}`);
    console.log(`   ${colors.yellow}⚡ Rate:${colors.reset}        ${colors.bold}${rate}${colors.reset} articles/min (2 workers)`);
    console.log(`   ${colors.magenta}🎯 Avg SEO:${colors.reset}     ${avgScore > 0 ? coloredScore(avgScore) : colors.dim + 'waiting...' + colors.reset}`);
    console.log(`   ${colors.blue}📋 Pending:${colors.reset}     ${colors.bold}${stats.pending}${colors.reset} keywords left`);
    console.log(`   ${colors.cyan}🔗 Last:${colors.reset}        ${lastUrl}`);
    console.log(`${colors.cyan}${'─'.repeat(70)}${colors.reset}`);
    console.log(`   ${colors.bold}🤖 Worker Stats (A/B Test):${colors.reset}`);
    console.log(`      ${colors.yellow}Copilot:${colors.reset}    ${copilotStats}`);
    console.log(`      ${colors.green}Cloudflare:${colors.reset} ${cloudflareStats} ${colors.dim}(FREE)${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(70)}${colors.reset}\n`);
    
    // Reset counters for next minute
    articlesThisMinute = 0;
    recentSeoScores = [];
    lastHeartbeatTime = Date.now();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function recordArticleGenerated(seoScore: number, slug?: string) {
  articlesThisMinute++;
  if (seoScore > 0) {
    recentSeoScores.push(seoScore);
  }
  if (slug) {
    lastGeneratedSlug = slug;
  }
}

// Color-coded log for successful article generation
function logSuccess(title: string, slug: string, seoScore: number, wordCount: number, model: string = 'gpt-4.1') {
  const url = `https://catsluvus.com/petinsurance/${slug}`;
  console.log(`\n${colors.bgGreen}${colors.bold} ✅ [COPILOT CLI] ${model} ${colors.reset}`);
  console.log(`   ${colors.bold}Title:${colors.reset} ${title}`);
  console.log(`   ${colors.bold}SEO Score:${colors.reset} ${coloredScore(seoScore)}`);
  console.log(`   ${colors.bold}Words:${colors.reset} ${wordCount}`);
  console.log(`   ${colors.bold}URL:${colors.reset} ${hyperlink(url)}`);
  console.log('');
}

// ============================================================================
// V3 RESEARCH PHASE ENDPOINTS
// Research must complete before generation can start
// Agent makes ALL strategic decisions - infrastructure executes them
// ============================================================================

/**
 * Start research phase - agent discovers niche, keywords, and monetization strategy
 */
router.post('/research/start', async (req: Request, res: Response) => {
  try {
    if (researchPhaseStatus === 'discovering' || researchPhaseStatus === 'analyzing') {
      return res.json({
        success: false,
        message: 'Research phase already in progress',
        status: researchPhaseStatus
      });
    }

    const { vertical, excludeCategories, minCPC, minVolume } = req.body;

    researchEngine = createResearchEngine();
    researchPhaseStatus = 'discovering';
    researchPhaseOutput = createEmptyResearchPhaseOutput();
    researchPhaseOutput.status = 'discovering';
    researchPhaseOutput.startedAt = new Date().toISOString();

    addActivityLog('info', 'Research phase STARTED - agent discovering niches', {
      vertical: vertical || 'cat/pet',
      excludeCategories: excludeCategories || ['petinsurance']
    });

    const prompt = researchEngine.getDiscoverNichesPrompt({
      vertical,
      excludeCategories: excludeCategories || ['petinsurance'],
      minCPC: minCPC || 2,
      minVolume: minVolume || 500
    });

    res.json({
      success: true,
      status: 'discovering',
      message: 'Research phase started - agent will discover profitable niches',
      prompt: prompt,
      nextStep: 'Use /research/submit-discovery to submit agent findings'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    addActivityLog('error', 'Research phase failed to start', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit niche discovery results from agent
 */
router.post('/research/submit-discovery', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started. Call /research/start first.' });
    }

    if (researchPhaseStatus !== 'discovering') {
      return res.status(400).json({
        error: `Invalid state: expected 'discovering', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'idle' ? 'Call /research/start first' : 'Already past discovery phase'
      });
    }

    const { discoveryResponse } = req.body;
    if (!discoveryResponse) {
      return res.status(400).json({ error: 'Missing discoveryResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(discoveryResponse);
    if (!parsed) {
      return res.status(400).json({ error: 'Failed to parse agent response', progress: researchEngine.getProgress() });
    }

    if (parsed.selectedNiche) {
      researchPhaseOutput.nicheDiscovery = {
        vertical: 'cat/pet',
        niche: parsed.selectedNiche.name,
        reasoning: parsed.selectedNiche.reasoning,
        marketSize: parsed.selectedNiche.marketSize || '',
        competitorCount: parsed.selectedNiche.topCompetitors?.length || 0,
        topCompetitors: parsed.selectedNiche.topCompetitors || []
      };
    }

    researchPhaseStatus = 'analyzing';
    researchPhaseOutput.status = 'analyzing';

    const analyzePrompt = researchEngine.getAnalyzeNichePrompt(
      researchPhaseOutput.nicheDiscovery.niche,
      researchPhaseOutput.nicheDiscovery.topCompetitors
    );

    addActivityLog('info', `Niche selected: ${researchPhaseOutput.nicheDiscovery.niche}`, {
      reasoning: researchPhaseOutput.nicheDiscovery.reasoning
    });

    res.json({
      success: true,
      status: 'analyzing',
      selectedNiche: researchPhaseOutput.nicheDiscovery,
      prompt: analyzePrompt,
      nextStep: 'Use /research/submit-analysis to submit detailed analysis'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit niche analysis results from agent
 */
router.post('/research/submit-analysis', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started' });
    }

    if (researchPhaseStatus !== 'analyzing') {
      return res.status(400).json({
        error: `Invalid state: expected 'analyzing', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'discovering' ? 'Submit discovery first via /research/submit-discovery' : 'State mismatch'
      });
    }

    const { analysisResponse } = req.body;
    if (!analysisResponse) {
      return res.status(400).json({ error: 'Missing analysisResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(analysisResponse);
    if (!parsed) {
      return res.status(400).json({ error: 'Failed to parse analysis response' });
    }

    if (parsed.keywordClusters) {
      researchPhaseOutput.keywordResearch.clusters = parsed.keywordClusters;
    }

    if (parsed.competitorAnalysis) {
      researchPhaseOutput.competitorAnalysis = parsed.competitorAnalysis;
    }

    if (parsed.affiliatePrograms) {
      researchPhaseOutput.monetization.affiliatePrograms = parsed.affiliatePrograms;
    }

    if (parsed.recommendedAuthors) {
      (researchPhaseOutput as any).recommendedAuthors = parsed.recommendedAuthors;
    }

    if (parsed.nicheAnalysis) {
      if (parsed.nicheAnalysis.growthTrend) {
        (researchPhaseOutput as any).growthTrend = parsed.nicheAnalysis.growthTrend;
      }
      if (parsed.nicheAnalysis.competitionLevel) {
        (researchPhaseOutput as any).competitionLevel = parsed.nicheAnalysis.competitionLevel;
      }
    }

    researchPhaseStatus = 'prioritizing';
    researchPhaseOutput.status = 'prioritizing';

    const keywordPrompt = researchEngine.getExtractKeywordsPrompt(
      researchPhaseOutput.nicheDiscovery.niche,
      researchPhaseOutput.keywordResearch.clusters
    );

    addActivityLog('info', 'Niche analysis complete - extracting keywords', {
      clusters: researchPhaseOutput.keywordResearch.clusters.length,
      affiliatePrograms: researchPhaseOutput.monetization.affiliatePrograms.length
    });

    res.json({
      success: true,
      status: 'prioritizing',
      analysis: {
        clusters: researchPhaseOutput.keywordResearch.clusters,
        competitorGaps: researchPhaseOutput.competitorAnalysis.gaps,
        affiliatePrograms: researchPhaseOutput.monetization.affiliatePrograms
      },
      prompt: keywordPrompt,
      nextStep: 'Use /research/submit-keywords to submit keyword list'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit keywords from agent and finalize CategoryContext
 */
router.post('/research/submit-keywords', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started' });
    }

    if (researchPhaseStatus !== 'prioritizing') {
      return res.status(400).json({
        error: `Invalid state: expected 'prioritizing', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'analyzing' ? 'Submit analysis first via /research/submit-analysis' : 'State mismatch'
      });
    }

    const { keywordsResponse, domain } = req.body;
    if (!keywordsResponse) {
      return res.status(400).json({ error: 'Missing keywordsResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(keywordsResponse);
    if (!parsed || !parsed.keywords) {
      return res.status(400).json({ error: 'Failed to parse keywords response' });
    }

    researchPhaseOutput.keywordResearch.topKeywords = parsed.keywords;
    researchPhaseOutput.keywordResearch.totalKeywords = parsed.keywords.length;

    if (parsed.summary) {
      researchPhaseOutput.keywordResearch.avgCPC = parsed.summary.averageCPC || 0;
      researchPhaseOutput.keywordResearch.avgVolume = parsed.summary.totalMonthlyVolume / parsed.summary.totalKeywords || 0;
    }

    const categorySlug = researchPhaseOutput.nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-');
    researchPhaseOutput.targetStructure = {
      domain: domain || 'catsluvus.com',
      basePath: `/${categorySlug}`,
      slugFormat: `/${categorySlug}/{keyword-slug}`,
      sitemapPath: `/${categorySlug}/sitemap.xml`,
      kvPrefix: `${categorySlug}:`
    };

    activeCategoryContext = researchEngine.outputCategoryContext(researchPhaseOutput, domain);
    researchPhaseOutput.categoryContext = activeCategoryContext;

    researchPhaseStatus = 'complete';
    researchPhaseOutput.status = 'complete';
    researchPhaseOutput.completedAt = new Date().toISOString();

    const kvResult = await saveResearchToKV(researchPhaseOutput, activeCategoryContext);
    if (!kvResult.success) {
      addActivityLog('error', `Failed to persist research to KV: ${kvResult.error}`, {});
    } else {
      addActivityLog('info', `Research persisted to KV: ${activeCategoryContext.kvPrefix}`, {});
    }

    // AUTO-CONFIGURE CLOUDFLARE WORKER ROUTE for this category
    // This ensures the public domain routes /{category}/* to the Worker
    const categorySlugForRoute = activeCategoryContext.basePath?.replace(/^\//, '') || categorySlug;
    console.log(`[SEO-V3] Configuring Worker Route for new category: ${categorySlugForRoute}`);
    const routeResult = await ensureWorkerRouteForCategory(categorySlugForRoute);
    if (routeResult.success) {
      addActivityLog('info', `Worker Route configured: catsluvus.com/${categorySlugForRoute}/*`, {
        routeId: routeResult.routeId
      });
    } else {
      addActivityLog('warning', `Worker Route config failed: ${routeResult.error}`, {});
    }

    addActivityLog('info', 'Research phase COMPLETE - CategoryContext ready', {
      category: activeCategoryContext.categoryName,
      keywords: activeCategoryContext.keywords.length,
      basePath: activeCategoryContext.basePath
    });

    res.json({
      success: true,
      status: 'complete',
      categoryContext: activeCategoryContext,
      kvPersisted: kvResult.success,
      message: 'Research complete. Use /autonomous/start to begin generation with this category.'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get current research phase status
 */
router.get('/research/status', async (req: Request, res: Response) => {
  const attemptRecovery = req.query.recover === 'true';
  const kvPrefix = req.query.kvPrefix as string;

  if (attemptRecovery && kvPrefix && !activeCategoryContext) {
    const recovered = await loadResearchFromKV(kvPrefix);
    if (recovered.categoryContext) {
      activeCategoryContext = recovered.categoryContext;
      researchPhaseOutput = recovered.researchOutput;
      researchPhaseStatus = 'complete';
      addActivityLog('info', `Recovered research from KV: ${kvPrefix}`, {});
    }
  }

  res.json({
    status: researchPhaseStatus,
    hasResearchEngine: !!researchEngine,
    hasOutput: !!researchPhaseOutput,
    hasCategoryContext: !!activeCategoryContext,
    output: researchPhaseOutput ? {
      id: researchPhaseOutput.id,
      niche: researchPhaseOutput.nicheDiscovery?.niche,
      keywordCount: researchPhaseOutput.keywordResearch?.totalKeywords,
      status: researchPhaseOutput.status
    } : null,
    categoryContext: activeCategoryContext ? {
      categoryName: activeCategoryContext.categoryName,
      basePath: activeCategoryContext.basePath,
      keywordCount: activeCategoryContext.keywords.length,
      kvPrefix: activeCategoryContext.kvPrefix
    } : null
  });
});

/**
 * Reset research phase to start fresh
 */
router.post('/research/reset', async (_req: Request, res: Response) => {
  researchEngine = null;
  researchPhaseOutput = null;
  activeCategoryContext = null;
  researchPhaseStatus = 'idle';

  addActivityLog('info', 'Research phase RESET');

  res.json({
    success: true,
    status: 'idle',
    message: 'Research phase reset. Call /research/start to begin new research.'
  });
});

/**
 * Get CategoryContext for use in generation
 */
router.get('/research/context', async (_req: Request, res: Response) => {
  if (!activeCategoryContext) {
    return res.status(404).json({
      error: 'No CategoryContext available. Complete research phase first.'
    });
  }

  res.json(activeCategoryContext);
});

// ============================================================================
// AUTONOMOUS GENERATION ENDPOINTS
// ============================================================================

/**
 * Start autonomous generation mode
 * V3 uses exclusive categories - auto-discovers and generates for V3-only categories
 * Runs as fast as possible with no delay - rate limits handle throttling naturally
 */
router.post('/autonomous/start', async (req: Request, res: Response) => {
  if (autonomousRunning) {
    addActivityLog('info', 'Autonomous mode already running');
    return res.json({ running: true, message: 'Already running' });
  }

  autonomousRunning = true;
  startHeartbeat();
  resetSessionHealth();

  // V3 FIX: Use V3-exclusive category generation instead of shared V2 keywords
  // This ensures V3 works on its own categories (cat-toys-interactive, etc.)
  // and doesn't compete with V2 on the same keywords
  const useV3Categories = req.body.useV3Categories !== false; // Default to true

  if (useV3Categories) {
    // Set V3 autonomous flag (separate from legacy autonomousRunning)
    v3AutonomousRunning = true;

    addActivityLog('info', `V3 Autonomous mode STARTED - using Copilot CLI autonomous discovery`, {
      mode: 'autonomous-copilot-discovery'
    });

    // Start V3 category-based generation (uses runV3AutonomousGeneration)
    runV3AutonomousGeneration();

    res.json({
      success: true,
      running: true,
      mode: 'v3-categories',
      message: 'V3 autonomous generation started (Copilot CLI discovery)',
      discoveryMode: 'autonomous-copilot-cli'
    });
  } else {
    // Legacy mode: use shared V2 keywords (for backwards compatibility)
    addActivityLog('info', `Autonomous mode STARTED (legacy V2 keywords)`, {
      remaining: stats.pending
    });

    generateNextArticle();

    res.json({
      success: true,
      running: true,
      mode: 'legacy-v2-keywords',
      message: 'Autonomous generation started (legacy V2 keywords)'
    });
  }
});

/**
 * Stop autonomous generation (both V2 legacy and V3 category modes)
 */
router.post('/autonomous/stop', async (_req: Request, res: Response) => {
  const wasV3Running = v3AutonomousRunning;
  const wasLegacyRunning = autonomousRunning;

  autonomousRunning = false;
  v3AutonomousRunning = false;
  stopHeartbeat();

  addActivityLog('info', 'Autonomous mode STOPPED', {
    v3Mode: wasV3Running,
    legacyMode: wasLegacyRunning,
    remaining: stats.pending,
    queuePosition: stats.generated
  });

  res.json({
    success: true,
    running: false,
    stoppedModes: {
      v3Categories: wasV3Running,
      legacyV2Keywords: wasLegacyRunning
    },
    message: 'Autonomous generation stopped'
  });
});

/**
 * Session Health - cockpit banner data for the V3 UI
 */
router.get('/session-health', (_req: Request, res: Response) => {
  const active = autonomousRunning || v3AutonomousRunning;
  const uptimeMs = sessionHealth.sessionStartTime ? Date.now() - sessionHealth.sessionStartTime : 0;

  // Format uptime as human-readable string
  let uptime = '0s';
  if (uptimeMs > 0) {
    const totalSec = Math.floor(uptimeMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h > 0) uptime = `${h}h ${m}m`;
    else if (m > 0) uptime = `${m}m`;
    else uptime = `${totalSec}s`;
  }

  // Format rate
  let rate = '--';
  if (sessionHealth.articlesGenerated > 0 && uptimeMs > 0) {
    const minPerArticle = (uptimeMs / 60000) / sessionHealth.articlesGenerated;
    rate = `1 every ${minPerArticle.toFixed(1)} min`;
  }

  // Format current stage duration
  let currentStageDuration: string | null = null;
  if (sessionHealth.currentStageStartTime) {
    const elapsed = Math.floor((Date.now() - sessionHealth.currentStageStartTime) / 1000);
    currentStageDuration = `${elapsed}s`;
  }

  const avgSeoScore = sessionHealth.seoScoreCount > 0
    ? Math.round(sessionHealth.totalSeoScore / sessionHealth.seoScoreCount)
    : 0;

  res.json({
    active,
    uptime,
    uptimeMs,
    generated: sessionHealth.articlesGenerated,
    failed: sessionHealth.articlesFailed,
    deployed: sessionHealth.articlesDeployed,
    avgSeoScore,
    currentKeyword: sessionHealth.currentKeyword,
    currentStage: sessionHealth.currentStage,
    currentStageDuration,
    rate,
    avgGenerationMs: sessionHealth.avgGenerationMs,
    consecutiveErrors: sessionHealth.consecutiveErrors,
    lastError: sessionHealth.lastError
  });
});

/**
 * Get autonomous status with queue information
 * Returns V3 category context when in V3 mode, legacy queue info otherwise
 */
router.get('/autonomous/status', async (_req: Request, res: Response) => {
  try {
    // V3 MODE: Return V3-exclusive category context
    if (v3AutonomousRunning || v3CategoryContext) {
      const pendingKeywords = v3CategoryContext?.keywords?.filter(k => k.status === 'pending') || [];
      const totalKeywords = v3CategoryContext?.keywords?.length || 0;
      const completedKeywords = totalKeywords - pendingKeywords.length;
      const percentComplete = totalKeywords > 0 ? ((completedKeywords / totalKeywords) * 100).toFixed(2) : '0.00';

      // Get next keyword from V3 context
      const sortedPending = [...pendingKeywords].sort((a, b) => {
        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        const aPriority = (a.priority || 'low').toLowerCase();
        const bPriority = (b.priority || 'low').toLowerCase();
        const priorityDiff = (priorityOrder[aPriority] ?? 2) - (priorityOrder[bPriority] ?? 2);
        if (priorityDiff !== 0) return priorityDiff;
        return (b.score || 0) - (a.score || 0);
      });

      return res.json({
        running: v3AutonomousRunning,
        mode: 'v3-categories',
        generated: completedKeywords,
        remaining: pendingKeywords.length,
        totalKeywords: totalKeywords,
        percentComplete: percentComplete,
        category: v3CategoryContext?.categorySlug || null,
        niche: v3CategoryContext?.niche || null,
        domain: v3CategoryContext?.domain || 'catsluvus.com',
        basePath: v3CategoryContext?.basePath || null,
        nextKeyword: sortedPending[0] ? {
          keyword: sortedPending[0].keyword,
          slug: sortedPending[0].slug,
          priority: sortedPending[0].priority,
          score: sortedPending[0].score,
          category: v3CategoryContext?.categorySlug
        } : null,
        discoveryMode: 'autonomous-copilot-cli'
      });
    }

    // LEGACY MODE: Return V2 keyword queue info
    const queueStatus = await getGenerationQueueStatus();

    res.json({
      running: autonomousRunning,
      mode: 'legacy-v2-keywords',
      generated: queueStatus.generated,
      remaining: queueStatus.remaining,
      totalKeywords: queueStatus.totalKeywords,
      percentComplete: queueStatus.percentComplete,
      pendingByPriority: queueStatus.topPending,
      nextKeyword: queueStatus.nextKeyword ? {
        keyword: queueStatus.nextKeyword.keyword,
        slug: queueStatus.nextKeyword.slug,
        priority: queueStatus.nextKeyword.priority,
        score: queueStatus.nextKeyword.score,
        category: queueStatus.nextKeyword.category
      } : null
    });
  } catch (error: any) {
    res.json({
      running: autonomousRunning || v3AutonomousRunning,
      generated: stats.generated,
      pending: stats.pending,
      percentComplete: stats.percentComplete,
      error: error.message
    });
  }
});

/**
 * Manually create Cloudflare Worker routes for a category
 * Used when auto-creation fails or to verify routes exist
 */

// ============================================================
// INDEX STATUS DASHBOARD ENDPOINTS (V3 Autonomous Indexing)
// ============================================================

/**
 * Get indexing status dashboard data
 * GET /api/seo-generator-v3/index-status
 */
router.get('/index-status', async (_req: Request, res: Response) => {
  try {
    await ensureIndexTrackerInitialized();
    const status = getIndexStatus();

    // Calculate summary
    const summary = {
      totalTracked: status.stats.totalTracked,
      indexed: status.stats.indexed,
      pending: status.stats.pending,
      failed: status.stats.failed,
      successRate: status.stats.totalTracked > 0
        ? ((status.stats.indexed / status.stats.totalTracked) * 100).toFixed(1) + '%'
        : 'N/A',
      avgTimeToIndex: status.stats.avgTimeToIndex.toFixed(1) + ' hours',
      lastUpdated: status.stats.lastUpdated
    };

    // Categorize queue items
    const pendingItems = status.queue.filter(i => i.status === 'pending' || i.status === 'retry_scheduled');
    const checkingItems = status.queue.filter(i => i.status === 'checking');
    const indexedItems = status.queue.filter(i => i.status === 'indexed').slice(-20);
    const failedItems = status.queue.filter(i => i.status === 'failed');

    res.json({
      success: true,
      summary,
      queue: {
        pending: pendingItems.length,
        checking: checkingItems.length,
        indexed: indexedItems.length,
        failed: failedItems.length,
        items: {
          pending: pendingItems.slice(0, 20),
          failed: failedItems,
          recentlyIndexed: indexedItems
        }
      },
      recentHistory: status.recentHistory.slice(-10)
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Force recheck a specific URL
 * POST /api/seo-generator-v3/index-status/recheck
 */
router.post('/index-status/recheck', async (req: Request, res: Response) => {
  try {
    await ensureIndexTrackerInitialized();
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL required' });
    }

    const result = await forceRecheck(url);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Manually trigger indexing verification cycle
 * POST /api/seo-generator-v3/index-status/process
 */
router.post('/index-status/process', async (req: Request, res: Response) => {
  try {
    await ensureIndexTrackerInitialized();
    const result = await processIndexQueue();

    // Log results to activity
    for (const r of result.results) {
      if (r.status === 'indexed') {
        addActivityLog('success', `✅ ${r.message}`, { keyword: r.slug, url: r.url });
      } else if (r.status === 'failed') {
        addActivityLog('error', `❌ ${r.message}`, { keyword: r.slug, url: r.url });
      } else if (r.status === 'retry') {
        addActivityLog('info', `🔄 ${r.message}`, { keyword: r.slug, url: r.url });
      }
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Cleanup old indexing records
 * POST /api/seo-generator-v3/index-status/cleanup
 */
router.post('/index-status/cleanup', async (_req: Request, res: Response) => {
  try {
    await ensureIndexTrackerInitialized();
    const removed = await cleanupOldItems();
    res.json({ success: true, removed });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/create-route', async (req: Request, res: Response) => {
  try {
    const { category } = req.body;
    if (!category) {
      return res.status(400).json({ error: 'Category is required' });
    }

    addActivityLog('info', `Manual route creation requested for: ${category}`);
    
    const result = await ensureWorkerRouteForCategory(category);
    
    if (result.success) {
      addActivityLog('success', `Worker route created/verified for: ${category}`, { routeId: result.routeId });
      return res.json({ 
        success: true, 
        category,
        routeId: result.routeId,
        message: `Worker routes configured for ${category}` 
      });
    } else {
      addActivityLog('error', `Route creation failed for ${category}: ${result.error}`);
      return res.status(500).json({ 
        success: false, 
        category,
        error: result.error 
      });
    }
  } catch (error: any) {
    addActivityLog('error', `Route creation error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * List all current Cloudflare Worker routes for debugging
 */
router.get('/list-routes', async (_req: Request, res: Response) => {
  try {
    const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
    if (!cfApiToken) {
      return res.status(400).json({ error: 'No Cloudflare API token configured' });
    }

    const routes = await fetchWorkerRoutes(cfApiToken);

    // Filter routes for catsluvus.com
    const catsluvusRoutes = routes.filter((r: any) =>
      r.pattern?.includes('catsluvus.com')
    );

    // Check which V3 categories have routes (dynamic from KV)
    const allV3Cats = await getAllCategoryStatusKeys();
    const v3CategoryRoutes = allV3Cats.map(cat => {
      const hasRoute = catsluvusRoutes.some((r: any) =>
        r.pattern?.includes(`/${cat}/`) || r.pattern?.includes(`/${cat}`)
      );
      return { category: cat, hasRoute, pattern: hasRoute ? `catsluvus.com/${cat}/*` : null };
    });

    res.json({
      totalRoutes: routes.length,
      catsluvusRoutes: catsluvusRoutes.length,
      routes: catsluvusRoutes.map((r: any) => ({
        id: r.id,
        pattern: r.pattern,
        script: r.script
      })),
      v3Categories: v3CategoryRoutes,
      missingV3Routes: v3CategoryRoutes.filter(c => !c.hasRoute).map(c => c.category),
      discoveryMode: 'autonomous-copilot-cli'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create routes for ALL V3 categories (dynamically from KV)
 */
router.post('/create-all-v3-routes', async (_req: Request, res: Response) => {
  try {
    const allV3Cats = await getAllCategoryStatusKeys();
    const results: any[] = [];

    for (const category of allV3Cats) {
      const result = await ensureWorkerRouteForCategory(category);
      results.push({
        category,
        success: result.success,
        routeId: result.routeId,
        error: result.error
      });
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({
      message: `Created routes for ${successful}/${allV3Cats.length} V3 categories`,
      successful,
      failed,
      results
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manually trigger category discovery (for testing)
 */
router.post('/discover-category', async (_req: Request, res: Response) => {
  try {
    addActivityLog('info', '[V3] Manual category discovery triggered');
    const category = await discoverNextCategory();
    if (category) {
      res.json({ success: true, category });
    } else {
      res.json({ success: false, message: 'No categories available' });
    }
  } catch (error: any) {
    addActivityLog('error', `[V3] Discovery error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manually start a new category with keywords
 */
router.post('/start-category', async (req: Request, res: Response) => {
  try {
    const { slug, name, keywords } = req.body;
    if (!slug) {
      return res.status(400).json({ error: 'slug is required' });
    }

    addActivityLog('info', `[V3] Manual category start: ${slug}`);
    
    // Create Worker routes
    const routeResult = await ensureWorkerRouteForCategory(slug);
    if (!routeResult.success) {
      addActivityLog('warning', `[V3] Route creation warning: ${routeResult.error}`);
    }
    
    // If no keywords provided, generate them
    let categoryKeywords = keywords;
    if (!categoryKeywords || categoryKeywords.length === 0) {
      const discovered: DiscoveredCategory = {
        name: name || slug,
        slug: slug,
        estimatedKeywords: 30,
        affiliatePotential: 'medium',
        reasoning: 'Manually started category'
      };
      categoryKeywords = await generateCategoryKeywords(discovered);
    }
    
    if (categoryKeywords.length < 5) {
      return res.status(400).json({ error: `Only ${categoryKeywords.length} keywords generated, need at least 5` });
    }
    
    // Save in-progress status
    await saveCategoryStatus(slug, {
      category: slug,
      status: 'in_progress',
      articleCount: 0,
      expectedCount: categoryKeywords.length,
      avgSeoScore: 0,
      startedAt: new Date().toISOString()
    });
    
    addActivityLog('success', `[V3] Category initialized: ${slug}`, {
      keywords: categoryKeywords.length,
      routeCreated: routeResult.success
    });
    
    res.json({ 
      success: true, 
      category: slug, 
      keywords: categoryKeywords.length,
      routeCreated: routeResult.success,
      message: 'Category routes and status created. To start generation, use the V3 autonomous flow.'
    });
  } catch (error: any) {
    addActivityLog('error', `[V3] Start category error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get category status
 */
router.get('/category-status/:category', async (req: Request, res: Response) => {
  try {
    const { category } = req.params;
    const status = await getCategoryStatus(category);
    const articleCount = await countArticlesInCategory(category);
    
    res.json({
      category,
      status: status || { status: 'unknown' },
      actualArticleCount: articleCount
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Regenerate all articles in a category (delete from KV and reset status)
 */
router.post('/regenerate-category/:category', async (req: Request, res: Response) => {
  try {
    const { category } = req.params;
    const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
    
    if (!cfApiToken) {
      return res.status(500).json({ error: 'Cloudflare API token not configured' });
    }
    
    console.log(`[SEO-V3] 🔄 Starting regeneration for category: ${category}`);
    
    // 1. Get all article keys for this category from KV
    const listUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${category}:`;
    const listRes = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    const listData = await listRes.json() as any;
    
    const articleKeys = listData.result?.map((k: any) => k.name) || [];
    console.log(`[SEO-V3] Found ${articleKeys.length} articles to delete in ${category}`);
    
    // 2. Delete each article from KV
    let deleted = 0;
    for (const key of articleKeys) {
      const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
      try {
        await fetch(deleteUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${cfApiToken}` } });
        deleted++;
      } catch (e) {
        console.log(`[SEO-V3] Failed to delete ${key}`);
      }
    }
    console.log(`[SEO-V3] ✓ Deleted ${deleted}/${articleKeys.length} articles`);
    
    // 3. Reset category status to in_progress
    const categoryStatus = await getCategoryStatus(category);
    if (categoryStatus) {
      await saveCategoryStatus(category, {
        ...categoryStatus,
        status: 'in_progress',
        articleCount: 0,
        completedAt: undefined
      });
      console.log(`[SEO-V3] ✓ Reset category status to in_progress`);
    }
    
    // 4. Reset keywords in research context if exists
    const kvPrefix = `${category}:`;
    const { categoryContext } = await loadResearchFromKV(kvPrefix);
    if (categoryContext && categoryContext.keywords) {
      categoryContext.keywords = categoryContext.keywords.map(k => ({ ...k, status: 'pending' }));
      await saveResearchToKV({ researchPhase: 'regenerating' } as any, categoryContext);
      console.log(`[SEO-V3] ✓ Reset ${categoryContext.keywords.length} keywords to pending`);
    }
    
    addActivityLog('info', `[V3] Regeneration started for ${category}`, { deleted, total: articleKeys.length });
    
    res.json({
      success: true,
      category,
      articlesDeleted: deleted,
      message: `Deleted ${deleted} articles. Category reset to in_progress. V3 autonomous will regenerate.`
    });
  } catch (error: any) {
    console.error(`[SEO-V3] Regeneration error:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Regenerate ALL V3 categories (for major fixes like video/image bug)
 */
router.post('/regenerate-all', async (_req: Request, res: Response) => {
  try {
    const allStatusKeys = await getAllCategoryStatusKeys();
    const allStatuses = await Promise.all(allStatusKeys.map(key => getCategoryStatus(key.split(':')[2]).then(s => s || { category: key.split(':')[2], status: 'unknown', articleCount: 0, expectedCount: 0, avgSeoScore: 0, startedAt: '' })));
    const results: any[] = [];
    
    console.log(`[SEO-V3] 🔄 Starting FULL regeneration of ${allStatuses.length} categories`);
    
    for (const catStatus of allStatuses) {
      const category = catStatus.category;
      const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
      
      // Get articles for this category
      const listUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${category}:`;
      const listRes = await fetch(listUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
      const listData = await listRes.json() as any;
      const articleKeys = listData.result?.map((k: any) => k.name) || [];
      
      // Delete articles
      let deleted = 0;
      for (const key of articleKeys) {
        const deleteUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
        try {
          await fetch(deleteUrl, { method: 'DELETE', headers: { 'Authorization': `Bearer ${cfApiToken}` } });
          deleted++;
        } catch (e) {}
      }
      
      // Reset status
      await saveCategoryStatus(category, {
        ...catStatus,
        status: 'in_progress',
        articleCount: 0,
        completedAt: undefined
      });
      
      // Reset keywords
      const kvPrefix = `${category}:`;
      const { categoryContext } = await loadResearchFromKV(kvPrefix);
      if (categoryContext && categoryContext.keywords) {
        categoryContext.keywords = categoryContext.keywords.map(k => ({ ...k, status: 'pending' }));
        await saveResearchToKV({ researchPhase: 'regenerating' } as any, categoryContext);
      }
      
      results.push({ category, deleted, keywordsReset: categoryContext?.keywords?.length || 0 });
      console.log(`[SEO-V3] ✓ Reset ${category}: ${deleted} articles deleted`);
    }
    
    addActivityLog('success', `[V3] FULL REGENERATION: ${results.length} categories reset`, { 
      totalArticles: results.reduce((sum, r) => sum + r.deleted, 0)
    });
    
    res.json({
      success: true,
      categoriesReset: results.length,
      totalArticlesDeleted: results.reduce((sum, r) => sum + r.deleted, 0),
      results
    });
  } catch (error: any) {
    console.error(`[SEO-V3] Full regeneration error:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * List all completed categories
 */
router.get('/completed-categories', async (_req: Request, res: Response) => {
  try {
    const completed = await getCompletedCategories();
    res.json({ completed, count: completed.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get detailed generation queue with priority breakdown
 */
router.get('/queue', async (_req: Request, res: Response) => {
  try {
    const v3Status = await fetchV3StatusFromKV();

    res.json({
      status: 'ok',
      queue: {
        totalKeywords: v3Status.totalKeywords,
        generated: v3Status.pagesComplete,
        remaining: v3Status.pagesNeeded,
        percentComplete: v3Status.percentComplete
      },
      categoryBreakdown: v3Status.categoryBreakdown || {},
      autonomousRunning
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function for autonomous generation using Copilot SDK - NO FALLBACK
// Now uses prioritized keywords and duplicate tracking
async function generateNextArticle() {
  if (!autonomousRunning) return;

  const startTime = Date.now();

  try {
    // Get next prioritized keyword that hasn't been generated
    addActivityLog('queue', 'Fetching next prioritized keyword from queue...');
    const nextKw = await getNextPrioritizedKeyword();

    if (!nextKw) {
      addActivityLog('success', '[V1] All keywords have been generated! Pet Insurance queue complete.', {
        remaining: 0
      });
      console.log('✅ [V1] All Pet Insurance keywords have been generated! Stopping autonomous mode.');
      autonomousRunning = false;
      return;
    }

    const { keyword, slug, priority, score, category } = nextKw;

    // Note: Keyword is already locked in keywordsInProgress by getNextPrioritizedKeyword()

    // Double-check the article doesn't already exist (race condition protection)
    if (await articleExists(slug)) {
      keywordsInProgress.delete(slug); // Release the lock
      addActivityLog('info', `Skipping duplicate: "${keyword}"`, { keyword, slug, priority });
      console.log(`⏭️ Skipping "${keyword}" - already exists in KV`);
      // Invalidate cache and try next keyword
      slugsCacheTime = 0;
      setTimeout(generateNextArticle, 1000); // Try next keyword after 1 second
      return;
    }

    // Log the start of generation
    addActivityLog('generating', `Starting generation: "${keyword}"`, {
      keyword,
      slug,
      priority,
      score,
      remaining: stats.pending
    });

    console.log(`🤖 Autonomous: Generating [${priority.toUpperCase()}] "${keyword}" (score: ${score}, category: ${category})`);

    // Start a heartbeat timer to show progress during generation
    let elapsed = 0;
    const heartbeatInterval = setInterval(() => {
      elapsed += 15;
      addActivityLog('info', `⏳ Generating... (${elapsed}s elapsed)`, {
        keyword,
        slug,
        priority
      });
    }, 15000); // Log every 15 seconds

    let result;
    try {
      result = await generateWithCopilotSDK(keyword);
    } finally {
      clearInterval(heartbeatInterval);
    }

    if (!result.success) {
      keywordsInProgress.delete(slug); // Release the lock on failure
      if (result.error?.includes('No model available') || result.error?.includes('policy enablement')) {
        addActivityLog('error', 'STOPPED: GitHub Copilot not enabled', {
          keyword,
          slug
        });
        console.error('❌ Autonomous STOPPED: GitHub Copilot not enabled at https://github.com/settings/copilot');
        autonomousRunning = false;
        return;
      }
      addActivityLog('error', `Generation failed: ${result.error}`, {
        keyword,
        slug,
        priority
      });
      console.error(`❌ Autonomous error: ${result.error}`);
      // Continue to next article on non-fatal errors
      if (autonomousRunning) {
        setTimeout(generateNextArticle, 5000);
      }
      return;
    }

    const duration = Date.now() - startTime;

    // Add to local cache immediately to prevent duplicates
    existingArticleSlugs.add(slug);
    registerArticleForLinking(slug, 'petinsurance');
    // Remove from in-progress (now complete)
    keywordsInProgress.delete(slug);

    // Update stats from queue status
    const queueStatus = await getGenerationQueueStatus();
    stats.generated = queueStatus.generated;
    stats.pending = queueStatus.remaining;
    stats.percentComplete = queueStatus.percentComplete;

    // Store in recent articles
    const articleData = {
      keyword,
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      date: new Date().toISOString(),
      deployed: result.deployed || false,
      liveUrl: result.liveUrl || null,
      priority,
      score,
      category
    };
    recentArticles.unshift(articleData as any);
    recentArticles = recentArticles.slice(0, 50);

    // Log successful generation with SEO score
    const articleSeoScore = (result as any).seoScore || 0;
    const articleWordCount = result.article!.wordCount || 3500;
    
    // Record for heartbeat stats (with slug for last URL display)
    recordArticleGenerated(articleSeoScore, slug);
    
    // Color-coded success log with clickable URL
    logSuccess(result.article!.title, slug, articleSeoScore, articleWordCount);
    
    addActivityLog('success', `Generated: "${result.article!.title}" | SEO: ${articleSeoScore}/100`, {
      keyword,
      slug,
      priority,
      score,
      seoScore: articleSeoScore,
      wordCount: articleWordCount,
      duration,
      remaining: stats.pending
    });

    // Log deployment status
    if (result.deployed) {
      const liveUrl = result.liveUrl || `https://catsluvus.com/petinsurance/${slug}`;
      addActivityLog('deployed', `Deployed to Cloudflare KV`, {
        keyword,
        slug,
        url: liveUrl
      });

      // DataForSEO On-Page scoring (async, non-blocking, 10s delay for CDN propagation)
      getOnPageScoreWithRetry(liveUrl, 2, 10000).then(dfsScore => {
        if (dfsScore) {
          const categorized = categorizeSEOIssues(dfsScore.issues);
          const fixableCount = categorized.fixable.length;
          const infoCount = categorized.informational.length;
          console.log(`[DataForSEO] ${slug}: ${dfsScore.overallScore}/100 (${dfsScore.checks.passed} passed, ${dfsScore.checks.failed} failed) | Fixable: ${fixableCount}, Infrastructure: ${infoCount}`);
          addActivityLog('info', `[DataForSEO] Professional SEO: ${dfsScore.overallScore}/100`, {
            keyword,
            slug,
            dataForSEOScore: dfsScore.overallScore,
            passed: dfsScore.checks.passed,
            failed: dfsScore.checks.failed,
            fixableIssues: categorized.fixable.join(', ') || 'none',
            infrastructureIssues: categorized.informational.join(', ') || 'none'
          });
        }
      }).catch(() => {});
    }

    // Log progress update
    addActivityLog('queue', `Progress: ${stats.generated}/${ALL_KEYWORDS.length} (${stats.percentComplete}%)`, {
      remaining: stats.pending,
      queuePosition: stats.generated
    });

    // V3: Indexing verification cycle - run every 5 articles during autonomous mode
    if (stats.generated % 5 === 0 && stats.generated > 0) {
      ensureIndexTrackerInitialized().then(() => processIndexQueue()).then(result => {
        if (result.checked > 0) {
          console.log(`[IndexTracker] Cycle: ${result.checked} checked, ${result.indexed} indexed, ${result.failed} failed`);
          for (const r of result.results) {
            if (r.status === 'indexed') {
              addActivityLog('success', `Index verified: ${r.slug}`, { url: r.url });
            } else if (r.status === 'failed') {
              addActivityLog('error', `Index failed: ${r.slug}`, { url: r.url });
            }
          }
        }
      }).catch(err => {
        console.log(`[IndexTracker] Cycle error: ${err.message}`);
      });
    }

    // Immediately start next article (no delay - max speed mode)
    if (autonomousRunning) {
      setImmediate(generateNextArticle);
    }

  } catch (error: any) {
    addActivityLog('error', `Error: ${error.message}`);
    console.error('❌ Autonomous error:', error.message);
    
    // On error, wait 5 seconds before retrying (rate limit backoff)
    if (autonomousRunning) {
      setTimeout(generateNextArticle, 5000);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V3 AUTONOMOUS RESEARCH & GENERATION
// Fully autonomous pipeline: Research → CategoryContext → Content Generation
// ═══════════════════════════════════════════════════════════════════════════

let v3AutonomousRunning = false;
let v3CategoryContext: CategoryContext | null = null;

async function runV3AutonomousResearch(): Promise<CategoryContext | null> {
  console.log('[SEO-V3] 🚀 Starting autonomous research phase...');
  addActivityLog('info', '[V3] Starting autonomous research - agent will discover new category');

  try {
    const engine = ResearchEngine.createForResearch();
    
    // Phase 1: Niche Discovery
    console.log('[SEO-V3] Phase 1: Niche Discovery...');
    const discoveryPrompt = engine.getNicheDiscoveryPrompt({
      vertical: 'cat/pet',
      excludeCategories: ['pet insurance', 'cat insurance'],
      minCPC: 1.0,
      minVolume: 500
    });

    const discoveryResponse = await generateWithCopilotCLI(discoveryPrompt, 300000);
    const discoveryJson = engine.parseAgentResponse<any>(discoveryResponse);
    
    // Handle both object and string formats for selectedNiche
    const selectedNiche = typeof discoveryJson?.selectedNiche === 'object' 
      ? discoveryJson.selectedNiche?.name || discoveryJson.selectedNiche?.niche || JSON.stringify(discoveryJson.selectedNiche)
      : discoveryJson?.selectedNiche;
    
    if (!selectedNiche) {
      throw new Error('Agent did not select a niche');
    }

    console.log(`[SEO-V3] ✅ Agent selected niche: "${selectedNiche}"`);
    addActivityLog('info', `[V3] Agent discovered niche: ${selectedNiche}`, {
      reasoning: discoveryJson.reasoning || discoveryJson.selectedNiche?.reasoning,
      marketSize: discoveryJson.marketSizeEstimate || discoveryJson.selectedNiche?.marketSize
    });

    // Phase 2: Niche Analysis
    console.log('[SEO-V3] Phase 2: Deep Niche Analysis...');
    const analysisPrompt = engine.getNicheAnalysisPrompt(
      selectedNiche,
      discoveryJson.keywordSeeds || []
    );

    const analysisResponse = await generateWithCopilotCLI(analysisPrompt, 300000);
    const analysisJson = engine.parseAgentResponse<any>(analysisResponse);

    if (!analysisJson?.keywordClusters) {
      throw new Error('Agent did not provide keyword clusters');
    }

    console.log(`[SEO-V3] ✅ Agent identified ${analysisJson.keywordClusters?.length || 0} keyword clusters`);

    // Phase 3: Keyword Extraction & Prioritization
    console.log('[SEO-V3] Phase 3: Keyword Prioritization...');
    const keywordPrompt = engine.getExtractKeywordsPrompt(
      selectedNiche,
      analysisJson.keywordClusters || []
    );

    const keywordResponse = await generateWithCopilotCLI(keywordPrompt, 300000);
    const keywordJson = engine.parseAgentResponse<any>(keywordResponse);

    // Handle multiple response formats: prioritizedKeywords, keywords, or topKeywords
    const extractedKeywords = keywordJson?.prioritizedKeywords || keywordJson?.keywords || keywordJson?.topKeywords || [];
    
    if (!extractedKeywords || extractedKeywords.length === 0) {
      console.log('[SEO-V3] ⚠️ No keywords extracted, using fallback keyword list');
      // Use discovered niche to generate basic keywords as fallback
    }

    console.log(`[SEO-V3] ✅ Agent prioritized ${extractedKeywords.length} keywords by revenue potential`);

    // Build slug from niche name
    const nicheSlug = selectedNiche.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    // Build ResearchPhaseOutput
    const researchOutput: ResearchPhaseOutput = {
      id: `v3-research-${Date.now()}`,
      status: 'complete',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      nicheDiscovery: {
        niche: selectedNiche,
        reasoning: discoveryJson.reasoning || discoveryJson.selectedNiche?.reasoning || '',
        marketSize: discoveryJson.marketSizeEstimate || discoveryJson.selectedNiche?.marketSize || '$1B+',
        growthRate: discoveryJson.growthRate || '10%',
        competitorCount: discoveryJson.competitorCount || 50
      },
      keywordResearch: {
        totalKeywords: extractedKeywords.length,
        avgCPC: 2.5,
        avgVolume: 1000,
        topKeywords: extractedKeywords.slice(0, 100).map((k: any, index: number) => ({
          keyword: k.keyword || k.name || k,
          slug: (k.keyword || k.name || k).toString().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
          volume: k.volume || 1000,
          cpc: k.cpc || k.breakdown?.cpcScore || 2.0,
          difficulty: k.difficulty || 50,
          intent: k.intent || 'informational' as const,
          priority: (k.recommendedOrder || index) <= 10 ? 'high' : (k.recommendedOrder || index) <= 30 ? 'medium' : 'low',
          status: 'pending' as const
        })),
        clusters: analysisJson.keywordClusters || []
      },
      competitorAnalysis: {
        topCompetitors: [],
        gaps: analysisJson.competitorGaps || analysisJson.competitorAnalysis?.gaps || [],
        opportunities: []
      },
      monetization: {
        affiliatePrograms: (analysisJson.affiliatePrograms || []).map((p: any) => ({
          name: p.name || p,
          commissionRate: p.commissionRate || 10,
          cookieDuration: p.cookieDuration || 30
        })),
        adPotential: 'high',
        revenueProjection: { month1: 500, month6: 3000, month12: 10000 }
      },
      targetStructure: {
        domain: 'catsluvus.com',
        basePath: `/${nicheSlug}`,
        slugFormat: `/${nicheSlug}/{keyword-slug}`,
        sitemapPath: `/${nicheSlug}/sitemap.xml`,
        kvPrefix: `${nicheSlug}:`
      }
    };

    // Store agent-provided metadata
    (researchOutput as any).recommendedAuthors = analysisJson.recommendedAuthors || [];
    (researchOutput as any).growthTrend = analysisJson.nicheAnalysis?.growthTrend || 'stable';
    (researchOutput as any).competitionLevel = analysisJson.nicheAnalysis?.competitionLevel || 'medium';

    // Generate CategoryContext
    const categoryContext = engine.outputCategoryContext(researchOutput, 'catsluvus.com');

    // Persist to KV
    await saveResearchToKV(researchOutput, categoryContext);

    console.log(`[SEO-V3] ✅ Research complete! Category: ${categoryContext.categoryName}`);
    console.log(`[SEO-V3] 📊 ${categoryContext.keywords.length} keywords ready for generation`);
    console.log(`[SEO-V3] 🔗 Base path: ${categoryContext.basePath}`);

    addActivityLog('success', `[V3] Research COMPLETE - ${categoryContext.categoryName}`, {
      keywords: categoryContext.keywords.length,
      basePath: categoryContext.basePath,
      kvPrefix: categoryContext.kvPrefix
    });

    return categoryContext;

  } catch (error: any) {
    console.error('[SEO-V3] ❌ Research failed:', error.message);
    addActivityLog('error', `[V3] Research failed: ${error.message}`);
    return null;
  }
}

async function generateV3Article(keyword: KeywordData, context: CategoryContext): Promise<boolean> {
  let currentStep = 'init';
  const genStartTime = Date.now();
  let histJsonRepaired = false;
  let histQualityRepairUsed = false;
  let histImageResult: { count: number; neuronsCost: number; timingMs: number } = { count: 0, neuronsCost: 0, timingMs: 0 };
  let histVideoData: GenerationRecord['video'] = null;
  let histVerificationPassed = false;
  try {
    console.log(`[SEO-V3] 📝 Generating: "${keyword.keyword}"`);
    addActivityLog('generating', `Generating: "${keyword.keyword}"`, {
      keyword: keyword.keyword,
      priority: keyword.priority || 'medium',
      slug: keyword.slug
    });
    const slug = keyword.slug;

    // 1. SERP Analysis - Analyze what's ranking #1-10 to beat competitors
    currentStep = '1/12: SERP Analysis';
    updateSessionStage(keyword.keyword, '1/12: SERP Analysis');
    console.log(`[SEO-V3] [Step 1/12] SERP analysis for: "${keyword.keyword}"`);
    const serpAnalysis = await analyzeSERP(keyword.keyword);
    console.log(`[SEO-V3] [Step 1/12] ✓ SERP complete (${serpAnalysis.topResults.length} results)`);
    addActivityLog('info', `[Step 1/12] SERP Analysis complete (${serpAnalysis.topResults.length} results)`, { keyword: keyword.keyword, step: '1/12' });
    
    // Build SERP insights for the prompt
    const competitorHeadingsText = serpAnalysis.competitorHeadings.length > 0
      ? `\nCompetitor H2/H3 headings (COVER ALL): ${serpAnalysis.competitorHeadings.slice(0, 12).join(' | ')}`
      : '';
    const competitorFAQsText = serpAnalysis.competitorFAQs.length > 0
      ? `\nCompetitor FAQ questions (ANSWER ALL): ${serpAnalysis.competitorFAQs.slice(0, 8).join(' | ')}`
      : '';
    const competitorEntitiesText = serpAnalysis.competitorEntities?.length > 0
      ? `\nKey entities/brands to reference: ${serpAnalysis.competitorEntities.slice(0, 10).join(', ')}`
      : '';

    const serpInsights = serpAnalysis.topResults.length > 0 
      ? `\n\nCOMPETITOR ANALYSIS (Top 10 Google results):
Top-ranking titles: ${serpAnalysis.topResults.slice(0, 5).map(r => `"${r.title}"`).join(', ')}
Topics ALL competitors cover: ${serpAnalysis.commonTopics.join(', ')}${competitorHeadingsText}${competitorFAQsText}${competitorEntitiesText}
Content gaps to exploit: ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount} words (match #1 competitor length)\n`
      : '';

    // 2. Fetch People Also Ask questions
    currentStep = '2/12: People Also Ask';
    updateSessionStage(keyword.keyword, '2/12: People Also Ask');
    console.log(`[SEO-V3] [Step 2/12] Fetching PAA questions...`);
    const paaQuestions = await fetchPAAQuestions(keyword.keyword);
    console.log(`[SEO-V3] [Step 2/12] ✓ PAA complete (${paaQuestions.length} questions)`);
    addActivityLog('info', `[Step 2/12] PAA Questions fetched (${paaQuestions.length} questions)`, { keyword: keyword.keyword, step: '2/12' });
    const paaQuestionsText = paaQuestions.length > 0 
      ? `\n\nPEOPLE ALSO ASK (Use as FAQs):\n${paaQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n`
      : '';

    // 3. Get existing articles for internal linking (BOTH same-category AND cross-category)
    currentStep = '3/12: Internal Linking';
    updateSessionStage(keyword.keyword, '3/12: Internal Linking');
    console.log(`[SEO-V3] [Step 3/12] Fetching existing article slugs...`);
    const existingSlugs = await fetchExistingArticleSlugsForCategory(context.kvPrefix);
    console.log(`[SEO-V3] [Step 3/12] ✓ Found ${existingSlugs.length} same-category articles`);

    // Fetch cross-category articles (from all V3 categories in KV) with full URLs
    const crossCategoryUrls = await fetchCrossCategoryArticlesForLinking(context.kvPrefix);
    console.log(`[SEO-V3] [Step 3/12] ✓ Found ${crossCategoryUrls.length} cross-category articles for linking`);
    addActivityLog('info', `[Step 3/12] Internal linking ready (${existingSlugs.length} same-category, ${crossCategoryUrls.length} cross-category)`, { keyword: keyword.keyword, step: '3/12' });

    // Combine: same-category slugs (convert to full URLs) + cross-category URLs
    // Normalize basePath to ensure proper URL format: /category/ (with trailing slash)
    let categoryPath = context.basePath || `/${context.kvPrefix.replace(/:$/, '')}/`;
    // Ensure categoryPath ends with exactly one slash
    if (!categoryPath.endsWith('/')) categoryPath += '/';
    if (!categoryPath.startsWith('/')) categoryPath = '/' + categoryPath;

    const sameCategoryUrls = existingSlugs.slice(0, 20).map(slug => `${categoryPath}${slug}`);
    const allArticleUrls = [...sameCategoryUrls, ...crossCategoryUrls.slice(0, 30)];
    const existingArticlesList = allArticleUrls.join('\n');

    // 4. Fetch real Amazon products for comparison table
    currentStep = '4/12: Amazon Products';
    updateSessionStage(keyword.keyword, '4/12: Amazon Products');
    console.log(`[SEO-V3] [Step 4/12] Fetching Amazon products...`);
    const amazonProducts = await fetchAmazonProductsForKeyword(keyword.keyword, 'Pet Supplies');
    console.log(`[SEO-V3] [Step 4/12] ✓ Amazon: ${amazonProducts.products.length} products found`);
    if (amazonProducts.products.length === 0) {
      console.warn(`[SEO-V3] ⚠️ [Step 4/12]: 0 Amazon products for "${keyword.keyword}" — continuing with knowledge-based product picks (no live ASINs).`);
      addActivityLog('warning',
        `[Step 4/12] No live Amazon products for "${keyword.keyword}" — generating with AI-grounded real product names (check Apify/API if unexpected).`,
        { keyword: keyword.keyword, productCount: 0, step: '4/12', reason: 'amazon-products-degraded' });
    } else {
      addActivityLog('info',
        `[Step 4/12] Amazon products found (${amazonProducts.products.length} products)`,
        { keyword: keyword.keyword, productCount: amazonProducts.products.length, step: '4/12' });
    }

    // 5. Get category-specific content data (brands, authors, FAQs, etc.)
    const categorySlug = context.categorySlug || context.niche || 'DEFAULT';
    const categoryContent = getCategoryContentData(categorySlug);
    console.log(`[SEO-V3] Using category content for: ${categorySlug}`);

    // 5. Build category-specific comparison table based on context entities or category defaults
    const contextEntities = context.entities || [];
    const comparisonBrands = contextEntities.length > 0 
      ? contextEntities.slice(0, 5).map(e => e.name).join(', ')
      : categoryContent.brands.join(', ');

    // 6. Build author info from context or category defaults
    const contextAuthors = context.authors || [];
    const expertAuthor = contextAuthors[0] || categoryContent.author;

    // 7. Build dynamic JSON template examples from category content
    const categoryImageExamples = categoryContent.imageAltTemplates.map((alt, i) => 
      `{"url": "https://images.unsplash.com/photo-category-${i + 1}?w=800&q=80", "alt": "${alt.replace('{keyword}', keyword.keyword)}", "caption": "${categoryContent.imageCaptions[i] || 'Expert guide image.'}"}`
    ).join(',\n    ');

    // Build comparison example with REAL Amazon products (if available) or instructions
    const amazonAffiliateTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
    let categoryComparisonExample: string;
    let amazonProductsPromptText = '';

    if (amazonProducts.products.length > 0) {
      // We have real Amazon products - use them directly
      amazonProductsPromptText = amazonProducts.promptText;
      categoryComparisonExample = `{
    "headers": ["Product Name", "Price", "Key Features", "Rating", "Amazon Search"],
    "rows": [
${amazonProducts.comparisonRows.map(row => `      ${JSON.stringify(row)}`).join(',\n')}
    ]
  }

USE THESE EXACT PRODUCTS - They are REAL Amazon products with verified data.`;
    } else {
      // No Amazon API products - instruct AI to use REAL products from its knowledge
      // Build category-specific product examples based on the keyword/category
      const categoryExamples = getCategoryProductExamples(categorySlug, keyword.keyword);

      categoryComparisonExample = `{
    "headers": ["Product Name", "Price", "Key Features", "Rating", "Amazon Search"],
    "rows": [
      // YOU MUST USE REAL PRODUCTS - see examples below for this category
    ]
  }

**MANDATORY: USE REAL PRODUCTS FROM YOUR KNOWLEDGE**

You are an expert who knows real products sold on Amazon. For "${keyword.keyword}", use ACTUAL products that exist and are sold on Amazon.

${categoryExamples}

STRICT REQUIREMENTS:
1. Use the EXACT brand and product names (e.g., "Sherpa Original Deluxe Carrier" NOT "Top Brand 1")
2. Use realistic prices based on your knowledge (e.g., "$45.99" NOT "$XX.XX")
3. Include real features specific to each product
4. The "Amazon Search" column = product name with + instead of spaces (e.g., "Sherpa+Original+Deluxe+Carrier")
5. Include exactly 3 products that are actually available on Amazon

**FAILURE MODE - DO NOT DO THIS:**
- "Top Brand 1", "Top Brand 2" = REJECTED
- "Brand A", "Brand B" = REJECTED
- "Product 1", "Product 2" = REJECTED
- Generic placeholder names = REJECTED

**SUCCESS MODE - DO THIS:**
- "Sherpa Original Deluxe Pet Carrier" = CORRECT
- "Litter-Robot 4" = CORRECT
- "Feliway Classic Diffuser" = CORRECT
- Actual product names you know exist = CORRECT`;
    }

    const faqTopicKeyword = keyword.keyword
      .replace(/^(reviews?\s+of|best|top|guide\s+to|how\s+to\s+choose|choosing\s+the\s+right)\s+/i, '')
      .trim();
    const categoryFaqExamples = categoryContent.faqTemplates.slice(0, 8).map(faq => 
      `{"question": "${faq.question.replace('{keyword}', faqTopicKeyword)}", "answer": "${faq.answerHint}. Direct answer first (40-60 words), then 2-3 supporting sentences. Total: 100-160 words max."}`
    ).join(',\n    ');

    const categoryExternalLinkExamples = categoryContent.externalLinks.map(link =>
      `{"url": "${link.url}", "text": "${link.text}", "context": "${link.context}"}`
    ).join(',\n    ');

    // Build product grounding text for inline injection into requirements
    let productGroundingText = '';
    let productNamesList: string[] = [];
    if (amazonProducts.products.length > 0) {
      productNamesList = amazonProducts.products.map((p: any) => p.name || p.title || '').filter(Boolean);
      const productSummary = amazonProducts.products.map((p: any, i: number) => 
        `${i + 1}. "${p.name || p.title}" (${p.price || 'check price'}, ${p.rating || 'N/A'})`
      ).join('\n');
      productGroundingText = `
CRITICAL — PRODUCT ACCURACY REQUIREMENT:
This article is about "${keyword.keyword}". You MUST discuss these REAL products that match this topic:
${productSummary}

DO NOT recommend products from a DIFFERENT category. For example:
- If the topic is "GPS trackers for cats", do NOT recommend DNA testing kits, food bowls, or toys
- If the topic is "automatic feeders", do NOT recommend litter boxes or carriers
- ONLY discuss products that a customer searching "${keyword.keyword}" would actually want to buy
- Mention at least 2 of the products listed above BY EXACT NAME in your article sections
`;
    } else {
      productGroundingText = `
CRITICAL — PRODUCT ACCURACY (NO LIVE AMAZON PULL):
Apify/API returned zero products for "${keyword.keyword}". You MUST still fill the comparison JSON with exactly 3 real products that exist on Amazon (per the MANDATORY block above) and mention at least 2 of those exact product names in the article body — real brand and model names only, no placeholders.
`;
    }

    // 8. Full SEO-optimized prompt matching V1 quality with DYNAMIC category content
    const prompt = `You are an expert SEO content writer for ${context.categoryName}. Generate an SEO article about "${keyword.keyword}" optimized for Google Featured Snippets.
${serpInsights}
${paaQuestionsText}${amazonProductsPromptText}
${productGroundingText}
TARGET SITE: https://${context.domain}${context.basePath}
EXPERT AUTHOR: ${expertAuthor.name}, ${expertAuthor.title} (${expertAuthor.credentials})

Requirements:
- STRICT WORD COUNT: Write EXACTLY ${serpAnalysis.targetWordCount} words (±15%). Do NOT exceed ${Math.round(serpAnalysis.targetWordCount * 1.15)} words. This target matches the #1 ranking competitor. Longer is NOT better — Google rewards concise, focused content that matches search intent.
- Use "${keyword.keyword}" naturally 8-12 times
- Include ${Math.max(6, serpAnalysis.competitorFAQs.length || 6)} FAQs optimized for Google Featured Snippets and People Also Ask
- FAQ ANSWER FORMAT (CRITICAL FOR FEATURED SNIPPETS - applies to EVERY FAQ):
  * First sentence: Direct answer in 40-60 words. This is what Google extracts for Position 0 and People Also Ask. Start with the answer, not context.
  * Then: 2-3 sentences of supporting detail with specific data, prices, or examples (60-100 words)
  * Total per FAQ: 100-160 words MAX. Concise beats comprehensive for snippet capture.
  * Use bullet points or numbered lists within answers when listing options, steps, or comparisons.
  * NEVER write essay-style 150+ word paragraphs. Google skips long-winded answers for snippets.
- FAQ questions MUST be about the PRODUCT/TOPIC itself, NOT about "reviews" or "guides". Strip action words from the keyword for FAQ questions. Example: for keyword "reviews of cat safe window screens", FAQs should ask about "cat safe window screens" (e.g., "Are cat safe window screens durable?" NOT "Are reviews of cat safe window screens worth it?")
- FAQ QUESTION FORMAT: Use VARIED, NATURAL question phrasing. Do NOT repeat the full keyword in every FAQ question. BAD: "What are safe plants for cat enrichment at home?", "How much do safe plants for cat enrichment at home cost?", "Are safe plants for cat enrichment at home worth it?". GOOD: "Which plants are safest for cats?", "How much do cat-safe plants cost?", "Are indoor plants worth it for cat enrichment?". Each question should feel like a different person asking naturally.
- FAQ QUESTION CASING: Start every question with a capital letter. When the topic appears in the question, use sentence-style topic phrasing (e.g. "Cat water fountain" / "Cat water fountain filters") — not all-lowercase ("cat water fountain") mid-sentence unless it is a common word like "and" or "the".
- Include expert quotes and real pricing/data
- Write in authoritative, trustworthy tone
- Include 3-5 external authority links to veterinary sites, manufacturer sites, research journals
- DO NOT include comparison tables or product tables in the article sections — a real product comparison is injected separately
- MUST mention at least 2 of the real Amazon products listed above by name in the article body

COPYWRITING PRINCIPLES (MANDATORY):
- Clarity over cleverness: if you must choose between clear and creative, choose clear
- Benefits over features: explain what it MEANS for the customer, not just what it does
- Specificity over vagueness: "cuts weekly reporting from 4 hours to 15 minutes" not "saves time"
- Use customer language: mirror the words real buyers use in reviews and forums
- One idea per section: each section advances one argument in a logical flow
- Use rhetorical questions to engage: "Tired of [pain point]?" makes readers think about their situation
- NEVER use exclamation points
- Strong CTAs: "Get [Specific Thing]" not "Learn More" or "Click Here"

INTERNAL LINKING (MANDATORY - REQUIRED FOR SEO SCORE):
**YOU MUST INCLUDE 8-12 INTERNAL LINKS** in the "internalLinks" array. This is NOT optional.
Pick 8-12 URLs from this list and create contextual anchor text for each:
${existingArticlesList || 'No existing articles yet - focus on external authority links'}

INTERNAL LINK RULES (REQUIRED):
- Pick EXACTLY 8-12 URLs from the list above
- Use descriptive anchor text (NOT "click here" or generic text)
- Each link needs: url (copy exactly from list), anchorText, context
- Only link to topically related articles — cross-category links must be relevant to the article topic
- FAILURE TO INCLUDE internalLinks ARRAY = ARTICLE REJECTED

STRICT SEO REQUIREMENTS FOR 100/100 SCORE (CRITICAL):
**TITLE: NATURALLY CONCISE, MAX 55 CHARACTERS**
- Write a punchy, complete title that naturally fits within 55 characters
- NEVER use "..." or truncated-looking endings
- Use concise phrasing: "Top Picks" not "Complete Comprehensive Guide"
- Pattern: "[Topic]: [Value Prop] [Year]" e.g., "Cat Food Delivery: Best Brands 2026" (36 chars)
- Count characters BEFORE outputting to ensure it fits
- GOOD: "Cat DNA Tests: Top 5 Kits Compared 2026" (40 chars)
- BAD: "The Complete Ultimate Guide to Cat DNA Testing Services & Everything..." (truncated)

**META DESCRIPTION: EXACTLY 145-155 CHARACTERS (not 156+, not 144-)**
- Count EVERY character before outputting
- Include primary keyword naturally once
- Include call-to-action (Discover, Compare, Learn, Find)

**KEYWORD DENSITY: 1.0-1.5%** (For ${serpAnalysis.targetWordCount} words = use keyword ${Math.round(serpAnalysis.targetWordCount * 0.01)}-${Math.round(serpAnalysis.targetWordCount * 0.015)} times evenly)

**HEADINGS: 4-8 unique H2s** - No duplicate text, use keyword naturally in 1-2 H2s ONLY. DO NOT repeat the full keyword phrase in every H2 — that is keyword stuffing. Use natural short variations like "How It Works", "Top Picks Compared", "Pricing Guide", "Key Benefits". Only include the full keyword in the H1 title.

**LINKS: 8-12 internal links (REQUIRED in internalLinks array) + 2-3 external authority links**

AEO (ANSWER ENGINE OPTIMIZATION) - For Featured Snippets & Voice Search:
- **Quick Answer Box**: First 40-60 words MUST directly answer the main query (appears in "quickAnswer")
- **Definition Pattern**: Start key sections with "X is..." or "X refers to..." for definition snippets
- **List Snippets**: Use numbered steps for "how to" content, bullet points for "best X" content
- **Table Snippets**: Comparison tables trigger rich snippets - include clear headers and data
- **FAQ Optimization**: Each FAQ answer MUST start with a direct 40-60 word answer (Google extracts this for snippets), then add 2-3 supporting sentences. Total: 100-160 words max per FAQ. Never write essay-length FAQ answers.
- **Voice Search Ready**: Write answers that sound natural when read aloud by voice assistants
- **Step-by-Step Blocks**: For "how to" content, use bold step names: "1. **[Step Name]**: [Action in 1-2 sentences]"
- **Pros/Cons Blocks**: For evaluation queries ("Is X worth it?"), use bold category labels with specific explanations
- **Self-Contained Answers**: Write quotable standalone statements that make sense without additional context

GEO (GENERATIVE ENGINE OPTIMIZATION) - For AI Search Engines (ChatGPT, Perplexity, Claude):
- **Entity Definitions**: Clearly define key terms so AI can cite you: "A [term] is [definition]..."
- **Factual Statements**: Include specific facts, statistics, and data points AI can reference
- **Source Attribution**: Mention studies, experts, and authoritative sources by name
- **E-E-A-T Signals**: Include author expertise, first-hand experience, and trust indicators
- **Structured Knowledge**: Use consistent formatting so AI can extract structured information
- **Citation-Worthy Content**: Write statements that AI would want to cite as a source
- **Semantic Clarity**: Avoid ambiguity - be precise about what, who, when, where, why, how
- **Statistics with Sources**: "According to [Organization], [stat with number and timeframe]" — stats with sources increase AI citation by 15-30%
- **Expert Quotes with Attribution**: '"[Quote]," says [Expert Name], [Title] at [Organization]' — named attribution increases citation likelihood
- **Evidence Sandwich**: Structure claims as [Claim] then [2-3 data points with sources] then [Actionable conclusion]

FACTUAL ACCURACY (ZERO TOLERANCE FOR HALLUCINATION):
- NEVER invent scientific/botanical/Latin names. If you don't know the exact scientific name, omit it entirely. "Pile spermicides" or "Repeat catalpa" are UNACCEPTABLE hallucinations.
- NEVER change or invent brand names. Use the EXACT brand names from the Amazon product data provided above. "Gayle Garden" when the data says "Zaylee Garden" is UNACCEPTABLE.
- NEVER change the author's credentials. The author is "${expertAuthor.name}, ${expertAuthor.title} (${expertAuthor.credentials})". Copy these EXACTLY. Do not paraphrase or abbreviate certifications.
- If you reference a study, organization, or statistic, it must be real and verifiable. Do not fabricate research citations.
- When discussing products not in the Amazon data, use common names only. Do not guess at model numbers, ASINs, or specifications you are unsure about.

OUTPUT QUALITY AND COMPLETENESS (MANDATORY):
- Every sentence in introduction, sections, conclusion, FAQ answers, keyTakeaways, and keyFacts MUST be grammatically complete: include a subject and a finite verb. Do not output fragments, dangling phrases, or placeholder stubs.
- Fix-class patterns to NEVER output: "the most factor" (say "the most important factor"); "highly for" / "are highly for" (say "highly recommended for" or "especially helpful for"); "praise its for" (say "praise it for" or "owners praise it for"); "addresses the of" / "justify the for" / "serves as an for" (always include the missing noun: needs, price, investment, option, etc.); "which dehydration" without a verb (say "which reduces dehydration" or "which helps prevent dehydration"); "making proper hydration for their health" without a verb (say "making proper hydration essential for" or "supporting hydration for").
- Do not merge a sentence into a heading label: use a period, space, or newline before labels like "Best for:" or "Pros:" (never "households.Best for:" on one line).
- If you use labels such as "Best for:", "Pros:", or "Cons:" inside section content, each label MUST be followed by at least one full sentence. Never leave them empty or with only a colon.
- Do not use empty CMS stubs: no "TODO", "TBD", or lorem ipsum. For stock/Unsplash images, include required license or attribution text (including "License this image" / photographer credit lines) when applicable.
- Product names in prose: first mention MUST use the EXACT full product title from the Amazon list above. After that, use a short form (brand plus short model or product type) so you do not repeat the entire Amazon title in every sentence. First mention stays exact; shortened form must still be recognizable and accurate.
- Numeric specs (dB, pump noise, days of water, filter change intervals, tank capacity): only use numbers that appear in the provided Amazon/product data, or clearly qualify them (e.g. "manufacturer-listed", "typically", "often rated at"). Never invent precise measurements or present guesses as tested fact.

AI WRITING DETECTION AVOIDANCE:
- NEVER use em dashes (—). Use commas, colons, or parentheses.
- AVOID: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, enhance
- AVOID: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking
- AVOID phrases: "In today's fast-paced world", "It's important to note", "Let's delve into"
- Use varied sentence lengths and natural conversational tone
- Write like a human expert, not an AI
- BANNED VERBS: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, endeavour, ascertain, elucidate, facilitate, optimise
- BANNED ADJECTIVES: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking, innovative, seamless, intricate, nuanced, multifaceted, holistic
- BANNED TRANSITIONS: furthermore, moreover, notwithstanding, "that being said", "at its core", "to put it simply", "it is worth noting that", "in the realm of", "in the landscape of", "in today's [anything]"
- BANNED OPENERS: "In today's fast-paced world", "In today's digital age", "In an era of", "In the ever-evolving landscape of", "In the realm of", "It's important to note that", "Let's delve into", "Imagine a world where"
- BANNED CLOSERS: "In conclusion", "To sum up", "By [doing X] you can [achieve Y]", "In the final analysis", "All things considered", "At the end of the day"
- BANNED PATTERNS: "Whether you're a [X], [Y], or [Z]...", "It's not just [X], it's also [Y]...", "Think of [X] as [elaborate metaphor]...", Starting sentences with "By" + gerund
- FILLER WORDS TO REMOVE: absolutely, basically, certainly, clearly, definitely, essentially, extremely, fundamentally, incredibly, naturally, obviously, quite, really, significantly, simply, surely, truly, ultimately, undoubtedly, very
- keyTakeaways FORMAT: JSON array of 4-5 plain strings only. Each element must be the takeaway sentence itself. Never use objects like {"takeaway":"..."} and never embed JSON inside a string for each bullet.

Return ONLY valid JSON:
{
  "title": "[CONCISE, ≤55 chars, no truncation] Punchy title with '${keyword.keyword}'",
  "metaDescription": "[MAX 155 CHARS] Description with '${keyword.keyword}'",
  "quickAnswer": "40-60 word direct answer for Featured Snippet Position 0 - START with the answer, not context",
  "definitionSnippet": "One clear sentence: '[Topic] is/refers to [definition]...' for AI citation and definition snippets",
  "keyFacts": [
    "Specific fact 1 with number/statistic that AI can cite",
    "Specific fact 2 with data point or research finding",
    "Specific fact 3 with expert consensus or study result"
  ],
  "keyTakeaways": ["5 key points, 15-25 words each"],
  "images": [
    ${categoryImageExamples}
  ],
  "introduction": "400+ words introducing ${context.categoryName} and this topic",
  "sections": [
    {"heading": "Natural H2 - explain how it works (DO NOT repeat full keyword - use short natural phrasing like 'How It Works' or 'How These [Product] Work')", "content": "500+ words"},
    {"heading": "Natural H2 - compare top options (e.g., 'Comparing the Top Options' or 'Side-by-Side Comparison')", "content": "500+ words"},
    {"heading": "Natural H2 - discuss pricing/value (e.g., 'Pricing and Value' or 'What You'll Pay')", "content": "500+ words"},
    {"heading": "Natural H2 - cover key benefits (e.g., 'Key Benefits and Features' or 'Why Cat Owners Love These')", "content": "500+ words"}
  ],
  "faqs": [
    ${categoryFaqExamples}
  ],
  "conclusion": "300+ words summarizing key points with call to action",
  "externalLinks": [
    ${categoryExternalLinkExamples}
  ],
  "internalLinks": [
    {"url": "/cat-carriers-travel-products/expandable-cat-carrier", "anchorText": "expandable cat carriers", "context": "For travel, consider expandable cat carriers that provide extra space."},
    {"url": "/cat-dna-testing/best-cat-dna-test", "anchorText": "cat DNA testing", "context": "Understanding your cat's breed through cat DNA testing helps choose the right products."},
    {"url": "/cat-trees-furniture/modern-cat-tree", "anchorText": "modern cat furniture", "context": "Pair your purchase with modern cat furniture for complete home setup."},
    {"url": "/cat-boarding/luxury-cat-boarding", "anchorText": "luxury cat boarding", "context": "When traveling without your cat, luxury cat boarding ensures their comfort."}
  ],
  "wordCount": ${serpAnalysis.targetWordCount}
}

PROGRAMMATIC SEO QUALITY GATES (MANDATORY):
- Every page MUST provide unique value specific to this keyword, not just swapped variables
- Proprietary data and original analysis wins over generic public information
- Match genuine search intent: the page must actually answer what people are searching for
- No thin content: better to have one great comprehensive article than five shallow ones
- Quality over quantity: every section must add genuine value, not just fill space`;

    // 7. Generate with Cloudflare AI (FREE - keeps Copilot for discovery/keywords only)
    currentStep = '5/12: AI Generation';
    updateSessionStage(keyword.keyword, '5/12: AI Generation');
    console.log(`[SEO-V3] [Step 5/12] Building prompt (${prompt.length} chars)...`);
    console.log(`[SEO-V3] [Step 5/12] Calling Claude Agent SDK for "${keyword.keyword}"...`);
    addActivityLog('generating', `[Step 5/12] Calling Claude Agent SDK (prompt: ${prompt.length} chars)...`, { keyword: keyword.keyword, step: '5/12', promptChars: prompt.length });
    let response = '';
    let aiModelUsed = 'unknown';
    const maxAiAttempts = 2;
    const aiStartTime = Date.now();
    let claudeFailed = false;
    for (let aiAttempt = 1; aiAttempt <= maxAiAttempts; aiAttempt++) {
      const attemptPrompt = aiAttempt === 1 ? prompt : `IMPORTANT: You MUST respond with ONLY a valid JSON object starting with { and ending with }. No explanations, no markdown, no text before or after the JSON. Just the raw JSON object.\n\n${prompt}`;
      if (aiAttempt > 1) {
        addActivityLog('info', `[Step 5/12] Retry ${aiAttempt}/${maxAiAttempts} — forcing JSON output`, { keyword: keyword.keyword, step: '5/12', attempt: aiAttempt });
      }
      try {
        const aiResult = await generateWithClaudeAgentSdk(attemptPrompt, { maxTokens: 16000 });
        if (!aiResult || !aiResult.content) {
          if (aiAttempt === maxAiAttempts) { claudeFailed = true; break; }
          console.log(`[SEO-V3] ⚠️ AI attempt ${aiAttempt}/${maxAiAttempts} returned empty, retrying...`);
          addActivityLog('info', `[Step 5/12] Attempt ${aiAttempt} returned empty, retrying...`, { keyword: keyword.keyword, step: '5/12', attempt: aiAttempt });
          continue;
        }
        response = aiResult.content;
        aiModelUsed = aiResult.model || 'unknown';
        if (!response.includes('{')) {
          if (aiAttempt === maxAiAttempts) break;
          console.log(`[SEO-V3] ⚠️ AI attempt ${aiAttempt}/${maxAiAttempts} returned no JSON (${response.length} chars text), retrying with JSON-forcing prompt...`);
          addActivityLog('info', `[Step 5/12] Attempt ${aiAttempt} returned ${response.length} chars but no JSON, retrying...`, { keyword: keyword.keyword, step: '5/12', attempt: aiAttempt, chars: response.length });
          continue;
        }
        break;
      } catch (claudeErr: any) {
        console.log(`[SEO-V3] ⚠️ Claude attempt ${aiAttempt} threw: ${claudeErr.message}`);
        if (aiAttempt === maxAiAttempts) { claudeFailed = true; }
      }
    }
    // Fallback to OpenRouter if Claude quota exhausted or failed
    if (claudeFailed || !response.includes('{')) {
      console.log(`[SEO-V3] 🔄 [Step 5/12] Claude failed — falling back to OpenRouter for article generation...`);
      addActivityLog('info', `[Step 5/12] Claude quota exhausted — trying OpenRouter fallback`, { keyword: keyword.keyword, step: '5/12' });
      try {
        const jsonPrompt = `IMPORTANT: You MUST respond with ONLY a valid JSON object. No markdown, no explanations, no text before or after the JSON.\n\n${prompt}`;
        response = await generateWithOpenRouter(jsonPrompt, 300000);
        aiModelUsed = 'openrouter/free';
        if (response.includes('<think>')) {
          response = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        }
        console.log(`[SEO-V3] ✅ [Step 5/12] OpenRouter fallback succeeded (${response.length} chars)`);
        addActivityLog('info', `[Step 5/12] OpenRouter fallback succeeded (${response.length} chars)`, { keyword: keyword.keyword, step: '5/12', model: 'openrouter/free' });
      } catch (orErr: any) {
        throw new Error(`Claude Agent SDK and OpenRouter both failed: ${orErr.message}`);
      }
    }
    const aiDuration = ((Date.now() - aiStartTime) / 1000).toFixed(1);
    console.log(`[SEO-V3] [Step 5/12] ✓ AI response received via ${aiModelUsed} (${response.length} chars, ${aiDuration}s)`);
    addActivityLog('info', `[Step 5/12] AI response received via ${aiModelUsed} (${response.length} chars, ${aiDuration}s)`, { keyword: keyword.keyword, model: aiModelUsed, chars: response.length, durationSec: aiDuration, step: '5/12' });

    // 8. Parse JSON response — simple extraction (Claude returns clean JSON)
    currentStep = '5b/12: JSON Parsing';
    updateSessionStage(keyword.keyword, '5b/12: JSON Parsing');
    addActivityLog('info', `[Step 5b/12] Parsing JSON from ${response.length} char response...`, { keyword: keyword.keyword, step: '5b/12', responseChars: response.length });
    let article: ArticleData;
    {
      let raw = response;

      // Strip markdown code fences if present: ```json ... ``` or ``` ... ```
      const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (fenceMatch) {
        raw = fenceMatch[1].trim();
        console.log(`[SEO-V3] [Step 5b/12] Stripped markdown fences`);
      }

      // Extract JSON object from first { to last }
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        addActivityLog('error', `[Step 5b/12] No valid JSON block found in response`, { keyword: keyword.keyword, step: '5b/12' });
        throw new Error('No article JSON in response — no valid {...} block found');
      }

      const jsonStr = raw.substring(firstBrace, lastBrace + 1);
      if (!jsonStr.includes('"title"')) {
        addActivityLog('error', `[Step 5b/12] JSON block missing "title" field`, { keyword: keyword.keyword, step: '5b/12', jsonChars: jsonStr.length });
        throw new Error('No article JSON in response — missing "title" field');
      }

      try {
        article = JSON.parse(jsonStr) as ArticleData;
        const sectionCount = article.sections?.length || 0;
        const faqCount = article.faqs?.length || 0;
        const wordCount = article.wordCount || 0;
        addActivityLog('info', `[Step 5b/12] JSON parsed — "${article.title}" (${sectionCount} sections, ${faqCount} FAQs, ~${wordCount} words)`, { keyword: keyword.keyword, step: '5b/12', title: article.title, sections: sectionCount, faqs: faqCount, wordCount });
      } catch (parseErr: any) {
        console.log(`[SEO-V3] JSON.parse failed: ${parseErr.message}, attempting json-repair...`);
        try {
          const repaired = repairJson(jsonStr, { returnObjects: false }) as string;
          article = JSON.parse(repaired) as ArticleData;
          const sectionCount = article.sections?.length || 0;
          const faqCount = article.faqs?.length || 0;
          const wordCount = article.wordCount || 0;
          histJsonRepaired = true;
          console.log(`[SEO-V3] ✅ json-repair recovered article: "${article.title}" (${sectionCount} sections, ${faqCount} FAQs, ~${wordCount} words)`);
          addActivityLog('info', `[Step 5b/12] JSON repaired & parsed — "${article.title}" (${sectionCount} sections, ${faqCount} FAQs, ~${wordCount} words)`, { keyword: keyword.keyword, step: '5b/12', title: article.title, sections: sectionCount, faqs: faqCount, wordCount, repaired: true });
        } catch (repairErr: any) {
          console.error(`[SEO-V3] json-repair also failed: ${repairErr.message}`);
          console.error(`[SEO-V3] First 300 chars:`, jsonStr.substring(0, 300));
          console.error(`[SEO-V3] Last 300 chars:`, jsonStr.substring(jsonStr.length - 300));
          addActivityLog('error', `[Step 5b/12] JSON parse failed (repair also failed): ${parseErr.message}`, { keyword: keyword.keyword, step: '5b/12', error: parseErr.message });
          throw new Error(`Failed to parse article JSON from Claude: ${parseErr.message}`);
        }
      }
    }

    // 5c/12: Output quality validation + optional one-shot LLM repair (before Harper)
    // Normalize any array/non-string fields that free models may return
    (article.sections || []).forEach((s: any) => {
      if (Array.isArray(s.content)) s.content = s.content.join('\n');
      else if (s.content !== null && typeof s.content !== 'string') s.content = String(s.content);
    });
    (article.faqs || []).forEach((f: any) => {
      if (Array.isArray(f.answer)) f.answer = f.answer.join('\n');
      else if (f.answer !== null && typeof f.answer !== 'string') f.answer = String(f.answer);
    });
    if (Array.isArray(article.introduction)) article.introduction = (article.introduction as any[]).join('\n');
    if (Array.isArray(article.conclusion)) article.conclusion = (article.conclusion as any[]).join('\n');
    normalizeKeyTakeawaysArray(article);
    // Ensure comparisonTable.rows is an array
    if (article.comparisonTable && !Array.isArray(article.comparisonTable.rows)) {
      article.comparisonTable.rows = [];
    }

    currentStep = '5c/12: Output Quality Validation';
    updateSessionStage(keyword.keyword, '5c/12: Output Quality Validation');
    {
      const quality = validateArticleOutputQuality(article);
      if (quality.ok) {
        addActivityLog('info', `[Step 5c/12] Output quality checks passed`, { keyword: keyword.keyword, step: '5c/12' });
      } else {
        const issueSummary = quality.issues.slice(0, 12).join('; ');
        console.warn(`[SEO-V3] [Step 5c/12] Output quality issues (${quality.issues.length}): ${issueSummary}`);
        addActivityLog('warning', `[Step 5c/12] Output quality issues (${quality.issues.length}): ${issueSummary}`, {
          keyword: keyword.keyword,
          step: '5c/12',
          issueCount: quality.issues.length,
          issues: quality.issues.slice(0, 20),
        });
        const repaired = await repairArticleJsonWithIssues(article, quality.issues, keyword.keyword);
        if (repaired) {
          histQualityRepairUsed = true;
          const recheck = validateArticleOutputQuality(repaired);
          article = repaired;
          if (recheck.ok) {
            console.log(`[SEO-V3] [Step 5c/12] Repair pass fixed all issues`);
            addActivityLog('info', `[Step 5c/12] Repair pass succeeded — all quality checks pass`, { keyword: keyword.keyword, step: '5c/12' });
          } else {
            console.warn(`[SEO-V3] [Step 5c/12] Repair pass applied; remaining issues: ${recheck.issues.join('; ')}`);
            addActivityLog('warning', `[Step 5c/12] Repair pass applied; ${recheck.issues.length} issue(s) remain`, {
              keyword: keyword.keyword,
              step: '5c/12',
              remaining: recheck.issues.slice(0, 15),
            });
          }
        } else {
          console.warn(`[SEO-V3] [Step 5c/12] Repair pass failed; continuing with original article`);
          addActivityLog('warning', `[Step 5c/12] Repair pass failed; continuing with original`, { keyword: keyword.keyword, step: '5c/12' });
        }
      }
    }

    currentStep = '6/12: Grammar & Quality Check';
    updateSessionStage(keyword.keyword, '6/12: Grammar & Quality Check');
    addActivityLog('info', `[Step 6/12] Running grammar check (Harper) & content normalization...`, { keyword: keyword.keyword, step: '6/12' });
    article = await grammarCheckArticle(article);  // Harper runs first on plain text
    article = normalizeArticleContent(article, { topicKeyword: keyword.keyword });     // Then wrap in <p> tags
    addActivityLog('info', `[Step 6/12] Grammar check & content normalization complete`, { keyword: keyword.keyword, step: '6/12' });

    if (!article.title) {
      throw new Error('Invalid article JSON - missing title');
    }

    // 8b. Product grounding validation — ensure article discusses real products, not hallucinated ones
    if (productNamesList.length > 0) {
      const articleText = [
        article.title || '',
        article.metaDescription || '',
        ...(article.sections || []).map((s: any) => `${s.heading || ''} ${s.content || ''}`),
        ...(article.faqs || []).map((f: any) => `${f.question || ''} ${f.answer || ''}`)
      ].join(' ').toLowerCase();

      const mentionedProducts = productNamesList.filter(name => {
        const words = name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const significantWords = words.slice(0, 3);
        return significantWords.some(word => articleText.includes(word));
      });

      if (mentionedProducts.length === 0) {
        console.error(`[SEO-V3] ❌ SKIPPED at [Step 8b]: "${keyword.keyword}" - PRODUCT HALLUCINATION: Article mentions NONE of the ${productNamesList.length} real Amazon products`);
        console.error(`[SEO-V3] ❌ Expected products: ${productNamesList.map(n => `"${n}"`).join(', ')}`);
        addActivityLog('error',
          `[Step 8b] SKIPPED — Product hallucination detected. Article mentions 0/${productNamesList.length} real Amazon products. Skipping to avoid publishing incoherent content.`,
          { keyword: keyword.keyword, expectedProducts: productNamesList, reason: 'product-hallucination' });
        return false;
      } else {
        console.log(`[SEO-V3] ✓ Product grounding: ${mentionedProducts.length}/${productNamesList.length} real products mentioned in article body`);
      }
    }

    // 9. Enforce SEO limits - truncate title and meta description
    const seoLimits = enforceSEOLimits(article);
    article.title = seoLimits.title;
    article.metaDescription = seoLimits.metaDescription;

    // 9.5 COMPARISON TABLE: Real Amazon data ALWAYS wins over AI-generated tables
    // AI hallucinates product names, prices, and ratings — use verified data instead
    if (amazonProducts.products.length > 0) {
      article.comparisonTable = {
        headers: ['Product Name', 'Price', 'Key Features', 'Rating', 'Amazon Search'],
        rows: amazonProducts.comparisonRows
      };
      console.log(`[SEO-V3] ✓ Comparison table: ${amazonProducts.products.length} REAL Amazon products (overriding AI)`);
    } else if (!article.comparisonTable || !article.comparisonTable.rows?.length) {
      const categorySlugForTable = context.categorySlug || context.niche?.replace(/\s+/g, '-').toLowerCase() || 'DEFAULT';
      const fallbackTable = buildFallbackComparisonTable(categorySlugForTable, keyword.keyword);
      article.comparisonTable = fallbackTable;
      console.log(`[SEO-V3] ✓ Comparison table from category fallback (${fallbackTable.rows.length} products for ${categorySlugForTable})`);
    }

    // 7/12. Search for relevant YouTube video using 5-level funnel
    currentStep = '7/12: YouTube Video Search';
    updateSessionStage(keyword.keyword, '7/12: YouTube Video Search');
    let video: YouTubeVideo | undefined;
    try {
      const categorySlugForVideo = context.categorySlug || context.niche?.replace(/\s+/g, '-').toLowerCase() || 'cat-content';
      console.log(`[SEO-V3] [Step 7/12] Starting video funnel for category: ${categorySlugForVideo}`);

      const funnelResult = await searchVideoFunnel(keyword.keyword, categorySlugForVideo);

      if (funnelResult.video) {
        video = funnelResult.video;
        histVideoData = { found: true, title: video.title, channel: video.channel, funnelLevel: funnelResult.level };
        const levelDesc = funnelResult.fallbackUsed ? 'funny cat fallback' : `level ${funnelResult.level}`;
        console.log(`[SEO-V3] [Step 7/12] ✓ Video found (${levelDesc}): "${video.title}" by ${video.channel}`);
        addActivityLog('info', `[Step 7/12] YouTube video found: "${video.title}" by ${video.channel}`, { keyword: keyword.keyword, step: '7/12' });
      } else {
        console.log(`[SEO-V3] [Step 7/12] ⚠️ No video found after all funnel levels`);
        addActivityLog('info', `[Step 7/12] YouTube video search — no match found`, { keyword: keyword.keyword, step: '7/12' });
      }
    } catch (err: any) {
      console.log(`[SEO-V3] [Step 7/12] ⚠️ Video funnel error: ${err.message}`);
      addActivityLog('info', `[Step 7/12] YouTube video search skipped`, { keyword: keyword.keyword, step: '7/12' });
    }

    // 8/12. Generate AI images for article sections (using FLUX.1 schnell)
    currentStep = '8/12: AI Image Generation';
    updateSessionStage(keyword.keyword, '8/12: AI Image Generation');
    let generatedImages: GeneratedImage[] = [];
    try {
      // Sanitize category slug: remove special chars like & to match URL path format
      const rawCategory = context.categorySlug || context.niche || 'cat-content';
      const categorySlug = rawCategory.toLowerCase()
        .replace(/&amp;/g, '')  // Remove HTML entities
        .replace(/&/g, '')      // Remove raw ampersands
        .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
        .replace(/(^-|-$)/g, '')  // Trim leading/trailing hyphens
        .replace(/-+/g, '-');     // Collapse multiple hyphens
      // Wrap addActivityLog to accept string type
      const logWrapper = (level: string, message: string, data?: any) => {
        const validTypes = ['info', 'success', 'error', 'generating', 'deployed', 'queue', 'warning'];
        const type = validTypes.includes(level) ? level as ActivityLogEntry['type'] : 'info';
        addActivityLog(type, `[Step 8/12] ${message}`, data);
      };
      const imageResult = await generateArticleImages(
        categorySlug,
        slug,
        keyword.keyword,
        article.title,
        article.sections || [],
        logWrapper
      );

      if (imageResult.success) {
        generatedImages = imageResult.images;
        histImageResult = { count: generatedImages.length, neuronsCost: imageResult.neuronsCost, timingMs: imageResult.timing?.totalMs || 0 };
        console.log(`[SEO-V3] [Step 8/12] 🖼️ Generated ${generatedImages.length} AI images (${imageResult.neuronsCost} neurons)`);
        addActivityLog('info', `[Step 8/12] AI images generated (${generatedImages.length} images, ${imageResult.neuronsCost} neurons)`, { keyword: keyword.keyword, step: '8/12', imageCount: generatedImages.length });
      } else if (imageResult.errors.length > 0) {
        console.log(`[SEO-V3] [Step 8/12] ⚠️ Image generation issues: ${imageResult.errors.join(', ')}`);
        addActivityLog('warning', `[Step 8/12] AI image generation partial: ${imageResult.errors.length} errors`, { keyword: keyword.keyword, step: '8/12' });
      }
    } catch (err: any) {
      // Image generation is optional - fallback to Unsplash URLs in article.images
      console.log(`[SEO-V3] [Step 8/12] ⚠️ AI image generation skipped: ${err.message}`);
      addActivityLog('info', `[Step 8/12] AI image generation skipped`, { keyword: keyword.keyword, step: '8/12' });
    }

    // 9/12. Build full HTML with schema markup + calculate SEO score
    currentStep = '9/12: HTML Build + SEO Score';
    updateSessionStage(keyword.keyword, '9/12: HTML Build + SEO Score');
    const html = buildArticleHtml(article, slug, keyword.keyword, context, video, generatedImages, amazonProducts);
    const seoScore = await calculateSEOScore(html, keyword.keyword, article.title, article.metaDescription, serpAnalysis.targetWordCount);
    console.log(`[SEO-V3] [Step 9/12] 📊 HTML built, SEO Score: ${seoScore.score}/100`);
    addActivityLog('info', `[Step 9/12] HTML built + SEO score: ${seoScore.score}/100`, {
      keyword: keyword.keyword,
      step: '9/12',
      seoScore: seoScore.score,
      preDeployBreakdown: seoScore.breakdown
    });

    // Quality gate - skip deployment for low-quality articles (below 60/100)
    const MIN_SEO_SCORE = 60;
    if (seoScore.score < MIN_SEO_SCORE) {
      console.log(`[SEO-V3] ⚠️ Skipping deployment - SEO score ${seoScore.score} below minimum ${MIN_SEO_SCORE}`);
      addActivityLog('warning', `Quality gate failed: SEO score ${seoScore.score}/100 (minimum ${MIN_SEO_SCORE})`, {
        keyword: keyword.keyword,
        seoScore: seoScore.score,
        reason: 'Below minimum quality threshold'
      });
      return false;
    }

    // 10/12. Deploy to Cloudflare KV (only if SEO score passes threshold)
    currentStep = '10/12: Deploy to Cloudflare KV';
    updateSessionStage(keyword.keyword, '10/12: Deploy to Cloudflare KV');
    console.log(`[SEO-V3] [Step 10/12] Deploying to Cloudflare KV...`);
    const derivedSlugForKv = context?.categorySlug || 'v3-articles';
    const safeKvPrefix = context?.kvPrefix || `${derivedSlugForKv}:`;
    const kvKey = `${safeKvPrefix}${slug}`;
    const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
    if (!cfApiToken) {
      console.error(`[SEO-V3] ❌ SKIPPED at [Step 10/12]: No Cloudflare API token — cannot deploy article.`);
      addActivityLog('error',
        `[Step 10/12] SKIPPED — No Cloudflare API token configured. Cannot deploy article to KV. Check CLOUDFLARE_API_TOKEN in Doppler/env.`,
        { keyword: keyword.keyword, step: '10/12', reason: 'no-cloudflare-token' });
      return false;
    }
    {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(kvKey)}`;
      const kvResponse = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
        body: html
      });
      if (!kvResponse.ok) {
        const errBody = await kvResponse.text().catch(() => 'no body');
        console.error(`[SEO-V3] ❌ SKIPPED at [Step 10/12]: KV PUT failed — ${kvResponse.status} ${kvResponse.statusText}: ${errBody}`);
        addActivityLog('error',
          `[Step 10/12] SKIPPED — Cloudflare KV deploy failed (HTTP ${kvResponse.status}). Article was NOT published.`,
          { keyword: keyword.keyword, step: '10/12', status: kvResponse.status, reason: 'kv-deploy-failed' });
        return false;
      }
      console.log(`[SEO-V3] [Step 10/12] ✓ Deployed: ${kvKey}`);

      const v3Category = safeKvPrefix.replace(':', '').replace(/-/g, '-') || 'cat-trees-condos';
      registerArticleForLinking(slug, v3Category);

      const articleUrl = `https://${context.domain}${context.basePath}/${slug}`;

      addActivityLog('deployed', `[Step 10/12] Deployed to Cloudflare KV`, {
        keyword: keyword.keyword,
        slug: slug,
        seoScore: seoScore.score,
        url: articleUrl,
        step: '10/12'
      });

      // 11/12. IndexNow instant indexing + URL verification
      currentStep = '11/12: IndexNow + URL Verification';
      updateSessionStage(keyword.keyword, '11/12: IndexNow + Verify');
      console.log(`[SEO-V3] [Step 11/12] Submitting to IndexNow & verifying URL...`);

      // Notify IndexNow for instant indexing
      notifyIndexNow(articleUrl);
      addActivityLog('info', `[Step 11/12] IndexNow submitted for instant indexing`, {
        keyword: keyword.keyword,
        url: articleUrl,
        step: '11/12'
      });

      // POST-DEPLOY VERIFICATION: Confirm article is accessible (no 404)
      const verifyDomain = context?.domain || 'catsluvus.com';
      const verifyBasePath = context?.basePath || '/cat-dna-testing';
      const verifyUrl = `https://${verifyDomain}${verifyBasePath}/${slug}`;
      let verificationPassed = false;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (!verificationPassed && retryCount < maxRetries) {
        // Wait 2 seconds for KV propagation before checking
        await new Promise(r => setTimeout(r, 2000));
        
        try {
          const verifyResponse = await fetch(verifyUrl, { 
            method: 'HEAD',
            headers: { 'User-Agent': 'SEO-V3-Verification-Bot/1.0' }
          });
          
          if (verifyResponse.status === 200) {
            console.log(`[SEO-V3] ✓ URL Verified: ${verifyUrl} (HTTP ${verifyResponse.status})`);
            verificationPassed = true;
          } else if (verifyResponse.status === 404) {
            retryCount++;
            console.log(`[SEO-V3] ⚠️ 404 detected for ${verifyUrl} - retry ${retryCount}/${maxRetries}`);
            
            if (retryCount < maxRetries) {
              // Re-deploy to KV
              console.log(`[SEO-V3] Re-deploying to KV...`);
              await fetch(url, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
                body: html
              });
            }
          } else {
            console.log(`[SEO-V3] ⚠️ Unexpected status ${verifyResponse.status} for ${verifyUrl}`);
            verificationPassed = true; // Don't retry on non-404 errors
          }
        } catch (verifyError: any) {
          console.log(`[SEO-V3] ⚠️ Verification fetch failed: ${verifyError.message}`);
          retryCount++;
        }
      }
      
      histVerificationPassed = verificationPassed;
      if (verificationPassed) {
        console.log(`[SEO-V3] [Step 11/12] ✓ URL verified accessible`);
        addActivityLog('success', `[Step 11/12] URL verified accessible`, { keyword: keyword.keyword, url: verifyUrl, step: '11/12' });
      } else {
        console.error(`[SEO-V3] [Step 11/12] ❌ URL verification FAILED after ${maxRetries} retries: ${verifyUrl}`);
        addActivityLog('error', `[Step 11/12] URL still 404 after ${maxRetries} retries: ${slug}`, {
          url: verifyUrl,
          kvKey: kvKey,
          retries: maxRetries,
          step: '11/12'
        });
      }
    }

    // 12/12. Update V3 sitemap
    currentStep = '12/12: Updating Sitemap';
    updateSessionStage(keyword.keyword, '12/12: Updating Sitemap');
    console.log(`[SEO-V3] [Step 12/12] Updating sitemap...`);
    await updateSitemap(slug, context);
    console.log(`[SEO-V3] [Step 12/12] ✓ Sitemap updated`);
    addActivityLog('info', `[Step 12/12] Sitemap updated`, { keyword: keyword.keyword, slug: slug, step: '12/12' });

    const safeDomain = context?.domain || 'catsluvus.com';
    const derivedSlugForUrl = context?.categorySlug || 'v3-articles';
    const safeBasePath = context?.basePath || `/${derivedSlugForUrl}`;
    const safeKvPrefixForOptimize = context?.kvPrefix || `${derivedSlugForUrl}:`;
    const articleUrl = `https://${safeDomain}${safeBasePath}/${slug}`;

    // 13/12. Post-publish QC: Gobii browser task + live on-page score (blocks until done or failure)
    currentStep = '13/12: Post-publish QC';
    updateSessionStage(keyword.keyword, '13/12: Post-publish QC');
    const qcOutcome = await runPostPublishQualityControl({
      articleUrl,
      keyword: keyword.keyword,
      slug,
      preDeploy: seoScore,
      addActivityLog: (type, message, details) => addActivityLog(type, message, details)
    });
    if (!qcOutcome.ok) {
      console.error(`[SEO-V3] ❌ Post-publish QC failed: ${qcOutcome.reason || 'unknown'}`);
      return false;
    }

    // Post-pipeline: Queue PageSpeed analysis with rate limiting (90s min interval, exponential backoff for 429s)
    queuePageSpeedCheck({
      url: articleUrl,
      strategy: 'mobile',
      articleSlug: slug,
      originalHtml: html,
      kvKey: `${safeKvPrefixForOptimize}${slug}`,
      context: context
    });

    console.log(`[SEO-V3] ✅ SUCCESS: "${article.title}" | Model: ${aiModelUsed} | SEO: ${seoScore.score}/100 | URL: ${articleUrl}`);
    addActivityLog('success', `Generated: ${article.title} | Model: ${aiModelUsed} | SEO: ${seoScore.score}/100`, {
      keyword: keyword.keyword,
      slug: slug,
      url: articleUrl,
      seoScore: seoScore.score,
      model: aiModelUsed
    });

    // Update session health with actual SEO score
    sessionHealth.totalSeoScore += seoScore.score;
    sessionHealth.seoScoreCount++;

    // Persist structured generation record
    try {
      const genRecord: GenerationRecord = {
        id: slug,
        keyword: keyword.keyword,
        slug,
        category: context.categorySlug || context.kvPrefix?.replace(/:$/, '') || 'unknown',
        url: articleUrl,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - genStartTime,
        model: aiModelUsed,
        seoScore: seoScore.score,
        wordCount: article.wordCount || 0,
        sectionCount: article.sections?.length || 0,
        faqCount: article.faqs?.length || 0,
        serp: {
          competitorsAnalyzed: serpAnalysis.topResults.length,
          avgWordCount: serpAnalysis.targetWordCount || 0,
          topicsFound: serpAnalysis.commonTopics || [],
          contentGaps: serpAnalysis.contentGaps || [],
        },
        amazon: {
          productCount: amazonProducts.products.length,
          products: amazonProducts.products.slice(0, 5).map((p: any) => ({
            asin: p.asin || '',
            name: p.name || p.title || '',
            price: p.price || '',
            rating: p.rating || '',
          })),
        },
        images: histImageResult,
        grammarFixes: getLastGrammarFixCount(),
        jsonRepaired: histJsonRepaired,
        qualityRepairUsed: histQualityRepairUsed,
        video: histVideoData,
        indexNowSubmitted: true,
        deployment: {
          kvKey,
          verified: histVerificationPassed,
        },
        pageSpeed: null,
        internalLinks: {
          total: article.internalLinks?.length || 0,
        },
        buildVersion: process.env.npm_package_version || new Date().toISOString().slice(0, 10),
      };
      saveGenerationRecord(genRecord);
    } catch (histErr: any) {
      console.error(`[GenerationHistory] Failed to save record: ${histErr.message}`);
    }

    return true;
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ FAILED at [${currentStep}]: "${keyword.keyword}" - ${error.message}`);
    console.error(`[SEO-V3] Stack:`, error.stack?.split('\n').slice(0, 5).join('\n'));
    addActivityLog('error', `[V3] Generation failed: ${keyword.keyword}`, { error: error.message, step: currentStep });

    // Persist failure to file so it survives activity log rotation
    try {
      const fs = await import('fs');
      const failureEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        keyword: keyword.keyword,
        slug: keyword.slug,
        step: currentStep,
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join(' | ')
      }) + '\n';
      fs.appendFileSync('/tmp/v3-failures.log', failureEntry);
    } catch (_) { /* ignore logging errors */ }

    // Persist structured error record
    try {
      const retryable = ['5/12: AI Generation', '5b/12: JSON Parsing', '4/12: Amazon Products'].some(s => currentStep.includes(s));
      saveErrorRecord({
        keyword: keyword.keyword,
        category: context.categorySlug || context.kvPrefix?.replace(/:$/, '') || 'unknown',
        timestamp: new Date().toISOString(),
        step: currentStep,
        error: error.message,
        retryable,
        details: { stack: error.stack?.split('\n').slice(0, 3).join(' | '), durationMs: Date.now() - genStartTime },
      });
    } catch (_) { /* ignore logging errors */ }

    return false;
  }
}

async function getAllCategoryStatusKeys(): Promise<string[]> {
  // Dynamic KV query - no hardcoded categories
  // See .github/skills/category-discovery/SKILL.md for discovery standards
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${CATEGORY_STATUS_PREFIX}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.result || []).map((key: any) => key.name.replace(CATEGORY_STATUS_PREFIX, ''));
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Failed to list category status keys: ${error.message}`);
    return [];
  }
}

async function runV3AutonomousGeneration() {
  if (!v3CategoryContext) {
    console.log('[SEO-V3] 🔍 No active context - checking for in-progress categories...');
    
    // Step 1: Dynamically query KV for all category statuses (no hardcoded list)
    const allCategories = await getAllCategoryStatusKeys();
    
    let foundInProgress: string | null = null;
    console.log(`[SEO-V3] Found ${allCategories.length} categories in KV to check...`);
    
    for (const cat of allCategories) {
      try {
        const status = await getCategoryStatus(cat);
        console.log(`[SEO-V3] Category ${cat}: status=${status?.status || 'not found'}`);
        if (status && status.status === 'in_progress') {
          foundInProgress = cat;
          console.log(`[SEO-V3] ✅ Found in-progress category: ${cat}`);
          break;
        }
      } catch (err: any) {
        console.log(`[SEO-V3] ⚠️ Error checking ${cat}: ${err.message}`);
      }
    }
    
    console.log(`[SEO-V3] Category check complete. Found in-progress: ${foundInProgress || 'none'}`)
    
    if (foundInProgress) {
      // Load context for in-progress category
      console.log(`[SEO-V3] Loading context for: ${foundInProgress}:`);
      const saved = await loadResearchFromKV(`${foundInProgress}:`);
      if (saved.categoryContext && saved.categoryContext.keywords?.length > 0) {
        const pendingCount = saved.categoryContext.keywords.filter(k => k.status === 'pending').length;
        console.log(`[SEO-V3] ✅ Loaded ${saved.categoryContext.niche}: ${pendingCount}/${saved.categoryContext.keywords.length} pending`);
        v3CategoryContext = saved.categoryContext;
        
        // CRITICAL FIX: Sync categoryName with niche to fix breadcrumbs
        if (v3CategoryContext.niche && v3CategoryContext.categoryName !== v3CategoryContext.niche) {
          console.log(`[SEO-V3] 🔧 Syncing categoryName: "${v3CategoryContext.categoryName}" → "${v3CategoryContext.niche}"`);
          v3CategoryContext.categoryName = v3CategoryContext.niche;
        }
        
        // Ensure Worker Route
        await ensureWorkerRouteForCategory(foundInProgress);
      } else {
        // Category is in_progress in KV but has no saved context (keyword gen may have failed)
        // Regenerate keywords for this category instead of discovering a new one
        console.log(`[SEO-V3] ⚠️ No saved context for ${foundInProgress}, regenerating keywords...`);
        addActivityLog('info', `[V3] Recovering in-progress category: ${foundInProgress}`);

        const categoryName = foundInProgress.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const recovered: DiscoveredCategory = {
          name: categoryName,
          slug: foundInProgress,
          estimatedKeywords: 25,
          affiliatePotential: 'high',
          reasoning: 'Recovered in-progress category (context was lost)'
        };

        await ensureWorkerRouteForCategory(foundInProgress);

        let keywords = await generateCategoryKeywords(recovered);
        if (keywords.length < 5) {
          const baseName = categoryName.toLowerCase();
          const fallbackKeywords = [
            `best ${baseName}`, `top ${baseName} reviews`, `${baseName} buying guide`,
            `affordable ${baseName}`, `${baseName} for indoor cats`, `${baseName} for kittens`,
            `${baseName} comparison`, `luxury ${baseName}`, `${baseName} on amazon`,
            `how to choose ${baseName}`, `${baseName} for senior cats`, `${baseName} for multiple cats`,
            `${baseName} recommendations`, `${baseName} under 50 dollars`, `${baseName} for small spaces`,
            `diy ${baseName}`, `${baseName} pros and cons`, `${baseName} for anxious cats`,
            `most popular ${baseName}`, `${baseName} worth buying`
          ];
          keywords = [...new Set([...keywords, ...fallbackKeywords])];
        }

        v3CategoryContext = createEmptyCategoryContext(foundInProgress, 'catsluvus.com', `/${foundInProgress}`);
        v3CategoryContext.niche = categoryName;
        v3CategoryContext.categoryName = categoryName;
        v3CategoryContext.keywords = keywords.map((kw: string) => ({
          keyword: kw,
          slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          priority: 'medium' as any,
          score: 50,
          status: 'pending' as const,
          cpc: 0,
          volume: 0,
          difficulty: 0,
          intent: 'informational' as const
        }));

        await saveCategoryStatus(foundInProgress, {
          category: foundInProgress,
          status: 'in_progress',
          articleCount: 0,
          expectedCount: keywords.length,
          avgSeoScore: 0,
          startedAt: new Date().toISOString()
        });

        await saveResearchToKV({
          researchPhase: 'generation',
          selectedNiche: categoryName,
          keywords: v3CategoryContext.keywords,
          startedAt: v3CategoryContext.createdAt
        } as any, v3CategoryContext);

        console.log(`[SEO-V3] ✅ Recovered ${foundInProgress} with ${keywords.length} keywords`);
        addActivityLog('success', `[V3] Recovered category: ${categoryName} (${keywords.length} keywords)`);
      }
    }
    
    // Step 2: If no in-progress category, discover next one
    if (!foundInProgress || !v3CategoryContext) {
      console.log('[SEO-V3] 🔄 No in-progress category found - calling discoverNextCategory()...');
      addActivityLog('info', '[V3] Starting category discovery...');
      
      try {
        console.log('[SEO-V3] Calling discoverNextCategory()...');
        const nextCategory = await discoverNextCategory();
        console.log(`[SEO-V3] discoverNextCategory returned: ${JSON.stringify(nextCategory)}`);
        
        if (nextCategory) {
          console.log(`[SEO-V3] ✅ Discovered: ${nextCategory.name} (${nextCategory.slug})`);
          addActivityLog('info', `[V3] Discovered next category: ${nextCategory.name}`);

          // IMMEDIATELY save in_progress status to KV so retries find this category
          let kvSaved = await saveCategoryStatus(nextCategory.slug, {
            category: nextCategory.slug,
            status: 'in_progress',
            articleCount: 0,
            expectedCount: 0,
            avgSeoScore: 0,
            startedAt: new Date().toISOString()
          });
          if (!kvSaved) {
            // Retry once after 2s - this save is critical to prevent re-discovery loops
            console.log(`[SEO-V3] ⚠️ KV save failed for ${nextCategory.slug}, retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            kvSaved = await saveCategoryStatus(nextCategory.slug, {
              category: nextCategory.slug,
              status: 'in_progress',
              articleCount: 0,
              expectedCount: 0,
              avgSeoScore: 0,
              startedAt: new Date().toISOString()
            });
            if (!kvSaved) {
              console.error(`[SEO-V3] ❌ CRITICAL: Could not save ${nextCategory.slug} to KV after retry - will cause re-discovery loop!`);
            }
          }

          // Create Worker routes
          await ensureWorkerRouteForCategory(nextCategory.slug);

          // Generate keywords via Copilot CLI
          let keywords = await generateCategoryKeywords(nextCategory);
          console.log(`[SEO-V3] Copilot returned ${keywords.length} keywords for ${nextCategory.name}`);

          // Fallback: generate basic keywords from category name if Copilot fails
          if (keywords.length < 5) {
            console.log(`[SEO-V3] ⚠️ Copilot keywords insufficient (${keywords.length}), using fallback generator`);
            addActivityLog('warning', `[V3] Copilot returned only ${keywords.length} keywords, using fallback`);
            const baseName = nextCategory.name.toLowerCase();
            const fallbackKeywords = [
              `best ${baseName}`,
              `top ${baseName} reviews`,
              `${baseName} buying guide`,
              `affordable ${baseName}`,
              `${baseName} for indoor cats`,
              `${baseName} for kittens`,
              `${baseName} comparison`,
              `luxury ${baseName}`,
              `${baseName} on amazon`,
              `how to choose ${baseName}`,
              `${baseName} for senior cats`,
              `${baseName} for multiple cats`,
              `${baseName} recommendations`,
              `${baseName} under 50 dollars`,
              `${baseName} for small spaces`,
              `diy ${baseName}`,
              `${baseName} pros and cons`,
              `${baseName} for anxious cats`,
              `most popular ${baseName}`,
              `${baseName} worth buying`
            ];
            // Merge: keep any Copilot keywords + add fallbacks
            const merged = [...new Set([...keywords, ...fallbackKeywords])];
            keywords = merged;
            console.log(`[SEO-V3] ✓ Fallback: now have ${keywords.length} keywords total`);
          }

          // Create new v3CategoryContext
          v3CategoryContext = createEmptyCategoryContext(nextCategory.slug, 'catsluvus.com', `/${nextCategory.slug}`);
          v3CategoryContext.niche = nextCategory.name;
          v3CategoryContext.categoryName = nextCategory.name;
          v3CategoryContext.keywords = keywords.map((kw: string) => ({
            keyword: kw,
            slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            priority: 'medium' as any,
            score: 50,
            status: 'pending' as const,
            cpc: 0,
            volume: 0,
            difficulty: 0,
            intent: 'informational' as const
          }));

          // Update KV status with actual keyword count
          await saveCategoryStatus(nextCategory.slug, {
            category: nextCategory.slug,
            status: 'in_progress',
            articleCount: 0,
            expectedCount: keywords.length,
            avgSeoScore: 0,
            startedAt: new Date().toISOString()
          });

          // Save context to KV for persistence
          await saveResearchToKV({
            researchPhase: 'generation',
            selectedNiche: nextCategory.name,
            keywords: v3CategoryContext.keywords,
            startedAt: v3CategoryContext.createdAt
          } as any, v3CategoryContext);

          addActivityLog('success', `[V3] Started category: ${nextCategory.name} (${keywords.length} keywords)`);
          console.log(`[SEO-V3] 🚀 STARTING: ${nextCategory.name} with ${keywords.length} keywords`);
        } else {
          console.log('[SEO-V3] ⏳ No categories discovered - retrying in 2 minutes...');
          addActivityLog('info', '[V3] Discovery returned null - scheduling retry in 2 minutes');
          setTimeout(runV3AutonomousGeneration, 2 * 60 * 1000);
          return;
        }
      } catch (error: any) {
        console.error(`[SEO-V3] ❌ Discovery failed: ${error.message}`);
        addActivityLog('error', `[V3] Discovery failed: ${error.message}`);
        console.log('[SEO-V3] Will retry in 2 minutes...');
        setTimeout(runV3AutonomousGeneration, 2 * 60 * 1000);
        return;
      }
    }
  }

  const pendingKeywords = v3CategoryContext.keywords.filter(k => k.status === 'pending');
  const totalKeywords = v3CategoryContext.keywords.length;
  const completedKeywords = totalKeywords - pendingKeywords.length;
  const completionPct = ((completedKeywords / totalKeywords) * 100).toFixed(1);
  
  if (pendingKeywords.length === 0) {
    const currentNiche = v3CategoryContext.niche || v3CategoryContext.categorySlug || 'unknown';
    console.log(`[SEO-V3] ✅ Niche "${currentNiche}" 100% complete! (${totalKeywords} articles)`);
    addActivityLog('success', `[V3] Niche complete: ${currentNiche} (${totalKeywords} articles)`);

    // Mark niche as complete in KV to prevent re-discovery on restart
    await saveResearchToKV({ researchPhase: 'niche_complete', selectedNiche: currentNiche, keywords: v3CategoryContext.keywords, completedAt: new Date().toISOString() } as any, v3CategoryContext);

    // Also save to category status system
    await saveCategoryStatus(v3CategoryContext.categorySlug || keywordToSlug(currentNiche), {
      category: v3CategoryContext.categorySlug || keywordToSlug(currentNiche),
      status: 'completed',
      articleCount: totalKeywords,
      expectedCount: totalKeywords,
      avgSeoScore: 85,
      startedAt: v3CategoryContext.createdAt || new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    
    // V3 AUTONOMOUS: Discover and start next category via Copilot CLI
    if (v3AutonomousRunning) {
      addActivityLog('info', '[V3] Discovering next high-CPC category...');
      
      try {
        const nextCategory = await discoverNextCategory();
        
        if (nextCategory) {
          addActivityLog('info', `[V3] Found next category: ${nextCategory.name}`);

          // IMMEDIATELY save in_progress to KV so retries find this category
          let kvSaved2 = await saveCategoryStatus(nextCategory.slug, {
            category: nextCategory.slug,
            status: 'in_progress',
            articleCount: 0,
            expectedCount: 0,
            avgSeoScore: 0,
            startedAt: new Date().toISOString()
          });
          if (!kvSaved2) {
            console.log(`[SEO-V3] ⚠️ KV save failed for ${nextCategory.slug}, retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            kvSaved2 = await saveCategoryStatus(nextCategory.slug, {
              category: nextCategory.slug,
              status: 'in_progress',
              articleCount: 0,
              expectedCount: 0,
              avgSeoScore: 0,
              startedAt: new Date().toISOString()
            });
            if (!kvSaved2) {
              console.error(`[SEO-V3] ❌ CRITICAL: Could not save ${nextCategory.slug} to KV after retry`);
            }
          }

          // Create Worker routes for new category
          await ensureWorkerRouteForCategory(nextCategory.slug);

          // Generate keywords for new category
          let keywords = await generateCategoryKeywords(nextCategory);

          // Fallback keywords if Copilot fails
          if (keywords.length < 5) {
            addActivityLog('warning', `[V3] Copilot returned only ${keywords.length} keywords, using fallback`);
            const baseName = nextCategory.name.toLowerCase();
            const fallbackKeywords = [
              `best ${baseName}`, `top ${baseName} reviews`, `${baseName} buying guide`,
              `affordable ${baseName}`, `${baseName} for indoor cats`, `${baseName} for kittens`,
              `${baseName} comparison`, `luxury ${baseName}`, `${baseName} on amazon`,
              `how to choose ${baseName}`, `${baseName} for senior cats`, `${baseName} for multiple cats`,
              `${baseName} recommendations`, `${baseName} under 50 dollars`, `${baseName} for small spaces`,
              `diy ${baseName}`, `${baseName} pros and cons`, `${baseName} for anxious cats`,
              `most popular ${baseName}`, `${baseName} worth buying`
            ];
            keywords = [...new Set([...keywords, ...fallbackKeywords])];
          }

          // Create new v3CategoryContext
          v3CategoryContext = createEmptyCategoryContext(nextCategory.slug, 'catsluvus.com', `/${nextCategory.slug}`);
          v3CategoryContext.niche = nextCategory.name;
          v3CategoryContext.categoryName = nextCategory.name;
          v3CategoryContext.keywords = keywords.map((kw: string) => ({
            keyword: kw,
            slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            priority: 'medium' as any,
            score: 50,
            status: 'pending' as const,
            cpc: 0,
            volume: 0,
            difficulty: 0,
            intent: 'informational' as const
          }));

          // Update KV with keyword count
          await saveCategoryStatus(nextCategory.slug, {
            category: nextCategory.slug,
            status: 'in_progress',
            articleCount: 0,
            expectedCount: keywords.length,
            avgSeoScore: 0,
            startedAt: new Date().toISOString()
          });

          addActivityLog('success', `[V3] Started new category: ${nextCategory.name} (${keywords.length} keywords)`);

          // Continue autonomous generation with new category
          setImmediate(runV3AutonomousGeneration);
          return;
        } else {
          console.log('[SEO-V3] ⏳ Category discovery returned null - retrying in 2 minutes...');
          addActivityLog('info', '[V3] No categories found - scheduling retry in 2 minutes');
          setTimeout(runV3AutonomousGeneration, 2 * 60 * 1000);
          return;
        }
      } catch (error: any) {
        addActivityLog('error', `[V3] Category discovery failed: ${error.message}`);
        console.log('[SEO-V3] ⏳ Discovery error during transition - retrying in 2 minutes...');
        setTimeout(runV3AutonomousGeneration, 2 * 60 * 1000);
        return;
      }
    }

    // Clear context - no more work
    v3CategoryContext = null;
    return;
  }

  // Sort by priority: HIGH > MEDIUM > LOW, then by score (highest first)
  // Normalize priority to lowercase for consistent sorting
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedPending = [...pendingKeywords].sort((a, b) => {
    const aPriority = (a.priority || 'low').toLowerCase();
    const bPriority = (b.priority || 'low').toLowerCase();
    const priorityDiff = (priorityOrder[aPriority] ?? 2) - (priorityOrder[bPriority] ?? 2);
    if (priorityDiff !== 0) return priorityDiff;
    return (b.score || 0) - (a.score || 0);
  });

  const nextKeyword = sortedPending[0];
  console.log(`[SEO-V3] 📊 Niche Progress: ${completedKeywords}/${totalKeywords} (${completionPct}%) | Next: [${nextKeyword.priority?.toUpperCase()}] "${nextKeyword.keyword}"`);

  const articleStartTime = Date.now();
  const success = await generateV3Article(nextKeyword, v3CategoryContext);
  const articleDurationMs = Date.now() - articleStartTime;

  if (success) {
    recordSessionSuccess(true, articleDurationMs);
    nextKeyword.status = 'published';
  } else {
    recordSessionError(`Failed: "${nextKeyword.keyword}"`);
    const prevFailures = (nextKeyword as any)._failures || 0;
    (nextKeyword as any)._failures = prevFailures + 1;
    if (prevFailures >= 1) {
      nextKeyword.status = 'published';
      console.log(`[SEO-V3] ⚠️ "${nextKeyword.keyword}" failed ${prevFailures + 1} times, skipping permanently`);
    } else {
      nextKeyword.status = 'pending';
      nextKeyword.priority = 'low';
      console.log(`[SEO-V3] ♻️ "${nextKeyword.keyword}" failed, will retry later (attempt ${prevFailures + 1}/2)`);
    }
  }
  
  // Save progress to KV after each article (using 'in_progress' status to distinguish from complete)
  await saveResearchToKV({ researchPhase: 'generation_in_progress', selectedNiche: v3CategoryContext.niche, keywords: v3CategoryContext.keywords } as any, v3CategoryContext);

  // Continue with next article
  if (v3AutonomousRunning) {
    setImmediate(runV3AutonomousGeneration);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: V1 Pet Insurance generation runs independently in seo-generator.ts
// V3 handles dynamic category discovery with Cloudflare AI generation
// V3's own auto-start is below (v3AutonomousRunning with 15s delay)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// FREE PAGESPEED INSIGHTS API (No API key required for basic usage)
// ═══════════════════════════════════════════════════════════════════════════

// PageSpeedResult interface is defined at the top of the file

async function analyzePageSpeed(url: string, strategy: 'mobile' | 'desktop' = 'mobile'): Promise<PageSpeedResult> {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  const keyParam = googleApiKey ? `&key=${googleApiKey}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices${keyParam}`;
  
  console.log(`[PageSpeed] Analyzing ${url} (${strategy})${googleApiKey ? ' [with API key]' : ' [no API key]'}...`);
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`PageSpeed API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const lighthouse = data.lighthouseResult;
  
  if (!lighthouse) {
    throw new Error('No Lighthouse results in response');
  }
  
  const opportunities: PageSpeedResult['opportunities'] = [];
  const opportunityAudits = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'offscreen-images',
    'efficient-animated-content',
    'duplicated-javascript',
    'legacy-javascript',
    'unminified-css',
    'unminified-javascript'
  ];
  
  for (const auditId of opportunityAudits) {
    const audit = lighthouse.audits?.[auditId];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        title: audit.title || auditId,
        description: audit.description || '',
        savings: audit.displayValue || 'Potential savings'
      });
    }
  }
  
  const result: PageSpeedResult = {
    url,
    strategy,
    scores: {
      performance: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
      accessibility: Math.round((lighthouse.categories?.accessibility?.score || 0) * 100),
      bestPractices: Math.round((lighthouse.categories?.['best-practices']?.score || 0) * 100),
      seo: Math.round((lighthouse.categories?.seo?.score || 0) * 100)
    },
    coreWebVitals: {
      lcp: Math.round(lighthouse.audits?.['largest-contentful-paint']?.numericValue || 0),
      cls: parseFloat((lighthouse.audits?.['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      tbt: Math.round(lighthouse.audits?.['total-blocking-time']?.numericValue || 0),
      fcp: Math.round(lighthouse.audits?.['first-contentful-paint']?.numericValue || 0),
      si: Math.round(lighthouse.audits?.['speed-index']?.numericValue || 0),
      ttfb: Math.round(lighthouse.audits?.['server-response-time']?.numericValue || 0)
    },
    opportunities,
    fetchedAt: new Date().toISOString()
  };
  
  console.log(`[PageSpeed] ${url}: Performance ${result.scores.performance}/100, SEO ${result.scores.seo}/100, LCP ${result.coreWebVitals.lcp}ms`);
  
  return result;
}

function getPageSpeedGrade(score: number): { grade: string; color: string; status: string } {
  if (score >= 90) return { grade: 'A', color: 'green', status: 'Good' };
  if (score >= 50) return { grade: 'B', color: 'orange', status: 'Needs Improvement' };
  return { grade: 'C', color: 'red', status: 'Poor' };
}

function getCoreWebVitalStatus(metric: string, value: number): { status: string; color: string } {
  switch (metric) {
    case 'lcp':
      if (value <= 2500) return { status: 'Good', color: 'green' };
      if (value <= 4000) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'cls':
      if (value <= 0.1) return { status: 'Good', color: 'green' };
      if (value <= 0.25) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'tbt':
      if (value <= 200) return { status: 'Good', color: 'green' };
      if (value <= 600) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'ttfb':
      if (value <= 800) return { status: 'Good', color: 'green' };
      if (value <= 1800) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    default:
      return { status: 'Unknown', color: 'gray' };
  }
}

/**
 * Auto-optimize article HTML for better performance scores
 * Applies lazy loading, image optimization, and other fixes
 */
function optimizeArticleHtml(html: string): string {
  let optimized = stripEmptyProductReviewLabelsInDocument(html);
  
  // 0. Add preconnect hints for external resources (reduces DNS/TCP latency by 100-300ms each)
  const preconnectTags = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://images.unsplash.com">
<link rel="preconnect" href="https://pagead2.googlesyndication.com" crossorigin>`;
  
  if (!optimized.includes('rel="preconnect"')) {
    optimized = optimized.replace(/<head([^>]*)>/i, `<head$1>${preconnectTags}`);
  }
  
  // 1. Add lazy loading to all images except first (hero image)
  let imageCount = 0;
  optimized = optimized.replace(/<img([^>]*)>/gi, (match, attrs) => {
    imageCount++;
    if (attrs.includes('loading=')) return match; // Already has loading attr
    
    if (imageCount === 1) {
      return `<img${attrs} loading="eager" decoding="async">`;
    } else {
      return `<img${attrs} loading="lazy" decoding="async">`;
    }
  });
  
  // 2. Add dimensions to images without them (prevents CLS)
  optimized = optimized.replace(/<img([^>]*)>/gi, (match, attrs) => {
    if (!attrs.includes('width=') && !attrs.includes('style=')) {
      return match.replace('>', ' width="800" height="600" style="aspect-ratio: 4/3;">');
    }
    return match;
  });
  
  // 3. Optimize Unsplash URLs for WebP format (skip small images like author photos)
  optimized = optimized.replace(
    /https:\/\/images\.unsplash\.com\/([^"'\s\?]+)(?:\?([^"'\s]*))?/g,
    (match, path, params) => {
      if (params && /w=1\d{2}(?:&|$)/.test(params)) return match.replace(/(?:&fm=\w+|&auto=\w+)/g, '') + '&fm=webp&auto=format';
      return `https://images.unsplash.com/${path}?w=800&q=80&fm=webp&auto=format`;
    }
  );
  
  // 4. Replace YouTube iframes with lightweight facades (biggest performance win)
  optimized = optimized.replace(
    /<iframe[^>]*src=["'](?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]+)[^"']*["'][^>]*><\/iframe>/gi,
    (match, videoId) => {
      return `<div class="yt-facade" style="position:relative;padding-bottom:56.25%;background:#000;cursor:pointer;" onclick="this.innerHTML='<iframe src=\\'https://www.youtube.com/embed/${videoId}?autoplay=1\\' style=\\'position:absolute;top:0;left:0;width:100%;height:100%;border:0\\' allow=\\'autoplay;encrypted-media\\' allowfullscreen></iframe>'">
  <img src="https://img.youtube.com/vi/${videoId}/hqdefault.jpg" alt="Video" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;" loading="lazy">
  <svg style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;" viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24L27 14v20" fill="white"/></svg>
</div>`;
    }
  );
  
  // 5. Add loading="lazy" to remaining iframes
  optimized = optimized.replace(/<iframe([^>]*)>/gi, (match, attrs) => {
    if (!attrs.includes('loading=')) {
      return `<iframe${attrs} loading="lazy">`;
    }
    return match;
  });
  
  // 5. Defer non-critical scripts
  optimized = optimized.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
    if (!before.includes('defer') && !before.includes('async')) {
      return `<script${before}src="${src}" defer${after}>`;
    }
    return match;
  });
  
  // 6. Add font-display: swap to any @font-face rules
  optimized = optimized.replace(/@font-face\s*\{([^}]+)\}/gi, (match, content) => {
    if (!content.includes('font-display')) {
      return `@font-face {${content}font-display: swap;}`;
    }
    return match;
  });
  
  return optimized;
}

// PageSpeed Queue Status Endpoint
router.get('/pagespeed/queue', (req: Request, res: Response) => {
  const now = Date.now();
  const timeSinceLastCall = now - pageSpeedLastCall;
  const nextCheckIn = Math.max(0, PAGESPEED_MIN_INTERVAL - timeSinceLastCall);
  
  res.json({
    success: true,
    queue: {
      size: pageSpeedQueue.length,
      processing: pageSpeedProcessing,
      lastCallAgo: Math.round(timeSinceLastCall / 1000),
      nextCheckIn: Math.round(nextCheckIn / 1000),
      minInterval: PAGESPEED_MIN_INTERVAL / 1000,
      items: pageSpeedQueue.map(item => ({
        slug: item.articleSlug,
        retryCount: item.retryCount,
        waitingFor: Math.round((now - item.addedAt) / 1000)
      }))
    },
    settings: {
      minIntervalSeconds: PAGESPEED_MIN_INTERVAL / 1000,
      maxRetries: PAGESPEED_MAX_RETRIES,
      backoffBaseSeconds: PAGESPEED_BACKOFF_BASE / 1000
    }
  });
});

// PageSpeed Analysis Endpoint (FREE - no API key required)
router.get('/pagespeed', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    const strategy = (req.query.strategy as 'mobile' | 'desktop') || 'mobile';
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }
    
    const result = await analyzePageSpeed(url, strategy);
    
    const performanceGrade = getPageSpeedGrade(result.scores.performance);
    const seoGrade = getPageSpeedGrade(result.scores.seo);
    
    res.json({
      success: true,
      data: {
        ...result,
        grades: {
          performance: performanceGrade,
          accessibility: getPageSpeedGrade(result.scores.accessibility),
          bestPractices: getPageSpeedGrade(result.scores.bestPractices),
          seo: seoGrade
        },
        coreWebVitalStatus: {
          lcp: getCoreWebVitalStatus('lcp', result.coreWebVitals.lcp),
          cls: getCoreWebVitalStatus('cls', result.coreWebVitals.cls),
          tbt: getCoreWebVitalStatus('tbt', result.coreWebVitals.tbt),
          ttfb: getCoreWebVitalStatus('ttfb', result.coreWebVitals.ttfb)
        },
        passesThresholds: {
          performance: result.scores.performance >= 90,
          seo: result.scores.seo >= 90,
          lcp: result.coreWebVitals.lcp <= 2500,
          cls: result.coreWebVitals.cls <= 0.1
        }
      }
    });
  } catch (error: any) {
    console.error('[PageSpeed] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Batch PageSpeed Analysis (analyze multiple URLs)
router.post('/pagespeed/batch', async (req: Request, res: Response) => {
  try {
    const { urls, strategy = 'mobile' } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'URLs array required' });
    }
    
    if (urls.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    }
    
    const results: PageSpeedResult[] = [];
    const errors: { url: string; error: string }[] = [];
    
    for (const url of urls) {
      try {
        const result = await analyzePageSpeed(url, strategy);
        results.push(result);
      } catch (error: any) {
        errors.push({ url, error: error.message });
      }
    }
    
    const avgPerformance = results.length > 0 
      ? Math.round(results.reduce((sum, r) => sum + r.scores.performance, 0) / results.length)
      : 0;
    
    res.json({
      success: true,
      data: {
        results,
        errors,
        summary: {
          totalAnalyzed: results.length,
          totalErrors: errors.length,
          averagePerformance: avgPerformance,
          averageSeo: results.length > 0 
            ? Math.round(results.reduce((sum, r) => sum + r.scores.seo, 0) / results.length)
            : 0
        }
      }
    });
  } catch (error: any) {
    console.error('[PageSpeed] Batch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// V3 AUTO-START (New Category Discovery - autonomous research + generation)
// ═══════════════════════════════════════════════════════════════════════════
// NOTE: V3 auto-starts the research pipeline that discovers NEW categories
// Uses Cloudflare AI for content generation (independent from V2's Copilot CLI)
// The petinsurance queue is handled by V1 (seo-generator.ts).
// ═══════════════════════════════════════════════════════════════════════════

console.log('[SEO-V3] Module loaded - scheduling V3 research pipeline auto-start in 15 seconds...');

// Auto-start V3 research pipeline (discovers new categories, NOT petinsurance)
setTimeout(() => {
  console.log('[SEO-V3] setTimeout triggered for V3 research pipeline...');
  if (!v3AutonomousRunning) {
    console.log('[SEO-V3] 🔬 Auto-starting V3 autonomous research pipeline...');
    v3AutonomousRunning = true;
    resetSessionHealth();
    addActivityLog('info', '[V3] Auto-starting autonomous research & generation pipeline (new category discovery)');
    runV3AutonomousGeneration();
  } else {
    console.log('[SEO-V3] V3 research pipeline already running, skipping auto-start');
  }
}, 15000); // Wait 15 seconds to let V1 start first

// ============================================================================
// AUTONOMOUS ROUTE HEALING - Fixes missing Cloudflare Worker routes
// Runs every 10 minutes to ensure all categories have proper routing
// ============================================================================

async function getAllKnownCategories(): Promise<string[]> {
  const staticCategories = [
    'petinsurance',
    'automatic-cat-feeders',
    'cat-automatic-litter-box-cleaners',
    'cat-calming-anxiety-products',
    'cat-carriers-travel-products',
    'cat-dna-testing',
    'cat-enclosures-outdoor-catios',
    'cat-flea-tick-treatments',
    'cat-food-delivery-services',
    'cat-food-nutrition',
    'cat-gps-trackers',
    'cat-grooming-tools-kits',
    'cat-health-supplements',
    'cat-scratchers-scratching-posts',
    'cat-trees-furniture',
    'cat-beds',
    'cat-health-wellness',
    'cat-litter-boxes',
    'cat-toys',
    'cat-trees-condos',
    'cat-scratching-posts-pads',
    'cat-strollers-pet-buggies',
    'cat-cameras-monitors',
    'cat-furniture-protectors',
    'cat-litter-mats',
    'cat-dental-care-products'
  ];
  // Include dynamically discovered V3 categories from KV
  const dynamicV3Cats = await getAllCategoryStatusKeys();
  const combined = new Set([...staticCategories, ...V3_LEGACY_CATEGORIES, ...dynamicV3Cats]);
  return Array.from(combined);
}

async function healMissingRoutes(): Promise<{ checked: number; created: number; errors: string[] }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.log('[Route Healer] No Cloudflare API token - skipping');
    return { checked: 0, created: 0, errors: ['No API token'] };
  }

  const allCategories = await getAllKnownCategories();
  console.log(`[Route Healer] 🔧 Checking ${allCategories.length} categories for missing routes...`);
  let checked = 0;
  let created = 0;
  const errors: string[] = [];

  let existingRoutes: any[] = [];
  try {
    existingRoutes = await fetchWorkerRoutes(cfApiToken);
    console.log(`[Route Healer] Found ${existingRoutes.length} existing routes`);
  } catch (err: any) {
    console.log(`[Route Healer] Failed to fetch routes: ${err.message}`);
    return { checked: 0, created: 0, errors: [err.message] };
  }

  for (const category of allCategories) {
    checked++;
    const routePattern = `catsluvus.com/${category}/*`;
    const hasRoute = existingRoutes.some((r: any) => r.pattern === routePattern);

    if (!hasRoute) {
      console.log(`[Route Healer] ⚠️ Missing route for: ${category}`);
      try {
        const result = await ensureWorkerRouteForCategory(category);
        if (result.success) {
          created++;
          console.log(`[Route Healer] ✅ Created route for: ${category}`);
          addActivityLog('success', `[Route Healer] Auto-created Worker route for ${category}`, { routeId: result.routeId });
        } else {
          errors.push(`${category}: ${result.error}`);
        }
      } catch (err: any) {
        errors.push(`${category}: ${err.message}`);
      }
    }
  }

  console.log(`[Route Healer] ✅ Check complete: ${checked} checked, ${created} created, ${errors.length} errors`);
  return { checked, created, errors };
}

// Run route healer every 10 minutes
setInterval(async () => {
  try {
    await healMissingRoutes();
  } catch (err: any) {
    console.log(`[Route Healer] Error: ${err.message}`);
  }
}, 10 * 60 * 1000); // 10 minutes

// Also run immediately on startup (after 30 seconds)
setTimeout(async () => {
  console.log('[Route Healer] Initial route healing check...');
  try {
    const result = await healMissingRoutes();
    if (result.created > 0) {
      console.log(`[Route Healer] 🔧 Fixed ${result.created} missing routes on startup`);
    }
  } catch (err: any) {
    console.log(`[Route Healer] Startup check error: ${err.message}`);
  }
}, 30000);

// Manual endpoint to trigger route healing
router.post('/heal-routes', async (req: Request, res: Response) => {
  try {
    const result = await healMissingRoutes();
    res.json({
      success: true,
      ...result,
      message: result.created > 0 ? `Created ${result.created} missing routes` : 'All routes already configured'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Generation History API endpoints (persistent structured data)
// ============================================================================
import { getHistory, getHistoryForSlug, getErrors, getCategoryProgress } from '../services/generation-history';

router.get('/history', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const records = getHistory(limit, offset);
    res.json({ success: true, count: records.length, limit, offset, records });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history/:slug', (req: Request, res: Response) => {
  try {
    const result = getHistoryForSlug(req.params.slug);
    if (!result.record) {
      res.status(404).json({ error: 'No history found for this slug' });
      return;
    }
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/errors', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const records = getErrors(limit);
    res.json({ success: true, count: records.length, records });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/category-progress', (req: Request, res: Response) => {
  try {
    const progress = getCategoryProgress();
    res.json({ success: true, progress: progress || { updatedAt: null, categories: {} } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
