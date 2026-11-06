#!/usr/bin/env node
// Builds the static datasets the app and MCP tools read:
//   data/assets.geojson      critical facilities from OpenStreetMap, each with ground elevation
//   data/land-samples.json   a regular grid of ground elevations per area (for "% of land flooded")
//   data/manifest.json       provenance: when, from where, counts
//
// Sources: OpenStreetMap via the Overpass API; elevation from the USGS 3DEP
// Elevation Point Query Service (NAVD88 meters), with Open-Meteo (Copernicus DEM)
// as a flagged fallback. Runs in GitHub Actions (see .github/workflows/refresh-data.yml)
// or locally with Node 22+: `node scripts/build-data.mjs`.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const EPQS = 'https://epqs.nationalmap.gov/v1/json';
const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation';
const USER_AGENT = 'hampton-roads-flood-mcp data builder (github.com/sgavathe/hampton-roads-flood-mcp)';
export const GRID_SIZE = 30; // 30 x 30 samples per area

// ---------- OpenStreetMap ----------

export function overpassQuery([west, south, east, north]) {
  const b = `${south},${west},${north},${east}`;
  return `[out:json][timeout:180];
(
  nwr["power"~"^(substation|plant)$"](${b});
  nwr["man_made"~"^(water_works|wastewater_plant|water_tower|pumping_station)$"](${b});
  nwr["amenity"~"^(hospital|fire_station|police|school)$"](${b});
  nwr["healthcare"="hospital"](${b});
  nwr["emergency"="ambulance_station"](${b});
  nwr["telecom"="exchange"](${b});
  nwr["man_made"~"^(mast|tower)$"]["tower:type"="communication"](${b});
);
out center tags;`;
}

export function categorize(tags = {}) {
  if (tags.power === 'substation' || tags.power === 'plant') return 'power';
  if (['water_works', 'wastewater_plant', 'water_tower', 'pumping_station'].includes(tags.man_made)) return 'water';
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'hospital';
  if (tags.amenity === 'fire_station' || tags.emergency === 'ambulance_station') return 'fire_ems';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'school') return 'school';
  if (tags.telecom === 'exchange' || tags['tower:type'] === 'communication') return 'telecom';
  return null;
}

const LABELS = {
  power: 'substation', water: 'water facility', hospital: 'hospital', fire_ems: 'fire/EMS station',
  police: 'police station', school: 'school', telecom: 'telecom site',
};

export function inBbox([lon, lat], [w, s, e, n]) {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

// Overpass JSON -> GeoJSON point features (ways/relations use their center).
export function toFeatures(overpassJson, area) {
  const seen = new Set();
  const features = [];
  for (const el of overpassJson.elements ?? []) {
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    const category = categorize(el.tags);
    const id = `osm:${el.type}/${el.id}`;
    if (lon == null || lat == null || !category || seen.has(id)) continue;
    if (!inBbox([lon, lat], area.bbox)) continue;
    seen.add(id);
    const name = el.tags?.name?.trim() || `Unnamed ${LABELS[category]}`;
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [round(lon, 6), round(lat, 6)] },
      properties: {
        id,
        name,
        category,
        area: area.id,
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        operator: el.tags?.operator ?? null,
      },
    });
  }
  return features;
}

async function fetchOverpass(query, fetchImpl) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        lastErr = err;
        await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(`Overpass failed: ${lastErr?.message}`);
}

// ---------- Elevation ----------

// USGS EPQS returns a huge negative sentinel (or nothing) where there is no data.
export function parseEpqs(json) {
  const v = Number(json?.value);
  return Number.isFinite(v) && v > -1000 ? round(v, 2) : null;
}

async function epqsPoint([lon, lat], fetchImpl) {
  const url = `${EPQS}?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseEpqs(await res.json());
    } catch {
      await sleep(500 * attempt);
    }
  }
  return undefined; // undefined = request failed (null = no data at that point)
}

async function openMeteoBatch(points, fetchImpl) {
  const lat = points.map((p) => p[1]).join(',');
  const lon = points.map((p) => p[0]).join(',');
  const res = await fetchImpl(`${OPEN_METEO}?latitude=${lat}&longitude=${lon}`, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const { elevation } = await res.json();
  return elevation.map((v) => (Number.isFinite(v) ? round(v, 2) : null));
}

// Returns [{ value, source }] aligned with `points`.
export async function elevations(points, { fetchImpl = fetch, concurrency = 10, log = () => {} } = {}) {
  const out = new Array(points.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < points.length) {
      const i = next++;
      const v = await epqsPoint(points[i], fetchImpl);
      out[i] = v === undefined ? undefined : { value: v, source: 'usgs-3dep' };
      if (++done % 250 === 0) log(`  elevation ${done}/${points.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const failed = out.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < failed.length; k += 100) {
    const idx = failed.slice(k, k + 100);
    const vals = await openMeteoBatch(idx.map((i) => points[i]), fetchImpl);
    idx.forEach((i, j) => { out[i] = { value: vals[j], source: 'copernicus-dem-90m' }; });
  }
  return out;
}

export function grid([w, s, e, n], size = GRID_SIZE) {
  const pts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      pts.push([round(w + ((c + 0.5) * (e - w)) / size, 5), round(s + ((r + 0.5) * (n - s)) / size, 5)]);
    }
  }
  return pts;
}

// ---------- Main ----------

export async function build({ fetchImpl = fetch, log = console.log, gridSize = GRID_SIZE, dataDir = DATA } = {}) {
  const config = JSON.parse(await readFile(path.join(dataDir, 'areas.json'), 'utf8'));
  const features = [];
  const landSamples = {};
  const sourceCounts = {};

  for (const area of config.areas) {
    log(`[${area.id}] querying OpenStreetMap`);
    const osm = await fetchOverpass(overpassQuery(area.bbox), fetchImpl);
    const areaFeatures = toFeatures(osm, area);
    log(`[${area.id}] ${areaFeatures.length} facilities; fetching elevations`);

    const assetElev = await elevations(areaFeatures.map((f) => f.geometry.coordinates), { fetchImpl, log });
    areaFeatures.forEach((f, i) => {
      f.properties.elevationM = assetElev[i].value;
      f.properties.elevationSource = assetElev[i].source;
      sourceCounts[assetElev[i].source] = (sourceCounts[assetElev[i].source] ?? 0) + 1;
    });
    features.push(...areaFeatures.filter((f) => f.properties.elevationM !== null));

    log(`[${area.id}] sampling ${gridSize}x${gridSize} land grid`);
    const pts = grid(area.bbox, gridSize);
    const sampleElev = await elevations(pts, { fetchImpl, log });
    landSamples[area.id] = sampleElev.map((e) => e.value);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    datum: config.datum,
    sources: {
      facilities: 'OpenStreetMap contributors (ODbL), via Overpass API',
      elevation: sourceCounts,
    },
    gridSize,
    counts: Object.fromEntries(config.areas.map((a) => [a.id, features.filter((f) => f.properties.area === a.id).length])),
  };

  await writeFile(path.join(dataDir, 'assets.geojson'), JSON.stringify({ type: 'FeatureCollection', features }) + '\n');
  await writeFile(path.join(dataDir, 'land-samples.json'), JSON.stringify({ gridSize, samples: landSamples }) + '\n');
  await writeFile(path.join(dataDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`Wrote ${features.length} facilities. Counts: ${JSON.stringify(manifest.counts)}`);
  return manifest;
}

function round(v, d) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
