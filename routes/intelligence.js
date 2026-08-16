/**
 * BMAD Intelligence Routes
 *
 * Exposes the self-improving engine via API endpoints:
 * - System metrics & health
 * - User research profile
 * - Feedback collection
 * - Learning insights
 */

const express = require('express');
const router = express.Router();
const learningEngine = require('../engine/learning');
const smartCache = require('../engine/cache');
const { requireAuth, optionalAuth } = require('../middleware/security');

// ──────────────────────────────────────────────
// SYSTEM INTELLIGENCE METRICS
// ──────────────────────────────────────────────
router.get('/metrics', (req, res) => {
  const learning = learningEngine.getMetrics();
  const cache = smartCache.getStats();

  res.json({
    system: 'ResearchHub Intelligence Engine',
    version: '1.0.0-bmad',
    status: 'operational',
    intelligence: {
      totalQueries: learning.totalQueries,
      totalUniqueQueries: learning.totalUniqueQueries,
      totalUsers: learning.totalUsers,
      avgResponseScore: learning.recentAvgScore,
      improvementRate: learning.improvementRate + '%',
      learningCycles: learning.learningCycles,
    },
    performance: {
      cacheHitRate: cache.hitRate,
      cacheSize: cache.currentSize,
      cacheHits: cache.hits,
      cacheMisses: cache.misses,
    },
    topQueries: learning.topQueries,
    searchBoosts: learning.searchBoosts,
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────
// USER RESEARCH PROFILE
// ──────────────────────────────────────────────
router.get('/profile', requireAuth, (req, res) => {
  const profile = learningEngine.getUserProfile(req.user.id);

  if (!profile) {
    return res.json({
      message: 'No research profile yet. Start searching and chatting to build your profile!',
      topics: [],
      recentQueries: [],
      queryCount: 0,
    });
  }

  res.json({
    userId: req.user.id,
    researchProfile: profile,
    enhancement: learningEngine.getQueryEnhancement(req.user.id, ''),
  });
});

// ──────────────────────────────────────────────
// FEEDBACK — User rates an AI response
// ──────────────────────────────────────────────
router.post('/feedback', optionalAuth, (req, res) => {
  const { query, rating, comment } = req.body;

  if (!query || rating === undefined) {
    return res.status(400).json({ error: 'Query and rating are required' });
  }

  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  const result = learningEngine.recordFeedback(
    req.user?.id || 'anonymous',
    query,
    rating,
    comment || ''
  );

  res.json({
    message: 'Feedback recorded. The system is learning from your input.',
    ...result,
  });
});

// ──────────────────────────────────────────────
// LEARNING INSIGHTS — What the system has learned
// ──────────────────────────────────────────────
router.get('/insights', (req, res) => {
  const metrics = learningEngine.getMetrics();

  const insights = [];

  // Generate insights from learned data
  if (metrics.topQueries.length > 0) {
    const topQuery = metrics.topQueries[0];
    insights.push({
      type: 'popular_topic',
      message: `"${topQuery.query}" is the most researched topic (${topQuery.count} queries, avg score: ${topQuery.avgScore}/100)`,
    });
  }

  if (parseFloat(metrics.improvementRate) > 0) {
    insights.push({
      type: 'improving',
      message: `Response quality has improved ${metrics.improvementRate}% in the last learning cycle`,
    });
  } else if (parseFloat(metrics.improvementRate) < 0) {
    insights.push({
      type: 'declining',
      message: `Response quality declined ${Math.abs(metrics.improvementRate)}% — investigating patterns`,
    });
  }

  if (metrics.searchBoosts.length > 0) {
    const boosted = metrics.searchBoosts.map(b => b.topic).join(', ');
    insights.push({
      type: 'boosted_topics',
      message: `Topics receiving search boosts based on user feedback: ${boosted}`,
    });
  }

  const cacheStats = smartCache.getStats();
  insights.push({
    type: 'performance',
    message: `Cache hit rate: ${cacheStats.hitRate} (${cacheStats.hits} hits, ${cacheStats.misses} misses)`,
  });

  res.json({
    insights,
    metrics: {
      queriesProcessed: metrics.totalQueries,
      uniqueUsers: metrics.totalUsers,
      avgQuality: metrics.recentAvgScore + '/100',
      learningCycles: metrics.learningCycles,
    },
  });
});

// ──────────────────────────────────────────────
// ENHANCED HEALTH CHECK — includes intelligence status
// ──────────────────────────────────────────────
router.get('/health', (req, res) => {
  const cache = smartCache.getStats();
  const learning = learningEngine.getMetrics();

  res.json({
    status: 'ok',
    engine: 'BMAD Self-Improving Intelligence',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    },
    intelligence: {
      learningActive: true,
      totalQueries: learning.totalQueries,
      avgScore: learning.recentAvgScore,
      cacheHitRate: cache.hitRate,
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
