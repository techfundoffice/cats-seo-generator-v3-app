# SEO Generator V3 - Copilot Instructions

## Repository
This is the **standalone** SEO Generator V3 app (cats-seo-generator-v3-app).

## SEO Generator V3 - VPS Deployment

### Live URL
https://catsluvus-v3-seo-generator.catsluvus.com (BasicAuth: admin / verify)

### VPS Access
- Host: 72.60.30.39 (SSH key: ~/.ssh/vps1_catsluvus)
- SSH: ssh -i ~/.ssh/vps1_catsluvus root@72.60.30.39

### App Location on VPS
- Running path: /home/claudeuser/workspace/ghl-marketplace-app/seo-generator-v3/
- Git root: /home/claudeuser/workspace (remote: techfundoffice/cats-seo-generator-v3-app)
- PM2 runs as claudeuser (ID 17, name: seo-generator-v3)

### PM2 Commands
su -c 'pm2 list' claudeuser
su -c 'pm2 restart seo-generator-v3 --update-env' claudeuser
su -c 'pm2 logs seo-generator-v3 --lines 50' claudeuser

### Frontend (Vue UI)
- Built SPA at ui/dist/ -- served via express.static at /
- Build: cd ui and npm run build
- Framework: Vue 3 + Vite

### Database
- Fully isolated PostgreSQL DB: seo_generator_v3
- Container: localai-postgres-1, port 5433
- Tables: seo_articles, seo_categories, seo_discovery_state, seo_keywords, seo_research_cache
- DB URL in .env (not committed): postgresql://postgres:***@127.0.0.1:5433/seo_generator_v3

### Infrastructure
- Traefik router: catsluvus-v3-seo-generator with ghl-auth BasicAuth to port 3000
- Cloudflare DNS: A record catsluvus-v3-seo-generator.catsluvus.com to 72.60.30.39 (proxied)

### CI/CD (GitHub Actions)
- Workflow: .github/workflows/deploy-seo-v3.yml
- Triggers on push to main
- Deploys via SSH to VPS

### Secrets / Config
- Doppler project: replit-n8n-catsluvus, config: prd
- GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID are in Doppler