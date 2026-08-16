const express = require('express');
const cors = require('cors');
require('dotenv').config();

// ── BMAD Engine Imports ──
const { securityHeaders, requestLogger, sanitize, apiLimiter } = require('./middleware/security');
const { compression, responseTime } = require('./middleware/performance');
const learningEngine = require('./engine/learning');
const smartCache = require('./engine/cache');

// ── Route Imports ──
const authRoutes = require('./routes/auth');
const graphRoutes = require('./routes/graph');
const searchRoutes = require('./routes/search');
const aiRoutes = require('./routes/ai');
const trendingRoutes = require('./routes/trending');
const deepAnalysisRoutes = require('./routes/deepanalysis');
const toolsRoutes = require('./routes/tools');
const billingRoutes = require('./routes/billing');
const intelligenceRoutes = require('./routes/intelligence');

const app = express();
const PORT = process.env.PORT || 10000;

// ══════════════════════════════════════════════
//  BMAD LAYER 1: SECURITY
// ══════════════════════════════════════════════
app.use(securityHeaders);

app.use(cors({
  origin: function (origin, callback) {
    const allowed = [process.env.CLIENT_URL || 'https://researchhub-sigma.vercel.app'].map((url) => url.replace(/\/$/, ''));
    if (!origin || allowed.includes(origin.replace(/\/$/, ''))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// ══════════════════════════════════════════════
//  BMAD LAYER 2: PERFORMANCE
// ══════════════════════════════════════════════
app.use(compression);
app.use(responseTime);

// JSON body parser — skipped for the Paystack webhook which needs the
// raw request body to verify its HMAC signature.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/paystack/webhook') return next();
  return express.json({ limit: '10mb' })(req, res, next);
});

// ══════════════════════════════════════════════
//  BMAD LAYER 3: OBSERVABILITY
// ══════════════════════════════════════════════
app.use(requestLogger);

// ══════════════════════════════════════════════
//  BMAD LAYER 4: GLOBAL MIDDLEWARE
// ══════════════════════════════════════════════
app.use(sanitize);
app.use(apiLimiter);

// ══════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════
app.use('/api/auth', authRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/trending', trendingRoutes);
app.use('/api/deep', deepAnalysisRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/billing', billingRoutes);

// ── BMAD Intelligence Routes ──
app.use('/api/intel', intelligenceRoutes);

// ══════════════════════════════════════════════
//  BMAD ENHANCED HEALTH CHECK
// ══════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  const cache = smartCache.getStats();
  const learning = learningEngine.getMetrics();

  const neo4jStatus = neo4jDriver.getConnectionInfo();

  res.json({
    status: 'ok',
    engine: 'BMAD Self-Improving Research Intelligence',
    version: '2.0.0-bmad',
    uptime: Math.round(process.uptime()) + 's',
    database: {
      neo4j: {
        configured: neo4jStatus.isConfigured,
        ready: neo4jStatus.isReady,
        uri: neo4jStatus.uri,
      },
    },
    intelligence: {
      queriesProcessed: learning.totalQueries,
      avgQualityScore: learning.recentAvgScore,
      cacheHitRate: cache.hitRate,
      learningCycles: learning.learningCycles,
      improvementRate: learning.improvementRate + '%',
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    },
    timestamp: new Date().toISOString(),
  });
});

// ══════════════════════════════════════════════
//  ERROR HANDLING
// ══════════════════════════════════════════════
app.use((err, req, res, _next) => {
  // BMAD: Record error for learning
  learningEngine.recordFailure('unhandled_error', {
    path: req.path,
    method: req.method,
    error: err.message,
  });

  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  // Never expose stack traces in production
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An internal error occurred'
      : err.message,
  });
});

// ══════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════
const neo4jDriver = require('./config/neo4j');

app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  ResearchHub BMAD Intelligence Engine v2.0`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Security: Helmet + CORS + Rate Limiting + Sanitization`);
  console.log(`  Performance: Compression + Smart Cache + Response Timing`);
  console.log(`  Intelligence: Learning Engine + Quality Scoring + Prompt Enhancement`);
  console.log(`  Self-Improving: Active (5-min learning cycles)`);
  console.log(`══════════════════════════════════════════════\n`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Cleaning up...');
  learningEngine.destroy();
  smartCache.destroy();
  await neo4jDriver.close();
  console.log('[SHUTDOWN] Done.');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  learningEngine.recordFailure('unhandled_rejection', { reason: String(reason) });
});
