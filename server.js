const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Parser = require('rss-parser');

const app = express();
app.use(cors());
app.use(express.json());

// ────────────────────────────────────────────────────────────────────────────
// Config (all overridable via environment variables)
// ────────────────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const NEWS_API_KEY     = process.env.NEWS_API_KEY || '';       // optional now
const REFRESH_MINUTES  = parseInt(process.env.REFRESH_MINUTES || '10', 10);
const MAX_AGE_DAYS     = parseInt(process.env.MAX_AGE_DAYS || '14', 10);
const MAX_ARTICLES     = parseInt(process.env.MAX_ARTICLES || '50', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '15000', 10);

if (!NEWS_API_KEY) {
  console.warn('[news] NEWS_API_KEY not set — NewsAPI source will be skipped.');
}

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': 'HantaWatch/2.0 (+https://hantawatch.com)' }
});

// ────────────────────────────────────────────────────────────────────────────
// Sources
// ────────────────────────────────────────────────────────────────────────────
// Authority feeds — high signal, low volume. These take priority in dedup.
const AUTHORITY_FEEDS = [
  { name: 'WHO DON',     url: 'https://www.who.int/feeds/entity/csr/don/en/rss.xml',                 weight: 10 },
  { name: 'ECDC',        url: 'https://www.ecdc.europa.eu/en/taxonomy/term/82/feed',                 weight: 9  },
  { name: 'CDC HAN',     url: 'https://emergency.cdc.gov/han/rss.asp',                                weight: 9  },
  { name: 'PAHO',        url: 'https://www.paho.org/en/rss.xml',                                      weight: 8  },
  { name: 'ProMED',      url: 'https://promedmail.org/promed-posts/feed/',                            weight: 9  }
];

