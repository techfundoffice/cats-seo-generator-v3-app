/**
 * Cloudflare Workers AI Image Generation Service
 * Uses FLUX.1 [schnell] for cost-effective image generation (~173 images/day free)
 * Stores images in R2 bucket: seo-images
 */

import { secrets } from './doppler-secrets';
import sharp from 'sharp';

// Cloudflare account config (env-configurable, falls back to production default)
const CLOUDFLARE_ACCOUNT_ID = secrets.get('CLOUDFLARE_ACCOUNT_ID') || 'bc8e15f958dc350e00c0e39d80ca6941';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

// R2 bucket name
const R2_BUCKET_NAME = 'seo-images';

// Rate limiting (173 images/day on free tier)
const DAILY_IMAGE_LIMIT = 170; // Leave buffer
let dailyImageCount = 0;
let dailyResetDate = new Date().toDateString();

// =============================================================================
// KEYWORD-FOCUSED IMAGE GENERATION
// Images that visually communicate the article topic at a glance
// Topic detection → Literal scene description → Photorealistic output
// =============================================================================

// Max generation attempts per image (retry on generation failure only)
const MAX_IMAGE_RETRIES = 2;

// Interfaces
export interface ArticleSection {
  heading: string;
  content: string;
}

export interface GeneratedImage {
  url: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  imageType: 'hero' | 'section' | 'closing';
  sectionIndex: number;
  prompt: string;
  r2Key: string;
}

export interface ImageGenerationResult {
  success: boolean;
  images: GeneratedImage[];
  errors: string[];
  neuronsCost: number;
  timing: {
    totalMs: number;
    perImageMs: number[];
  };
}

interface SectionImageContext {
  index: number;
  heading: string;
  headingClean: string;
  imageType: 'hero' | 'section' | 'closing';
  articleTitle: string;      // Full article title for context
  topH2s: string[];          // First 3 H2 headings for topic context
}

/**
 * Check if we can generate more images today
 */
function canGenerateImage(): boolean {
  const today = new Date().toDateString();
  if (dailyResetDate !== today) {
    dailyImageCount = 0;
    dailyResetDate = today;
  }
  return dailyImageCount < DAILY_IMAGE_LIMIT;
}

/**
 * Record image generation for rate limiting
 */
function recordImageGeneration(count: number = 1): void {
  dailyImageCount += count;
}

/**
 * Get current image quota status
 */
export function getImageQuotaStatus(): { used: number; limit: number; remaining: number; resetDate: string } {
  const today = new Date().toDateString();
  if (dailyResetDate !== today) {
    dailyImageCount = 0;
    dailyResetDate = today;
  }
  return {
    used: dailyImageCount,
    limit: DAILY_IMAGE_LIMIT,
    remaining: DAILY_IMAGE_LIMIT - dailyImageCount,
    resetDate: dailyResetDate
  };
}

/**
 * Extract image contexts for article (hero + 1 optional mid-article image)
 * SEO Best Practice: Only 1-2 images per article that add real value
 * More images ≠ better SEO. Only add images that help explain the content.
 */
function extractImageContexts(articleTitle: string, sections: ArticleSection[]): SectionImageContext[] {
  const contexts: SectionImageContext[] = [];

  // Extract first 3 H2 headings for topic context
  const topH2s = (sections && Array.isArray(sections))
    ? sections.slice(0, 3).map(s => s.heading.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim())
    : [];

  // Hero image based on article title (always include)
  contexts.push({
    index: 0,
    heading: articleTitle,
    headingClean: articleTitle.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim(),
    imageType: 'hero',
    articleTitle: articleTitle,
    topH2s: topH2s
  });

  // Add 1 mid-article section image only for longer articles (3+ sections)
  if (sections && Array.isArray(sections) && sections.length >= 3) {
    // Pick the middle section for the image
    const midIndex = Math.floor(sections.length / 2);
    const midSection = sections[midIndex];
    contexts.push({
      index: midIndex + 1,
      heading: midSection.heading,
      headingClean: midSection.heading.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim(),
      imageType: 'section',
      articleTitle: articleTitle,
      topH2s: topH2s
    });
  }

  // No closing image - it adds no value, just decoration

  return contexts;
}

