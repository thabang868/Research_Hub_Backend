/**
 * BMAD Self-Improving Learning Engine
 *
 * Tracks query patterns, response quality, and user behavior
 * to continuously improve AI responses and search results.
 *
 * Architecture:
 *   User Action → Capture → Score → Learn → Enhance → Better Response
 */

class LearningEngine {
  constructor() {
    // In-memory learning store (persists to Neo4j periodically)
    this.queryPatterns = new Map();      // query → { count, avgScore, bestPrompt }
    this.topicInterests = new Map();     // userId → Set<topics>
    this.responseScores = [];            // { query, score, timestamp }
    this.failurePatterns = new Map();    // errorType → { count, lastSeen, context }
    this.promptPerformance = new Map();  // promptHash → { avgScore, uses }
    this.searchBoosts = new Map();       // keyword → boost multiplier

    // Self-improvement metrics
    this.metrics = {
      totalQueries: 0,
      avgResponseScore: 0,
      cacheHitRate: 0,
      improvementRate: 0,
      topPerformingPrompts: [],
      learningCycles: 0,
    };

    // Periodic learning cycle (every 5 minutes)
    this._learningInterval = setInterval(() => this._runLearningCycle(), 5 * 60 * 1000);
  }

  /**
   * Record a user query for pattern learning
   */
  recordQuery(userId, query, category, metadata = {}) {
    this.metrics.totalQueries++;

    const normalizedQuery = query.toLowerCase().trim();
    const existing = this.queryPatterns.get(normalizedQuery) || {
      count: 0,
      totalScore: 0,
      avgScore: 0,
      categories: new Set(),
      lastSeen: null,
      bestResponse: null,
    };

    existing.count++;
    existing.lastSeen = Date.now();
    if (category) existing.categories.add(category);

    this.queryPatterns.set(normalizedQuery, existing);

    // Track user interests
    if (userId) {
      const interests = this.topicInterests.get(userId) || {
        topics: new Set(),
        queries: [],
        lastActive: null,
      };

      // Extract topics from query
      const topics = this._extractTopics(query);
      topics.forEach(t => interests.topics.add(t));
      interests.queries.push({ query: normalizedQuery, timestamp: Date.now(), ...metadata });
      if (interests.queries.length > 100) interests.queries = interests.queries.slice(-100);
      interests.lastActive = Date.now();

      this.topicInterests.set(userId, interests);
    }

    return { queryCount: existing.count, isRepeated: existing.count > 1 };
  }

  /**
   * Score an AI response for quality tracking
   */
  scoreResponse(query, response, metrics = {}) {
    const score = this._calculateAutoScore(query, response, metrics);

    const normalizedQuery = query.toLowerCase().trim();
    const pattern = this.queryPatterns.get(normalizedQuery);
    if (pattern) {
      pattern.totalScore += score;
      pattern.avgScore = pattern.totalScore / pattern.count;
      if (score > (pattern.bestScore || 0)) {
        pattern.bestScore = score;
        pattern.bestResponse = response.slice(0, 500);
      }
    }

    this.responseScores.push({
      query: normalizedQuery,
      score,
      timestamp: Date.now(),
      responseLength: response.length,
      ...metrics,
    });

    // Keep only last 1000 scores
    if (this.responseScores.length > 1000) {
      this.responseScores = this.responseScores.slice(-1000);
    }

    // Update average
    const recentScores = this.responseScores.slice(-100);
    this.metrics.avgResponseScore = recentScores.reduce((sum, s) => sum + s.score, 0) / recentScores.length;

    return { score, avgScore: this.metrics.avgResponseScore };
  }

  /**
   * Record a user's explicit feedback (thumbs up/down, rating)
   */
  recordFeedback(userId, query, rating, comment = '') {
    const normalizedQuery = query.toLowerCase().trim();
    const pattern = this.queryPatterns.get(normalizedQuery);

    if (pattern) {
      pattern.userRating = rating;
      pattern.userFeedback = comment;

      // High rating → boost similar queries
      if (rating >= 4) {
        const topics = this._extractTopics(query);
        topics.forEach(topic => {
          const boost = this.searchBoosts.get(topic) || 1.0;
          this.searchBoosts.set(topic, Math.min(boost + 0.1, 2.0));
        });
      }

      // Low rating → learn from failure
      if (rating <= 2) {
        this.recordFailure('low_user_rating', { query, rating, comment });
      }
    }

    return { recorded: true };
  }

  /**
   * Record a failure for pattern detection
   */
  recordFailure(errorType, context = {}) {
    const existing = this.failurePatterns.get(errorType) || {
      count: 0,
      contexts: [],
      lastSeen: null,
    };

    existing.count++;
    existing.lastSeen = Date.now();
    existing.contexts.push({ ...context, timestamp: Date.now() });
    if (existing.contexts.length > 50) existing.contexts = existing.contexts.slice(-50);

    this.failurePatterns.set(errorType, existing);
  }

