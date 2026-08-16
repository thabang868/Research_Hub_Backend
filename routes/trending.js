const express = require('express');
const router = express.Router();
const neo4jDriver = require('../config/neo4j');
const smartCache = require('../engine/cache');
const { searchLimiter, sanitize } = require('../middleware/security');

const COHERE_URL = 'https://api.cohere.com/v2/chat';

const BLOCKED_IMAGE_DOMAINS = ['usatoday.com', 'gannett-cdn.com', 'washingtonpost.com', 'nytimes.com', 'wsj.com', 'ft.com'];

// ──────────────────────────────────────────────
// SERVER-SIDE CACHE for live feed (avoids hammering external APIs)
// ──────────────────────────────────────────────
const liveCache = {
  news: { data: [], lastFetch: 0 },
  research: { data: [], lastFetch: 0 },
};
const CACHE_TTL = 30000; // Refresh from external APIs every 30 seconds

function filterImage(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    if (BLOCKED_IMAGE_DOMAINS.some((d) => hostname.includes(d))) return null;
    return url;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// RESEARCH CATEGORIES — OpenAlex topic filters
// ──────────────────────────────────────────────
const RESEARCH_CATEGORIES = {
  genai: {
    label: 'Generative AI',
    icon: 'sparkles',
    color: '#8B5CF6',
    queries: ['generative artificial intelligence', 'large language models', 'GPT', 'diffusion models', 'text-to-image'],
    openalex_concepts: ['C154945302', 'C124101348'],
  },
  datascience: {
    label: 'Data Science',
    icon: 'chart',
    color: '#3B82F6',
    queries: ['data science', 'machine learning', 'deep learning', 'predictive analytics', 'big data'],
    openalex_concepts: ['C124101348', 'C119857082'],
  },
  nature: {
    label: 'Nature & Science',
    icon: 'leaf',
    color: '#10B981',
    queries: ['climate change', 'biodiversity', 'genomics', 'neuroscience', 'quantum physics'],
    openalex_concepts: ['C185592680', 'C86803240'],
  },
  nlp: {
    label: 'Natural Language Processing',
    icon: 'chat',
    color: '#F59E0B',
    queries: ['natural language processing', 'transformer models', 'sentiment analysis', 'text mining', 'BERT'],
    openalex_concepts: ['C204321447', 'C154945302'],
  },
  airesearch: {
    label: 'Top AI Research',
    icon: 'brain',
    color: '#EF4444',
    queries: ['artificial intelligence', 'reinforcement learning', 'computer vision', 'neural architecture', 'foundation models'],
    openalex_concepts: ['C154945302', 'C108827166'],
  },
};

// ──────────────────────────────────────────────
// HELPER: Fetch OpenAlex research by search query
// ──────────────────────────────────────────────
async function fetchOpenAlexResearch(query, perPage = 5) {
  try {
    const currentYear = new Date().getFullYear();
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&sort=cited_by_count:desc&per_page=${perPage}&filter=from_publication_date:${currentYear - 1}-01-01`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((w) => ({
      title: w.display_name,
      year: w.publication_year,
      citations: w.cited_by_count || 0,
      url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
      source: w.primary_location?.source?.display_name || 'OpenAlex',
      abstract: w.abstract_inverted_index ? reconstructAbstract(w.abstract_inverted_index) : null,
      topics: (w.topics || []).slice(0, 3).map((t) => t.display_name),
      type: w.type,
      openAccess: w.open_access?.is_oa || false,
    }));
  } catch {
    return [];
  }
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return null;
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  const text = words.filter(Boolean).join(' ');
  return text.length > 300 ? text.slice(0, 300) + '...' : text;
}

// ──────────────────────────────────────────────
// HELPER: AI-powered BERTopic-style trend detection
// ──────────────────────────────────────────────
async function detectTrends(papers) {
  try {
    if (!papers || papers.length === 0) return [];

    const paperSummaries = papers.slice(0, 20).map((p, i) =>
      `${i + 1}. "${p.title}" (${p.citations} citations, ${p.year}) — Topics: ${(p.topics || []).join(', ')}`
    ).join('\n');

    const response = await fetch(COHERE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'command-a-03-2025',
        messages: [
          {
            role: 'system',
            content: `You are BERTopic — a topic modeling system for research papers. Analyze the given papers and extract emerging research trends. For each trend, provide a JSON array with objects containing: "topic" (short topic name), "description" (one sentence), "heat" (1-100 score for how hot/trending), "papers_count" (how many of the given papers relate), "keywords" (array of 3-5 keywords). Return ONLY valid JSON array, no other text.`,
          },
          {
            role: 'user',
            content: `Analyze these recent research papers and detect the top 6 emerging trends:\n\n${paperSummaries}\n\nReturn JSON array only.`,
          },
        ],
      }),
    });

    if (!response.ok) return [];
    const data = await response.json();
    const text = data.message?.content?.[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// HELPER: Store/Get trending topics in Neo4j
// ──────────────────────────────────────────────
async function storeTrendingInNeo4j(trends, category) {
  const session = neo4jDriver.session();
  try {
    for (const trend of trends) {
      await session.run(
        `MERGE (t:TrendingTopic {name: $name, category: $category})
         SET t.heat = $heat, t.description = $description, t.updatedAt = datetime(),
             t.keywords = $keywords, t.papersCount = $papersCount
         WITH t
         UNWIND $keywords AS kw
         MERGE (k:Keyword {name: kw})
         MERGE (t)-[:HAS_KEYWORD]->(k)`,
        {
          name: trend.topic,
          category,
          heat: trend.heat || 50,
          description: trend.description || '',
          keywords: trend.keywords || [],
          papersCount: trend.papers_count || 0,
        }
      );
    }
  } catch (err) {
    console.error('Neo4j trending store error:', err.message);
  } finally {
    await session.close();
  }
}

async function getTrendingFromNeo4j() {
  const session = neo4jDriver.session();
  try {
    const result = await session.run(
      `MATCH (t:TrendingTopic)
       WHERE t.updatedAt > datetime() - duration('PT24H')
       RETURN t.name AS topic, t.category AS category, t.heat AS heat,
              t.description AS description, t.keywords AS keywords, t.papersCount AS papersCount
       ORDER BY t.heat DESC LIMIT 20`
    );
    return result.records.map((r) => ({
      topic: r.get('topic'),
      category: r.get('category'),
      heat: typeof r.get('heat') === 'object' ? r.get('heat').toNumber() : r.get('heat'),
      description: r.get('description'),
      keywords: r.get('keywords'),
      papersCount: typeof r.get('papersCount') === 'object' ? r.get('papersCount').toNumber() : r.get('papersCount'),
    }));
  } catch (err) {
    console.error('Neo4j trending fetch error:', err.message);
    return [];
  } finally {
    await session.close();
  }
}

// ──────────────────────────────────────────────
// LIVE TRENDING NEWS — NewsAPI
// ──────────────────────────────────────────────
router.get('/news', async (req, res) => {
  try {
    const { category = 'science', country = 'za', limit = 10 } = req.query;
    const url = `https://newsapi.org/v2/top-headlines?category=${category}&country=${country}&pageSize=${limit}&apiKey=${process.env.NEWS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: 'News service unavailable' });
    const data = await response.json();
    const articles = (data.articles || []).map((a) => ({
      title: a.title, description: a.description, source: a.source?.name || 'Unknown',
      url: a.url, image: filterImage(a.urlToImage), publishedAt: a.publishedAt,
    }));
    res.json({ articles, total: data.totalResults || 0 });
  } catch (err) {
    console.error('News error:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

router.get('/news/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=${limit}&language=en&apiKey=${process.env.NEWS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: 'News service unavailable' });
    const data = await response.json();
    const articles = (data.articles || []).map((a) => ({
      title: a.title, description: a.description, source: a.source?.name || 'Unknown',
      url: a.url, image: filterImage(a.urlToImage), publishedAt: a.publishedAt,
    }));
    res.json({ articles, total: data.totalResults || 0 });
  } catch (err) {
    console.error('News search error:', err);
    res.status(500).json({ error: 'Failed to search news' });
  }
});

// ──────────────────────────────────────────────
// CATEGORIZED RESEARCH — fetch papers by category
// ──────────────────────────────────────────────
router.get('/research/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const config = RESEARCH_CATEGORIES[category];
    if (!config) return res.status(400).json({ error: 'Invalid category' });
    const query = config.queries[Math.floor(Math.random() * config.queries.length)];
    const papers = await fetchOpenAlexResearch(query, 8);
    res.json({ category, label: config.label, color: config.color, papers });
  } catch (err) {
    console.error('Research category error:', err);
    res.status(500).json({ error: 'Failed to fetch research' });
  }
});

