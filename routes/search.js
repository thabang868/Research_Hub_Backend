const express = require('express');
const router = express.Router();
const learningEngine = require('../engine/learning');
const smartCache = require('../engine/cache');
const { optionalAuth, searchLimiter, sanitize } = require('../middleware/security');

const OPENALEX_HEADERS = {
  'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)',
};

const TRUSTED_PAPER_SOURCES = [
  {
    name: 'Scielo',
    url: (query) => `https://search.scielo.org/?q=${encodeURIComponent(query)}`,
  },
  {
    name: 'BASE',
    url: (query) => `https://www.base-search.net/Search/Results?lookfor=${encodeURIComponent(query)}&type=all&sort=score`,
  },
  {
    name: 'AJOL',
    url: (query) => `https://www.ajol.info/index.php/search?query=${encodeURIComponent(query)}`,
  },
];

// ──────────────────────────────────────────────
// SEARCH PAPERS — OpenAlex + trusted research repositories + English normalization
// ──────────────────────────────────────────────
router.get('/papers', optionalAuth, searchLimiter, sanitize, async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const userId = req.user?.id || 'anonymous';
    learningEngine.recordQuery(userId, q, 'paper_search');

    const cacheKey = `papers:${q}:${limit}:${offset}`;
    const cached = smartCache.get(cacheKey);
    if (cached) return res.json(cached);

    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    const requestedLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
    const openAlexUrl = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${requestedLimit * 3}&page=${page}&sort=relevance_score:desc`;
    const openAlexResponse = await fetchWithTimeout(openAlexUrl, { headers: OPENALEX_HEADERS });

    let openAlexPapers = [];
    if (openAlexResponse.ok) {
      const data = await openAlexResponse.json();
      openAlexPapers = (data.results || []).map((work) => mapOpenAlexWork(work, 'OpenAlex'))
        .filter((paper) => isGenuinePaper(paper) && isRelevantResult(paper, q));
    }

    // OpenAlex records have stable identifiers and canonical landing pages. HTML
    // search-page links are intentionally excluded because they are not papers.
    const normalized = dedupePapers(openAlexPapers).slice(0, requestedLimit);

    const result = {
      papers: normalized,
      total: normalized.length,
      offset: parseInt(offset),
      limit: requestedLimit,
      sources: countSources(normalized),
    };

    smartCache.set(cacheKey, result, 'search');
    res.json(result);
  } catch (err) {
    console.error('Paper search error:', err);
    learningEngine.recordFailure('paper_search_error', { error: err.message });
    res.status(500).json({ error: 'Failed to search papers' });
  }
});

// ──────────────────────────────────────────────
// SEARCH DATASETS — OpenAlex + Harvard Dataverse + Zenodo + UCI + HuggingFace + World Bank + NASA + PubMed
// ──────────────────────────────────────────────
router.get('/datasets', optionalAuth, searchLimiter, sanitize, async (req, res) => {
  try {
    const { q, limit = 10, page = 1 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    // BMAD: Record and cache
    const userId = req.user?.id || 'anonymous';
    learningEngine.recordQuery(userId, q, 'dataset_search');

    const cacheKey = `datasets:${q}:${limit}:${page}`;
    const cached = smartCache.get(cacheKey);
    if (cached) return res.json(cached);

    const searchQuery = buildDatasetQuery(q);

    const sadilarResources = getSadilarResources(q);

    const [openAlexRes, dataverseRes, zenodoRes, huggingFaceRes, worldBankRes, nasaRes, pubmedDataRes, uciRes] = await Promise.allSettled([
      fetch(
        `https://api.openalex.org/works?search=${encodeURIComponent(searchQuery)}&filter=type:dataset&per_page=50&page=${page}&sort=relevance_score:desc`,
        { headers: OPENALEX_HEADERS }
      ),
      fetch(
        `https://dataverse.harvard.edu/api/search?q=${encodeURIComponent(searchQuery)}&type=dataset&per_page=50&start=${(parseInt(page) - 1) * 50}`
      ),
      fetch(
        `https://zenodo.org/api/records?q=${encodeURIComponent(searchQuery)}&type=dataset&size=25&sort=bestmatch`
      ),
      // Hugging Face Datasets API
      fetch(
        `https://huggingface.co/api/datasets?search=${encodeURIComponent(searchQuery)}&limit=50&sort=downloads&direction=-1`
      ),
      // World Bank Indicators API
      fetch(
        `https://api.worldbank.org/v2/indicator?format=json&per_page=20000&source=2`
      ),
      // NASA Open Data API (CKAN-based)
      fetch(
        `https://data.nasa.gov/api/3/action/package_search?q=${encodeURIComponent(searchQuery)}&rows=50`
      ),
      // PubMed datasets via search
      fetch(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gds&term=${encodeURIComponent(searchQuery)}&retmax=50&retmode=json`
      ),
      fetch(
        `https://archive.ics.uci.edu/api/datasets/list?search=${encodeURIComponent(searchQuery)}`
      ),
    ]);

    let datasets = [];

    // OpenAlex
    if (openAlexRes.status === 'fulfilled' && openAlexRes.value.ok) {
      const data = await safeJson(openAlexRes.value);
      if (data) {
        datasets.push(...mapDatasets(data.results || []).map((d) => ({ ...d, _from: 'OpenAlex' })));
      }
    }

    // Harvard Dataverse
    if (dataverseRes.status === 'fulfilled' && dataverseRes.value.ok) {
      const data = await safeJson(dataverseRes.value);
      if (data) {
        datasets.push(
          ...(data.data?.items || []).map((item) => ({
            id: `dataverse-${item.global_id || item.entity_id}`,
            title: item.name || 'Untitled',
            source: 'Harvard Dataverse',
            year: item.published_at ? parseInt(item.published_at.slice(0, 4)) : null,
            url: item.url || `https://dataverse.harvard.edu/dataset.xhtml?persistentId=${item.global_id}`,
            citations: item.citation_count || 0,
            type: 'dataset',
            keywords: (item.subjects || []).slice(0, 5),
            description: item.description || '',
            _from: 'Harvard Dataverse',
          }))
        );
      }
    }

    // Zenodo
    if (zenodoRes.status === 'fulfilled' && zenodoRes.value.ok) {
      const data = await safeJson(zenodoRes.value);
      if (data) {
        datasets.push(
          ...(data.hits?.hits || []).map((hit) => ({
            id: `zenodo-${hit.id}`,
            title: hit.metadata?.title || 'Untitled',
            source: 'Zenodo',
            year: hit.metadata?.publication_date ? parseInt(hit.metadata.publication_date.slice(0, 4)) : null,
            url: hit.links?.self_html || hit.links?.html || `https://zenodo.org/records/${hit.id}`,
            citations: 0,
            type: 'dataset',
            keywords: (hit.metadata?.keywords || []).slice(0, 5),
            description: hit.metadata?.description?.replace(/<[^>]*>/g, '').slice(0, 200) || '',
            _from: 'Zenodo',
          }))
        );
      }
    }

    // Hugging Face
    if (huggingFaceRes.status === 'fulfilled' && huggingFaceRes.value.ok) {
      try {
        const data = await safeJson(huggingFaceRes.value);
        if (data) {
          datasets.push(
            ...(data || []).slice(0, 50).map((ds) => ({
              id: `hf-${ds.id}`,
              title: ds.id || 'Untitled',
              source: 'Hugging Face',
              year: ds.lastModified ? parseInt(ds.lastModified.slice(0, 4)) : null,
              url: `https://huggingface.co/datasets/${ds.id}`,
              citations: ds.downloads || 0,
              type: 'dataset',
              keywords: (ds.tags || []).filter((t) => !t.includes(':') && t.length < 30).slice(0, 5),
              description: ds.description?.slice(0, 200) || `${ds.downloads?.toLocaleString() || 0} downloads`,
              _from: 'Hugging Face',
            }))
          );
        }
      } catch {}
    }

    // World Bank — search indicators matching the query
    if (worldBankRes.status === 'fulfilled' && worldBankRes.value.ok) {
      try {
        const data = await safeJson(worldBankRes.value);
        if (!data) throw new Error('WorldBank empty');
        const indicators = data[1] || [];
        const queryLower = q.toLowerCase();
        const matched = indicators.filter((ind) =>
          (ind.name || '').toLowerCase().includes(queryLower) ||
          (ind.sourceNote || '').toLowerCase().includes(queryLower)
        ).slice(0, 15);
        datasets.push(
          ...matched.map((ind) => ({
            id: `wb-${ind.id}`,
            title: ind.name || 'Untitled Indicator',
            source: 'World Bank',
            year: null,
            url: `https://data.worldbank.org/indicator/${ind.id}`,
            citations: 0,
            type: 'dataset',
            keywords: [ind.source?.value, 'economics', 'development'].filter(Boolean).slice(0, 5),
            description: (ind.sourceNote || '').slice(0, 200),
            _from: 'World Bank',
          }))
        );
      } catch {}
    }

    // NASA Open Data
    if (nasaRes.status === 'fulfilled' && nasaRes.value.ok) {
      try {
        const data = await safeJson(nasaRes.value);
        if (!data) throw new Error('NASA empty');
        const results = data.result?.results || [];
        datasets.push(
          ...results.slice(0, 30).map((item) => ({
            id: `nasa-${item.id || item.name}`,
            title: item.title || item.name || 'Untitled',
            source: 'NASA',
            year: item.metadata_created ? parseInt(item.metadata_created.slice(0, 4)) : null,
            url: `https://data.nasa.gov/dataset/${item.name || item.id}`,
            citations: 0,
            type: 'dataset',
            keywords: (item.tags || []).map((t) => t.display_name || t.name).slice(0, 5),
            description: (item.notes || '').replace(/<[^>]*>/g, '').slice(0, 200),
            _from: 'NASA',
          }))
        );
      } catch {}
    }

    // PubMed GEO datasets
    if (pubmedDataRes.status === 'fulfilled' && pubmedDataRes.value.ok) {
      try {
        const data = await safeJson(pubmedDataRes.value);
        if (!data) throw new Error('PubMed GEO empty');
        const ids = data.esearchresult?.idlist || [];
        if (ids.length > 0) {
          const detailRes = await fetch(
            `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gds&id=${ids.slice(0, 15).join(',')}&retmode=json`
          );
          if (detailRes.ok) {
            const detailData = await safeJson(detailRes);
            if (detailData) {
              const results = detailData.result || {};
              for (const id of ids.slice(0, 15)) {
                const item = results[id];
                if (!item || item.error) continue;
                datasets.push({
                  id: `pubmed-gds-${id}`,
                  title: item.title || 'Untitled',
                  source: 'PubMed GEO',
                  year: item.pdat ? parseInt(item.pdat.slice(0, 4)) : null,
                  url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${item.accession || `GDS${id}`}`,
                  citations: 0,
                  type: 'dataset',
                  keywords: [item.gdstype, item.taxon, 'genomics'].filter(Boolean).slice(0, 5),
                  description: (item.summary || '').slice(0, 200),
                  _from: 'PubMed GEO',
                });
              }
            }
          }
        }
      } catch {}
    }

    // UCI Machine Learning Repository — concrete dataset records, not search links.
    if (uciRes.status === 'fulfilled' && uciRes.value.ok) {
      const data = await safeJson(uciRes.value);
      datasets.push(...(data?.data || []).map((item) => ({
        id: `uci-${item.id}`,
        title: item.name || 'Untitled',
        source: 'UCI Machine Learning Repository',
        year: null,
        url: `https://archive.ics.uci.edu/dataset/${item.id}`,
        citations: 0,
        type: 'dataset',
        keywords: [],
        description: '',
        _from: 'UCI Machine Learning Repository',
      })));
    }

    if (sadilarResources.length > 0) {
      datasets.unshift(...sadilarResources.map((resource) => ({
        ...resource,
        _from: 'SADiLaR',
      })));
    }

    // Search pages and papers relabelled as datasets are not downloadable data.
    const requestedLimit = Math.min(Math.max(parseInt(limit) || 30, 1), 50);
    datasets = selectDiverseDatasets(
      dedupeDatasets(datasets).filter((dataset) => isGenuineDataset(dataset) && isRelevantResult(dataset, searchQuery)),
      requestedLimit,
      searchQuery
    );

    // Count sources
    const sourceCounts = {};
    for (const d of datasets) {
      sourceCounts[d._from] = (sourceCounts[d._from] || 0) + 1;
    }

    const result = { datasets, total: datasets.length, sources: sourceCounts };
    smartCache.set(cacheKey, result, 'search');
    res.json(result);
  } catch (err) {
    console.error('Dataset search error:', err);
    learningEngine.recordFailure('dataset_search_error', { error: err.message });
    res.status(500).json({ error: 'Failed to search datasets' });
  }
});

