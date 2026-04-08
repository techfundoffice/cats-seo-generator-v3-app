<template>
  <div class="seo-generator seo-generator-v3">
    <header class="page-header">
      <div class="header-content">
        <div class="header-title-row">
          <h1>SEO Article Generator <span class="v3-badge">V3</span></h1>
          <span class="indexing-indicator">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 6v6l4 2"/>
            </svg>
            Indexing Tracker
          </span>
        </div>
        <p class="subtitle">Cloudflare AI-native generation with <strong>indexing verification</strong>, autonomous categories &amp; EEAT optimization</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" @click="refreshAll">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          Refresh
        </button>
      </div>
    </header>

    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-value">{{ queueData.totalKeywords.toLocaleString() }}</span>
          <span class="stat-label">Total Keywords</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon generated">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-value">{{ queueData.generated.toLocaleString() }}</span>
          <span class="stat-label">Generated</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon pending">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-value">{{ queueData.remaining.toLocaleString() }}</span>
          <span class="stat-label">Remaining</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon progress">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="20" x2="12" y2="10"/>
            <line x1="18" y1="20" x2="18" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="16"/>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-value">{{ queueData.percentComplete }}%</span>
          <span class="stat-label">Complete</span>
        </div>
      </div>

      <div class="stat-card" v-if="totalArticleCount > 0">
        <div class="stat-icon" style="color: #6366f1;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div class="stat-content">
          <span class="stat-value">{{ totalArticleCount.toLocaleString() }}</span>
          <span class="stat-label">Total Live (All Categories)</span>
        </div>
      </div>
    </div>

    <div class="single-column">
        <!-- Autonomous Mode -->
        <div class="section autonomous-section">
          <div class="section-header">
            <h2>⚡ Autonomous Mode</h2>
            <span class="status-badge" :class="{ active: autonomousRunning }">
              {{ autonomousRunning ? '● Running' : '○ Stopped' }}
            </span>
          </div>
          <p class="section-desc">Continuously generates articles across V3-exclusive categories</p>

          <div class="interval-selector">
            <label>Generation Interval:</label>
            <select v-model="selectedInterval" :disabled="autonomousRunning">
              <option :value="30000">30 seconds</option>
              <option :value="60000">1 minute</option>
              <option :value="120000">2 minutes</option>
              <option :value="300000">5 minutes</option>
            </select>
          </div>

          <div class="button-row">
            <button
              class="btn btn-success"
              :disabled="autonomousRunning"
              @click="startAutonomous"
            >
              ▶ Start
            </button>
            <button
              class="btn btn-danger"
              :disabled="!autonomousRunning"
              @click="stopAutonomous"
            >
              ■ Stop
            </button>
          </div>

          <div class="progress-overall" v-if="autonomousRunning">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: queueData.percentComplete + '%' }"></div>
            </div>
            <span class="progress-text">{{ queueData.percentComplete }}% complete</span>
            <span v-if="estimatedTimeRemaining" class="progress-eta">{{ estimatedTimeRemaining }}</span>
          </div>
        </div>

        <!-- Generate Single Article -->
        <div class="section generator-section">
          <div class="section-header">
            <h2>📝 Generate Single Article</h2>
            <span class="badge" v-if="isGenerating">Generating...</span>
          </div>

          <div class="input-group">
            <label for="keyword">Target Keyword</label>
            <input
              id="keyword"
              v-model="keyword"
              type="text"
              placeholder="e.g., best pet insurance for cats"
              :disabled="isGenerating"
              @keyup.enter="generateArticle"
            />
          </div>

          <button
            class="btn btn-primary full-width"
            :disabled="!keyword.trim() || isGenerating"
            @click="generateArticle"
          >
            <svg v-if="isGenerating" class="spinner" width="16" height="16" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 70"/>
            </svg>
            {{ isGenerating ? 'Generating...' : 'Generate Article' }}
          </button>
        </div>

        <!-- Article Progress & Activity -->
        <div class="section activity-section">
          <!-- View toggle -->
          <div class="section-header">
            <h2>Live Output Log</h2>
            <div class="log-header-actions">
              <span class="polling-indicator" :class="{ active: isPolling, error: pollError }" :title="pollError ? 'Last poll failed — retrying' : ''">
                <span class="polling-dot"></span>
                {{ isPolling ? (pollError ? '⚠ Retrying' : 'Live') : 'Paused' }}
              </span>
              <button class="btn btn-sm btn-secondary" @click="copyLog" title="Copy log to clipboard">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                Copy
              </button>
              <button class="btn btn-sm btn-secondary" @click="pollActivityLog">Refresh</button>
            </div>
          </div>

          <div class="developer-view">
            <!-- Session Health Banner (original) -->
            <div class="health-banner-inner" v-if="sessionHealth">
              <div class="health-header">
                <span class="health-title">Session Health</span>
                <span class="health-badge" :class="healthStatus.cls">{{ healthStatus.label }}</span>
              </div>
              <div class="health-stats-row">
                <div class="health-stat">
                  <span class="health-stat-value">{{ sessionHealth.generated }}</span>
                  <span class="health-stat-label">generated</span>
                </div>
                <div class="health-stat">
                  <span class="health-stat-value health-stat-fail" v-if="sessionHealth.failed > 0">{{ sessionHealth.failed }}</span>
                  <span class="health-stat-value" v-else>0</span>
                  <span class="health-stat-label">failed</span>
                </div>
                <div class="health-stat">
                  <span class="health-stat-value">{{ sessionHealth.deployed }}</span>
                  <span class="health-stat-label">deployed</span>
                </div>
                <div class="health-stat">
                  <span class="health-stat-value">{{ sessionHealth.avgSeoScore || '--' }}</span>
                  <span class="health-stat-label">avg SEO</span>
                </div>
              </div>
              <div class="health-current" v-if="sessionHealth.currentKeyword">
                <span class="health-current-icon">&#9654;</span>
                <span class="health-current-text">
                  Generating "<strong>{{ truncatedKeyword }}</strong>" &mdash; {{ sessionHealth.currentStage }}
                  <span class="health-stage-time" v-if="sessionHealth.currentStageDuration">({{ sessionHealth.currentStageDuration }})</span>
                </span>
              </div>
              <div class="health-footer">
                <span>Uptime: {{ sessionHealth.uptime || '0s' }}</span>
                <span class="health-divider">|</span>
                <span>Rate: ~{{ sessionHealth.rate }}</span>
              </div>
              <div class="health-error" v-if="sessionHealth.lastError && sessionHealth.consecutiveErrors > 0">
                Last error: {{ sessionHealth.lastError }}
              </div>
            </div>

            <!-- Log toolbar: search, filter, controls -->
            <div class="log-toolbar">
              <div class="log-search-wrap">
                <svg class="log-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  v-model="logSearchQuery"
                  class="log-search-input"
                  type="text"
                  placeholder="Search log..."
                />
              </div>
              <div class="log-filter-btns">
                <button
                  v-for="f in (['all','success','error','info','generating'] as const)"
                  :key="f"
                  class="log-filter-btn"
                  :class="{ active: logStatusFilter === f, [f]: true }"
                  @click="logStatusFilter = f"
                >{{ f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) }} <span class="log-filter-count">{{ logFilterCounts[f] }}</span></button>
              </div>
              <div class="log-toolbar-right">
                <span class="last-poll-time" v-if="lastPollTime">{{ lastPollTime }}</span>
                <button
                  class="btn btn-sm log-scroll-toggle"
                  :class="{ paused: pauseAutoScroll }"
                  @click="pauseAutoScroll = !pauseAutoScroll"
                  :title="pauseAutoScroll ? 'Resume auto-scroll' : 'Pause auto-scroll'"
                >{{ pauseAutoScroll ? 'Scroll Paused' : 'Auto-scroll' }}</button>
                <button class="btn btn-sm btn-secondary" @click="clearLog">Clear</button>
              </div>
            </div>

            <!-- Log container with grouped entries -->
            <div class="log-container" ref="logContainer">
              <template v-for="(group, gi) in groupedLog" :key="gi">
                <!-- Keyword group header (skip for ungrouped) -->
                <div
                  v-if="group.keyword !== '_ungrouped'"
                  class="log-group-header"
                  :class="{ collapsed: collapsedKeywords.has(group.keyword), 'has-error': group.hasError, 'has-success': group.hasSuccess }"
                  @click="toggleKeywordGroup(group.keyword)"
                >
                  <span class="log-group-chevron">{{ collapsedKeywords.has(group.keyword) ? '\u25B6' : '\u25BC' }}</span>
                  <span class="log-group-keyword">{{ group.keyword }}</span>
                  <span class="log-group-count">{{ group.entries.length }} entries</span>
                  <span class="log-group-time">{{ group.latestTime }}</span>
                </div>
                <!-- Group entries (hidden when collapsed) -->
                <template v-if="!collapsedKeywords.has(group.keyword)">
                  <div
                    v-for="(entry, index) in group.entries"
                    :key="`${gi}-${index}`"
                    class="log-entry"
                    :class="[entry.status, { 'is-history': entry.source === 'history' }]"
                    @click="toggleEntryExpand(entry)"
                  >
                    <span class="log-time">{{ entry.time }}</span>
                    <span class="log-priority" :class="entry.priority || 'INFO'">{{ entry.priority?.toUpperCase() || 'INFO' }}</span>
                    <span class="log-message">{{ entry.message }}</span>
                    <span v-if="entry.source === 'history'" class="log-history-badge">history</span>
                    <span v-if="entry.errorDetail" class="log-error-detail">{{ entry.errorDetail }}</span>
                    <a v-if="entry.richResultsUrl" :href="entry.richResultsUrl" target="_blank" class="log-url rich-results-link" @click.stop>🧪 Test Rich Results</a>
                    <a v-if="entry.url" :href="entry.url" target="_blank" class="log-url" @click.stop>{{ entry.url }}</a>
                    <!-- Expandable details panel -->
                    <div v-if="entry.expanded && entry.details" class="log-detail-panel">
                      <div class="log-detail-row" v-for="(val, key) in entry.details" :key="key">
                        <span class="log-detail-key">{{ key }}</span>
                        <span class="log-detail-val">{{ typeof val === 'object' ? JSON.stringify(val) : val }}</span>
                      </div>
                    </div>
                  </div>
                </template>
              </template>
              <div class="log-empty" v-if="filteredLog.length === 0">
                <template v-if="logSearchQuery || logStatusFilter !== 'all'">No entries match your filter.</template>
                <template v-else>No activity yet. Start autonomous mode or generate an article.</template>
              </div>
            </div>
          </div>
        </div>

        <!-- Index Status (V3-unique) -->
        <div class="section index-status-section">
          <div class="section-header">
            <h2>🔍 Indexing Status</h2>
            <div class="index-actions">
              <span class="count" v-if="indexStatus">{{ indexStatus.indexed }}/{{ indexStatus.total }} indexed</span>
              <button class="btn btn-sm btn-secondary" @click="refreshIndexStatus">Refresh</button>
              <button class="btn btn-sm btn-secondary" @click="processIndexQueue">Process Queue</button>
            </div>
          </div>

          <div class="index-summary" v-if="indexStatus">
            <div class="index-stat indexed">
              <span class="index-stat-value">{{ indexStatus.indexed }}</span>
              <span class="index-stat-label">Indexed</span>
            </div>
            <div class="index-stat pending-index">
              <span class="index-stat-value">{{ indexStatus.pending }}</span>
              <span class="index-stat-label">Pending</span>
            </div>
            <div class="index-stat not-indexed">
              <span class="index-stat-value">{{ indexStatus.notIndexed }}</span>
              <span class="index-stat-label">Not Indexed</span>
            </div>
          </div>

          <div class="empty-state" v-else>
            <p>Loading index status...</p>
          </div>
        </div>

        <!-- Category Breakdown -->
        <div class="section categories-section">
          <div class="section-header">
            <h2>📊 Category Breakdown</h2>
          </div>
          <div class="category-grid">
            <div class="category-item" v-for="(count, category) in queueData.categoryBreakdown" :key="category">
              <span class="category-icon">{{ getCategoryIcon(category) }}</span>
              <span class="category-count">{{ count.toLocaleString() }}</span>
              <span class="category-name">{{ formatCategory(category) }}</span>
            </div>
          </div>
        </div>

        <!-- Recent Articles -->
        <div class="section recent-section">
          <div class="section-header">
            <h2>📰 Recent Articles</h2>
            <span class="count">{{ totalArticleCount > recentArticles.length ? totalArticleCount.toLocaleString() + ' total' : recentArticles.length + ' articles' }}</span>
          </div>

          <div class="articles-list" v-if="recentArticles.length > 0">
            <div class="article-item" v-for="article in recentArticles" :key="article.slug">
              <div class="article-info">
                <strong>{{ article.title || article.keyword }}</strong>
                <div class="article-meta">
                  <span v-if="article.category" class="meta-badge category-badge">
                    {{ formatCategory(article.category) }}
                  </span>
                  <span v-else class="meta-badge" :class="article.priority || 'low'">
                    {{ (article.priority || 'N/A').toUpperCase() }}
                  </span>
                  <code>{{ article.slug }}</code>
                  <span v-if="article.wordCount">{{ article.wordCount?.toLocaleString() }} words</span>
                </div>
              </div>
              <div class="article-actions">
                <a
                  v-if="article.liveUrl"
                  :href="getSchemaTestUrl(article.liveUrl)"
                  target="_blank"
                  rel="noopener"
                  class="test-schema-link"
                  title="Test with Google Rich Results"
                >
                  🧪
                </a>
                <span class="deploy-status" :class="{ deployed: article.deployed }">
                  {{ article.deployed ? '✓ Live' : '⏳ Pending' }}
                </span>
                <a
                  v-if="article.liveUrl"
                  :href="article.liveUrl"
                  target="_blank"
                  rel="noopener"
                  class="view-link"
                >
                  View →
                </a>
              </div>
            </div>
          </div>

          <div class="empty-state" v-else>
            <p>No articles generated yet</p>
          </div>
        </div>

        <!-- Sitemap Section -->
        <div class="section sitemap-section">
          <div class="section-header">
            <h2>🗺️ Live Sitemap (All Categories)</h2>
            <div class="sitemap-actions">
              <span class="count">{{ sitemapUrls.length }} pages</span>
              <button class="btn btn-sm btn-secondary" @click="refreshSitemap">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                </svg>
                Refresh
              </button>
            </div>
          </div>

          <div class="sitemap-filter">
            <input
              v-model="sitemapSearch"
              type="text"
              placeholder="Filter pages..."
              class="sitemap-search"
            />
          </div>

          <div class="sitemap-grid" v-if="filteredSitemapUrls.length > 0">
            <a
              v-for="item in filteredSitemapUrls"
              :key="item.url"
              :href="item.url"
              target="_blank"
              rel="noopener"
              class="sitemap-item"
            >
              <span v-if="item.category" class="sitemap-category">{{ formatCategory(item.category) }}</span>
              <span class="sitemap-title">{{ item.title }}</span>
              <code class="sitemap-slug">{{ item.slug }}</code>
            </a>
          </div>

          <div class="empty-state" v-else-if="sitemapSearch">
            <p>No pages match "{{ sitemapSearch }}"</p>
          </div>

          <div class="empty-state" v-else>
            <p>Loading sitemap...</p>
          </div>
        </div>
    </div>

    <!-- Generated Article Preview -->
    <div class="section preview-section" v-if="generatedArticle">
      <div class="section-header">
        <h2>Generated Article</h2>
        <div class="preview-actions">
          <a
            v-if="generatedArticle.liveUrl"
            :href="generatedArticle.liveUrl"
            target="_blank"
            rel="noopener"
            class="btn btn-success"
          >
            View Live →
          </a>
          <button class="btn btn-secondary" @click="copyArticle">Copy HTML</button>
        </div>
      </div>

      <div class="article-preview">
        <div class="preview-meta">
          <span><strong>Title:</strong> {{ generatedArticle.title }}</span>
          <span><strong>Words:</strong> {{ generatedArticle.wordCount }}</span>
          <span><strong>Slug:</strong> {{ generatedArticle.slug }}</span>
          <span v-if="generatedArticle.deployed" class="deployed-badge">✓ Deployed to Cloudflare</span>
        </div>
        <div class="preview-content" v-html="generatedArticle.preview"></div>
      </div>
    </div>

    <div class="toast" v-if="toast.show" :class="toast.type">
      {{ toast.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, nextTick } from 'vue'

const API_BASE = '/api/seo-generator-v3'

interface Article {
  keyword: string
  slug: string
  title?: string
  wordCount?: number
  date: string
  deployed?: boolean
  liveUrl?: string | null
  priority?: string
  score?: number
  category?: string
}

interface GeneratedArticle {
  title: string
  slug: string
  wordCount: number
  preview: string
  deployed?: boolean
  liveUrl?: string | null
}

interface LogEntry {
  time: string
  message: string
  status: 'success' | 'error' | 'info' | 'generating'
  priority?: string
  url?: string
  richResultsUrl?: string
  errorDetail?: string
  keyword?: string
  details?: Record<string, any>
  expanded?: boolean
  source?: 'live' | 'history'
}

interface QueueData {
  totalKeywords: number
  generated: number
  remaining: number
  percentComplete: string
  categoryBreakdown: Record<string, number>
}

interface IndexStatusData {
  total: number
  indexed: number
  pending: number
  notIndexed: number
}

interface SessionHealthData {
  active: boolean
  uptime: string
  generated: number
  failed: number
  deployed: number
  avgSeoScore: number
  currentKeyword: string | null
  currentStage: string | null
  currentStageDuration: string | null
  rate: string
  consecutiveErrors: number
  lastError: string | null
  avgGenerationMs?: number
}

interface SitemapItem {
  url: string
  slug: string
  title: string
  category?: string
}

const keyword = ref('')
const isGenerating = ref(false)
const autonomousRunning = ref(false)
const selectedInterval = ref(120000)
const generatedArticle = ref<GeneratedArticle | null>(null)
const recentArticles = ref<Article[]>([])
const outputLog = ref<LogEntry[]>([])
const pauseAutoScroll = ref(false)
const logContainer = ref<HTMLElement | null>(null)
const sitemapUrls = ref<SitemapItem[]>([])
const sitemapSearch = ref('')
const totalArticleCount = ref(0)
const isPolling = ref(false)
const pollError = ref(false)
const lastPollTime = ref('')
const indexStatus = ref<IndexStatusData | null>(null)
const sessionHealth = ref<SessionHealthData | null>(null)

// Log improvements: search, filter, grouping
const logSearchQuery = ref('')
const logStatusFilter = ref<'all' | 'success' | 'error' | 'info' | 'generating'>('all')
const collapsedKeywords = ref<Set<string>>(new Set())
const historyLoaded = ref(false)


const queueData = reactive<QueueData>({
  totalKeywords: 0,
  generated: 0,
  remaining: 0,
  percentComplete: '0.00',
  categoryBreakdown: {}
})

const toast = reactive({
  show: false,
  message: '',
  type: 'success'
})

let statusInterval: number | null = null
let activityPollInterval: number | null = null
let lastActivityId = 0
let isActivityPollInFlight = false
let activityPollAbortController: AbortController | null = null

const healthStatus = computed(() => {
  if (!sessionHealth.value || !sessionHealth.value.active) return { label: 'Idle', cls: 'idle' }
  if (sessionHealth.value.consecutiveErrors >= 3) return { label: 'Failing', cls: 'failing' }
  if (sessionHealth.value.consecutiveErrors >= 1) return { label: 'Warning', cls: 'warning' }
  return { label: 'Healthy', cls: 'healthy' }
})

const truncatedKeyword = computed(() => {
  const kw = sessionHealth.value?.currentKeyword
  if (!kw) return null
  return kw.length > 40 ? kw.slice(0, 37) + '...' : kw
})

const progressPercent = computed(() => {
  if (!queueData.totalKeywords || queueData.totalKeywords === 0) return 0
  return Math.min(100, Math.round((queueData.generated / queueData.totalKeywords) * 100))
})

const estimatedTimeRemaining = computed(() => {
  if (!sessionHealth.value?.active || !sessionHealth.value.avgGenerationMs) return null
  const remaining = queueData.remaining
  if (remaining <= 0) return 'Done!'
  const avgMs = sessionHealth.value.avgGenerationMs
  const totalMs = remaining * avgMs
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  if (hours > 0) return `~${hours}h ${minutes}m remaining`
  if (minutes > 0) return `~${minutes}m remaining`
  return 'Less than a minute'
})

const filteredSitemapUrls = computed(() => {
  if (!sitemapSearch.value) return sitemapUrls.value
  const search = sitemapSearch.value.toLowerCase()
  return sitemapUrls.value.filter(item =>
    item.title.toLowerCase().includes(search) ||
    item.slug.toLowerCase().includes(search)
  )
})

// Filtered log entries based on search query and status filter
const filteredLog = computed(() => {
  let entries = outputLog.value
  if (logStatusFilter.value !== 'all') {
    entries = entries.filter(e => e.status === logStatusFilter.value)
  }
  if (logSearchQuery.value) {
    const q = logSearchQuery.value.toLowerCase()
    entries = entries.filter(e =>
      e.message.toLowerCase().includes(q) ||
      (e.keyword && e.keyword.toLowerCase().includes(q)) ||
      (e.url && e.url.toLowerCase().includes(q)) ||
      (e.errorDetail && e.errorDetail.toLowerCase().includes(q))
    )
  }
  return entries
})

// Group log entries by keyword for collapsible sections
interface LogGroup {
  keyword: string
  entries: LogEntry[]
  latestTime: string
  hasError: boolean
  hasSuccess: boolean
}
const groupedLog = computed((): LogGroup[] => {
  const map = new Map<string, LogGroup>()

  // filteredLog is newest-first (entries are prepended via unshift).
  // Map insertion order reflects first encounter, so iterating the map gives groups
  // in newest-first order naturally — no time-string comparison needed.
  for (const entry of filteredLog.value) {
    const kw = entry.keyword || '_ungrouped'
    let group = map.get(kw)
    if (!group) {
      // First encounter for this keyword is the newest entry; record its time once.
      group = { keyword: kw, entries: [], latestTime: entry.time, hasError: false, hasSuccess: false }
      map.set(kw, group)
    }
    group.entries.push(entry)
    if (entry.status === 'error') group.hasError = true
    if (entry.status === 'success') group.hasSuccess = true
  }

  // Preserve Map insertion order (newest group first); push _ungrouped to the end.
  const groups = Array.from(map.values())
  const ungroupedIdx = groups.findIndex(g => g.keyword === '_ungrouped')
  if (ungroupedIdx > 0) {
    groups.push(...groups.splice(ungroupedIdx, 1))
  }
  return groups
})

const toggleKeywordGroup = (keyword: string) => {
  const s = new Set(collapsedKeywords.value)
  if (s.has(keyword)) { s.delete(keyword) } else { s.add(keyword) }
  collapsedKeywords.value = s
}

const toggleEntryExpand = (entry: LogEntry) => {
  entry.expanded = !entry.expanded
}

const logFilterCounts = computed(() => ({
  all: outputLog.value.length,
  success: outputLog.value.filter(e => e.status === 'success').length,
  error: outputLog.value.filter(e => e.status === 'error').length,
  info: outputLog.value.filter(e => e.status === 'info').length,
  generating: outputLog.value.filter(e => e.status === 'generating').length,
}))

const showToast = (message: string, type = 'success') => {
  toast.message = message
  toast.type = type
  toast.show = true
  setTimeout(() => { toast.show = false }, 3000)
}

const addLogEntry = (message: string, status: LogEntry['status'], priority?: string, url?: string, richResultsUrl?: string, errorDetail?: string, keyword?: string, details?: Record<string, any>, source: 'live' | 'history' = 'live') => {
  const now = new Date()
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  outputLog.value.unshift({ time, message, status, priority, url, richResultsUrl, errorDetail, keyword, details, expanded: false, source })

  if (outputLog.value.length > 500) {
    outputLog.value = outputLog.value.slice(0, 500)
  }

  if (!pauseAutoScroll.value && logContainer.value) {
    nextTick(() => {
      logContainer.value!.scrollTop = 0
    })
  }
}

const clearLog = () => {
  outputLog.value = []
}

const copyLog = async () => {
  const text = outputLog.value.map(entry => {
    const prio = entry.priority ? `[${entry.priority.toUpperCase()}]` : '[INFO]'
    const url = entry.url ? `\n  ${entry.url}` : ''
    return `${entry.time}  ${prio}  ${entry.message}${url}`
  }).join('\n')

  try {
    await navigator.clipboard.writeText(text)
    showToast('Log copied to clipboard')
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    showToast('Log copied to clipboard')
  }
}

const getCategoryIcon = (category: string): string => {
  const icons: Record<string, string> = {
    'comparison': '⚖️',
    'best-of': '🏆',
    'cost': '💰',
    'general': '📋',
    'location': '📍',
    'dogs': '🐕',
    'cats': '🐱',
    'conditions': '🏥',
    'exotic': '🦜',
    'senior-pets': '👴',
    'provider-reviews': '⭐'
  }
  return icons[category] || '📄'
}

const formatCategory = (category: string): string => {
  return category.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

const getSchemaTestUrl = (url: string) => {
  return `https://search.google.com/test/rich-results?url=${encodeURIComponent(url)}`
}

const refreshAll = async () => {
  addLogEntry('Refreshing data...', 'info')
  await Promise.all([
    refreshQueue(),
    refreshRecent(),
    refreshSitemap(),
    refreshIndexStatus()
  ])
  addLogEntry('Data refreshed', 'success')
}

const refreshQueue = async () => {
  try {
    const response = await fetch(`${API_BASE}/queue`)
    if (response.ok) {
      const data = await response.json()
      queueData.totalKeywords = data.queue?.totalKeywords || 0
      queueData.generated = data.queue?.generated || 0
      queueData.remaining = data.queue?.remaining || 0
      queueData.percentComplete = data.queue?.percentComplete || '0.00'
      queueData.categoryBreakdown = data.categoryBreakdown || {}
      autonomousRunning.value = data.autonomousRunning || false
    }
  } catch (error) {
    console.error('Failed to refresh queue:', error)
  }
}

const refreshRecent = async () => {
  try {
    const response = await fetch(`${API_BASE}/recent`)
    if (response.ok) {
      const data = await response.json()
      recentArticles.value = data.articles || []
    }
    // If still empty after /recent, fallback to /all-articles from KV
    if (recentArticles.value.length === 0) {
      try {
        const fallback = await fetch(`${API_BASE}/all-articles?limit=50`)
        if (fallback.ok) {
          const allData = await fallback.json()
          if (allData.articles && allData.articles.length > 0) {
            recentArticles.value = allData.articles.map((a: any) => ({
              keyword: a.title,
              slug: a.slug,
              title: a.title,
              wordCount: 0,
              date: new Date().toISOString(),
              deployed: true,
              liveUrl: a.url,
              category: a.category
            }))
            totalArticleCount.value = allData.total || 0
          }
        }
      } catch (e) {
        console.error('Failed to fetch all-articles fallback:', e)
      }
    }
  } catch (error) {
    console.error('Failed to refresh recent:', error)
  }
}

const refreshSitemap = async () => {
  try {
    const response = await fetch(`${API_BASE}/sitemap-all`)
    if (response.ok) {
      const data = await response.json()
      sitemapUrls.value = data.urls || []
      if (data.total) {
        totalArticleCount.value = Math.max(totalArticleCount.value, data.count || 0)
      }
    }
  } catch (error) {
    // Fallback to single-category sitemap
    try {
      const fallback = await fetch(`${API_BASE}/sitemap`)
      if (fallback.ok) {
        const data = await fallback.json()
        sitemapUrls.value = data.urls || []
      }
    } catch (e) {
      console.error('Failed to refresh sitemap:', e)
    }
  }
}

const refreshIndexStatus = async () => {
  try {
    const response = await fetch(`${API_BASE}/index-status`)
    if (response.ok) {
      const data = await response.json()
      indexStatus.value = {
        total: data.total || 0,
        indexed: data.indexed || 0,
        pending: data.pending || 0,
        notIndexed: data.notIndexed || 0
      }
    }
  } catch (error) {
    console.error('Failed to refresh index status:', error)
  }
}

const processIndexQueue = async () => {
  try {
    addLogEntry('Processing index verification queue...', 'info')
    const response = await fetch(`${API_BASE}/index-status/process`, { method: 'POST' })
    if (response.ok) {
      const data = await response.json()
      addLogEntry(`Index queue processed: ${data.processed || 0} checked`, 'success')
      await refreshIndexStatus()
    }
  } catch (error) {
    addLogEntry('Failed to process index queue', 'error')
  }
}

const pollSessionHealth = async () => {
  try {
    const response = await fetch(`${API_BASE}/session-health`)
    if (response.ok) {
      sessionHealth.value = await response.json()
    }
  } catch (error) {
    // Silent fail - session health is non-critical
  }
}

const pollActivityLog = async () => {
  if (isActivityPollInFlight) return

  isActivityPollInFlight = true
  isPolling.value = true
  const now = new Date()
  lastPollTime.value = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  pollSessionHealth()

  if (activityPollAbortController) {
    activityPollAbortController.abort()
  }
  activityPollAbortController = new AbortController()
  const signal = activityPollAbortController.signal

  try {
    const response = await fetch(`${API_BASE}/activity-log?since=${lastActivityId}&limit=50`, { signal })
    if (!response.ok) {
      pollError.value = true
      isActivityPollInFlight = false
      return
    }
    pollError.value = false

    const data = await response.json()
    if (!data.logs || data.logs.length === 0) {
      isPolling.value = true
      isActivityPollInFlight = false
      return
    }

    const statusMap: Record<string, LogEntry['status']> = {
      'info': 'info',
      'success': 'success',
      'error': 'error',
      'generating': 'generating',
      'deployed': 'success',
      'queue': 'info',
      'warning': 'error'
    }

    const sortedLogs = [...data.logs].sort((a: any, b: any) => a.id - b.id)

    for (const log of sortedLogs) {
      if (log.id <= lastActivityId) continue

      lastActivityId = log.id
      const details = log.details || {}

      let message = log.message
      if (details.liveSeoScore != null && details.preDeployScore != null) {
        const d = details.seoScoreDelta ?? (details.liveSeoScore - details.preDeployScore)
        const sign = d >= 0 ? '+' : ''
        message += ` | Pre ${details.preDeployScore}/100 → Live ${details.liveSeoScore}/100 (Δ ${sign}${d})`
      } else if (details.seoScore && details.seoScore > 0 && !log.message.includes('SEO:')) {
        message += ` | SEO: ${details.seoScore}/100`
      }
      if (details.wordCount) message += ` (${details.wordCount.toLocaleString()} words)`
      if (details.duration) message += ` [${(details.duration / 1000).toFixed(1)}s]`
      if (details.remaining !== undefined && log.type !== 'queue') {
        message += ` • ${details.remaining.toLocaleString()} remaining`
      }

      const errorDetail = (log.type === 'error' && details.step)
        ? `[${details.step}] ${details.error || 'Unknown error'}`
        : undefined

      addLogEntry(message, statusMap[log.type] || 'info', details.priority, details.url, details.richResultsUrl, errorDetail, details.keyword, details)
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('Failed to poll activity log:', error)
    }
  } finally {
    isActivityPollInFlight = false
  }
}

const startActivityPolling = () => {
  if (activityPollInterval) return
  activityPollInterval = window.setInterval(pollActivityLog, 5000)
  pollActivityLog()
}

const stopActivityPolling = () => {
  if (activityPollInterval) {
    clearInterval(activityPollInterval)
    activityPollInterval = null
  }
  if (activityPollAbortController) {
    activityPollAbortController.abort()
    activityPollAbortController = null
  }
  isActivityPollInFlight = false
  isPolling.value = false
}

const generateArticle = async () => {
  if (!keyword.value.trim() || isGenerating.value) return

  const currentKeyword = keyword.value.trim()
  isGenerating.value = true
  generatedArticle.value = null
  addLogEntry(`V3 Generating: "${currentKeyword}"`, 'generating', undefined, undefined, undefined, undefined, currentKeyword)

  try {
    const response = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: currentKeyword
      })
    })

    if (!response.ok) throw new Error('Generation failed')

    const data = await response.json()

    generatedArticle.value = {
      title: data.title || currentKeyword,
      slug: data.slug,
      wordCount: data.wordCount || 0,
      preview: data.preview || '<p>Article generated successfully</p>',
      deployed: data.deployed,
      liveUrl: data.liveUrl
    }

    addLogEntry(`✓ V3 Generated: ${data.title}`, 'success', 'high', data.liveUrl, undefined, undefined, currentKeyword)
    showToast(`Article generated: ${data.slug}${data.deployed ? ' (Deployed!)' : ''}`)
    keyword.value = ''
    refreshQueue()
    refreshRecent()
  } catch (error) {
    console.error('V3 Generation error:', error)
    addLogEntry(`✗ Failed to generate: ${currentKeyword}`, 'error', undefined, undefined, undefined, undefined, currentKeyword)
    showToast('Failed to generate article', 'error')
  } finally {
    isGenerating.value = false
  }
}

