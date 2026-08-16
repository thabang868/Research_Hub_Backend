const express = require('express');
const neo4j = require('neo4j-driver');
const router = express.Router();
const neo4jDriver = require('../config/neo4j');

// Save a research paper to the graph
router.post('/papers', async (req, res) => {
  let session;
  try {
    const { title, authors, abstract, source, url, keywords, userId } = req.body;

    if (!title || !userId) {
      return res.status(400).json({ error: 'Title and userId are required' });
    }

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.status(503).json({ error: 'Graph database is temporarily unavailable. Please try again later.' });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MERGE (p:Paper {title: $title})
       SET p.abstract = $abstract,
           p.source = $source,
           p.url = $url,
           p.createdAt = datetime()
       WITH p
       MERGE (u:User {id: $userId})
       MERGE (u)-[:SAVED]->(p)
       WITH p
       UNWIND $authors AS authorName
         MERGE (a:Author {name: authorName})
         MERGE (a)-[:AUTHORED]->(p)
       WITH p
       UNWIND $keywords AS kw
         MERGE (k:Keyword {name: kw})
         MERGE (p)-[:TAGGED]->(k)
       RETURN p`,
      {
        title,
        abstract: abstract || '',
        source: source || '',
        url: url || '',
        authors: authors || [],
        keywords: keywords || [],
        userId,
      }
    );

    res.status(201).json({ message: 'Paper saved to graph', paper: result.records[0]?.get('p').properties });
  } catch (err) {
    console.error('Neo4j save paper error:', err);
    res.status(503).json({ error: 'Graph database is temporarily unavailable. Please try again later.' });
  } finally {
    if (session) await session.close();
  }
});

// Find similar/related papers by shared keywords or authors
router.get('/papers/:title/related', async (req, res) => {
  let session;
  try {
    const { title } = req.params;
    const limit = parseInt(req.query.limit) || 10;

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.json({ related: [] });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MATCH (p:Paper {title: $title})-[:TAGGED]->(k:Keyword)<-[:TAGGED]-(related:Paper)
       WHERE related.title <> $title
       WITH related, COUNT(k) AS sharedKeywords
       ORDER BY sharedKeywords DESC
       LIMIT $limit
       RETURN related.title AS title, related.abstract AS abstract,
              related.source AS source, related.url AS url,
              sharedKeywords`,
      { title, limit: neo4j.int(limit) }
    );

    const papers = result.records.map((r) => ({
      title: r.get('title'),
      abstract: r.get('abstract'),
      source: r.get('source'),
      url: r.get('url'),
      sharedKeywords: r.get('sharedKeywords').toNumber(),
    }));

    res.json({ related: papers });
  } catch (err) {
    console.error('Neo4j related papers error:', err);
    res.json({ related: [] });
  } finally {
    if (session) await session.close();
  }
});

// Get a user's saved papers
router.get('/users/:userId/papers', async (req, res) => {
  let session;
  try {
    const { userId } = req.params;

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.json({ papers: [] });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MATCH (u:User {id: $userId})-[:SAVED]->(p:Paper)
       OPTIONAL MATCH (p)-[:TAGGED]->(k:Keyword)
       OPTIONAL MATCH (a:Author)-[:AUTHORED]->(p)
       RETURN p.title AS title, p.abstract AS abstract,
              p.source AS source, p.url AS url,
              p.createdAt AS createdAt,
              COLLECT(DISTINCT k.name) AS keywords,
              COLLECT(DISTINCT a.name) AS authors
       ORDER BY createdAt DESC`,
      { userId }
    );

    const papers = result.records.map((r) => ({
      title: r.get('title'),
      abstract: r.get('abstract'),
      source: r.get('source'),
      url: r.get('url'),
      keywords: r.get('keywords'),
      authors: r.get('authors'),
    }));

    res.json({ papers });
  } catch (err) {
    console.error('Neo4j user papers error:', err);
    res.json({ papers: [] });
  } finally {
    if (session) await session.close();
  }
});

// Suggest datasets based on paper keywords
router.get('/papers/:title/suggest-datasets', async (req, res) => {
  let session;
  try {
    const { title } = req.params;

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.json({ datasets: [] });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MATCH (p:Paper {title: $title})-[:TAGGED]->(k:Keyword)<-[:TAGGED]-(d:Dataset)
       WITH d, COLLECT(k.name) AS matchedKeywords, COUNT(k) AS relevance
       ORDER BY relevance DESC
       LIMIT 10
       RETURN d.title AS title, d.source AS source, d.url AS url,
              matchedKeywords, relevance`,
      { title }
    );

    const datasets = result.records.map((r) => ({
      title: r.get('title'),
      source: r.get('source'),
      url: r.get('url'),
      matchedKeywords: r.get('matchedKeywords'),
      relevance: r.get('relevance').toNumber(),
    }));

    res.json({ datasets });
  } catch (err) {
    console.error('Neo4j suggest datasets error:', err);
    res.json({ datasets: [] });
  } finally {
    if (session) await session.close();
  }
});

// Save a dataset to the graph
router.post('/datasets', async (req, res) => {
  let session;
  try {
    const { title, source, url, keywords, userId } = req.body;

    if (!title || !userId) {
      return res.status(400).json({ error: 'Title and userId are required' });
    }

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.status(503).json({ error: 'Graph database is temporarily unavailable. Please try again later.' });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MERGE (d:Dataset {title: $title})
       SET d.source = $source,
           d.url = $url,
           d.createdAt = datetime()
       WITH d
       MERGE (u:User {id: $userId})
       MERGE (u)-[:SAVED]->(d)
       WITH d
       UNWIND $keywords AS kw
         MERGE (k:Keyword {name: kw})
         MERGE (d)-[:TAGGED]->(k)
       RETURN d`,
      {
        title,
        source: source || '',
        url: url || '',
        keywords: keywords || [],
        userId,
      }
    );

    res.status(201).json({ message: 'Dataset saved to graph', dataset: result.records[0]?.get('d').properties });
  } catch (err) {
    console.error('Neo4j save dataset error:', err);
    res.status(503).json({ error: 'Graph database is temporarily unavailable. Please try again later.' });
  } finally {
    if (session) await session.close();
  }
});

// Get trending keywords across all papers
router.get('/trending-keywords', async (req, res) => {
  let session;
  try {
    const limit = parseInt(req.query.limit) || 20;

    const isReady = await neo4jDriver.ensureReady();
    if (!isReady) {
      return res.json({ keywords: [] });
    }

    session = neo4jDriver.session();
    const result = await session.run(
      `MATCH (k:Keyword)<-[:TAGGED]-(p)
       WITH k.name AS keyword, COUNT(p) AS usage
       ORDER BY usage DESC
       LIMIT $limit
       RETURN keyword, usage`,
      { limit: neo4j.int(limit) }
    );

    const keywords = result.records.map((r) => ({
      keyword: r.get('keyword'),
      usage: r.get('usage').toNumber(),
    }));

    res.json({ keywords });
  } catch (err) {
    console.error('Neo4j trending keywords error:', err);
    res.status(500).json({ error: 'Failed to fetch trending keywords' });
  } finally {
    await session.close();
  }
});

module.exports = router;
