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
//
// Each query is tagged with a `lang` field. The /api/news endpoint can filter
// by language via ?lang=ko (or ja, es, en) so the frontend's KO/JA UI shows
// native-language coverage instead of English headlines.
const GOOGLE_NEWS_QUERIES = [
  // — English —
  { q: '"MV Hondius"',                             hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: '"Hondius" hantavirus',                     hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: '"Hondius" outbreak',                       hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: '"Andes virus" OR "Andes hantavirus"',      hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: 'Andes hantavirus outbreak',                hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: 'Hondius "Cape Verde" OR Praia',            hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: 'Hondius "Canary Islands" OR "Las Palmas"', hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: 'Hondius "Saint Helena" OR Ascension',      hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },
  { q: 'Hondius "Tristan da Cunha"',               hl: 'en', gl: 'US', ceid: 'US:en', lang: 'en' },

  // — Spanish (Canary Islands + Cape Verde + Madrid) —
  { q: 'Hondius hantavirus',                       hl: 'es', gl: 'ES', ceid: 'ES:es', lang: 'es' },
  { q: '"virus Andes" crucero OR barco',           hl: 'es', gl: 'ES', ceid: 'ES:es', lang: 'es' },

  // — Korean (hantavirus is named after Korea's Hantan River; story has cultural resonance) —
  { q: '한타바이러스 혼디우스',                       hl: 'ko', gl: 'KR', ceid: 'KR:ko', lang: 'ko' },
  { q: 'MV 혼디우스 크루즈',                          hl: 'ko', gl: 'KR', ceid: 'KR:ko', lang: 'ko' },
  { q: '안데스바이러스 크루즈',                       hl: 'ko', gl: 'KR', ceid: 'KR:ko', lang: 'ko' },

  // — Japanese (1 Japanese passenger onboard, media is covering closely) —
  { q: 'ハンタウイルス ホンディウス',                  hl: 'ja', gl: 'JP', ceid: 'JP:ja', lang: 'ja' },
  { q: 'MVホンディウス クルーズ',                      hl: 'ja', gl: 'JP', ceid: 'JP:ja', lang: 'ja' },
  { q: 'アンデスウイルス クルーズ',                    hl: 'ja', gl: 'JP', ceid: 'JP:ja', lang: 'ja' }
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
  // English ship signals
  'hondius',
  'mv hondius',
  // English Andes strain signals
  'andes virus',
  'andes hantavirus',
  // Spanish
  'virus andes',
  'hantavirus andes',
  // Spanish vernacular for the Andes-strain reservoir host
  'ratón colilargo',
  // Korean — "혼디우스" = Hondius transliterated; "안데스바이러스" = Andes virus
  '혼디우스',
  '안데스바이러스',
  '안데스 바이러스',
  '안데스 한타바이러스',
  // Japanese — "ホンディウス" = Hondius katakana; "アンデスウイルス" = Andes virus
  'ホンディウス',
  'アンデスウイルス',
  'アンデス ウイルス',
  'アンデスハンタウイルス'
];

