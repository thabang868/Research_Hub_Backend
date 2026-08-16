/**
 * BMAD Security Middleware Stack
 *
 * Provides: Rate Limiting, Input Sanitization, Auth Verification, Request Logging
 */

const supabase = require('../config/supabase');

// ──────────────────────────────────────────────
// RATE LIMITER — Token bucket per IP + per user
// ──────────────────────────────────────────────
const rateBuckets = new Map();

function getRateBucket(key, maxTokens, refillRate) {
  let bucket = rateBuckets.get(key);
  const now = Date.now();

  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    rateBuckets.set(key, bucket);
    return bucket;
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor(elapsed / 1000) * refillRate;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
  bucket.lastRefill = now;

  return bucket;
}

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.lastRefill < cutoff) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware
 * @param {number} maxRequests - Max requests per window
 * @param {number} windowMs - Window in milliseconds
 */
function rateLimiter(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  const refillRate = maxRequests / (windowMs / 1000);

  return (req, res, next) => {
    const key = req.user?.id || req.ip || req.connection?.remoteAddress || 'unknown';
    const bucket = getRateBucket(`rl:${key}`, maxRequests, refillRate);

    if (bucket.tokens <= 0) {
      res.set('Retry-After', Math.ceil(1 / refillRate));
      return res.status(429).json({
        error: 'Too many requests. Please slow down.',
        retryAfter: Math.ceil(1 / refillRate),
      });
    }

    bucket.tokens--;
    res.set('X-RateLimit-Remaining', Math.floor(bucket.tokens));
    next();
  };
}

// Preconfigured rate limiters
const apiLimiter = rateLimiter(100, 15 * 60 * 1000);        // 100 req / 15 min
const authLimiter = rateLimiter(20, 15 * 60 * 1000);        // 20 req / 15 min (auth endpoints)
const aiLimiter = rateLimiter(30, 15 * 60 * 1000);          // 30 req / 15 min (AI endpoints — expensive)
const searchLimiter = rateLimiter(60, 15 * 60 * 1000);      // 60 req / 15 min (search)

// ──────────────────────────────────────────────
// INPUT SANITIZER — Prevent XSS, injection attacks
// ──────────────────────────────────────────────

/**
 * Sanitize a string value — strips dangerous content
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove script content
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    // Remove potential SQL injection
    .replace(/(['";])\s*(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|EXEC)\s/gi, '$1 ')
    // Remove null bytes
    .replace(/\0/g, '')
    // Trim excessive whitespace
    .replace(/\s{10,}/g, '  ')
    .trim();
}

/**
 * Deep sanitize an object recursively
 */
function sanitizeObject(obj) {
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj && typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[sanitizeString(key)] = sanitizeObject(value);
    }
    return cleaned;
  }
  return obj;
}

/**
 * Express middleware — sanitizes req.body, req.query, req.params
 */
function sanitize(req, res, next) {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.query) req.query = sanitizeObject(req.query);
  if (req.params) req.params = sanitizeObject(req.params);
  next();
}

// ──────────────────────────────────────────────
// AUTH MIDDLEWARE — Verify JWT token via Supabase
// ──────────────────────────────────────────────

/**
 * Require valid authentication token
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach user to request for downstream use
    req.user = { id: user.id, email: user.email };
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional auth — attaches user if token present, but doesn't block
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) req.user = { id: user.id, email: user.email };
    }
  } catch {
    // Silently continue without auth
  }
  next();
}

// ──────────────────────────────────────────────
// REQUEST LOGGER — Structured logging for debugging
// ──────────────────────────────────────────────

function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';

    // Only log slow requests or errors in production
    if (duration > 1000 || res.statusCode >= 400) {
      console.log(
        `[${logLevel}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)` +
        (req.user ? ` user:${req.user.id.slice(0, 8)}` : '')
      );
    }
  });

  // Attach timing to request for downstream use
  req.startTime = start;
  next();
}

// ──────────────────────────────────────────────
// SECURITY HEADERS — Additional hardening
// ──────────────────────────────────────────────

function securityHeaders(req, res, next) {
  // Prevent clickjacking
  res.set('X-Frame-Options', 'DENY');
  // Prevent MIME type sniffing
  res.set('X-Content-Type-Options', 'nosniff');
  // XSS Protection
  res.set('X-XSS-Protection', '1; mode=block');
  // Referrer Policy
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions Policy
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Content Security Policy
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  // Strict Transport Security
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Remove X-Powered-By
  res.removeHeader('X-Powered-By');

  next();
}

module.exports = {
  rateLimiter,
  apiLimiter,
  authLimiter,
  aiLimiter,
  searchLimiter,
  sanitize,
  sanitizeString,
  requireAuth,
  optionalAuth,
  requestLogger,
  securityHeaders,
};