// ──────────────────────────────────────────────
// SEARCH CROSSREF — 150M+ works, free, no key
// ──────────────────────────────────────────────
router.get('/crossref', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${limit}&offset=${offset}&sort=relevance&order=desc`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' },
    });
    if (!response.ok) return res.status(502).json({ error: 'CrossRef unavailable' });

    const data = await response.json();
    const items = data.message?.items || [];
    const papers = items.map((item) => ({
      id: item.DOI,
      title: (item.title || ['Untitled'])[0],
      abstract: item.abstract ? item.abstract.replace(/<[^>]*>/g, '').slice(0, 500) : '',
      authors: (item.author || []).map((a) => `${a.given || ''} ${a.family || ''}`.trim()),
      year: item.published?.['date-parts']?.[0]?.[0] || null,
      citations: item['is-referenced-by-count'] || 0,
      url: `https://doi.org/${item.DOI}`,
      doi: item.DOI,
      fields: item.subject || [],
      source: (item['container-title'] || ['CrossRef'])[0],
      type: item.type || 'article',
    }));

    res.json({ papers, total: data.message?.['total-results'] || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('CrossRef search error:', err);
    res.status(500).json({ error: 'Failed to search CrossRef' });
  }
});

// ──────────────────────────────────────────────
// PUBMED — free, no key, 37M+ biomedical papers
// ──────────────────────────────────────────────
router.get('/pubmed', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    // Step 1: Search for IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmax=${limit}&retstart=${offset}&sort=relevance&retmode=json`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return res.status(502).json({ error: 'PubMed unavailable' });

    const searchData = await searchRes.json();
    const ids = searchData.esearchresult?.idlist || [];
    const total = parseInt(searchData.esearchresult?.count || 0);

    if (ids.length === 0) return res.json({ papers: [], total: 0, offset: parseInt(offset), limit: parseInt(limit) });

    // Step 2: Fetch details
    const detailUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
    const detailRes = await fetch(detailUrl);
    if (!detailRes.ok) return res.json({ papers: [], total, offset: parseInt(offset), limit: parseInt(limit) });

    const detailData = await detailRes.json();
    const results = detailData.result || {};

    const papers = ids.map((id) => {
      const item = results[id];
      if (!item || item.error) return null;
      return {
        id: `pubmed-${id}`,
        title: item.title || 'Untitled',
        abstract: '',
        authors: (item.authors || []).map((a) => a.name),
        year: item.pubdate ? parseInt(item.pubdate.slice(0, 4)) : null,
        citations: 0,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        doi: (item.elocationid || '').replace('doi: ', ''),
        fields: [],
        source: item.fulljournalname || item.source || 'PubMed',
        type: 'article',
        openAccess: false,
        pdfUrl: '',
      };
    }).filter(Boolean);

    res.json({ papers, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('PubMed search error:', err);
    res.status(500).json({ error: 'Failed to search PubMed' });
  }
});

