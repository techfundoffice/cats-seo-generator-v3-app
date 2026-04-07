/**
 * SEO Generator V3 - Standalone Server
 * AI-powered article generation with Amazon affiliate integration
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import seoGeneratorV3Router from './routes/seo-generator-v3';

const DEFAULT_PORT = 3000;
const VITE_DEV_ORIGIN = 'http://localhost:5173';
const MAX_JSON_BODY_SIZE = '10mb';

const app = express();
const PORT = process.env.PORT || DEFAULT_PORT;

// CORS for Vite dev server
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: VITE_DEV_ORIGIN }));
}

// Middleware
app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
app.use(express.urlencoded({ extended: true }));

// Health check (gitSha confirms the running image matches a GitHub commit when built via CI)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'v3',
    timestamp: new Date().toISOString(),
    gitSha: process.env.APP_GIT_SHA || 'local-dev'
  });
});

// V3 SEO Generator routes
app.use('/api/seo-generator-v3', seoGeneratorV3Router);

// Serve Vue UI static files in production
if (process.env.NODE_ENV === 'production') {
  const uiDistPath = path.resolve(__dirname, '../ui/dist');
  app.use(express.static(uiDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(uiDistPath, 'index.html'));
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`[SEO Generator V3] Server running on port ${PORT}`);
  console.log(`[SEO Generator V3] API endpoint: http://localhost:${PORT}/api/seo-generator-v3`);
});

export default app;