/**
 * Generate KEYWORD-FOCUSED image prompt
 *
 * DIRECT APPROACH: Extract the core subject and create a literal visual.
 * The image should instantly communicate what the article is about.
 *
 * Examples:
 * - "cat flea treatment" → cat being treated for fleas, close-up
 * - "best cat food for sensitive stomach" → cat eating from premium bowl
 * - "how to trim cat nails" → hands trimming cat's nails
 * - "cat dental care tips" → cat with healthy teeth, vet examining
 */
function generateImagePrompt(
  category: string,
  sectionContext: SectionImageContext,
  keyword: string
): string {
  // Extract the CORE SUBJECT from the keyword
  const lowerKeyword = keyword.toLowerCase();

  // Remove filler words to get the real topic
  const coreSubject = lowerKeyword
    .replace(/\b(best|top|review|reviews|guide|how to|what is|why|when|where|can|should|do|does|the|a|an|for|with|and|or|your|my|our|their|2024|2025|2026|near me|online|cheap|affordable|premium|luxury)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Detect the PRIMARY ACTION or TOPIC (ordered by specificity - most specific first)
  // Using word boundaries \b to avoid false matches (e.g., "treatment" matching "eat")
  const topics = {
    medical: /\b(flea|tick|worm|parasite|treatment|medicine|vet|health|sick|disease|symptom|vaccine|shot)\b/i,
    dental: /\b(dental|teeth|tooth|mouth|breath|gum)\b/i,
    grooming: /\b(groom|brush|comb|fur|hair|bath|wash|nail|trim|shed|mat)\b/i,
    behavior: /\b(behavior|train|scratch|bite|meow|sleep|play|stress|anxiety|aggress)\b/i,
    supplies: /\b(litter|carrier|toy|tree|post|fountain)\b/i,
    insurance: /\b(insurance|coverage|policy|claim|vet bill)\b/i,
    breed: /\b(breed|kitten|persian|siamese|maine coon|bengal|ragdoll|british)\b/i,
    feeding: /\b(food|feed|diet|nutrition|meal|hungry|appetite|eat)\b/i
  };

  // Find matching topic
  let detectedTopic = 'general';
  for (const [topic, pattern] of Object.entries(topics)) {
    if (pattern.test(lowerKeyword)) {
      detectedTopic = topic;
      break;
    }
  }

  // Build a SPECIFIC, LITERAL scene based on topic
  let scene: string;

  switch (detectedTopic) {
    case 'feeding':
      scene = `close-up photograph of a healthy cat eating from a food bowl, ${coreSubject}, kitchen or home setting, natural daylight, cat looks content and healthy`;
      break;
    case 'medical':
      scene = `veterinarian gently examining a calm cat on examination table, ${coreSubject}, professional veterinary clinic, caring hands, cat looks relaxed`;
      break;
    case 'grooming':
      scene = `person gently grooming a relaxed cat, ${coreSubject}, showing the grooming action clearly, cat enjoying the attention, soft natural lighting`;
      break;
    case 'dental':
      scene = `close-up of a cat with mouth slightly open showing healthy teeth, ${coreSubject}, veterinary dental check, clean professional setting`;
      break;
    case 'behavior':
      scene = `expressive cat demonstrating natural behavior, ${coreSubject}, home environment, cat's body language clearly visible, candid moment`;
      break;
    case 'supplies':
      scene = `cat interacting with pet supplies, ${coreSubject}, the product clearly visible in use, modern home setting, cat engaged and happy`;
      break;
    case 'insurance':
      scene = `happy healthy cat being held by caring owner, ${coreSubject}, suggesting pet healthcare and protection, warm family moment`;
      break;
    case 'breed':
      scene = `beautiful purebred cat portrait, ${coreSubject}, showing distinctive breed features, professional pet photography, stunning coat and eyes`;
      break;
    default:
      scene = `adorable cat in a cozy home setting, ${coreSubject}, warm natural lighting, cat looking directly at camera, engaging expression`;
  }

  // Build final prompt - SHORT and SPECIFIC
  const prompt = [
    'Generate image with NO TEXT NO WORDS NO LETTERS anywhere',
    scene,
    'real photograph, not illustration, photorealistic, high quality, sharp focus',
    'natural cat, no costumes, no clothes, no accessories on cat'
  ].join('. ');

  return prompt;
}

/**
 * Generate a single image using Cloudflare Workers AI FLUX.1 schnell
 */
async function generateSingleImage(
  prompt: string,
  width: number = 672,
  height: number = 504
): Promise<ArrayBuffer | null> {
  // Use Workers AI specific token, fall back to general token
  const apiToken = secrets.get('CLOUDFLARE_WORKERS_AI_TOKEN') || secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

  if (!apiToken) {
    console.error('[Image Gen] No Cloudflare Workers AI token configured. Add CLOUDFLARE_WORKERS_AI_TOKEN to Doppler.');
    return null;
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${IMAGE_MODEL}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        width,
        height
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Image Gen] FLUX API error: ${response.status} - ${errorText}`);
      return null;
    }

    // FLUX returns JSON with base64-encoded image
    const data = await response.json() as { result?: { image?: string } };

    if (!data.result?.image) {
      console.error('[Image Gen] FLUX API returned no image data');
      return null;
    }

    // Decode base64 to binary
    const base64Image = data.result.image;
    const binaryString = atob(base64Image);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;

  } catch (error: any) {
    console.error(`[Image Gen] Request failed: ${error.message}`);
    return null;
  }
}

/**
 * Store image in R2 bucket via Cloudflare API
 */
async function storeImageInR2(
  imageBuffer: ArrayBuffer,
  r2Key: string
): Promise<boolean> {
  // Upload via Worker endpoint on domain (has R2 binding and zone routes)
  const workerUrl = 'https://catsluvus.com/img/upload';

  try {
    // Optimize PNG: strip metadata, maximize compression (lossless)
    const optimizedBuffer = await sharp(Buffer.from(imageBuffer))
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    const originalSize = imageBuffer.byteLength;
    const optimizedSize = optimizedBuffer.byteLength;
    console.log(`[Image Gen] PNG optimized: ${(originalSize / 1024).toFixed(0)}KB → ${(optimizedSize / 1024).toFixed(0)}KB (${((1 - optimizedSize / originalSize) * 100).toFixed(0)}% smaller)`);

    // Convert to base64
    const base64Image = optimizedBuffer.toString('base64');

    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: r2Key,
        image: base64Image,
        contentType: 'image/png'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Image Gen] R2 upload error: ${response.status} - ${errorText}`);
      return false;
    }

    const result = await response.json() as any;
    if (result.success) {
      console.log(`[Image Gen] ✅ Uploaded to R2: ${r2Key} (${result.size} bytes)`);
      return true;
    }

    console.error(`[Image Gen] R2 upload failed: ${result.error}`);
    return false;
  } catch (error: any) {
    console.error(`[Image Gen] R2 upload failed: ${error.message}`);
    return false;
  }
}