// ──────────────────────────────────────────────
// CORE — 300M+ open access papers, free API
// ──────────────────────────────────────────────
router.get('/core', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${process.env.CORE_API_KEY || ''}` },
    });

    // Fallback: search CORE via OpenAlex if no API key
    if (!response.ok || !process.env.CORE_API_KEY) {
      const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=open_access.is_oa:true&per_page=${limit}&page=${Math.floor(parseInt(offset) / parseInt(limit)) + 1}&sort=relevance_score:desc`;
      const oaRes = await fetch(oaUrl, { headers: OPENALEX_HEADERS });
      if (!oaRes.ok) return res.status(502).json({ error: 'CORE unavailable' });
      const oaData = await oaRes.json();
      const papers = (oaData.results || []).map((work) => ({
        ...mapOpenAlexWork(work, 'CORE (via OpenAlex)'),
        openAccess: true,
      }));
      return res.json({ papers, total: oaData.meta?.count || 0, offset: parseInt(offset), limit: parseInt(limit) });
    }

    const data = await response.json();
    const papers = (data.results || []).map((item) => ({
      id: `core-${item.id}`,
      title: item.title || 'Untitled',
      abstract: (item.abstract || '').slice(0, 500),
      authors: (item.authors || []).map((a) => a.name || a).filter(Boolean),
      year: item.yearPublished || null,
      citations: item.citationCount || 0,
      url: item.downloadUrl || item.sourceFulltextUrls?.[0] || `https://core.ac.uk/works/${item.id}`,
      doi: item.doi || '',
      fields: (item.fieldOfStudy || []).slice(0, 5),
      source: item.publisher || 'CORE',
      type: 'article',
      openAccess: true,
      pdfUrl: item.downloadUrl || '',
    }));

    res.json({ papers, total: data.totalHits || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('CORE search error:', err);
    res.status(500).json({ error: 'Failed to search CORE' });
  }
});