const CONTEXT_TERMS = [
  // Generic hantavirus mention — counts only if a primary term is also present
  { term: 'hantavirus',  weight: 2 },
  { term: 'hanta',       weight: 1 },
  { term: '한타바이러스', weight: 2 },
  { term: 'ハンタウイルス', weight: 2 },
  // Outbreak verbs
  { term: 'outbreak',    weight: 1 },
  { term: 'brote',       weight: 1 },
  { term: 'surto',       weight: 1 },
  { term: '집단 감염',   weight: 1 },
  { term: '집단감염',    weight: 1 },
  { term: '集団感染',    weight: 1 },
  // Ports / locations strongly tied to this outbreak
  { term: 'cape verde',  weight: 1 },
  { term: 'praia',       weight: 1 },
  { term: 'canary islands', weight: 1 },
  { term: 'las palmas',  weight: 1 },
  { term: 'saint helena', weight: 1 },
  { term: 'ascension island', weight: 1 },
  { term: 'tristan da cunha', weight: 1 },
  { term: '카나리아',    weight: 1 },
  { term: 'カナリア',    weight: 1 }
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
  const dangerTerms = [
    'death', 'died', 'fatal', 'killed',
    'fallec', 'morte', 'muert',           // ES/PT
    '사망', '숨졌', '숨진',                  // KO
    '死亡', '死去', '亡くな'                 // JA
  ];
  const warnTerms = [
    'outbreak', 'cases', 'confirmed', 'suspected', 'quarantine',
    'brote', 'surto', 'casos',
    '확진', '의심', '격리', '집단감염', '집단 감염',  // KO
    '感染', '陽性', '隔離', '集団感染'                 // JA
  ];
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
      sourceWeight,
      lang:        'en'
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
        sourceWeight: 1,
        lang: query.lang || 'en'
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
          sourceWeight: 1,
          lang:        'en'
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

    // Trim and enrich for output. We keep a generous cap (3x MAX_ARTICLES) so
    // that per-language filtering at request time still has enough headroom
    // for KO/JA/ES even though most articles are English.
    const out = deduped.slice(0, MAX_ARTICLES * 3).map(a => ({
      title:       a.title,
      description: a.description,
      url:         a.url,
      source:      a.source,
      severity:    a.severity,
      lang:        a.lang || 'en',
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
// Canonical outbreak totals. The per-location data below counts both
// confirmed PCR-positive cases AND people under monitoring/observation
// (which is not the same as having the virus). To avoid the EpiTrace-style
// inflation problem, we keep the top-line "confirmed" count strictly to
// WHO/ECDC's definition — PCR-positive — and surface the wider monitoring
// population as a separate "suspected" stat that the frontend renders
// in its own cell.
//
// Last updated: 13 May 2026.
// Source: WHO Disease Outbreak News DON601 (13 May 2026).
// 11 cases total — 8 confirmed, 1 inconclusive (Kornfeld, USA, re-testing),
// 2 probable. 3 deaths — 2 confirmed, 1 probable.
// WHO now publicly states evidence suggests human-to-human transmission
// occurred on board.
// Crew status: 25 crew + 2 RIVM medics remain aboard MV Hondius en route
// to Vlissingen, Netherlands for deep-cleaning.
const OUTBREAK_TOTALS = {
  confirmed:    8,    // PCR-confirmed (WHO DON601)
  probable:     2,    // probable / awaiting labs (WHO DON601)
  inconclusive: 1,    // mixed lab results — USA case under re-test
  deaths:       3,    // 2 Dutch confirmed, 1 German probable
  cases:        11,   // confirmed + probable + inconclusive (WHO total)
  onBoard:      27,   // 25 crew + 2 RIVM medics, en route Vlissingen
  attackRate:   '~7%', // 11 of ~150 original passengers/crew
  strain:       'Andes virus (Orthohantavirus andesense)',
  ship:         'MV Hondius',
  operator:     'Oceanwide Expeditions',
  origin:       'Ushuaia, Argentina',
  departed:     '2026-04-01',
  reportedToWho:'2026-05-02',
  whoReference: 'DON601'
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
                        note: 'Dutch couple (70M/69F) were the first two deaths (11 Apr aboard / 26 Apr Johannesburg). 3 more evacuated 6 May incl. ship\'s doctor. Ship returning to Vlissingen for deep-cleaning by RIVM. 8 Dutch nationals total were aboard (passengers + crew).' },
  Germany:            { cases: 1, deaths: 1, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'German woman died on board 2 May.' },
  'South Africa':     { cases: 2, deaths: 1, confirmed: 1, suspected: 1, strain: 'Andes', role: 'repat',
                        note: 'Two patients in Johannesburg; one Dutch death (26 April). 62 contacts traced — 42 tested negative, 20 still being located (some may have travelled abroad).' },
  UK:                 { cases: 3, deaths: 0, confirmed: 2, suspected: 1, strain: 'Andes', role: 'repat',
                        note: '2 Britons confirmed infected, 1 additional suspected (UKHSA 8 May). Critical-but-stable British passenger transferred to Johannesburg; 22 disembarked at Manchester 10 May entering 72-hour Wirral quarantine, then 45-day home self-isolation.' },
  Spain:              { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'Spanish passenger at Gómez Ulla Hospital, Madrid: PCR-positive confirmed, began showing compatible symptoms early Tuesday 12 May (was asymptomatic on arrival). Isolated in High-Level Isolation Unit (UATAN). Other 13 Spanish evacuees tested negative. 42-day surveillance active.' },
  Switzerland:        { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'One hospitalized passenger in Zurich; sequence shared with Pathoplexus (ANDV/Switzerland/Hu-3337/2026). Patient disembarked at Saint Helena 24 April.' },
  USA:                { cases: 1, deaths: 0, confirmed: 0, suspected: 1, strain: 'Andes', role: 'repat',
                        note: 'Dr. Stephen Kornfeld (ship\'s replacement doctor) initially tested PCR-positive in a Dutch lab but US re-test returned negative — case now classified as inconclusive per WHO DON601 pending further testing. 15 other Americans in quarantine at UNMC Omaha (asymptomatic). 2 more at Emory University Hospital, Atlanta. Plane-contact monitoring: 2 King County (WA) residents, plus Minnesota (1) and Kansas (3) tracking close contacts of confirmed cases. NJ/MD also monitoring. AZ/CA/GA/TX/VA monitoring earlier disembarkees.' },
  France:             { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes', role: 'repat',
                        note: 'French passenger now on life support with artificial lungs as of 13 May — French authorities describe this as "the final stage of supportive care." Isolated at Bichat Hospital, Paris. 8 contacts being monitored (4 already negative).' },
  Australia:          { cases: 4, deaths: 0, confirmed: 0, suspected: 4, strain: 'Andes', role: 'repat',
                        note: '4 Australian passengers being repatriated to Perth for 3-week quarantine due to Andes hantavirus exposure. Disembarked Tenerife 10 May. None symptomatic at time of repatriation. Andes is the only hantavirus with documented limited person-to-person transmission, prompting the extended isolation.' },
  'New Zealand':      { cases: 2, deaths: 0, confirmed: 0, suspected: 2, strain: 'Andes', role: 'repat',
                        note: '2 New Zealand passengers joining the Australian group for repatriation via Perth and onward 3-week quarantine. None symptomatic at disembarkation.' },
  Italy:              { cases: 2, deaths: 0, confirmed: 0, suspected: 2, strain: 'Andes', role: 'repat',
                        note: '1 English tourist quarantined at Sacco Hospital, Milan — shared a flight from Saint Helena to Johannesburg with the Dutch widow (now traced to Italy). 1 Argentine tourist hospitalized in Messina with pneumonia, awaiting hantavirus test results (arrived in Italy 30 April).' },
  Argentina:          { cases: 0, deaths: 0, confirmed: 0, suspected: 0, strain: 'Andes', role: 'origin',
                        note: 'Ship departed Ushuaia 1 April. Argentine health ministry tracing the Dutch index case\'s 4-month road trip (27 Nov 2025 – 1 Apr 2026) through Chile, Uruguay, and Argentina; Malbrán Institute capturing and testing rodents along the route. Index case returned from Uruguay only 4 days before departure.' }
};

const coordinates = {
  // Ports of call — use the actual port city, not the country center
  'Tristan da Cunha': { lat: -37.1088, lng: -12.2774 },  // Edinburgh of the Seven Seas
  'Saint Helena':     { lat: -15.9387, lng:  -5.7166 },  // Jamestown
  'Ascension Island': { lat:  -7.9467, lng: -14.3559 },  // Georgetown
  'Cape Verde':       { lat:  14.9177, lng: -23.5092 },  // Praia
  'Canary Islands':   { lat:  28.4636, lng: -16.2518 },  // Tenerife (Santa Cruz)
  // Repatriation destinations — use the actual treatment city when known
  Netherlands:        { lat:  51.4416, lng:   3.5733 },  // Vlissingen (ship return port + RIVM facility)
  Germany:            { lat:  52.5200, lng:  13.4050 },  // Berlin (Robert Koch Institute)
  'South Africa':     { lat: -26.2041, lng:  28.0473 },  // Johannesburg (hospital + contact-tracing hub)
  UK:                 { lat:  53.4084, lng:  -2.9916 },  // Liverpool/Wirral (quarantine site after Manchester arrival)
  Spain:              { lat:  40.3839, lng:  -3.7344 },  // Madrid — Gómez Ulla Hospital (Carabanchel)
  Switzerland:        { lat:  47.3769, lng:   8.5417 },  // Zurich (treatment city)
  USA:                { lat:  41.2565, lng: -95.9345 },  // Omaha, NE — UNMC biocontainment unit
  France:             { lat:  48.8398, lng:   2.3490 },  // Paris — Bichat Hospital (18th arr.)
  Australia:          { lat: -31.9523, lng: 115.8613 },  // Perth (3-week quarantine destination)
  'New Zealand':      { lat: -36.8485, lng: 174.7633 },  // Auckland (home country destination after Perth transit)
  Italy:              { lat:  45.4945, lng:   9.1737 },  // Milan — Sacco Hospital
  Argentina:          { lat: -54.8019, lng: -68.3030 }   // Ushuaia (departure port)
};

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  // Confirmed and Deaths come from canonical WHO totals (OUTBREAK_TOTALS)
  // to avoid double-counting patients across ports + repatriation countries.
  //
  // Suspected/Monitoring is computed from per-location data — this is the
  // wider population of probable cases and people under observation. It's
  // intentionally separate from "confirmed" so users can see at a glance
  // how many are actually PCR-positive vs how many are being watched.
  const locations = Object.keys(globalCaseData).length;

  // Sum the per-location "suspected" field (includes Australia's 5, NZ's 1,
  // etc.) and add WHO's 2 probables. Subtract any overlap with WHO
  // probables already attributed to specific countries.
  let perLocationSuspected = 0;
  for (const country in globalCaseData) {
    perLocationSuspected += (globalCaseData[country].suspected || 0);
  }
  // perLocationSuspected may already include WHO's 2 probables (in the
  // France/USA/UK rows), so we take max() not sum to avoid double-counting.
  const suspected = Math.max(perLocationSuspected, OUTBREAK_TOTALS.probable);

  res.json({
    ...OUTBREAK_TOTALS,
    suspected,
    // Backwards-compat aliases for any older frontend code:
    totalCases:     OUTBREAK_TOTALS.cases,
    totalConfirmed: OUTBREAK_TOTALS.confirmed,
    totalDeaths:    OUTBREAK_TOTALS.deaths,
    totalSuspected: suspected,
    totalCountries: locations,
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
//
// Language filtering:
//   ?lang=en   → English only
//   ?lang=ko   → Korean articles first; if fewer than MIN_PER_LANG, top up with English
//   ?lang=ja   → same as ko but Japanese
//   ?lang=es   → Spanish first, English fallback
//   (no lang) → all languages, English-first ordering preserved
//
// The fallback exists so KO/JA users always see *something* — if Korean
// coverage is thin on a given day, they get top KO articles + a few EN.
app.get('/api/news', async (req, res) => {
  if (newsCache.data.length === 0 && isRefreshing) {
    const deadline = Date.now() + 8000;
    while (isRefreshing && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const requestedLang = String(req.query.lang || '').toLowerCase();
  const MIN_PER_LANG = 6;   // ensure at least this many cards in the timeline
  const MAX_RETURN  = 20;   // ceiling for response size

  const all = newsCache.data || [];

  // No filter requested → return everything (caller decides)
  if (!requestedLang || requestedLang === 'all') {
    return res.json(all.slice(0, MAX_RETURN));
  }

  // Native-language articles first
  const native = all.filter(a => a.lang === requestedLang);

  // If there are enough native, return only those
  if (native.length >= MIN_PER_LANG) {
    return res.json(native.slice(0, MAX_RETURN));
  }

  // Otherwise, top up with English (the universal fallback) — but only if the
  // requested language wasn't already English.
  if (requestedLang !== 'en') {
    const englishTopUp = all.filter(a => a.lang === 'en');
    const merged = [...native, ...englishTopUp];
    return res.json(merged.slice(0, MAX_RETURN));
  }

  // Requested EN but no EN articles — return whatever we have
  return res.json(all.slice(0, MAX_RETURN));
});

// Inspect what's in the cache and where it came from
app.get('/api/news/sources', (req, res) => {
  const langBreakdown = {};
  for (const a of (newsCache.data || [])) {
    const k = a.lang || 'en';
    langBreakdown[k] = (langBreakdown[k] || 0) + 1;
  }
  res.json({
    lastUpdated: newsCache.lastUpdated,
    refreshIntervalMinutes: REFRESH_MINUTES,
    maxAgeDays: MAX_AGE_DAYS,
    articleCount: newsCache.data.length,
    languageBreakdown: langBreakdown,
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