// Google News RSS — wide media coverage, no API key, supports queries & locales.
// Format: https://news.google.com/rss/search?q=QUERY&hl=LANG&gl=COUNTRY&ceid=COUNTRY:LANG
const GOOGLE_NEWS_QUERIES = [
  // English
  { q: 'hantavirus outbreak',         hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'hantavirus cases',            hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: '"Andes virus" OR "Andes hantavirus"', hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'HFRS hantavirus',             hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: '"MV Hondius" hantavirus',     hl: 'en', gl: 'US', ceid: 'US:en' },
  // Spanish — critical for Andes region coverage (Argentina, Chile, Bolivia, Paraguay)
  { q: 'hantavirus brote',            hl: 'es', gl: 'AR', ceid: 'AR:es' },
  { q: 'hantavirus casos',            hl: 'es', gl: 'CL', ceid: 'CL:es' },
  // Portuguese — Brazil reports significant Andes hantavirus activity
  { q: 'hantavirus surto',            hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' }
];

function googleNewsUrl(q) {
  const params = new URLSearchParams({ q: q.q, hl: q.hl, gl: q.gl, ceid: q.ceid });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Relevance scoring — keep articles that actually mention hantavirus topics
// ────────────────────────────────────────────────────────────────────────────
const RELEVANCE_TERMS = [
  // Core terms (case-insensitive, multi-language)
  { term: 'hantavirus',  weight: 5 },
  { term: 'hantaan',     weight: 5 },
  { term: 'hfrs',        weight: 4 },
  { term: 'hps',         weight: 3 },
  { term: 'andes virus', weight: 5 },
  { term: 'sin nombre',  weight: 4 },
  { term: 'puumala',     weight: 4 },
  { term: 'seoul virus', weight: 4 },
  { term: 'hondius',     weight: 5 },
  // Spanish / Portuguese cognates and vernacular
  { term: 'ratón colilargo', weight: 4 },
  { term: 'hanta',           weight: 3 },
  // Supporting terms — only count if a core term is also present
  { term: 'outbreak',    weight: 1 },
  { term: 'brote',       weight: 1 },
  { term: 'surto',       weight: 1 }
];

// Articles need this score or higher (after lowercasing title+description) to pass.
const RELEVANCE_THRESHOLD = 3;

function scoreRelevance(text) {
  const t = (text || '').toLowerCase();
  let score = 0;
  let hasCore = false;
  for (const { term, weight } of RELEVANCE_TERMS) {
    if (t.includes(term)) {
      score += weight;
      if (weight >= 3) hasCore = true;
    }
  }
  return hasCore ? score : 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Severity tagging — drives the colored dot on each timeline card
// ────────────────────────────────────────────────────────────────────────────
function detectSeverity(text) {
  const t = (text || '').toLowerCase();
  const dangerTerms = ['death', 'died', 'fatal', 'killed', 'fallec', 'morte', 'muert'];
  const warnTerms   = ['outbreak', 'cases', 'confirmed', 'suspected', 'quarantine', 'brote', 'surto', 'casos'];
  if (dangerTerms.some(x => t.includes(x))) return 'danger';
  if (warnTerms.some(x => t.includes(x)))   return 'warn';
  return 'ok';
}

// ────────────────────────────────────────────────────────────────────────────
// Fetchers
// ────────────────────────────────────────────────────────────────────────────
async function fetchRssFeed(name, url, sourceWeight = 1) {
  try {
    const feed = await parser.parseURL(url);
    return (feed.items || []).map(item => ({
      title:       (item.title || '').trim(),
      description: stripHtml(item.contentSnippet || item.content || item.summary || ''),
      url:         item.link || '',
      source:      name,
      publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
      sourceWeight
    }));
  } catch (err) {
    console.error(`[news] RSS fetch failed for ${name}: ${err.message}`);
    return [];
  }
}

async function fetchGoogleNews(query) {
  // Google News uses publisher name in item.source, fall back to feed title
  try {
    const feed = await parser.parseURL(googleNewsUrl(query));
    return (feed.items || []).map(item => {
      // Google News titles are typically "Headline - Publisher"
      const rawTitle = (item.title || '').trim();
      const lastDash = rawTitle.lastIndexOf(' - ');
      const title    = lastDash > 20 ? rawTitle.slice(0, lastDash) : rawTitle;
      const source   = lastDash > 20 ? rawTitle.slice(lastDash + 3) : 'Google News';
      return {
        title,
        description: stripHtml(item.contentSnippet || item.content || ''),
        url:         item.link || '',
        source,
        publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
        sourceWeight: 1
      };
    });
  } catch (err) {
    console.error(`[news] Google News fetch failed for "${query.q}": ${err.message}`);
    return [];
  }
}

async function fetchNewsApi() {
  if (!NEWS_API_KEY) return [];
  const queries = [
    'hantavirus outbreak',
    'MV Hondius hantavirus',
    'Andes virus',
    'hantavirus cases'
  ];
  const results = [];
  for (const q of queries) {
    try {
      const r = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q,
          sortBy: 'publishedAt',
          language: 'en',
          apiKey: NEWS_API_KEY,
          pageSize: 20
        },
        timeout: FETCH_TIMEOUT_MS
      });
      for (const a of (r.data.articles || [])) {
        results.push({
          title:       a.title || '',
          description: a.description || '',
          url:         a.url || '',
          source:      (a.source && a.source.name) || 'NewsAPI',
          publishedAt: a.publishedAt || new Date().toISOString(),
          sourceWeight: 1
        });
      }
    } catch (err) {
      console.error(`[news] NewsAPI fetch failed for "${q}": ${err.message}`);
    }
  }
  return results;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregation pipeline
// ────────────────────────────────────────────────────────────────────────────
let newsCache = { data: [], lastUpdated: null, lastSourceStats: {} };
let isRefreshing = false;

async function aggregateNews() {
  if (isRefreshing) {
    console.log('[news] Refresh already in progress, skipping.');
    return newsCache.data;
  }
  isRefreshing = true;
  const started = Date.now();

  try {
    const tasks = [
      ...AUTHORITY_FEEDS.map(f => fetchRssFeed(f.name, f.url, f.weight)),
      ...GOOGLE_NEWS_QUERIES.map(q => fetchGoogleNews(q)),
      fetchNewsApi()
    ];

    const settled = await Promise.allSettled(tasks);
    let all = [];
    for (const r of settled) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) all = all.concat(r.value);
    }

    // Recency filter
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    all = all.filter(a => {
      const t = new Date(a.publishedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });

    // Relevance scoring (combine title + description)
    all = all
      .map(a => {
        const text = `${a.title} ${a.description}`;
        const relevance = scoreRelevance(text) + (a.sourceWeight || 0);
        const severity = detectSeverity(text);
        return { ...a, relevance, severity };
      })
      .filter(a => a.relevance >= RELEVANCE_THRESHOLD);

    // Dedupe — prefer higher-relevance / authority sources
    all.sort((a, b) => b.relevance - a.relevance);
    const seen = new Set();
    const deduped = [];
    for (const a of all) {
      const key = normalizeTitle(a.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(a);
    }

    // Final ordering — newest first
    deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    // Trim and enrich for output
    const out = deduped.slice(0, MAX_ARTICLES).map(a => ({
      title:       a.title,
      description: a.description,
      url:         a.url,
      source:      a.source,
      severity:    a.severity,
      publishedAt: a.publishedAt,
      timeAgo:     getTimeAgo(a.publishedAt)
    }));

    // Source stats — what each source contributed (after filtering, before trim)
    const stats = {};
    for (const a of deduped) stats[a.source] = (stats[a.source] || 0) + 1;

    newsCache = { data: out, lastUpdated: new Date(), lastSourceStats: stats };
    console.log(`[news] Refreshed: ${out.length} articles in ${Date.now() - started}ms from ${Object.keys(stats).length} sources`);
    return out;
  } catch (err) {
    console.error('[news] Aggregation error:', err);
    return newsCache.data;
  } finally {
    isRefreshing = false;
  }
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60)    return 'just now';
  if (seconds < 3600)  return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// ────────────────────────────────────────────────────────────────────────────
// Case data (unchanged)
// ────────────────────────────────────────────────────────────────────────────
const globalCaseData = {
  USA:               { cases: 17,   deaths: 0,   confirmed: 17,   suspected: 0, strain: 'Sin Nombre/Andes' },
  Netherlands:       { cases: 4,    deaths: 1,   confirmed: 4,    suspected: 0, strain: 'Andes' },
  UK:                { cases: 1,    deaths: 0,   confirmed: 1,    suspected: 0, strain: 'Andes' },
  Germany:           { cases: 1,    deaths: 1,   confirmed: 1,    suspected: 0, strain: 'Andes' },
  France:            { cases: 2,    deaths: 0,   confirmed: 1,    suspected: 1, strain: 'Andes' },
  'South Africa':    { cases: 1,    deaths: 0,   confirmed: 1,    suspected: 0, strain: 'Andes' },
  Argentina:         { cases: 1,    deaths: 1,   confirmed: 1,    suspected: 0, strain: 'Andes' },
  'Tristan da Cunha':{ cases: 1,    deaths: 0,   confirmed: 0,    suspected: 1, strain: 'Andes' },
  Canada:            { cases: 3,    deaths: 0,   confirmed: 0,    suspected: 3, strain: 'Andes' },
  'New Zealand':     { cases: 1,    deaths: 0,   confirmed: 0,    suspected: 1, strain: 'Andes' },
  Singapore:         { cases: 2,    deaths: 0,   confirmed: 0,    suspected: 2, strain: 'Andes' },
  Spain:             { cases: 1,    deaths: 0,   confirmed: 0,    suspected: 1, strain: 'Andes' },
  China:             { cases: 180,  deaths: 5,   confirmed: 180,  suspected: 0, strain: 'HFRS (Hantaan)' },
  Russia:            { cases: 8000, deaths: 200, confirmed: 8000, suspected: 0, strain: 'HFRS (Puumala)' },
  Finland:           { cases: 1200, deaths: 20,  confirmed: 1200, suspected: 0, strain: 'HFRS (Puumala)' },
  Brazil:            { cases: 19,   deaths: 10,  confirmed: 19,   suspected: 0, strain: 'Andes' },
  Chile:             { cases: 45,   deaths: 15,  confirmed: 45,   suspected: 0, strain: 'Andes' },
  Paraguay:          { cases: 26,   deaths: 6,   confirmed: 26,   suspected: 0, strain: 'Andes' },
  Bolivia:           { cases: 48,   deaths: 11,  confirmed: 48,   suspected: 0, strain: 'Andes' }
};

const coordinates = {
  USA:                { lat: 37.0902,  lng: -95.7129 },
  Netherlands:        { lat: 52.1326,  lng: 5.2913 },
  UK:                 { lat: 55.3781,  lng: -3.4360 },
  Germany:            { lat: 51.1657,  lng: 10.4515 },
  France:             { lat: 46.2276,  lng: 2.2137 },
  'South Africa':     { lat: -25.7461, lng: 28.2293 },
  Argentina:          { lat: -34.6037, lng: -58.3816 },
  'Tristan da Cunha': { lat: -37.1088, lng: -12.2774 },
  Canada:             { lat: 56.1304,  lng: -106.3468 },
  'New Zealand':      { lat: -40.9006, lng: 174.8860 },
  Singapore:          { lat: 1.3521,   lng: 103.8198 },
  Spain:              { lat: 40.4637,  lng: -3.7492 },
  China:              { lat: 35.8617,  lng: 104.1954 },
  Russia:             { lat: 61.5240,  lng: 105.3188 },
  Finland:            { lat: 61.9241,  lng: 25.7482 },
  Brazil:             { lat: -14.2350, lng: -51.9253 },
  Chile:              { lat: -35.6751, lng: -71.5430 },
  Paraguay:           { lat: -23.4425, lng: -58.4438 },
  Bolivia:            { lat: -16.2902, lng: -63.5887 }
};

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  let totalCases = 0, totalDeaths = 0, totalConfirmed = 0;
  const totalCountries = Object.keys(globalCaseData).length;
  for (const c in globalCaseData) {
    totalCases     += globalCaseData[c].cases;
    totalDeaths    += globalCaseData[c].deaths;
    totalConfirmed += globalCaseData[c].confirmed;
  }
  res.json({ totalCases, totalDeaths, totalConfirmed, totalCountries, attackRate: '2-6%', lastUpdated: new Date() });
});