// ──────────────────────────────────────────────
// SCIENCEDIRECT / RESEARCHGATE — via OpenAlex filters (free proxy)
// ──────────────────────────────────────────────
router.get('/sciencedirect', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    // Search for papers from Elsevier (ScienceDirect publisher) via OpenAlex
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=primary_location.source.publisher_lineage:P4310320990&per_page=${limit}&page=${page}&sort=relevance_score:desc`;
    const response = await fetch(url, { headers: OPENALEX_HEADERS });
    if (!response.ok) return res.status(502).json({ error: 'ScienceDirect unavailable' });

    const data = await response.json();
    const papers = (data.results || []).map((work) => mapOpenAlexWork(work, 'ScienceDirect'));

    res.json({ papers, total: data.meta?.count || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('ScienceDirect search error:', err);
    res.status(500).json({ error: 'Failed to search ScienceDirect' });
  }
});

router.get('/researchgate', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    // ResearchGate doesn't have a public API — use OpenAlex which indexes ResearchGate content
    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${limit}&page=${page}&sort=cited_by_count:desc`;
    const response = await fetch(url, { headers: OPENALEX_HEADERS });
    if (!response.ok) return res.status(502).json({ error: 'ResearchGate unavailable' });

    const data = await response.json();
    const papers = (data.results || []).map((work) => mapOpenAlexWork(work, 'ResearchGate'));

    res.json({ papers, total: data.meta?.count || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('ResearchGate search error:', err);
    res.status(500).json({ error: 'Failed to search ResearchGate' });
  }
});

