/**
 * BMAD Intelligent Cache Engine
 *
 * Multi-tier caching with intelligent TTL, auto-invalidation,
 * and hit-rate tracking for the self-improving loop.
 */

class SmartCache {
  constructor() {
    this.store = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      evictions: 0,
    };

    // Default TTLs per category (in ms)
    this.ttlConfig = {
      search: 5 * 60 * 1000,           // 5 minutes — search results
      ai_response: 10 * 60 * 1000,     // 10 minutes — AI responses
      trending: 30 * 1000,              // 30 seconds — live feeds
      news: 60 * 1000,                  // 1 minute — news
      user_profile: 2 * 60 * 1000,     // 2 minutes — user data
      graph: 5 * 60 * 1000,            // 5 minutes — graph queries
      metrics: 30 * 1000,              // 30 seconds — system metrics
    };

    // Max entries per category to prevent memory bloat
    this.maxEntries = 500;

    // Cleanup stale entries every minute
    this._cleanupInterval = setInterval(() => this._cleanup(), 60 * 1000);
  }

  /**
   * Get a cached value
   * @returns {*} cached value or null
   */
  get(key) {
    const entry = this.store.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    entry.lastAccessed = Date.now();
    entry.accessCount++;

    return entry.value;
  }

  /**
   * Set a cached value
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @param {string} category - TTL category (search, ai_response, trending, etc.)
   * @param {number} [customTtl] - Override TTL in ms
   */
  set(key, value, category = 'search', customTtl = null) {
    const ttl = customTtl || this.ttlConfig[category] || 5 * 60 * 1000;

    this.store.set(key, {
      value,
      category,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
      lastAccessed: Date.now(),
      accessCount: 0,
    });

    this.stats.sets++;

    // Evict if over limit
    if (this.store.size > this.maxEntries) {
      this._evictLRU();
    }
  }

  /**
   * Delete a specific key
   */
  delete(key) {
    return this.store.delete(key);
  }

  /**
   * Clear all entries in a category
   */
  clearCategory(category) {
    for (const [key, entry] of this.store) {
      if (entry.category === category) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Get cache statistics for the self-improving metrics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : '0%',
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      evictions: this.stats.evictions,
      currentSize: this.store.size,
      maxSize: this.maxEntries,
      categoryCounts: this._getCategoryCounts(),
    };
  }

  /**
   * Generate a cache key from request parameters
   */
  static key(prefix, params) {
    const sorted = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');
    return `${prefix}:${sorted}`;
  }

  // ── Express Middleware ──

  /**
   * Express middleware factory for caching GET responses
   * @param {string} category - Cache category for TTL
   */
  middleware(category = 'search') {
    return (req, res, next) => {
      if (req.method !== 'GET') return next();

      const key = SmartCache.key(req.baseUrl + req.path, req.query);
      const cached = this.get(key);

      if (cached) {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Category', category);
        return res.json(cached);
      }

      // Intercept res.json to cache the response
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          this.set(key, data, category);
        }
        res.set('X-Cache', 'MISS');
        return originalJson(data);
      };

      next();
    };
  }

  // ── Private Methods ──

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        this.stats.evictions++;
      }
    }
  }

  _evictLRU() {
    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessed < oldestAccess) {
        oldestAccess = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.store.delete(oldestKey);
      this.stats.evictions++;
    }
  }

  _getCategoryCounts() {
    const counts = {};
    for (const [, entry] of this.store) {
      counts[entry.category] = (counts[entry.category] || 0) + 1;
    }
    return counts;
  }

  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
  }
}

// Singleton instance
const smartCache = new SmartCache();

module.exports = smartCache;
