FROM node:20-slim

# Set at build time (see .github/workflows/deploy-seo-v3.yml) to verify production matches GitHub
ARG APP_GIT_SHA=unknown
ENV APP_GIT_SHA=$APP_GIT_SHA

WORKDIR /app

# Install python3 for youtube_search dependency
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Copy everything first (postinstall needs src/lib/amazon-creatorsapi)
COPY . .

# Install dependencies including devDependencies for build (postinstall runs: cd src/lib/amazon-creatorsapi && npm install)
RUN npm ci --production=false

# Install python dependency
RUN pip3 install youtube_search --break-system-packages 2>/dev/null || pip3 install youtube_search

# Build TypeScript API
RUN npx tsc

# Copy vendored lib (amazon-creatorsapi compiled dist) into TypeScript output
RUN cp -r src/lib dist/lib

# Build Vue UI
RUN npx vite build --config ui/vite.config.ts

ENV NODE_ENV=production
EXPOSE 3000

# Run with node (secrets via env vars or doppler)
CMD ["node", "dist/index.js"]