# SEO Generator V3

AI-powered SEO article generator with Amazon affiliate integration for catsluvus.com.

## Tech Stack

- **Backend**: Express.js + TypeScript (Node 20)
- **Frontend**: Vue 3 + Vite
- **AI**: Anthropic Claude Agent SDK (Claude Sonnet 4.5)
- **Image Gen**: Cloudflare Workers AI (FLUX.1)
- **Storage**: Cloudflare KV
- **SEO**: DataForSEO, Seord, Harper.js
- **Affiliate**: Amazon Product Advertising API
- **QC**: Gobii post-publish quality control
- **Secrets**: Doppler CLI

## Quick Start

```bash
# Option A: With Doppler (recommended)
doppler login && doppler setup
npm install
npm run dev:doppler

# Option B: With .env file
cp .env.example .env  # fill in your keys
npm install
npm run dev
```

- API runs on http://localhost:3000
- Vue UI runs on http://localhost:5173 (proxies API)

## Key Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start API + UI concurrently |
| `npm run dev:api` | Start Express API only |
| `npm run dev:ui` | Start Vite UI only |
| `npm run dev:doppler` | Start with Doppler secrets |
| `npm run build` | Build TypeScript + Vue UI |
| `npm test` | Run Jest tests |
| `npm run lint` | ESLint check |
| `npm start` | Run production build |

## Project Structure

```
src/
  index.ts              # Express server entry point
  routes/
    seo-generator-v3.ts # All 51 API endpoints
  services/
    claude-agent-sdk-client.ts  # AI text generation
    vercel-ai-gateway.ts        # AI gateway
    cloudflare-image-gen.ts     # FLUX.1 image generation
    amazon-products.ts          # Amazon affiliate products
    apify-amazon.ts             # Apify product scraping
    seo-score.ts                # SEO quality scoring
    skill-engine.ts             # Skill orchestration
    skill-parser.ts             # YAML skill parsing
    research-engine.ts          # SEO research pipeline
    dataforseo-client.ts        # On-page SEO metrics
    google-search-console.ts    # GSC integration
    post-publish-qc.ts          # Gobii browser-use QC
    gobii-client.ts             # Gobii API client
    indexing-tracker.ts         # Google indexing status
    generation-history.ts       # Article history tracking
    qc-history-store.ts         # QC result storage
    doppler-secrets.ts          # Secret management
    youtube-search.py           # YouTube search helper
  config/
    seo-skills.ts       # Skill profiles (quick/comprehensive/advanced/marketing/autonomous)
    gobii-qc.ts         # Post-publish QC config
  data/
    seo-data.ts         # SEO keyword data
    keyword-priorities.ts # Keyword priority system
    keywords-full.ts    # Full keyword database
  types/
    skills.ts           # Skill type definitions
    category-context.ts # Category/research types
    vendor.d.ts         # Third-party type declarations
  lib/
    amazon-creatorsapi/ # Vendored Amazon Creators API SDK
ui/
  SEOArticleGeneratorV3.vue  # Main Vue component (entire UI)
  main.ts                     # Vue app bootstrap
  vite.config.ts              # Vite config with API proxy
tests/
  seo-skills.test.ts          # Skill configuration tests
```

## API Endpoints

All endpoints are at `/api/seo-generator-v3/`. Key groups:

- **Generation**: `POST /generate`, `POST /batch`, `POST /validate`
- **Research**: `POST /research/start`, `POST /research/submit-discovery`, etc.
- **Autonomous**: `POST /autonomous/start`, `POST /autonomous/stop`
- **Keywords**: `GET /keywords`, `GET /keywords/random`, `POST /keywords`
- **History**: `GET /recent`, `GET /history`, `GET /stats`
- **QC**: `POST /index-status/process`, `GET /pagespeed`
- **Categories**: `POST /start-category`, `GET /category-progress`
- **Health**: `GET /health`, `GET /status`

## Deployment

```bash
# Docker
docker build -t seo-generator-v3 .
docker run -p 3000:3000 --env-file .env seo-generator-v3

# Docker Compose
docker-compose up -d
```

CI/CD via GitHub Actions: pushes to `main` build and deploy automatically.

## Environment Variables

See `.env.example` for all variables. Required:
- `ANTHROPIC_API_KEY` - Claude API key
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` - Image gen + KV
- `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_KV_NAMESPACE_ID` - Storage
