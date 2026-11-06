// MCP server: the same exposure engine the 3D map uses, exposed as tools so an
// AI agent can ask "what floods in Norfolk at +2 m?" and get the map's numbers.
// Streamable HTTP, stateless (fresh server per request) to suit scale-to-zero hosting.

import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  MAX_LEVEL,
  assetDetails,
  compare,
  exposure,
  findFacilities,
  resolveArea,
} from './exposure.js';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const CAVEAT = 'Bathtub what-if model on USGS 3DEP ground elevations (NAVD88); not a forecast.';

function ok(structured, text) {
  return { structuredContent: structured, content: [{ type: 'text', text }] };
}
function fail(err) {
  return { isError: true, content: [{ type: 'text', text: err.message }] };
}

export function createMcpServer({ data, conditions, logger = console }) {
  const server = new McpServer({ name: 'hampton-roads-flood', version: '1.0.0' });
  const areaIds = data.areas.map((a) => a.id);
  const categoryIds = data.categories.map((c) => c.id);
  const areaArg = z.string().describe(`Area id: ${areaIds.join(', ')}`);
  const levelArg = z.number().min(0).max(MAX_LEVEL).describe('Water level in meters above NAVD88 (about mean sea level), 0-5.');

  const run = (name, fn) => async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err.name !== 'InputError') logger.error(`[mcp] ${name}: ${err.message}`);
      return fail(err);
    }
  };

  server.registerTool(
    'list_areas',
    {
      title: 'List study areas',
      description: 'List the Hampton Roads study areas, facility categories, and when the data was generated.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    run('list_areas', async () => {
      const areas = data.areas.map((a) => ({
        id: a.id, name: a.name, subtitle: a.subtitle, bbox: a.bbox, facilities: (data.byArea.get(a.id) ?? []).length,
      }));
      return ok(
        { areas, categories: data.categories, dataGeneratedAt: data.manifest?.generatedAt ?? null, datum: data.datum },
        areas.map((a) => `${a.id}: ${a.name} (${a.subtitle}), ${a.facilities} facilities`).join('\n'),
      );
    }),
  );

  server.registerTool(
    'flood_exposure',
    {
      title: 'Flood exposure at a water level',
      description:
        'Which critical facilities (power, water, hospitals, fire/EMS, police, schools, telecom) in an area ' +
        'sit at or below a what-if water level, with depth at each. Also returns the share of sampled land flooded. ' + CAVEAT,
      inputSchema: {
        area: areaArg,
        water_level_m: levelArg,
        limit: z.number().int().min(1).max(100).optional().describe('Max facilities listed (deepest first). Default 25.'),
      },
      annotations: READ_ONLY,
    },
    run('flood_exposure', async ({ area, water_level_m, limit = 25 }) => {
      const r = exposure(data, area, water_level_m, { limit });
      const cats = r.byCategory.filter((c) => c.exposed).map((c) => `${c.label} ${c.exposed}/${c.total}`).join(', ') || 'none';
      const top = r.exposed.slice(0, 10).map((e) => `- ${e.name} (${e.category}): ${e.depthM} m deep`).join('\n');
      return ok(
        r,
        `${r.area.name} at +${r.waterLevelM} m: ${r.totals.exposed} of ${r.totals.facilities} facilities exposed ` +
          `(${r.totals.deep} at >=1.5 m). Land flooded: ${r.landFloodedPct ?? 'n/a'}%.\nBy category: ${cats}\n${top}\n${CAVEAT}`,
      );
    }),
  );

  server.registerTool(
    'compare_scenarios',
    {
      title: 'Compare water levels',
      description: 'Compare facility exposure and land flooded across several what-if water levels for one area.',
      inputSchema: {
        area: areaArg,
        water_levels_m: z.array(z.number().min(0).max(MAX_LEVEL)).min(1).max(8).optional()
          .describe('Levels to compare. Default [1, 2, 3].'),
      },
      annotations: READ_ONLY,
    },
    run('compare_scenarios', async ({ area, water_levels_m }) => {
      const r = compare(data, area, water_levels_m);
      return ok(
        r,
        r.scenarios.map((s) => `+${s.waterLevelM} m: ${s.exposed}/${r.facilities} facilities, ${s.deep} deep, land ${s.landFloodedPct ?? 'n/a'}%`).join('\n'),
      );
    }),
  );

  server.registerTool(
    'find_facilities',
    {
      title: 'Find facilities',
      description: 'List facilities in an area, lowest ground first, optionally filtered by category and maximum ground elevation.',
      inputSchema: {
        area: areaArg,
        category: z.enum(categoryIds).optional(),
        max_elevation_m: z.number().optional().describe('Only facilities at or below this ground elevation (NAVD88 m).'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    run('find_facilities', async ({ area, category, max_elevation_m, limit }) => {
      const r = findFacilities(data, area, { category, maxElevationM: max_elevation_m, limit });
      return ok(r, `${r.count} match.\n` + r.facilities.map((f) => `- ${f.id} ${f.name} (${f.category}) ground ${f.elevationM} m`).join('\n'));
    }),
  );

  server.registerTool(
    'facility_details',
    {
      title: 'Facility details',
      description: 'Ground elevation, the water level at which it floods, and depth at +1/+2/+3 m for one facility id (e.g. osm:way/123).',
      inputSchema: { id: z.string() },
      annotations: READ_ONLY,
    },
    run('facility_details', async ({ id }) => {
      const r = assetDetails(data, id);
      return ok(
        r,
        `${r.name} (${r.category}), ground ${r.elevationM} m NAVD88; first reached at +${r.floodsAtLevelM} m.\n` +
          r.scenarios.map((s) => `+${s.waterLevelM} m: ${s.depthM === null ? 'dry' : `${s.depthM} m (${s.status})`}`).join('\n'),
      );
    }),
  );

  server.registerTool(
    'current_conditions',
    {
      title: 'Current weather and tide',
      description: 'Live weather (Open-Meteo) and latest NOAA tide-gauge water level for an area. Context only.',
      inputSchema: { area: areaArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run('current_conditions', async ({ area }) => {
      const r = await conditions(resolveArea(data, area));
      const w = r.weather ? `${r.weather.summary}, ${r.weather.tempF}°F, wind ${r.weather.windMph} mph ${r.weather.windDir}` : 'weather unavailable';
      const t = r.tide ? `${r.tide.station}: ${r.tide.waterLevelM} m ${r.tide.datum} at ${r.tide.observedAt}` : 'tide unavailable';
      return ok(r, `${w}\n${t}\n${r.note}`);
    }),
  );

  return server;
}

function keysMatch(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mcpAuth({ apiKey, allowAnonymous }) {
  return (req, res, next) => {
    if (!apiKey) {
      if (allowAnonymous) return next();
      return res.status(503).json({ error: 'MCP endpoint is disabled: MCP_API_KEY is not configured.' });
    }
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !keysMatch(token, apiKey)) {
      res.set('WWW-Authenticate', 'Bearer realm="mcp"');
      return res.status(401).json({ error: 'Missing or invalid bearer token.' });
    }
    return next();
  };
}

export function mountMcp(app, { data, conditions, apiKey, allowAnonymous, limiter, logger = console }) {
  const guards = [limiter, mcpAuth({ apiKey, allowAnonymous })].filter(Boolean);

  app.post('/mcp', ...guards, async (req, res) => {
    const server = createMcpServer({ data, conditions, logger });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error(`[mcp] ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  const notAllowed = (_req, res) =>
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' },
      id: null,
    });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
