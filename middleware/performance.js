/**
 * BMAD Performance Middleware
 *
 * Provides: Response Compression, Response Time Headers, Payload Optimization
 */

const zlib = require('zlib');

// ──────────────────────────────────────────────
// RESPONSE COMPRESSION — gzip/deflate
// ──────────────────────────────────────────────

function compression(req, res, next) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding) return next();

  // Intercept res.json to compress large JSON payloads
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    const body = JSON.stringify(data);

    // Only compress if body is large enough to benefit (> 1KB)
    if (body.length < 1024 || res.headersSent) {
      return originalJson(data);
    }

    const encoding = acceptEncoding.includes('gzip') ? 'gzip'
      : acceptEncoding.includes('deflate') ? 'deflate'
      : null;

    if (!encoding) return originalJson(data);

    const compressor = encoding === 'gzip' ? zlib.gzip : zlib.deflate;
    compressor(Buffer.from(body), (err, compressed) => {
      if (err || res.headersSent) {
        if (!res.headersSent) originalJson(data);
        return;
      }
      res.set('Content-Encoding', encoding);
      res.set('Content-Type', 'application/json');
      res.set('Content-Length', String(compressed.length));
      res.removeHeader('Transfer-Encoding');
      res.end(compressed);
    });
  };

  next();
}

// ──────────────────────────────────────────────
// RESPONSE TIME HEADER — Track performance
// ──────────────────────────────────────────────

function responseTime(req, res, next) {
  const start = process.hrtime.bigint();

  // Set response time header before the response is sent
  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Number(process.hrtime.bigint() - start) / 1e6;
    if (!res.headersSent) {
      res.set('X-Response-Time', `${duration.toFixed(1)}ms`);
    }
    return originalEnd.apply(this, args);
  };

  // Make timing available to route handlers
  req._perfStart = start;
  req.getElapsedMs = () => Number(process.hrtime.bigint() - start) / 1e6;

  next();
}

// ──────────────────────────────────────────────
// PAYLOAD OPTIMIZER — Trim unnecessary data
// ──────────────────────────────────────────────

/**
 * Middleware to limit response payload size for list endpoints
 */
function payloadOptimizer(maxItems = 50) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (data) => {
      // If response contains arrays, trim them
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          if (Array.isArray(value) && value.length > maxItems) {
            data[key] = value.slice(0, maxItems);
            data[`${key}_truncated`] = true;
            data[`${key}_total`] = value.length;
          }
        }
      }
      return originalJson(data);
    };

    next();
  };
}

module.exports = {
  compression,
  responseTime,
  payloadOptimizer,
};
