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
//
// Scope: MV Hondius outbreak + the Andes hantavirus variant only.
// We are NOT a general hantavirus tracker — no HFRS / Puumala / Hantaan / Seoul queries.
const GOOGLE_NEWS_QUERIES = [
  // The ship itself — primary story
  { q: '"MV Hondius"',                            hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: '"Hondius" hantavirus',                    hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: '"Hondius" outbreak',                      hl: 'en', gl: 'US', ceid: 'US:en' },
  // Andes hantavirus variant (the strain on the ship)
  { q: '"Andes virus" OR "Andes hantavirus"',     hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'Andes hantavirus outbreak',               hl: 'en', gl: 'US', ceid: 'US:en' },
  // Ports of call + repatriation destinations — local coverage often breaks first
  { q: 'Hondius "Cape Verde" OR Praia',           hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'Hondius "Canary Islands" OR "Las Palmas"', hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'Hondius "Saint Helena" OR Ascension',     hl: 'en', gl: 'US', ceid: 'US:en' },
  { q: 'Hondius "Tristan da Cunha"',              hl: 'en', gl: 'US', ceid: 'US:en' },
  // Spanish — Canary Islands + Cape Verde local media
  { q: 'Hondius hantavirus',                      hl: 'es', gl: 'ES', ceid: 'ES:es' },
  { q: '"virus Andes" crucero OR barco',          hl: 'es', gl: 'ES', ceid: 'ES:es' }
];

