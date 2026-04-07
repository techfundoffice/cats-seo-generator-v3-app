import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api/seo-generator-v3': 'http://localhost:3000'
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist')
  }
});
