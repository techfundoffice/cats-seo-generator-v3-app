# SEO Generator V3

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/techfundoffice/seo-generator-v3-app?quickstart=1)

AI-powered SEO article generator with Cloudflare AI image generation, Amazon affiliate integration, and autonomous category discovery.

## Quick Start

### Option A: Docker (fastest)

```bash
# Pull the pre-built image from GitHub Container Registry
docker login ghcr.io -u techfundoffice
docker pull ghcr.io/techfundoffice/seo-generator-v3-app/seo-generator-v3:latest

# Run it (create .env with your API keys first — see .env.example)
docker run -d -p 3000:3000 --env-file .env \
  ghcr.io/techfundoffice/seo-generator-v3-app/seo-generator-v3:latest
```

The Docker image is automatically built and pushed to GHCR on every push to main.
Find it at: https://github.com/techfundoffice/seo-generator-v3-app/pkgs/container/seo-generator-v3-app%2Fseo-generator-v3

### Option B: Docker Compose

```bash
git clone https://github.com/techfundoffice/seo-generator-v3-app.git
cd seo-generator-v3-app/ghl-marketplace-app/seo-generator-v3
cp .env.example .env     # fill in your API keys
docker-compose up
```

### Option C: Codespaces

Click the badge above. The devcontainer installs everything automatically, then:

```bash
# With Doppler (secrets manager)
doppler login
doppler setup            # select seo-generator-v3 project
npm run dev:doppler

# Or with .env file
cp .env.example .env     # fill in your API keys
npm run dev
```

### Option D: Local

```bash
git clone https://github.com/techfundoffice/seo-generator-v3-app.git
cd seo-generator-v3-app/ghl-marketplace-app/seo-generator-v3
npm run setup            # installs npm + pip deps
cp .env.example .env     # fill in your API keys
npm run dev
```

## What `npm run dev` Starts

| Service     | URL                     | Description            |
|-------------|-------------------------|------------------------|
| Express API | http://localhost:3000    | Backend API server     |
| Vue UI      | http://localhost:5173    | Frontend dev server    |

The Vite dev server proxies `/api/seo-generator-v3/*` requests to Express, so the Vue component works without code changes.

## Scripts

| Script          | Description                                    |
|-----------------|------------------------------------------------|
| `npm run dev`   | Start API + UI concurrently                    |
| `npm run dev:api` | Start Express API only                       |
| `npm run dev:ui`  | Start Vite UI only                           |
| `npm run dev:doppler` | Start with Doppler secrets injection      |
| `npm run build` | Compile TypeScript + build Vue UI              |
| `npm run setup` | Install npm + pip dependencies                 |
| `npm start`     | Run compiled production server                 |

## API Endpoints

### Health Check
```
GET /health
```

### Stats
```
GET /api/seo-generator-v3/stats
```

### Generate Article
```
POST /api/seo-generator-v3/generate
{
  "keyword": "best cat carrier for travel",
  "category": "cat-carriers-travel-products"
}
```

## Architecture

```
seo-generator-v3/
├── src/
│   ├── index.ts              # Express server entry point
│   ├── routes/               # API route handlers
│   ├── services/             # Business logic
│   │   ├── doppler-secrets   # Secrets from process.env
│   │   ├── claude-agent-sdk-client  # Claude Agent SDK text (article JSON)
│   │   ├── cloudflare-image  # FLUX.1 image generation + R2
│   │   ├── amazon-products   # Affiliate product search
│   │   └── research-engine   # SEO research pipeline
│   ├── config/               # Skill profiles & thresholds
│   ├── data/                 # Keywords, SEO data
│   ├── lib/                  # Vendored libraries
│   └── types/                # TypeScript types
├── ui/
│   ├── SEOArticleGeneratorV3.vue  # Main Vue component
│   ├── index.html            # Dev server HTML shell
│   ├── main.ts               # Vue app bootstrap
│   └── vite.config.ts        # Vite config with API proxy
├── .devcontainer/            # GitHub Codespaces config
└── tests/                    # Test files
```

## Environment Variables

See `.env.example` for the full list. At minimum you need:

| Variable               | Required | Description                        |
|------------------------|----------|------------------------------------|
| `CLOUDFLARE_API_TOKEN` | Yes      | Cloudflare API token               |
| `CLOUDFLARE_ACCOUNT_ID`| Yes     | Cloudflare account ID              |
| `ANTHROPIC_API_KEY`    | Yes      | Claude API key for content gen     |
| `AMAZON_AFFILIATE_TAG` | No       | Amazon Associates tag              |
| `GOOGLE_API_KEY`       | No       | Google Custom Search API key       |

## License

MIT
