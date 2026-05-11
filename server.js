const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const NEWS_API_KEY = 'fe8f6f956c4e42929d774630de500892';
const PORT = process.env.PORT || 3000;

// Global hantavirus case data (from public ArcGIS dataset + WHO)
// Global hantavirus case data (MV Hondius outbreak + contacts, 2026)
const globalCaseData = {
  USA: { cases: 2, deaths: 0, confirmed: 2, suspected: 0, strain: 'Andes' },
  Netherlands: { cases: 2, deaths: 1, confirmed: 2, suspected: 0, strain: 'Andes' },
  UK: { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes' },
  Germany: { cases: 1, deaths: 1, confirmed: 1, suspected: 0, strain: 'Andes' },
  France: { cases: 2, deaths: 0, confirmed: 1, suspected: 1, strain: 'Andes' },
  'South Africa': { cases: 1, deaths: 0, confirmed: 1, suspected: 0, strain: 'Andes' },
  Argentina: { cases: 1, deaths: 1, confirmed: 1, suspected: 0, strain: 'Andes' },
  'Tristan da Cunha': { cases: 1, deaths: 0, confirmed: 0, suspected: 1, strain: 'Andes' }
};


// Cache for news articles
let newsCache = {
  data: [],
  lastUpdated: null
};

// Fetch news from NewsAPI
async function fetchHantavirusNews() {
  try {
    const queries = [
      'hantavirus outbreak 2026',
      'MV Hondius hantavirus',
      'Andes virus cruise ship',
      'hantavirus cases worldwide'
    ];

    let allArticles = [];

    for (const query of queries) {
      const response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          sortBy: 'publishedAt',
          language: 'en',
          apiKey: NEWS_API_KEY,
          pageSize: 20
        }
      });

      if (response.data.articles) {
        allArticles = allArticles.concat(response.data.articles);
      }
    }

    // Remove duplicates
    const uniqueArticles = [];
    const seen = new Set();

    for (const article of allArticles) {
      const key = article.title + article.source.name;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueArticles.push({
          title: article.title,
          description: article.description,
          url: article.url,
          source: article.source.name,
          image: article.urlToImage,
          publishedAt: article.publishedAt,
          timeAgo: getTimeAgo(article.publishedAt)
        });
      }
    }

    // Sort by date, newest first
    uniqueArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    newsCache = {
      data: uniqueArticles.slice(0, 50),
      lastUpdated: new Date()
    };

    return newsCache.data;
  } catch (error) {
    console.error('Error fetching news:', error.message);
    return newsCache.data || [];
  }
}

// Helper function to format time ago
function getTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// Routes

// Global hantavirus stats endpoint
app.get('/api/stats', (req, res) => {
  let totalCases = 0;
  let totalDeaths = 0;
  let totalConfirmed = 0;
  let totalCountries = Object.keys(globalCaseData).length;

  for (const country in globalCaseData) {
    const data = globalCaseData[country];
    totalCases += data.cases;
    totalDeaths += data.deaths;
    totalConfirmed += data.confirmed;
  }

  res.json({
    totalCases,
    totalDeaths,
    totalConfirmed,
    totalCountries,
    attackRate: '2-6%',
    lastUpdated: new Date()
  });
});

// All countries data endpoint
app.get('/api/cases', (req, res) => {
  const countries = [];

  for (const country in globalCaseData) {
    const data = globalCaseData[country];
    countries.push({
      name: country,
      ...data
    });
  }

  // Sort by cases descending
  countries.sort((a, b) => b.cases - a.cases);

  res.json(countries);
});

// Single country endpoint
app.get('/api/cases/:country', (req, res) => {
  const country = req.params.country;
  const countryData = Object.entries(globalCaseData).find(
    ([key]) => key.toLowerCase() === country.toLowerCase()
  );

  if (countryData) {
    res.json({
      name: countryData[0],
      ...countryData[1]
    });
  } else {
    res.status(404).json({ error: 'Country not found' });
  }
});

// News endpoint
app.get('/api/news', async (req, res) => {
  // Return cached news, update in background
  res.json(newsCache.data || []);

  // Update cache if older than 30 minutes
  if (!newsCache.lastUpdated || (Date.now() - newsCache.lastUpdated) > 30 * 60 * 1000) {
    fetchHantavirusNews();
  }
});

// Force update news
app.post('/api/news/update', async (req, res) => {
  const news = await fetchHantavirusNews();
  res.json({ success: true, articles: news.length });
});

// Map data endpoint (for Leaflet.js)
app.get('/api/map', (req, res) => {
  const mapMarkers = [];

  const coordinates = {
    USA: { lat: 37.0902, lng: -95.7129 },
    Netherlands: { lat: 52.1326, lng: 5.2913 },
    UK: { lat: 55.3781, lng: -3.4360 },
    Germany: { lat: 51.1657, lng: 10.4515 },
    France: { lat: 46.2276, lng: 2.2137 },
    'South Africa': { lat: -25.7461, lng: 28.2293 },
    Argentina: { lat: -34.6037, lng: -58.3816 },
    'Tristan da Cunha': { lat: -37.1088, lng: -12.2774 },
    Canada: { lat: 56.1304, lng: -106.3468 },
    'New Zealand': { lat: -40.9006, lng: 174.8860 },
    Singapore: { lat: 1.3521, lng: 103.8198 },
    Spain: { lat: 40.4637, lng: -3.7492 },
    China: { lat: 35.8617, lng: 104.1954 },
    Russia: { lat: 61.5240, lng: 105.3188 },
    Finland: { lat: 61.9241, lng: 25.7482 },
    Brazil: { lat: -14.2350, lng: -51.9253 },
    Chile: { lat: -35.6751, lng: -71.5430 },
    Paraguay: { lat: -23.4425, lng: -58.4438 },
    Bolivia: { lat: -16.2902, lng: -63.5887 }
  };

  for (const country in globalCaseData) {
    const data = globalCaseData[country];
    const coords = coordinates[country];

    if (coords) {
      mapMarkers.push({
        name: country,
        lat: coords.lat,
        lng: coords.lng,
        confirmed: data.confirmed,
        suspected: data.suspected,
        deaths: data.deaths,
        strain: data.strain
      });
    }
  }

  res.json(mapMarkers);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Stats: http://localhost:${PORT}/api/stats`);
  console.log(`Cases: http://localhost:${PORT}/api/cases`);
  console.log(`News: http://localhost:${PORT}/api/news`);

  // Initial news fetch
  fetchHantavirusNews();
});
