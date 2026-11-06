import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  InputError,
  areaGeoJson,
  assetDetails,
  compare,
  exposure,
  resolveArea,
} from './exposure.js';
import { AskError } from './agent.js';
import { mountMcp } from './mcp.js';

// Tiny fixed-window per-client limiter.
export function rateLimit({ limit = 60, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    return next();
  };
}

export function createApp({
  data,
  conditions,
  staticDir,
  logger = console,
  mcpApiKey,
  allowAnonymousMcp = false,
  publicConfig = {},
  apiRateLimitPerMinute = 120,
  mcpRateLimitPerMinute = 30,
  ask = null,
  askRateLimitPerMinute = 10,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Azure Container Apps ingress sets X-Forwarded-For
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', rateLimit({ limit: apiRateLimitPerMinute }));

  // Wrap handlers: InputError -> 400, anything else -> 502 with a log line.
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof InputError) return res.status(400).json({ error: err.message });
      logger.error(`[api] ${req.path}: ${err.message}`);
      return res.status(502).json({ error: 'Upstream request failed.' });
    }
  };

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', dataReady: data.ready, mcp: Boolean(mcpApiKey) || allowAnonymousMcp, ai: Boolean(ask) });
  });

  // Browser config: the ArcGIS key is a public, referrer-restricted client key.
  app.get('/api/config', (_req, res) => res.json(publicConfig));

  app.get('/api/areas', handle(async () => ({
    ready: data.ready,
    datum: data.datum,
    areas: data.areas.map((a) => ({ ...a, facilities: (data.byArea.get(a.id) ?? []).length })),
    categories: data.categories,
    manifest: data.manifest,
  })));

  app.get('/api/areas/:id/facilities', handle(async (req) => areaGeoJson(data, req.params.id)));
  app.get('/api/exposure', handle(async (req) => exposure(data, req.query.area, req.query.level, { limit: 5000 })));
  app.get('/api/compare', handle(async (req) => compare(data, req.query.area, req.query.levels ?? '1,2,3')));
  app.get('/api/facility', handle(async (req) => assetDetails(data, req.query.id)));
  app.get('/api/conditions', handle(async (req) => conditions(resolveArea(data, req.query.area))));

  // Ask the map: Azure OpenAI agent over this app's MCP tools. Each call costs tokens,
  // so it has its own, tighter rate limit.
  app.post('/api/ask', rateLimit({ limit: askRateLimitPerMinute }), async (req, res) => {
    if (!ask) return res.status(503).json({ error: 'The AI assistant is not configured on this deployment.' });
    try {
      return res.json(await ask(req.body?.question));
    } catch (err) {
      if (err instanceof AskError || err instanceof InputError) return res.status(err.status ?? 400).json({ error: err.message });
      const status = err?.status === 429 ? 429 : 502;
      logger.error(`[ask] ${status} ${err?.message}`);
      return res.status(status).json({
        error: status === 429 ? 'The AI model is busy. Try again in a few seconds.' : 'The AI assistant failed. Check the API logs.',
      });
    }
  });

  mountMcp(app, {
    data,
    conditions,
    apiKey: mcpApiKey,
    allowAnonymous: allowAnonymousMcp,
    limiter: rateLimit({ limit: mcpRateLimitPerMinute }),
    logger,
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (staticDir && existsSync(staticDir)) {
    const root = path.resolve(staticDir);
    app.use(express.static(root, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => res.sendFile('index.html', { root }));
  }

  return app;
}