// ──────────────────────────────────────────────
// MULTI-SOURCE SEARCH — All sources simultaneously
// ──────────────────────────────────────────────
router.get('/multi', async (req, res) => {
  try {
    const { q, limit = 30 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const perSource = 10;

    const fetches = [
      // OpenAlex
      fetch(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${perSource}&sort=relevance_score:desc`, { headers: OPENALEX_HEADERS }),
      // CrossRef
      fetch(`https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${perSource}&sort=relevance&order=desc`, { headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' } }),
      // PubMed
      fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmax=${perSource}&sort=relevance&retmode=json`),
      // arXiv
      fetch(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${perSource}&sortBy=relevance&sortOrder=descending`),
      // CORE (open access via OpenAlex)
      fetch(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=open_access.is_oa:true&per_page=${perSource}&sort=relevance_score:desc`, { headers: OPENALEX_HEADERS }),
      // ScienceDirect (Elsevier via OpenAlex)
      fetch(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=primary_location.source.publisher_lineage:P4310320990&per_page=${perSource}&sort=relevance_score:desc`, { headers: OPENALEX_HEADERS }),
      // IEEE Xplore (via OpenAlex)
      fetch(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=primary_location.source.display_name:IEEE&per_page=${perSource}&sort=relevance_score:desc`, { headers: OPENALEX_HEADERS }),
    ];

    // Semantic Scholar
    if (process.env.SEMANTIC_SCHOLAR_KEY) {
      fetches.push(
        fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${perSource}&fields=title,abstract,authors,year,citationCount,url,externalIds,fieldsOfStudy,isOpenAccess,openAccessPdf`, {
          headers: { 'x-api-key': process.env.SEMANTIC_SCHOLAR_KEY },
        })
      );
    }

    const results = await Promise.allSettled(fetches);
    let papers = [];

    // OpenAlex
    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      const data = await results[0].value.json();
      papers.push(...(data.results || []).map((w) => ({ ...mapOpenAlexWork(w, 'OpenAlex'), _from: 'OpenAlex' })));
    }

    // CrossRef
    if (results[1].status === 'fulfilled' && results[1].value.ok) {
      const data = await results[1].value.json();
      papers.push(...(data.message?.items || []).map((item) => ({
        id: item.DOI,
        title: (item.title || ['Untitled'])[0],
        abstract: item.abstract ? item.abstract.replace(/<[^>]*>/g, '').slice(0, 500) : '',
        authors: (item.author || []).slice(0, 5).map((a) => `${a.given || ''} ${a.family || ''}`.trim()),
        year: item.published?.['date-parts']?.[0]?.[0] || null,
        citations: item['is-referenced-by-count'] || 0,
        url: `https://doi.org/${item.DOI}`,
        doi: item.DOI,
        fields: (item.subject || []).slice(0, 3),
        source: (item['container-title'] || ['CrossRef'])[0],
        openAccess: false,
        pdfUrl: '',
        _from: 'CrossRef',
      })));
    }

    // PubMed
    if (results[2].status === 'fulfilled' && results[2].value.ok) {
      try {
        const searchData = await results[2].value.json();
        const ids = searchData.esearchresult?.idlist || [];
        if (ids.length > 0) {
          const detailRes = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            const r = detailData.result || {};
            for (const id of ids) {
              const item = r[id];
              if (!item || item.error) continue;
              papers.push({
                id: `pubmed-${id}`,
                title: item.title || 'Untitled',
                abstract: '',
                authors: (item.authors || []).slice(0, 5).map((a) => a.name),
                year: item.pubdate ? parseInt(item.pubdate.slice(0, 4)) : null,
                citations: 0,
                url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
                doi: (item.elocationid || '').replace('doi: ', ''),
                fields: [],
                source: item.fulljournalname || item.source || 'PubMed',
                openAccess: false,
                pdfUrl: '',
                _from: 'PubMed',
              });
            }
          }
        }
      } catch {}
    }

    // arXiv
    if (results[3].status === 'fulfilled' && results[3].value.ok) {
      try {
        const xmlText = await results[3].value.text();
        papers.push(...parseArxivXml(xmlText).map((p) => ({ ...p, _from: 'arXiv' })));
      } catch {}
    }

    // CORE
    if (results[4].status === 'fulfilled' && results[4].value.ok) {
      const data = await results[4].value.json();
      papers.push(...(data.results || []).map((w) => ({ ...mapOpenAlexWork(w, 'CORE'), openAccess: true, _from: 'CORE' })));
    }

    // ScienceDirect
    if (results[5].status === 'fulfilled' && results[5].value.ok) {
      const data = await results[5].value.json();
      papers.push(...(data.results || []).map((w) => ({ ...mapOpenAlexWork(w, 'ScienceDirect'), _from: 'ScienceDirect' })));
    }

    // IEEE
    if (results[6].status === 'fulfilled' && results[6].value.ok) {
      const data = await results[6].value.json();
      papers.push(...(data.results || []).map((w) => ({ ...mapOpenAlexWork(w, 'IEEE Xplore'), _from: 'IEEE Xplore' })));
    }

    // Semantic Scholar
    if (results[7] && results[7].status === 'fulfilled' && results[7].value.ok) {
      const data = await results[7].value.json();
      papers.push(...(data.data || []).map((p) => ({
        id: p.paperId,
        title: p.title || 'Untitled',
        abstract: p.abstract || '',
        authors: (p.authors || []).slice(0, 5).map((a) => a.name),
        year: p.year,
        citations: p.citationCount || 0,
        url: p.url || '',
        doi: p.externalIds?.DOI || '',
        fields: p.fieldsOfStudy || [],
        source: 'Semantic Scholar',
        openAccess: p.isOpenAccess || false,
        pdfUrl: p.openAccessPdf?.url || '',
        _from: 'Semantic Scholar',
      })));
    }

    // Deduplicate by DOI
    const byDoi = new Map();
    const noDoi = [];
    for (const p of papers) {
      if (p.doi) {
        const existing = byDoi.get(p.doi);
        if (!existing || (p.abstract && !existing.abstract) || p.citations > (existing.citations || 0)) {
          byDoi.set(p.doi, p);
        }
      } else {
        noDoi.push(p);
      }
    }

    const titleSeen = new Set();
    const uniqueNoDoi = noDoi.filter((p) => {
      const key = p.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (titleSeen.has(key)) return false;
      titleSeen.add(key);
      return true;
    });

    let unique = [...byDoi.values(), ...uniqueNoDoi]
      .filter((paper) => isGenuinePaper(paper) && isRelevantResult(paper, q));
    unique.sort((a, b) => (b.citations || 0) - (a.citations || 0));
    unique = unique.slice(0, Math.min(Math.max(parseInt(limit) || 30, 1), 50));

    const sourceCounts = {};
    for (const p of unique) {
      sourceCounts[p._from] = (sourceCounts[p._from] || 0) + 1;
    }

    res.json({ papers: unique, total: unique.length, sources: sourceCounts });
  } catch (err) {
    console.error('Multi search error:', err);
    res.status(500).json({ error: 'Failed to search' });
  }
});