/**
 * Generate image caption based on context
 */
function generateCaption(
  category: string,
  sectionContext: SectionImageContext,
  keyword: string
): string {
  const categoryName = category.replace(/-/g, ' ');

  switch (sectionContext.imageType) {
    case 'hero':
      return `Complete guide to ${keyword} - expert recommendations and comparisons`;
    case 'closing':
      return `Summary: Everything you need to know about ${keyword}`;
    default:
      return `${sectionContext.heading} - ${categoryName} expert guide`;
  }
}

/**
 * Generate alt text for SEO
 */
function generateAltText(
  category: string,
  sectionContext: SectionImageContext,
  keyword: string
): string {
  const cleanKeyword = keyword.replace(/-/g, ' ');
  const headingClean = sectionContext.headingClean || '';

  switch (sectionContext.imageType) {
    case 'hero':
      return `Cat owner reviewing ${cleanKeyword} options for their pet in 2026`;
    case 'closing':
      return `Complete guide summary for choosing the best ${cleanKeyword}`;
    default:
      if (headingClean && headingClean.length > 10) {
        return `${headingClean} - expert ${cleanKeyword} guide`;
      }
      return `Detailed look at ${cleanKeyword} features and benefits for cats`;
  }
}

/**
 * Main function: Generate all images for an article
 */