// ──────────────────────────────────────────────
// TREND DETECTION — BERTopic-style analysis
// ──────────────────────────────────────────────
router.get('/detect-trends', async (req, res) => {
  try {
    const allPapers = [];
    const categoryQueries = Object.values(RESEARCH_CATEGORIES).flatMap((c) => c.queries.slice(0, 2));
    const selectedQueries = categoryQueries.sort(() => Math.random() - 0.5).slice(0, 4);
    const results = await Promise.all(
      selectedQueries.map((q) => fetchOpenAlexResearch(q, 5))
    );
    results.forEach((papers) => allPapers.push(...papers));
    const trends = await detectTrends(allPapers);
    if (trends.length > 0) {
      storeTrendingInNeo4j(trends, 'auto_detected').catch(() => {});
    }
    res.json({ trends, papersAnalyzed: allPapers.length });
  } catch (err) {
    console.error('Trend detection error:', err);
    res.status(500).json({ error: 'Failed to detect trends' });
  }
});

// ──────────────────────────────────────────────
// TECH NEWS — AI, GenAI, Data Science focused
// ──────────────────────────────────────────────
router.get('/tech-news', async (req, res) => {
  try {
    const queries = ['artificial intelligence', 'generative AI', 'data science', 'machine learning'];
    const selectedQuery = queries[Math.floor(Math.random() * queries.length)];
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(selectedQuery)}&sortBy=publishedAt&pageSize=8&language=en&apiKey=${process.env.NEWS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: 'Tech news unavailable' });
    const data = await response.json();
    const articles = (data.articles || []).map((a) => ({
      title: a.title, description: a.description, source: a.source?.name || 'Unknown',
      url: a.url, image: filterImage(a.urlToImage), publishedAt: a.publishedAt,
      category: selectedQuery,
    }));
    res.json({ articles, query: selectedQuery });
  } catch (err) {
    console.error('Tech news error:', err);
    res.status(500).json({ error: 'Failed to fetch tech news' });
  }
});