// ──────────────────────────────────────────────
// SEMANTIC SCHOLAR — with API key
// ──────────────────────────────────────────────
router.get('/semantic', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });
    if (!process.env.SEMANTIC_SCHOLAR_KEY) return res.status(503).json({ error: 'Semantic Scholar API key not configured' });

    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&fields=title,abstract,authors,year,citationCount,url,externalIds,fieldsOfStudy,isOpenAccess,openAccessPdf`;
    const response = await fetch(url, { headers: { 'x-api-key': process.env.SEMANTIC_SCHOLAR_KEY } });
    if (!response.ok) return res.status(response.status).json({ error: 'Semantic Scholar unavailable' });

    const data = await response.json();
    const papers = (data.data || []).map((paper) => ({
      id: paper.paperId,
      title: paper.title,
      abstract: paper.abstract || '',
      authors: (paper.authors || []).map((a) => a.name),
      year: paper.year,
      citations: paper.citationCount || 0,
      url: paper.url || '',
      doi: paper.externalIds?.DOI || '',
      fields: paper.fieldsOfStudy || [],
      source: 'Semantic Scholar',
      openAccess: paper.isOpenAccess || false,
      pdfUrl: paper.openAccessPdf?.url || '',
    }));

    res.json({ papers, total: data.total || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('Semantic Scholar search error:', err);
    res.status(500).json({ error: 'Failed to search Semantic Scholar' });
  }
});

// ──────────────────────────────────────────────
// ARXIV — free, no key, 2.4M+ papers
// ──────────────────────────────────────────────
router.get('/arxiv', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=${parseInt(offset)}&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
    const response = await fetch(url);
    if (!response.ok) return res.status(502).json({ error: 'arXiv unavailable' });

    const xmlText = await response.text();
    const totalMatch = xmlText.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;

    const papers = parseArxivXml(xmlText);
    res.json({ papers, total, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('arXiv search error:', err);
    res.status(500).json({ error: 'Failed to search arXiv' });
  }
});

// ──────────────────────────────────────────────
// IEEE XPLORE — via OpenAlex IEEE filter (free)
// ──────────────────────────────────────────────
router.get('/ieee', async (req, res) => {
  try {
    const { q, limit = 10, offset = 0 } = req.query;
    if (!q) return res.status(400).json({ error: 'Search query is required' });

    const page = Math.floor(parseInt(offset) / parseInt(limit)) + 1;
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&filter=primary_location.source.display_name:IEEE&per_page=${limit}&page=${page}&sort=relevance_score:desc`;
    const response = await fetch(url, { headers: OPENALEX_HEADERS });
    if (!response.ok) return res.status(502).json({ error: 'IEEE search unavailable' });

    const data = await response.json();
    const papers = (data.results || []).map((work) => mapOpenAlexWork(work, 'IEEE Xplore'));

    res.json({ papers, total: data.meta?.count || 0, offset: parseInt(offset), limit: parseInt(limit) });
  } catch (err) {
    console.error('IEEE search error:', err);
    res.status(500).json({ error: 'Failed to search IEEE' });
  }
});

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(' ').slice(0, 500);
}

async function safeJson(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripHtml(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with',
  'dataset', 'datasets', 'data', 'research', 'study', 'studies', 'analysis', 'analysing', 'analyzing', 'assessing',
  'evaluate', 'evaluating', 'evaluation', 'accuracy', 'impact', 'role', 'effect', 'effects', 'using', 'based',
  'user', 'users', 'experience', 'experiences', 'model', 'models', 'system', 'systems', 'approach', 'support',
]);

function queryTerms(query) {
  return String(query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((term) => term.length > 1 && !STOP_WORDS.has(term)) || [];
}

function buildDatasetQuery(query) {
  let terms = queryTerms(query);
  const methodTerms = new Set(['artificial', 'intelligence', 'machine', 'learning', 'deep', 'algorithm', 'algorithms']);
  const domainTerms = terms.filter((term) => !methodTerms.has(term));
  // When a title contains both a method and a subject, repositories retrieve far
  // more useful datasets from the subject (for example "cancer detection") than
  // from the whole sentence. Two terms also avoid implicit-AND over-filtering.
  if (domainTerms.length >= 2) terms = domainTerms;
  return (terms.slice(0, 2).join(' ') || String(query || '').trim()).slice(0, 100);
}

function isRelevantResult(item, query) {
  const terms = queryTerms(query);
  if (!terms.length) return false;
  const title = stripHtml(item.title || '').toLowerCase();
  const searchable = `${title} ${stripHtml(item.abstract || item.description || '')} ${(item.fields || item.keywords || []).join(' ')}`.toLowerCase();
  const matches = terms.filter((term) => searchable.includes(term));
  const required = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.4));
  return matches.length >= required;
}

function isHttpUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function isGenuinePaper(paper) {
  if (!paper.id || !paper.title || paper.title === 'Untitled' || !isHttpUrl(paper.url)) return false;
  try {
    const host = new URL(paper.url).hostname.toLowerCase();
    return Boolean(paper.doi || ['openalex.org', 'pubmed.ncbi.nlm.nih.gov', 'arxiv.org', 'semanticscholar.org'].some((domain) => host === domain || host.endsWith(`.${domain}`)));
  } catch { return false; }
}