app.get('/api/cases', (req, res) => {
  const countries = Object.entries(globalCaseData)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.cases - a.cases);
  res.json(countries);
});

app.get('/api/cases/:country', (req, res) => {
  const found = Object.entries(globalCaseData).find(
    ([k]) => k.toLowerCase() === req.params.country.toLowerCase()
  );
  if (!found) return res.status(404).json({ error: 'Country not found' });
  res.json({ name: found[0], ...found[1] });
});

app.get('/api/map', (req, res) => {
  const markers = [];
  for (const country in globalCaseData) {
    const coords = coordinates[country];
    if (!coords) continue;
    const d = globalCaseData[country];
    markers.push({
      name: country, lat: coords.lat, lng: coords.lng,
      confirmed: d.confirmed, suspected: d.suspected, deaths: d.deaths, strain: d.strain
    });
  }
  res.json(markers);
});

// News — returns cached data immediately. If cache is empty (first request
// before initial fetch finishes), wait for the in-progress refresh.
app.get('/api/news', async (req, res) => {
  if (newsCache.data.length === 0 && isRefreshing) {
    // Wait for the in-flight refresh, max 8s
    const deadline = Date.now() + 8000;
    while (isRefreshing && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  res.json(newsCache.data || []);
});

// Inspect what's in the cache and where it came from
app.get('/api/news/sources', (req, res) => {
  res.json({
    lastUpdated: newsCache.lastUpdated,
    refreshIntervalMinutes: REFRESH_MINUTES,
    maxAgeDays: MAX_AGE_DAYS,
    articleCount: newsCache.data.length,
    sourceBreakdown: newsCache.lastSourceStats,
    newsApiEnabled: !!NEWS_API_KEY
  });
});

// Manual refresh
app.post('/api/news/update', async (req, res) => {
  const news = await aggregateNews();
  res.json({ success: true, articles: news.length, lastUpdated: newsCache.lastUpdated });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    newsLastUpdated: newsCache.lastUpdated,
    newsArticles: newsCache.data.length
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[boot] HantaWatch backend on port ${PORT}`);
  console.log(`[boot] News refresh every ${REFRESH_MINUTES}min, max age ${MAX_AGE_DAYS}d, cap ${MAX_ARTICLES} articles`);
  aggregateNews();
  setInterval(aggregateNews, REFRESH_MINUTES * 60 * 1000);
});
