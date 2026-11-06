import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { createConditions, parseWeather } from '../src/conditions.js';
import { testData } from './fixtures.js';

const quiet = { error: () => {} };
const KEY = 'k-test';
const data = testData();
const fakeConditions = async (area) => ({ area: area.id, weather: { summary: 'Clear', tempF: 60, windMph: 5, windDir: 'NE' }, tide: null, note: 'context' });

async function withServer(opts, fn) {
  const app = createApp({ data, conditions: fakeConditions, logger: quiet, mcpApiKey: KEY, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

async function mcpClient(base, token = KEY) {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  }));
  return client;
}

test('REST: areas, exposure, compare, facility, 400s', async () => {
  await withServer({}, async (base) => {
    const get = async (p) => {
      const r = await fetch(base + p);
      return { status: r.status, body: await r.json() };
    };
    const areas = await get('/api/areas');
    assert.equal(areas.body.areas.length, 3);
    assert.equal(areas.body.areas.find((a) => a.id === 'norfolk').facilities, 5);

    const ex = await get('/api/exposure?area=norfolk&level=2');
    assert.equal(ex.body.totals.exposed, 2);

    const cmp = await get('/api/compare?area=norfolk&levels=1,3');
    assert.deepEqual(cmp.body.scenarios.map((s) => s.exposed), [1, 4]);

    assert.equal((await get('/api/facility?id=osm:way/3')).body.floodsAtLevelM, 1.2);
    assert.equal((await get('/api/exposure?area=richmond&level=1')).status, 400);
    assert.equal((await get('/api/exposure?area=norfolk&level=12')).status, 400);
    assert.equal((await get('/api/areas/norfolk/facilities')).body.features.length, 5);
    assert.equal((await get('/api/nope')).status, 404);
  });
});

test('MCP: lists the six tools', async () => {
  await withServer({}, async (base) => {
    const client = await mcpClient(base);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'compare_scenarios', 'current_conditions', 'facility_details', 'find_facilities', 'flood_exposure', 'list_areas',
    ]);
    await client.close();
  });
});

test('MCP: flood_exposure and compare_scenarios match the REST engine', async () => {
  await withServer({}, async (base) => {
    const client = await mcpClient(base);
    const ex = await client.callTool({ name: 'flood_exposure', arguments: { area: 'norfolk', water_level_m: 2 } });
    assert.equal(ex.structuredContent.totals.exposed, 2);
    assert.match(ex.content[0].text, /2 of 5 facilities exposed/);
    assert.match(ex.content[0].text, /not a forecast/);

    const cmp = await client.callTool({ name: 'compare_scenarios', arguments: { area: 'Norfolk' } });
    assert.deepEqual(cmp.structuredContent.scenarios.map((s) => s.exposed), [1, 2, 4]);

    const det = await client.callTool({ name: 'facility_details', arguments: { id: 'osm:node/1' } });
    assert.match(det.content[0].text, /first reached at \+0\.4 m/);

    const cond = await client.callTool({ name: 'current_conditions', arguments: { area: 'williamsburg' } });
    assert.match(cond.content[0].text, /Clear, 60°F/);
    await client.close();
  });
});

test('MCP: bad input is a tool error, not a crash', async () => {
  await withServer({}, async (base) => {
    const client = await mcpClient(base);
    const r = await client.callTool({ name: 'flood_exposure', arguments: { area: 'richmond', water_level_m: 1 } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Unknown area/);
    await client.close();
  });
});

test('MCP: 401 without key, 503 when unconfigured, open only when explicitly allowed', async () => {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: init });
    assert.equal(r.status, 401);
  });
  await withServer({ mcpApiKey: undefined }, async (base) => {
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers, body: init })).status, 503);
  });
  await withServer({ mcpApiKey: undefined, allowAnonymousMcp: true }, async (base) => {
    const client = await mcpClient(base, null);
    assert.equal((await client.listTools()).tools.length, 6);
    await client.close();
  });
});

test('conditions: parses weather, prefers NAVD88 tide, falls back to MLLW, caches', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const body = url.includes('open-meteo')
      ? {
          current: { time: 't', temperature_2m: 61, apparent_temperature: 59, relative_humidity_2m: 80, precipitation: 0, weather_code: 3, wind_speed_10m: 9, wind_direction_10m: 45 },
          daily: { time: ['d1'], weather_code: [61], temperature_2m_max: [64], temperature_2m_min: [50], precipitation_probability_max: [70] },
        }
      : url.includes('datum=NAVD')
        ? { error: { message: 'No data was found' } }
        : { data: [{ t: '2026-11-05 16:00', v: '0.512' }] };
    return { ok: true, status: 200, json: async () => body };
  };
  const conditions = createConditions({ fetchImpl });
  const area = data.areas[0];
  const r = await conditions(area);
  assert.equal(r.weather.summary, 'Overcast');
  assert.equal(r.weather.windDir, 'NE');
  assert.equal(r.weather.daily[0].summary, 'Rain');
  assert.deepEqual([r.tide.waterLevelM, r.tide.datum, r.tide.comparableToScenario], [0.512, 'MLLW', false]);
  const before = calls;
  await conditions(area);
  assert.equal(calls, before, 'second call served from cache');
  assert.equal(parseWeather({}).daily.length, 0);
});