function isGenuineDataset(dataset) {
  // OpenAlex's `type:dataset` classification includes reports and articles. Use
  // repositories that expose a concrete dataset record instead.
  const trusted = new Set(['Harvard Dataverse', 'Zenodo', 'Hugging Face', 'World Bank', 'NASA', 'PubMed GEO', 'UCI Machine Learning Repository', 'SADiLaR']);
  return Boolean(dataset.id && dataset.title && dataset.title !== 'Untitled' && trusted.has(dataset._from) && isHttpUrl(dataset.url));
}

function dedupeDatasets(items) {
  const seen = new Map();
  for (const item of items) {
    const key = String(item.url || item.id).toLowerCase().replace(/\/$/, '');
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function relevanceScore(item, query) {
  const terms = queryTerms(query);
  const title = stripHtml(item.title || '').toLowerCase();
  const description = stripHtml(item.description || '').toLowerCase();
  const keywords = (item.keywords || []).join(' ').toLowerCase();
  return terms.reduce((score, term) => score
    + (title.includes(term) ? 5 : 0)
    + (keywords.includes(term) ? 2 : 0)
    + (description.includes(term) ? 1 : 0), 0);
}

function selectDiverseDatasets(items, limit, query) {
  const groups = new Map();
  for (const item of items) {
    const source = item._from || item.source || 'Unknown';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(item);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => relevanceScore(b, query) - relevanceScore(a, query));
  }

  // Round-robin selection guarantees that every source with relevant records is
  // represented before a prolific repository receives a second slot.
  const selected = [];
  const sourceNames = [...groups.keys()];
  let round = 0;
  while (selected.length < limit) {
    let added = false;
    for (const source of sourceNames) {
      const candidate = groups.get(source)[round];
      if (candidate) {
        selected.push(candidate);
        added = true;
        if (selected.length === limit) break;
      }
    }
    if (!added) break;
    round++;
  }
  return selected;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function countSources(items) {
  const counts = {};
  for (const item of items || []) {
    const source = item.source || 'Unknown';
    counts[source] = (counts[source] || 0) + 1;
  }
  return counts;
}

function dedupePapers(items) {
  const deduped = new Map();
  for (const paper of items) {
    const candidate = {
      ...paper,
      title: stripHtml(paper.title || 'Untitled'),
      abstract: stripHtml(paper.abstract || ''),
    };

    const key = candidate.doi || candidate.url || candidate.title?.toLowerCase();
    if (!key) {
      deduped.set(`${candidate.source}-${Math.random()}` , candidate);
      continue;
    }

    const existing = deduped.get(key);
    if (!existing || (candidate.citations || 0) > (existing.citations || 0)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()].sort((a, b) => (b.citations || 0) - (a.citations || 0));
}

async function translateText(text) {
  const cleanText = stripHtml(text || '').trim();
  if (!cleanText || cleanText.length < 3) return cleanText;

  try {
    const response = await fetch('https://translate.argosopentech.com/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ResearchHubAI/1.0',
      },
      body: JSON.stringify({
        q: cleanText,
        source: 'auto',
        target: 'en',
        format: 'text',
      }),
    });

    if (!response.ok) return cleanText;
    const data = await response.json();
    const translated = Array.isArray(data) ? data[0]?.translatedText : data?.translatedText;
    return translated || cleanText;
  } catch (error) {
    console.warn('Translation fallback used for text:', error.message);
    return cleanText;
  }
}

async function searchTrustedPaperSources(query, limit) {
  const sources = await Promise.all(
    TRUSTED_PAPER_SOURCES.map(async (source) => {
      try {
        const response = await fetch(source.url(query), {
          headers: { 'User-Agent': 'ResearchHubAI/1.0 (mailto:research@example.com)' },
        });

        if (!response.ok) return [];

        const html = await response.text();
        const items = [];
        const hrefPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;

        while ((match = hrefPattern.exec(html)) !== null) {
          const href = match[1];
          const label = decodeHtml(stripHtml(match[2] || ''));
          if (!href || !label) continue;
          if (!href.includes('http') && !href.startsWith('/')) continue;

          const cleanUrl = href.startsWith('http') ? href : new URL(href, response.url).toString();
          const urlLower = cleanUrl.toLowerCase();
          const blocked = /anubis|honeypot|within\.website|techaro|dont click me|click me/i.test(label) || /anubis|honeypot|within\.website|techaro/i.test(urlLower);
          if (blocked) continue;

          const allowedDomains = ['scielo.org', 'base-search.net', 'ajol.info'];
          if (!allowedDomains.some((d) => urlLower.includes(d))) continue;

          items.push({
            id: `${source.name.toLowerCase()}-${cleanUrl}`,
            title: label,
            abstract: `${source.name} result for query: ${query}`,
            authors: [],
            year: null,
            citations: 0,
            url: cleanUrl,
            doi: '',
            fields: ['trusted source'],
            source: source.name,
            type: 'article',
            openAccess: true,
            pdfUrl: '',
          });
        }

        return items.filter((item) => item.title.length > 2).slice(0, Math.max(2, Math.ceil(limit / 2)));
      } catch (error) {
        console.warn(`Trusted source failure for ${source.name}:`, error.message);
        return [];
      }
    })
  );

  return sources.flat().slice(0, limit);
}

function getSadilarResources(query) {
  const text = (query || '').toLowerCase();
  const hasLanguageNlpSignal = /language|linguistics|nlp|natural language|speech|text mining|translation|morphology|corpus|lexicon|phonology|semantic|syntax|named entity|sentiment|multilingual|afrikaans|isiZulu|sepedi|setswana|tswana|xhosa|zulu|south african/.test(text);

  if (!hasLanguageNlpSignal) return [];

  return [
    {
      id: 'sadilar-resource-index',
      title: 'SADiLaR Resource Index',
      source: 'SADiLaR',
      year: null,
      url: 'https://repo.sadilar.org/collections/61ce70ba-0406-439a-948e-c71ef542a778',
      citations: 0,
      type: 'dataset',
      keywords: ['language resources', 'NLP', 'corpora', 'linguistics', 'South African languages'],
      description: 'Curated SADiLaR collection for language resources, corpora, and research datasets relevant to linguistic and NLP work.',
    },
    {
      id: 'sadilar-student-data-repository',
      title: 'SADiLaR Student Data Repository',
      source: 'SADiLaR',
      year: null,
      url: 'https://repo.sadilar.org/collections/41c184fd-8ca1-4cd8-9701-26537e2527ea',
      citations: 0,
      type: 'dataset',
      keywords: ['student data', 'language datasets', 'NLP', 'research data'],
      description: 'Research datasets and student-related language resources curated by SADiLaR for language and NLP studies.',
    },
    {
      id: 'sadilar-language-resource',
      title: 'SADiLaR language resource dataset',
      source: 'SADiLaR',
      year: null,
      url: 'http://repo.sadilar.org/handle/20.500.12185/7?_gl=1*1xttxb9*_ga*MTQ2OTIyOTY4MS4xNzg2ODg4NjEz*_ga_3JW04QV6ES*czE3ODY4ODg2MTMkbzEkZzEkdDE3ODY4ODg3NzEkajYwJGwwJGgw',
      citations: 0,
      type: 'dataset',
      keywords: ['language resources', 'corpora', 'South African languages'],
      description: 'A direct SADiLaR language-resource record for quick access to relevant datasets and linguistic resources.',
    },
  ];
}

function mapOpenAlexWork(work, sourceName) {
  return {
    id: work.id,
    title: work.display_name || 'Untitled',
    abstract: work.abstract_inverted_index ? reconstructAbstract(work.abstract_inverted_index) : '',
    authors: (work.authorships || []).slice(0, 10).map((a) => a.author?.display_name).filter(Boolean),
    year: work.publication_year,
    citations: work.cited_by_count || 0,
    url: work.doi ? `https://doi.org/${work.doi.replace('https://doi.org/', '')}` : work.primary_location?.landing_page_url || work.id,
    doi: work.doi ? work.doi.replace('https://doi.org/', '') : '',
    fields: (work.concepts || []).slice(0, 5).map((c) => c.display_name),
    source: sourceName || work.primary_location?.source?.display_name || 'OpenAlex',
    type: work.type || 'article',
    openAccess: work.open_access?.is_oa || false,
    pdfUrl: work.open_access?.oa_url || '',
  };
}

function mapDatasets(results, typeOverride) {
  return results.map((work) => ({
    id: work.id,
    title: work.display_name || work.title,
    source: work.primary_location?.source?.display_name || 'OpenAlex',
    year: work.publication_year,
    url: work.doi ? `https://doi.org/${work.doi.replace('https://doi.org/', '')}` : work.id,
    citations: work.cited_by_count || 0,
    type: typeOverride || work.type || 'dataset',
    keywords: (work.concepts || []).slice(0, 5).map((c) => c.display_name),
  }));
}

function parseArxivXml(xmlText) {
  const entries = xmlText.split('<entry>').slice(1);
  return entries.map((entry) => {
    const getTag = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    const getAllTags = (tag) => {
      const matches = [];
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
      let m;
      while ((m = re.exec(entry)) !== null) matches.push(m[1].trim());
      return matches;
    };

    const title = getTag('title').replace(/\s+/g, ' ');
    const abstract = getTag('summary').replace(/\s+/g, ' ').slice(0, 500);
    const authorNames = getAllTags('name');
    const published = getTag('published');
    const year = published ? parseInt(published.slice(0, 4)) : null;
    const idUrl = getTag('id');
    const arxivId = idUrl.replace('http://arxiv.org/abs/', '');

    const categories = [];
    const catMatches = entry.match(/term="([^"]+)"/g) || [];
    for (const cm of catMatches) {
      const t = cm.match(/term="([^"]+)"/);
      if (t && !t[1].includes('http')) categories.push(t[1]);
    }

    let pdfUrl = '';
    const linkMatches = entry.match(/<link[^>]*>/g) || [];
    for (const link of linkMatches) {
      if (link.includes('title="pdf"')) {
        const href = link.match(/href="([^"]*)"/);
        if (href) pdfUrl = href[1];
      }
    }

    return {
      id: `arxiv-${arxivId}`,
      title: title || 'Untitled',
      abstract,
      authors: authorNames.slice(0, 5),
      year,
      citations: 0,
      url: idUrl,
      doi: '',
      fields: categories.slice(0, 3),
      source: 'arXiv',
      openAccess: true,
      pdfUrl: pdfUrl || `https://arxiv.org/pdf/${arxivId}`,
    };
  });
}

module.exports = router;