export async function generateArticleImages(
  category: string,
  slug: string,
  keyword: string,
  articleTitle: string,
  sections: ArticleSection[],
  addActivityLog?: (level: string, message: string, data?: any) => void
): Promise<ImageGenerationResult> {
  const startTime = Date.now();

  // Sanitize category and slug for R2 storage paths (remove special chars like &)
  const safeCategory = category.toLowerCase()
    .replace(/&amp;/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-+/g, '-');
  const safeSlug = slug.toLowerCase()
    .replace(/&amp;/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-+/g, '-');

  const result: ImageGenerationResult = {
    success: false,
    images: [],
    errors: [],
    neuronsCost: 0,
    timing: { totalMs: 0, perImageMs: [] }
  };

  const log = addActivityLog || ((level: string, msg: string) => console.log(`[Image Gen] ${msg}`));

  // Check rate limit
  if (!canGenerateImage()) {
    log('warning', `[V3] Image generation quota exceeded (${dailyImageCount}/${DAILY_IMAGE_LIMIT})`, {});
    result.errors.push('Daily image quota exceeded');
    return result;
  }

  // Extract image contexts (hero + optional 1 mid-article image)
  // SEO Best Practice: 1-2 purposeful images, not decorative filler
  const imageContexts = extractImageContexts(articleTitle, sections);

  // Max 2 images per article (hero + 1 section for longer articles)
  const maxImages = 2;
  const imagesToGenerate = imageContexts.slice(0, maxImages);

  log('info', `[V3] Generating ${imagesToGenerate.length} AI images for "${keyword}"...`, {
    category,
    slug,
    imageCount: imagesToGenerate.length
  });

  // Generate images sequentially with rate limiting and verification
  for (const context of imagesToGenerate) {
    // Check quota before each image
    if (!canGenerateImage()) {
      log('warning', '[V3] Image quota reached mid-generation', {});
      break;
    }

    // Determine R2 key early to check if image already exists
    let r2KeyCheck: string;
    switch (context.imageType) {
      case 'hero':
        r2KeyCheck = `${safeCategory}/${safeSlug}/hero.png`;
        break;
      case 'closing':
        r2KeyCheck = `${safeCategory}/${safeSlug}/closing.png`;
        break;
      default:
        r2KeyCheck = `${safeCategory}/${safeSlug}/section-${context.index}.png`;
    }

    // Check if image already exists in R2 before burning neurons
    try {
      const checkUrl = `https://catsluvus.com/img/${r2KeyCheck}`;
      const headResp = await fetch(checkUrl, { method: 'HEAD' });
      if (headResp.ok) {
        log('info', `[V3] Image already in R2: ${r2KeyCheck}, skipping generation`, {});
        result.images.push({
          url: `/img/${r2KeyCheck}`,
          alt: generateAltText(safeCategory, context, keyword),
          caption: generateCaption(safeCategory, context, keyword),
          width: 672,
          height: 504,
          imageType: context.imageType,
          sectionIndex: context.index,
          prompt: '(cached)',
          r2Key: r2KeyCheck,
        });
        continue;
      }
    } catch {
      // HEAD check failed, proceed with generation
    }

    const imageStart = Date.now();
    let imageBuffer: ArrayBuffer | null = null;
    let prompt = '';
    let attempt = 0;

    // Retry loop (retry on generation failure only)
    while (attempt < MAX_IMAGE_RETRIES && !imageBuffer) {
      attempt++;

      // Check quota before each attempt
      if (!canGenerateImage()) {
        log('warning', '[V3] Image quota reached during retry', {});
        break;
      }

      prompt = generateImagePrompt(category, context, keyword);

      if (attempt === 1) {
        log('info', `[V3] Generating ${context.imageType} image for "${keyword}"...`, {});
      } else {
        log('info', `[V3] Retry ${attempt}/${MAX_IMAGE_RETRIES} for "${keyword}"...`, {});
      }

      imageBuffer = await generateSingleImage(prompt, 672, 504);

      if (!imageBuffer) {
        log('warning', `[V3] Generation failed on attempt ${attempt}`, {});
      }
    }

    if (!imageBuffer) {
      result.errors.push(`Failed to generate ${context.imageType} image after ${attempt} attempts`);
      result.timing.perImageMs.push(Date.now() - imageStart);
      continue;
    }

    // Determine R2 key (use sanitized category/slug for URL-safe paths)
    let r2Key: string;
    switch (context.imageType) {
      case 'hero':
        r2Key = `${safeCategory}/${safeSlug}/hero.png`;
        break;
      case 'closing':
        r2Key = `${safeCategory}/${safeSlug}/closing.png`;
        break;
      default:
        r2Key = `${safeCategory}/${safeSlug}/section-${context.index}.png`;
    }

    // Store in R2
    const stored = await storeImageInR2(imageBuffer, r2Key);

    if (stored) {
      const generatedImage: GeneratedImage = {
        url: `/img/${r2Key}`,
        alt: generateAltText(safeCategory, context, keyword),
        caption: generateCaption(safeCategory, context, keyword),
        width: 672,
        height: 504,
        imageType: context.imageType,
        sectionIndex: context.index,
        prompt: prompt,
        r2Key: r2Key
      };

      result.images.push(generatedImage);
      recordImageGeneration(attempt);
      result.neuronsCost += 58 * attempt;

      log('info', `[V3] ${context.imageType} image stored: ${r2Key} (${attempt} attempt${attempt > 1 ? 's' : ''})`, {
        r2Key
      });
    } else {
      result.errors.push(`Failed to store ${context.imageType} image to R2`);
    }

    result.timing.perImageMs.push(Date.now() - imageStart);

    // Rate limiting delay between images (2 seconds)
    if (imagesToGenerate.indexOf(context) < imagesToGenerate.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  result.timing.totalMs = Date.now() - startTime;
  result.success = result.images.length > 0;

  log(
    result.success ? 'success' : 'warning',
    `[V3] Image generation complete: ${result.images.length}/${imagesToGenerate.length} images`,
    {
      totalMs: result.timing.totalMs,
      neuronsCost: result.neuronsCost,
      errors: result.errors.length > 0 ? result.errors : undefined
    }
  );

  return result;
}

/**
 * Test image generation with a simple prompt
 */
export async function testImageGeneration(): Promise<{ success: boolean; message: string; imageUrl?: string }> {
  const testPrompt = 'A cute cat sitting on a modern cat tree, professional photography, warm lighting';

  console.log('[Image Gen] Testing FLUX.1 schnell with prompt:', testPrompt);

  const imageBuffer = await generateSingleImage(testPrompt, 512, 512);

  if (!imageBuffer) {
    return { success: false, message: 'Failed to generate test image' };
  }

  // Store test image
  const testKey = `test/test-${Date.now()}.png`;
  const stored = await storeImageInR2(imageBuffer, testKey);

  if (!stored) {
    return { success: false, message: 'Image generated but failed to store in R2' };
  }

  return {
    success: true,
    message: 'Test image generated and stored successfully',
    imageUrl: `/img/${testKey}`
  };
}