function googleNewsUrl(q) {
  const params = new URLSearchParams({ q: q.q, hl: q.hl, gl: q.gl, ceid: q.ceid });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Relevance scoring — articles must be about the MV Hondius outbreak or the
// Andes hantavirus variant. Plain "hantavirus" is not enough on its own.
// ────────────────────────────────────────────────────────────────────────────
const PRIMARY_TERMS = [
  // Ship signals
  'hondius',
  'mv hondius',
  // Andes strain signals
  'andes virus',
  'andes hantavirus',
  'virus andes',                // Spanish form
  'hantavirus andes',
  // Vernacular for the Andes-strain reservoir host (Spanish-speaking media)
  'ratón colilargo'
];

const CONTEXT_TERMS = [
  // Generic hantavirus mention — counts only if a primary term is also present
  { term: 'hantavirus',  weight: 2 },
  { term: 'hanta',       weight: 1 },
  // Outbreak verbs that frequently co-occur in real stories
  { term: 'outbreak',    weight: 1 },
  { term: 'brote',       weight: 1 },
  { term: 'surto',       weight: 1 },
  // Ports / locations strongly tied to this outbreak — disambiguate from
  // unrelated hantavirus stories elsewhere
  { term: 'cape verde',  weight: 1 },
  { term: 'praia',       weight: 1 },
  { term: 'canary islands', weight: 1 },
  { term: 'las palmas',  weight: 1 },
  { term: 'saint helena', weight: 1 },
  { term: 'ascension island', weight: 1 },
  { term: 'tristan da cunha', weight: 1 }
];

const RELEVANCE_THRESHOLD = 5;

function scoreRelevance(text) {
  const t = (text || '').toLowerCase();
  // Must mention a primary term — ship name or Andes strain
  let hasPrimary = false;
  let score = 0;
  for (const term of PRIMARY_TERMS) {
    if (t.includes(term)) { hasPrimary = true; score += 5; }
  }
  if (!hasPrimary) return 0;
  for (const { term, weight } of CONTEXT_TERMS) {
    if (t.includes(term)) score += weight;
  }
  return score;
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
    '"MV Hondius"',
    'Hondius hantavirus',
    '"Andes virus"',
    '"Andes hantavirus"'
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
// ────────────────────────────────────────────────────────────────────────────
// MV Hondius outbreak data (Andes virus / ANDV)
// Source: WHO DON599 (4 May 2026), WHO Tedros briefing (7 May 2026),
// ECDC threat assessment (6 May 2026), Wikipedia summary (current).
// Totals as of ~9-10 May 2026: 8 cases (6 confirmed, 2 suspected), 3 deaths,
// 147 on board en route to Tenerife.
//
// Locations are a mix of ship ports of call where cases originated/disembarked
// and countries that received evacuated patients.
// ────────────────────────────────────────────────────────────────────────────
// Canonical outbreak totals — what WHO reports globally. The per-location
// numbers below may count the same patient twice (e.g. a passenger who
// became symptomatic at a port and was later evacuated to a country), so
// /api/stats uses these canonical numbers, not a sum.
//
// Last updated: 11 May 2026. Update OUTBREAK_TOTALS and the per-location
// data below as WHO/Tedros briefings publish new figures.
const OUTBREAK_TOTALS = {
  cases:        11,   // confirmed + probable (Tedros 11 May; rising from DON599's 8)
  deaths:       3,    // 1 Dutch man (11 April aboard), 1 Dutch woman (26 April Johannesburg), 1 German woman (2 May aboard)
  confirmed:    8,
  suspected:    3,
  onBoard:      30,   // skeleton crew + 2 health workers en route Rotterdam after Tenerife disembark
  attackRate:   '~7%', // 11 of ~150 original passengers/crew
  strain:       'Andes virus (Orthohantavirus andesense)',
  ship:         'MV Hondius',
  operator:     'Oceanwide Expeditions',
  origin:       'Ushuaia, Argentina',
  departed:     '2026-04-01',
  reportedToWho:'2026-05-02',
  whoReference: 'DON599'
};

const globalCaseData = {
  // — Ship ports of call (chronological) —
  'Tristan da Cunha': { cases: 1, deaths: 1, confirmed: 1, suspected: 0, strain: 'Andes', role: 'port',
                        note: 'First death aboard 11 April (Dutch passenger).' },
  'Saint Helena':     { cases: 2, deaths: 1, confirmed: 1, suspected: 1, strain: 'Andes', role: 'port',
                        note: 'Body offloaded 24 April; 30 passengers disembarked (incl. 6 Americans); second death airlifted to Johannesburg.' },
  'Ascension Island': { cases: 1, deaths: 0, confirmed: 0, suspected: 1, strain: 'Andes', role: 'port',
                        note: 'Medical evacuation stop, departed 27 April.' },
  'Cape Verde':       { cases: 0, deaths: 0, confirmed: 0, suspected: 0, strain: 'Andes', role: 'port',
                        note: 'Docked Praia 3 May for three days; no one disembarked. Isolation area established.' },
  'Canary Islands':   { cases: 0, deaths: 0, confirmed: 0, suspected: 0, strain: 'Andes', role: 'port',
                        note: 'Tenerife arrival 10 May; passenger disembarkation under hazmat protocol.' },

  // — Countries receiving evacuated / repatriated patients —
  Netherlands:        { cases: 3, deaths: 2, confirmed: 3, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'Dutch couple (70M/69F) died of Andes virus (11 Apr / 26 Apr); 3 evacuated 6 May incl. ship\'s doctor.' },
  Germany:            { cases: 1, deaths: 1, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'German woman died on board 2 May.' },
  'South Africa':     { cases: 2, deaths: 1, confirmed: 1, suspected: 1, strain: 'Andes', role: 'repat',
                        note: 'Two patients in Johannesburg; one Dutch death (26 April). 62 contacts traced, 42 negative.' },
  UK:                 { cases: 1, deaths: 0, confirmed: 0, suspected: 1, strain: 'Andes', role: 'repat',
                        note: 'British crew member evacuated 6 May; UKHSA contact-tracing 30 disembarked travellers.' },
  Spain:              { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'Asymptomatic positive at Gómez Ulla Hospital, Madrid (Spanish passenger).' },
  Switzerland:        { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'One hospitalized passenger; sequence shared with Pathoplexus.' },
  USA:                { cases: 2, deaths: 0, confirmed: 1, suspected: 1, strain: 'Andes', role: 'repat',
                        note: '16 Americans arrived at University of Nebraska Medical Center 10 May; 1 PCR-positive in biocontainment, 1 symptomatic. AZ/CA/GA/VA/TX monitoring earlier disembarkees.' },
  France:             { cases: 1, deaths: 0, confirmed: 0, suspected: 1, strain: 'Andes', role: 'repat',
                        note: 'French national developed symptoms on repatriation flight; 8 contacts isolated at Bichat Hospital, Paris.' },
  Argentina:          { cases: 0, deaths: 0, confirmed: 0, suspected: 0, strain: 'Andes', role: 'origin',
                        note: 'Ship departed Ushuaia 1 April. Dutch couple believed exposed at landfill during pre-cruise bird-watching trip.' }
};

const coordinates = {
  // Ports of call — use the actual port city, not the country center
  'Tristan da Cunha': { lat: -37.1088, lng: -12.2774 },  // Edinburgh of the Seven Seas
  'Saint Helena':     { lat: -15.9387, lng:  -5.7166 },  // Jamestown
  'Ascension Island': { lat:  -7.9467, lng: -14.3559 },  // Georgetown
  'Cape Verde':       { lat:  14.9177, lng: -23.5092 },  // Praia
  'Canary Islands':   { lat:  28.4636, lng: -16.2518 },  // Tenerife (Santa Cruz)
  // Repatriation destinations — usually treatment-center city, not country center
  Netherlands:        { lat:  52.1326, lng:   5.2913 },
  Germany:            { lat:  51.1657, lng:  10.4515 },
  'South Africa':     { lat: -26.2041, lng:  28.0473 },  // Johannesburg
  UK:                 { lat:  55.3781, lng:  -3.4360 },
  Spain:              { lat:  40.4168, lng:  -3.7038 },  // Madrid (Gómez Ulla Hospital)
  Switzerland:        { lat:  46.8182, lng:   8.2275 },
  USA:                { lat:  41.2565, lng: -95.9345 },  // Omaha, NE (UNMC biocontainment unit)
  France:             { lat:  48.8566, lng:   2.3522 },  // Paris (Bichat Hospital)
  Argentina:          { lat: -54.8019, lng: -68.3030 }   // Ushuaia (departure port)
};

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  // Use canonical WHO totals — NOT a sum of per-location numbers, because
  // the same patient may be recorded both at the port where they became ill
  // and at the country they were evacuated to. Locations count is the number
  // of jurisdictions involved (ports of call + destination countries).
  const locations = Object.keys(globalCaseData).length;
  res.json({
    ...OUTBREAK_TOTALS,
    totalCases:     OUTBREAK_TOTALS.cases,
    totalDeaths:    OUTBREAK_TOTALS.deaths,
    totalConfirmed: OUTBREAK_TOTALS.confirmed,
    totalCountries: locations,    // kept for frontend backwards-compat
    totalLocations: locations,
    lastUpdated:    new Date()
  });
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
      confirmed: d.confirmed, suspected: d.suspected, deaths: d.deaths,
      strain: d.strain, role: d.role, note: d.note
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