const startAutonomous = async () => {
  try {
    const response = await fetch(`${API_BASE}/autonomous/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs: selectedInterval.value })
    })

    if (response.ok) {
      autonomousRunning.value = true
      showToast('Autonomous generation started')

      startActivityPolling()

      statusInterval = window.setInterval(async () => {
        await refreshQueue()
        await refreshRecent()
      }, 15000)
    }
  } catch (error) {
    addLogEntry('✗ Failed to start autonomous mode', 'error')
    showToast('Failed to start autonomous mode', 'error')
  }
}

const stopAutonomous = async () => {
  try {
    const response = await fetch(`${API_BASE}/autonomous/stop`, {
      method: 'POST'
    })

    if (response.ok) {
      autonomousRunning.value = false
      showToast('Autonomous generation stopped')

      if (statusInterval) {
        clearInterval(statusInterval)
        statusInterval = null
      }
    }
  } catch (error) {
    addLogEntry('✗ Failed to stop autonomous mode', 'error')
    showToast('Failed to stop autonomous mode', 'error')
  }
}

const copyArticle = async () => {
  if (!generatedArticle.value) return
  try {
    await navigator.clipboard.writeText(generatedArticle.value.preview)
    showToast('HTML copied to clipboard')
  } catch (error) {
    showToast('Failed to copy', 'error')
  }
}

// Load persistent history from API (survives page refresh)
const loadHistoryFromAPI = async () => {
  if (historyLoaded.value) return
  try {
    const [histRes, errRes] = await Promise.all([
      fetch(`${API_BASE}/history?limit=100`).catch(() => null),
      fetch(`${API_BASE}/errors?limit=50`).catch(() => null),
    ])
    if (histRes && histRes.ok) {
      const data = await histRes.json()
      if (data.records && data.records.length > 0) {
        for (const rec of data.records) {
          const ts = new Date(rec.timestamp)
          const time = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          const msg = `[History] ${rec.keyword} | SEO: ${rec.seoScore}/100 | ${rec.wordCount} words | ${rec.model}`
          outputLog.value.push({
            time,
            message: msg,
            status: 'success',
            keyword: rec.keyword,
            url: rec.url,
            details: rec,
            expanded: false,
            source: 'history',
          })
        }
      }
    }
    if (errRes && errRes.ok) {
      const data = await errRes.json()
      if (data.records && data.records.length > 0) {
        for (const rec of data.records) {
          const ts = new Date(rec.timestamp)
          const time = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          outputLog.value.push({
            time,
            message: `[History] Failed: ${rec.keyword} at ${rec.step}`,
            status: 'error',
            keyword: rec.keyword,
            errorDetail: rec.error,
            details: rec,
            expanded: false,
            source: 'history',
          })
        }
      }
    }
    historyLoaded.value = true
  } catch (e) {
    // Non-critical: history API may not be available yet
  }
}

onMounted(async () => {
  // Add startup log entry so the log is never blank
  addLogEntry('Dashboard connected - loading data...', 'info')

  await refreshAll()
  pollSessionHealth()

  // Load persistent history from backend (survives page refresh)
  loadHistoryFromAPI()

  // Always start activity polling for real-time V3 output
  startActivityPolling()

  if (autonomousRunning.value) {
    statusInterval = window.setInterval(async () => {
      await refreshQueue()
      await refreshRecent()
    }, 15000)
  }
})

onUnmounted(() => {
  if (statusInterval) {
    clearInterval(statusInterval)
  }
  stopActivityPolling()
})
</script>

<style scoped>
/* V3 Badge - Blue theme */
.seo-generator-v3 .v3-badge {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}

.header-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.indexing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(59, 130, 246, 0.2);
}

/* Base Styles */
.seo-generator {
  padding: 24px;
  max-width: 1600px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

.header-content h1 {
  font-size: 28px;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0 0 4px 0;
}

.subtitle {
  color: #6b7280;
  margin: 0;
  font-size: 14px;
}

.header-actions {
  display: flex;
  gap: 12px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
  text-decoration: none;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary { background: #3b82f6; color: white; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }

.btn-secondary { background: #f3f4f6; color: #374151; }
.btn-secondary:hover:not(:disabled) { background: #e5e7eb; }

.btn-success { background: #16a34a; color: white; }
.btn-success:hover:not(:disabled) { background: #15803d; }

.btn-danger { background: #dc2626; color: white; }
.btn-danger:hover:not(:disabled) { background: #b91c1c; }

.btn-sm { padding: 6px 12px; font-size: 12px; }
.full-width { width: 100%; justify-content: center; }

/* Stats Grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: white;
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  gap: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: #dbeafe;
  color: #2563eb;
  display: flex;
  align-items: center;
  justify-content: center;
}

.stat-icon.generated { background: #dcfce7; color: #16a34a; }
.stat-icon.pending { background: #fef3c7; color: #d97706; }
.stat-icon.progress { background: #ede9fe; color: #7c3aed; }

.stat-content { display: flex; flex-direction: column; }
.stat-value { font-size: 24px; font-weight: 700; color: #1a1a2e; }
.stat-label { font-size: 13px; color: #6b7280; }

/* Single Column Layout */
.single-column {
  display: flex;
  flex-direction: column;
  gap: 24px;
  margin-bottom: 24px;
}

/* Move Activity/Output Log above Autonomous Mode */
.single-column .activity-section {
  order: -1;
}

.section {
  background: white;
  border-radius: 12px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h2 {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a2e;
  margin: 0;
}

.section-desc {
  color: #6b7280;
  font-size: 14px;
  margin: 0 0 16px 0;
}

.status-badge {
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
}

.status-badge.active {
  background: #dcfce7;
  color: #16a34a;
}

.badge {
  background: #fef3c7;
  color: #d97706;
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
}

.count { color: #6b7280; font-size: 14px; }

/* Interval Selector */
.interval-selector {
  margin-bottom: 16px;
}

.interval-selector label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 8px;
}

.interval-selector select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 14px;
  background: white;
}

.button-row {
  display: flex;
  gap: 12px;
}

.progress-overall {
  margin-top: 16px;
}

.progress-bar {
  height: 8px;
  background: #e5e7eb;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 13px;
  color: #6b7280;
}

.progress-eta {
  font-size: 13px;
  color: #6b7280;
  margin-left: 8px;
}

/* Input Group */
.input-group {
  margin-bottom: 16px;
}

.input-group label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 8px;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 14px;
}

.input-group input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

/* Log Section */
.log-section {
  max-height: none;
  display: flex;
  flex-direction: column;
}

.log-container {
  flex: 1;
  overflow-y: scroll;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-family: 'Monaco', 'Menlo', monospace;
  font-size: 12px;
  background: #1a1a2e;
  color: #e5e7eb;
  min-height: 300px;
  max-height: calc(100vh - 200px);
  scroll-behavior: smooth;
}

/* Custom scrollbar for the log */
.log-container::-webkit-scrollbar {
  width: 8px;
}
.log-container::-webkit-scrollbar-track {
  background: #16162a;
  border-radius: 4px;
}
.log-container::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 4px;
}
.log-container::-webkit-scrollbar-thumb:hover {
  background: #6b7280;
}

/* Firefox scrollbar support */
.log-container {
  scrollbar-width: thin;
  scrollbar-color: #4b5563 #16162a;
}

/* Log Toolbar */
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.log-search-wrap {
  position: relative;
  flex: 1;
  min-width: 150px;
  max-width: 280px;
}

.log-search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: #6b7280;
  pointer-events: none;
}

.log-search-input {
  width: 100%;
  padding: 6px 10px 6px 28px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 12px;
  background: #f9fafb;
  color: #1a1a2e;
  outline: none;
}

.log-search-input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
}

.log-filter-btns {
  display: flex;
  gap: 4px;
}

.log-filter-btn {
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  font-size: 11px;
  background: #f9fafb;
  color: #6b7280;
  cursor: pointer;
  white-space: nowrap;
}

.log-filter-btn:hover { background: #f3f4f6; }

.log-filter-btn.active {
  font-weight: 600;
  border-color: #3b82f6;
  color: #1d4ed8;
  background: #eff6ff;
}

.log-filter-btn.active.error { border-color: #dc2626; color: #dc2626; background: #fef2f2; }
.log-filter-btn.active.success { border-color: #16a34a; color: #16a34a; background: #f0fdf4; }
.log-filter-btn.active.generating { border-color: #f59e0b; color: #b45309; background: #fffbeb; }

.log-filter-count {
  font-size: 10px;
  opacity: 0.7;
  margin-left: 2px;
}

.log-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.log-scroll-toggle {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 4px;
  background: #dcfce7;
  color: #16a34a;
  border: 1px solid #bbf7d0;
  cursor: pointer;
}

.log-scroll-toggle.paused {
  background: #fef3c7;
  color: #b45309;
  border-color: #fde68a;
}

/* Group headers */
.log-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #16162a;
  border-bottom: 1px solid #2d2d44;
  cursor: pointer;
  user-select: none;
  position: sticky;
  top: 0;
  z-index: 2;
}

.log-group-header:hover { background: #1e1e3a; }
.log-group-header.has-error { border-left: 3px solid #ef4444; }
.log-group-header.has-success:not(.has-error) { border-left: 3px solid #22c55e; }

.log-group-chevron { color: #6b7280; font-size: 10px; width: 12px; }
.log-group-keyword { color: #e5e7eb; font-weight: 600; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-group-count { color: #6b7280; font-size: 11px; }
.log-group-time { color: #6b7280; font-size: 11px; }

/* History badge */
.log-history-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(99, 102, 241, 0.2);
  color: #a5b4fc;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-entry.is-history { opacity: 0.85; }

/* Expandable detail panel */
.log-entry { cursor: pointer; }

.log-detail-panel {
  width: 100%;
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 4px;
  border: 1px solid #2d2d44;
  font-size: 11px;
}

.log-detail-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.log-detail-row:last-child { border-bottom: none; }

.log-detail-key {
  color: #818cf8;
  min-width: 100px;
  font-weight: 500;
}

.log-detail-val {
  color: #d1d5db;
  word-break: break-all;
  flex: 1;
}

.log-entry {
  padding: 8px 12px;
  border-bottom: 1px solid #2d2d44;
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}

.log-entry:last-child { border-bottom: none; }

.log-entry.success { background: rgba(22, 163, 74, 0.1); }
.log-entry.error { background: rgba(220, 38, 38, 0.1); }
.log-entry.generating { background: rgba(245, 158, 11, 0.1); }

.log-time { color: #6b7280; min-width: 70px; }

.log-priority {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}

.log-priority.high { background: #ef4444; color: white; }
.log-priority.medium { background: #f59e0b; color: white; }
.log-priority.low { background: #22c55e; color: white; }
.log-priority.INFO { background: #3b82f6; color: white; }

.log-message { flex: 1; word-break: break-word; }
.log-error-detail { display: block; margin-left: 120px; color: #f87171; font-size: 0.8em; font-family: monospace; padding: 2px 0; }

.log-url {
  display: block;
  margin-top: 4px;
  padding: 4px 8px;
  background: rgba(59, 130, 246, 0.15);
  border-radius: 4px;
  color: #60a5fa;
  text-decoration: none;
  font-size: 11px;
  word-break: break-all;
  width: 100%;
}

.log-url:hover {
  background: rgba(59, 130, 246, 0.25);
  text-decoration: underline;
}

.log-url.rich-results-link {
  background: rgba(139, 92, 246, 0.2);
  color: #a78bfa;
  font-weight: 500;
}

.log-url.rich-results-link:hover {
  background: rgba(139, 92, 246, 0.35);
}

.log-empty {
  padding: 24px;
  text-align: center;
  color: #6b7280;
}

.log-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.polling-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
  padding: 4px 10px;
  background: #f3f4f6;
  border-radius: 12px;
}

.polling-indicator.active {
  color: #16a34a;
  background: #dcfce7;
}

.polling-indicator.active.error {
  color: #b45309;
  background: #fef3c7;
}

.polling-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
}

.polling-indicator.active .polling-dot {
  background: #16a34a;
  animation: pulse 1.5s ease-in-out infinite;
}

.polling-indicator.active.error .polling-dot {
  background: #b45309;
}

.last-poll-time {
  font-size: 11px;
  color: #6b7280;
  font-family: 'Monaco', 'Menlo', monospace;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* Index Status Section (V3-unique) */
.index-status-section {
  background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
  border: 1px solid #bfdbfe;
}

.index-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.index-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.index-stat {
  text-align: center;
  padding: 16px;
  border-radius: 8px;
  background: white;
}

.index-stat.indexed { border-left: 4px solid #22c55e; }
.index-stat.pending-index { border-left: 4px solid #f59e0b; }
.index-stat.not-indexed { border-left: 4px solid #ef4444; }

.index-stat-value {
  display: block;
  font-size: 28px;
  font-weight: 700;
  color: #1a1a2e;
}

.index-stat-label {
  display: block;
  font-size: 13px;
  color: #6b7280;
  margin-top: 4px;
}

/* Category Grid */
.category-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.category-item {
  background: #f9fafb;
  padding: 12px;
  border-radius: 8px;
  text-align: center;
}

.category-icon { font-size: 20px; display: block; }
.category-count { font-size: 18px; font-weight: 700; color: #1a1a2e; display: block; }
.category-name { font-size: 11px; color: #6b7280; }

/* Articles List */
.articles-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 300px;
  overflow-y: auto;
}

.article-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px;
  background: #f9fafb;
  border-radius: 8px;
  gap: 16px;
}

.article-info strong { display: block; font-size: 14px; margin-bottom: 4px; }
.article-meta { display: flex; gap: 8px; font-size: 12px; color: #6b7280; align-items: center; flex-wrap: wrap; }
.article-meta code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }

.meta-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.meta-badge.high { background: #ef4444; color: white; }
.meta-badge.medium { background: #f59e0b; color: white; }
.meta-badge.low { background: #22c55e; color: white; }
.meta-badge.category-badge { background: #6366f1; color: white; }

.article-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.deploy-status { font-size: 12px; color: #d97706; }
.deploy-status.deployed { color: #16a34a; }
.view-link { color: #3b82f6; text-decoration: none; font-size: 13px; font-weight: 500; }
.view-link:hover { text-decoration: underline; }

.test-schema-link {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: #e0f2fe;
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  font-size: 14px;
  transition: all 0.2s;
}
.test-schema-link:hover { background: #bae6fd; transform: scale(1.1); }

/* Preview Section */
.preview-section { margin-top: 0; }
.preview-actions { display: flex; gap: 8px; }

.article-preview {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
}

.preview-meta {
  background: #f9fafb;
  padding: 12px 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  border-bottom: 1px solid #e5e7eb;
  font-size: 13px;
  color: #6b7280;
}

.preview-meta strong { color: #374151; }

.deployed-badge {
  background: #dcfce7;
  color: #16a34a;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.preview-content {
  padding: 16px;
  max-height: 300px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.6;
}

.empty-state {
  text-align: center;
  padding: 32px;
  color: #6b7280;
}

/* Sitemap Section */
.sitemap-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sitemap-filter {
  margin-bottom: 16px;
}

.sitemap-search {
  width: 100%;
  padding: 10px 16px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 14px;
}

.sitemap-search:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.sitemap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  max-height: 500px;
  overflow-y: auto;
  padding: 4px;
}

.sitemap-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  text-decoration: none;
  transition: all 0.2s;
}

.sitemap-item:hover {
  background: #f0f9ff;
  border-color: #3b82f6;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.1);
}

.sitemap-title {
  font-size: 14px;
  font-weight: 500;
  color: #1a1a2e;
  line-height: 1.3;
}

.sitemap-slug {
  font-size: 11px;
  color: #6b7280;
  background: #e5e7eb;
  padding: 2px 6px;
  border-radius: 4px;
  width: fit-content;
}

.sitemap-category {
  font-size: 10px;
  font-weight: 600;
  color: white;
  background: #6366f1;
  padding: 2px 6px;
  border-radius: 4px;
  width: fit-content;
}

/* View Toggle */
/* Developer View */
.developer-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.health-banner-inner {
  padding: 12px 16px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}

.dev-log-controls {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}

/* Session Health Banner */
.health-banner {
  padding: 16px 20px !important;
}

.health-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.health-title {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a2e;
}

.health-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
}

.health-badge.healthy {
  background: #dcfce7;
  color: #15803d;
}

.health-badge.warning {
  background: #fef3c7;
  color: #92400e;
}

.health-badge.failing {
  background: #fee2e2;
  color: #dc2626;
}

.health-badge.idle {
  background: #f3f4f6;
  color: #6b7280;
}

.health-stats-row {
  display: flex;
  gap: 16px;
  margin-bottom: 10px;
}

.health-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  padding: 8px 0;
  background: #f9fafb;
  border-radius: 8px;
}

.health-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: #1a1a2e;
  line-height: 1.2;
}

.health-stat-fail {
  color: #dc2626;
}

.health-stat-label {
  font-size: 11px;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.health-current {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #eff6ff;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 13px;
  color: #1e40af;
}

.health-current-icon {
  font-size: 10px;
  flex-shrink: 0;
}

.health-current-text {
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.health-stage-time {
  color: #3b82f6;
}

.health-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b7280;
}

.health-divider {
  color: #d1d5db;
}

.health-error {
  margin-top: 8px;
  padding: 6px 10px;
  background: #fef2f2;
  border-radius: 4px;
  font-size: 12px;
  color: #dc2626;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Toast */
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: white;
  z-index: 1000;
}

.toast.success { background: #16a34a; }
.toast.error { background: #dc2626; }

.spinner { animation: spin 1s linear infinite; }

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 1024px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .category-grid { grid-template-columns: repeat(2, 1fr); }
  .sitemap-grid { grid-template-columns: 1fr; }
  .index-summary { grid-template-columns: 1fr; }
  .log-toolbar { flex-direction: column; align-items: stretch; }
  .log-search-wrap { max-width: none; }
  .log-filter-btns { flex-wrap: wrap; }
  .log-toolbar-right { margin-left: 0; justify-content: flex-end; }
}
</style>