// ──────────────────────────────────────────────
// NEO4J TRENDING GRAPH — stored trending topics
// ──────────────────────────────────────────────
router.get('/graph-trends', async (req, res) => {
  try {
    const trends = await getTrendingFromNeo4j();
    res.json({ trends });
  } catch (err) {
    console.error('Graph trends error:', err);
    res.status(500).json({ error: 'Failed to fetch graph trends' });
  }
});

// ──────────────────────────────────────────────
// LIVE FEED — cached, polls external APIs every 30s
// Frontend can poll this every 4s without rate-limit issues
// ──────────────────────────────────────────────
router.get('/live', async (req, res) => {
  try {
    const now = Date.now();

    // Refresh news cache if stale
    if (now - liveCache.news.lastFetch > CACHE_TTL) {
      try {
        const queries = ['artificial intelligence', 'generative AI', 'data science', 'machine learning'];
        const selectedQuery = queries[Math.floor(Math.random() * queries.length)];
        const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(selectedQuery)}&sortBy=publishedAt&pageSize=8&language=en&apiKey=${process.env.NEWS_API_KEY}`;
        const newsResp = await fetch(newsUrl);
        if (newsResp.ok) {
          const d = await newsResp.json();
          liveCache.news.data = (d.articles || []).map((a) => ({
            title: a.title, description: a.description, source: a.source?.name || 'Unknown',
            url: a.url, image: filterImage(a.urlToImage), publishedAt: a.publishedAt,
            category: selectedQuery,
          }));
          liveCache.news.lastFetch = now;
        }
      } catch (e) {
        console.error('Live news cache refresh error:', e.message);
      }
    }

    // Refresh research cache if stale — sorted by publication date (newest first)
    if (now - liveCache.research.lastFetch > CACHE_TTL) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const researchUrl = `https://api.openalex.org/works?search=artificial+intelligence+machine+learning+large+language+models&sort=publication_date:desc&per_page=10&filter=from_publication_date:${thirtyDaysAgo},to_publication_date:${today}`;
        const resResp = await fetch(researchUrl, {
          headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' },
        });
        if (resResp.ok) {
          const d = await resResp.json();
          liveCache.research.data = (d.results || []).map((w) => ({
            title: w.display_name, year: w.publication_year,
            citations: w.cited_by_count,
            url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
            source: w.primary_location?.source?.display_name || 'OpenAlex',
            publishedAt: w.publication_date,
          }));
          liveCache.research.lastFetch = now;
        }
      } catch (e) {
        console.error('Live research cache refresh error:', e.message);
      }
    }

    res.json({
      articles: liveCache.news.data,
      trendingPapers: liveCache.research.data,
      cachedAt: { news: liveCache.news.lastFetch, research: liveCache.research.lastFetch },
    });
  } catch (err) {
    console.error('Live feed error:', err);
    res.status(500).json({ error: 'Failed to fetch live feed' });
  }
});

// ──────────────────────────────────────────────
// COMBINED TRENDING — news + research (no market data)
// ──────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const [newsRes, researchRes] = await Promise.allSettled([
      fetch(`https://newsapi.org/v2/top-headlines?category=science&country=us&pageSize=5&apiKey=${process.env.NEWS_API_KEY}`),
      fetch('https://api.openalex.org/works?search=generative+artificial+intelligence+large+language+models+natural+language+processing&sort=cited_by_count:desc&per_page=10&filter=from_publication_date:2024-01-01', {
        headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' },
      }),
    ]);

    const result = { news: [], trendingPapers: [] };

    if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
      const d = await newsRes.value.json();
      result.news = (d.articles || []).map((a) => ({
        title: a.title, description: a.description, source: a.source?.name,
        url: a.url, image: filterImage(a.urlToImage), publishedAt: a.publishedAt,
      }));
    }

    if (researchRes.status === 'fulfilled' && researchRes.value.ok) {
      const d = await researchRes.value.json();
      result.trendingPapers = (d.results || []).map((w) => ({
        title: w.display_name, year: w.publication_year,
        citations: w.cited_by_count, url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : w.id,
        source: w.primary_location?.source?.display_name || 'OpenAlex',
      }));
    }

    res.json(result);
  } catch (err) {
    console.error('Trending all error:', err);
    res.status(500).json({ error: 'Failed to fetch trending data' });
  }
});

module.exports = router;
