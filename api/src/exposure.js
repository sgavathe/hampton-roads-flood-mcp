// "Bathtub" flood exposure: a facility is exposed when the scenario water level
// (NAVD88 m) is at or above its ground elevation. Depth = level - ground.
// This is a what-if screening model, not a forecast: it ignores hydraulic
// connectivity, levees, drainage, waves and duration.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const MIN_LEVEL = 0;
export const MAX_LEVEL = 5;
export const DEEP_THRESHOLD_M = 1.5;
export const DEFAULT_SCENARIOS = [1, 2, 3];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export function loadData(dataDir) {
  const read = (f) => JSON.parse(readFileSync(path.join(dataDir, f), 'utf8'));
  const config = read('areas.json');
  const ready = ['assets.geojson', 'land-samples.json', 'manifest.json'].every((f) => existsSync(path.join(dataDir, f)));
  const assets = ready ? read('assets.geojson').features : [];
  const land = ready ? read('land-samples.json') : { samples: {} };
  const manifest = ready ? read('manifest.json') : null;
  return buildIndex({ config, assets, land, manifest });
}

export function buildIndex({ config, assets, land, manifest }) {
  const byArea = new Map(config.areas.map((a) => [a.id, []]));
  const byId = new Map();
  for (const f of assets) {
    byArea.get(f.properties.area)?.push(f);
    byId.set(f.properties.id, f);
  }
  return {
    ready: assets.length > 0,
    datum: config.datum,
    areas: config.areas,
    categories: config.categories,
    byArea,
    byId,
    land: land.samples ?? {},
    manifest,
  };
}

export function resolveArea(data, areaId) {
  const id = String(areaId ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  const area = data.areas.find((a) => a.id === id || a.name.toLowerCase() === id.replace(/-/g, ' '));
  if (!area) throw new InputError(`Unknown area "${areaId}". Use one of: ${data.areas.map((a) => a.id).join(', ')}.`);
  return area;
}

export function parseLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new InputError(`Water level must be a number between ${MIN_LEVEL} and ${MAX_LEVEL} meters.`);
  }
  return Math.round(level * 100) / 100;
}

export function depthAt(elevationM, level) {
  const depth = level - elevationM;
  return depth >= 0 ? Math.round(depth * 100) / 100 : null;
}

export function depthClass(depth) {
  if (depth === null) return 'dry';
  return depth >= DEEP_THRESHOLD_M ? 'deep' : 'shallow';
}

function requireData(data) {
  if (!data.ready) {
    throw new InputError('Facility data has not been generated yet. Run `node scripts/build-data.mjs` or the "Refresh data" workflow.');
  }
}

// Share of sampled dry land (ground above 0 m) that is at or below the level.
export function landFloodedPct(samples = [], level) {
  const land = samples.filter((v) => v !== null && v > 0);
  if (!land.length) return { pct: null, sampled: 0 };
  const flooded = land.filter((v) => v <= level).length;
  return { pct: Math.round((flooded / land.length) * 1000) / 10, sampled: land.length };
}

export function exposure(data, areaId, levelInput, { limit = 50 } = {}) {
  requireData(data);
  const area = resolveArea(data, areaId);
  const level = parseLevel(levelInput);
  const assets = data.byArea.get(area.id) ?? [];

  const byCategory = data.categories.map((c) => ({ id: c.id, label: c.label, total: 0, exposed: 0, deep: 0 }));
  const catIndex = new Map(byCategory.map((c) => [c.id, c]));
  const exposed = [];

  for (const f of assets) {
    const p = f.properties;
    const cat = catIndex.get(p.category);
    if (!cat) continue;
    cat.total += 1;
    const depth = depthAt(p.elevationM, level);
    if (depth === null) continue;
    cat.exposed += 1;
    if (depth >= DEEP_THRESHOLD_M) cat.deep += 1;
    exposed.push({
      id: p.id,
      name: p.name,
      category: p.category,
      elevationM: p.elevationM,
      depthM: depth,
      depthClass: depthClass(depth),
      coordinates: f.geometry.coordinates,
    });
  }
  exposed.sort((a, b) => b.depthM - a.depthM);

  const land = landFloodedPct(data.land[area.id], level);
  return {
    area: { id: area.id, name: area.name },
    waterLevelM: level,
    datum: data.datum,
    totals: {
      facilities: assets.length,
      exposed: exposed.length,
      deep: exposed.filter((e) => e.depthClass === 'deep').length,
    },
    byCategory,
    landFloodedPct: land.pct,
    landSamples: land.sampled,
    exposed: exposed.slice(0, limit),
    exposedTruncated: exposed.length > limit,
    model: 'bathtub what-if (not a forecast)',
  };
}

export function compare(data, areaId, levels = DEFAULT_SCENARIOS) {
  const list = (Array.isArray(levels) ? levels : String(levels).split(','))
    .map((l) => parseLevel(l))
    .slice(0, 8);
  if (!list.length) throw new InputError('Provide at least one water level.');
  return {
    scenarios: list.map((l) => {
      const r = exposure(data, areaId, l, { limit: 0 });
      return {
        waterLevelM: l,
        exposed: r.totals.exposed,
        deep: r.totals.deep,
        landFloodedPct: r.landFloodedPct,
        byCategory: Object.fromEntries(r.byCategory.map((c) => [c.id, c.exposed])),
      };
    }),
    area: resolveArea(data, areaId).id,
    facilities: (data.byArea.get(resolveArea(data, areaId).id) ?? []).length,
  };
}

export function assetDetails(data, id, levels = [...DEFAULT_SCENARIOS]) {
  requireData(data);
  const f = data.byId.get(String(id));
  if (!f) throw new InputError(`No facility with id "${id}".`);
  const p = f.properties;
  return {
    ...p,
    coordinates: f.geometry.coordinates,
    // Water level (NAVD88) at which the bathtub model first reaches this facility.
    floodsAtLevelM: Math.max(0, p.elevationM),
    scenarios: levels.map((l) => {
      const depth = depthAt(p.elevationM, l);
      return { waterLevelM: l, depthM: depth, status: depthClass(depth) };
    }),
  };
}

export function findFacilities(data, areaId, { category, maxElevationM, limit = 25 } = {}) {
  requireData(data);
  const area = resolveArea(data, areaId);
  if (category && !data.categories.some((c) => c.id === category)) {
    throw new InputError(`Unknown category "${category}". Use one of: ${data.categories.map((c) => c.id).join(', ')}.`);
  }
  const rows = (data.byArea.get(area.id) ?? [])
    .map((f) => ({ ...f.properties, coordinates: f.geometry.coordinates }))
    .filter((p) => !category || p.category === category)
    .filter((p) => maxElevationM === undefined || p.elevationM <= maxElevationM)
    .sort((a, b) => a.elevationM - b.elevationM);
  return { area: area.id, count: rows.length, facilities: rows.slice(0, limit) };
}

export function areaGeoJson(data, areaId) {
  const area = resolveArea(data, areaId);
  return { type: 'FeatureCollection', features: data.byArea.get(area.id) ?? [] };
}