  /**
   * Get enhanced context for a query based on learned patterns
   */
  getQueryEnhancement(userId, query) {
    const normalizedQuery = query.toLowerCase().trim();
    const pattern = this.queryPatterns.get(normalizedQuery);
    const userInterests = this.topicInterests.get(userId);

    const enhancement = {
      isRepeatedQuery: pattern ? pattern.count > 1 : false,
      previousAvgScore: pattern?.avgScore || null,
      userTopics: userInterests ? [...userInterests.topics].slice(0, 10) : [],
      recentQueries: userInterests ? userInterests.queries.slice(-5).map(q => q.query) : [],
      suggestedBoosts: [],
      promptHint: null,
    };

    // Suggest search boosts based on learned patterns
    const queryTopics = this._extractTopics(query);
    queryTopics.forEach(topic => {
      const boost = this.searchBoosts.get(topic);
      if (boost && boost > 1.0) {
        enhancement.suggestedBoosts.push({ topic, boost });
      }
    });

    // If we've seen this query before and it scored well, hint the prompt
    if (pattern && pattern.bestScore > 80) {
      enhancement.promptHint = 'This type of query performs well. Maintain the current approach.';
    } else if (pattern && pattern.avgScore < 50) {
      enhancement.promptHint = 'This type of query has scored low historically. Try providing more specific, actionable details.';
    }

    return enhancement;
  }

  /**
   * Get user's research profile for personalized responses
   */
  getUserProfile(userId) {
    const interests = this.topicInterests.get(userId);
    if (!interests) return null;

    return {
      topics: [...interests.topics].slice(0, 20),
      recentQueries: interests.queries.slice(-10).map(q => q.query),
      queryCount: interests.queries.length,
      lastActive: interests.lastActive,
      topCategories: this._getTopCategories(interests.queries),
    };
  }

  /**
   * Get system-wide intelligence metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      totalUniqueQueries: this.queryPatterns.size,
      totalUsers: this.topicInterests.size,
      totalFailures: [...this.failurePatterns.values()].reduce((sum, f) => sum + f.count, 0),
      topQueries: [...this.queryPatterns.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([q, data]) => ({ query: q, count: data.count, avgScore: Math.round(data.avgScore) })),
      recentAvgScore: this.metrics.avgResponseScore.toFixed(1),
      searchBoosts: [...this.searchBoosts.entries()]
        .filter(([, boost]) => boost > 1.0)
        .map(([topic, boost]) => ({ topic, boost: boost.toFixed(2) })),
    };
  }

  // ── Private Methods ──

  /**
   * Auto-score a response based on heuristics
   */
  _calculateAutoScore(query, response, metrics) {
    let score = 50; // Base score

    // Length appropriateness (not too short, not excessive)
    const words = response.split(/\s+/).length;
    if (words > 50 && words < 2000) score += 15;
    else if (words > 20) score += 5;

    // Contains structured content (lists, sections)
    if (response.includes('**') || response.includes('- ') || response.match(/\d+\./)) score += 10;

    // Contains specific data (numbers, citations, URLs)
    if (response.match(/\d{4}/) || response.match(/https?:\/\//) || response.match(/et al\./)) score += 10;

    // Response time (from metrics)
    if (metrics.responseTimeMs) {
      if (metrics.responseTimeMs < 1000) score += 10;
      else if (metrics.responseTimeMs < 3000) score += 5;
    }

    // Query coverage — does the response mention key terms from the query?
    const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const responseLower = response.toLowerCase();
    const coverage = queryTerms.filter(t => responseLower.includes(t)).length / Math.max(queryTerms.length, 1);
    score += Math.round(coverage * 15);

    return Math.min(Math.max(score, 0), 100);
  }

  /**
   * Extract topic keywords from a query
   */
  _extractTopics(query) {
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or', 'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because', 'about', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'how', 'when', 'where', 'why', 'how', 'me', 'my', 'i', 'you', 'your', 'we', 'our', 'they', 'their', 'it', 'its', 'find', 'search', 'show', 'tell', 'give', 'get', 'help', 'need', 'want', 'like', 'use', 'using', 'used']);

    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  /**
   * Get top categories from user's queries
   */
  _getTopCategories(queries) {
    const categories = {};
    queries.forEach(q => {
      if (q.category) {
        categories[q.category] = (categories[q.category] || 0) + 1;
      }
    });
    return Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, count]) => ({ category: cat, count }));
  }

  /**
   * Periodic learning cycle — analyze patterns and adjust
   */
  _runLearningCycle() {
    this.metrics.learningCycles++;

    // Calculate improvement rate
    const recentScores = this.responseScores.slice(-50);
    const olderScores = this.responseScores.slice(-100, -50);

    if (recentScores.length > 0 && olderScores.length > 0) {
      const recentAvg = recentScores.reduce((s, r) => s + r.score, 0) / recentScores.length;
      const olderAvg = olderScores.reduce((s, r) => s + r.score, 0) / olderScores.length;
      this.metrics.improvementRate = ((recentAvg - olderAvg) / Math.max(olderAvg, 1) * 100).toFixed(1);
    }

    // Decay old search boosts
    for (const [topic, boost] of this.searchBoosts) {
      const decayed = boost * 0.95;
      if (decayed <= 1.01) this.searchBoosts.delete(topic);
      else this.searchBoosts.set(topic, decayed);
    }

    // Clean old query patterns (> 7 days)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [query, data] of this.queryPatterns) {
      if (data.lastSeen < weekAgo && data.count < 3) {
        this.queryPatterns.delete(query);
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy() {
    if (this._learningInterval) {
      clearInterval(this._learningInterval);
    }
  }
}

// Singleton instance
const learningEngine = new LearningEngine();

module.exports = learningEngine;
