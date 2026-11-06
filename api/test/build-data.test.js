import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, categorize, grid, overpassQuery, parseEpqs, toFeatures } from '../../scripts/build-data.mjs';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('categorize maps OSM tags to facility categories', () => {
  assert.equal(categorize({ power: 'substation' }), 'power');
  assert.equal(categorize({ man_made: 'wastewater_plant' }), 'water');
  assert.equal(categorize({ healthcare: 'hospital' }), 'hospital');
  assert.equal(categorize({ emergency: 'ambulance_station' }), 'fire_ems');
  assert.equal(categorize({ man_made: 'mast', 'tower:type': 'communication' }), 'telecom');
  assert.equal(categorize({ amenity: 'cafe' }), null);
});

test('overpass query uses south,west,north,east order', () => {
  assert.match(overpassQuery([-76.34, 36.83, -76.18, 36.97]), /\(36\.83,-76\.34,36\.97,-76\.18\)/);
});

test('toFeatures uses way centers, dedupes, drops out-of-bbox and unnamed fallbacks', () => {
  const area = { id: 'norfolk', bbox: [-76.34, 36.83, -76.18, 36.97] };
  const f = toFeatures({
    elements: [
      { type: 'node', id: 1, lat: 36.85, lon: -76.29, tags: { power: 'substation', name: 'Sub A' } },
      { type: 'node', id: 1, lat: 36.85, lon: -76.29, tags: { power: 'substation' } },
      { type: 'way', id: 2, center: { lat: 36.86, lon: -76.3 }, tags: { amenity: 'hospital' } },
      { type: 'node', id: 3, lat: 40, lon: -70, tags: { amenity: 'police' } },
      { type: 'node', id: 4, lat: 36.85, lon: -76.29, tags: { amenity: 'cafe' } },
    ],
  }, area);
  assert.deepEqual(f.map((x) => x.id), ['osm:node/1', 'osm:way/2']);
  assert.equal(f[1].properties.name, 'Unnamed hospital');
});

test('EPQS no-data sentinel becomes null', () => {
  assert.equal(parseEpqs({ value: '2.345' }), 2.35);
  assert.equal(parseEpqs({ value: -1000000 }), null);
  assert.equal(parseEpqs({}), null);
});

test('grid places cell-centred samples inside the bbox', () => {
  const g = grid([0, 0, 1, 1], 2);
  assert.deepEqual(g, [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]);
});

test('build() writes assets, samples and manifest; falls back to Open-Meteo when USGS fails', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'flood-data-'));
  cpSync(new URL('../../data/areas.json', import.meta.url), path.join(dir, 'areas.json'));

  const fetchImpl = async (url) => {
    if (url.includes('overpass')) {
      return json({ elements: [{ type: 'node', id: 7, lat: 36.9, lon: -76.25, tags: { amenity: 'fire_station', name: 'Station 7' } }] });
    }
    if (url.includes('epqs')) {
      // Simulate USGS outage for Williamsburg-area points to exercise the fallback.
      const lat = Number(new URL(url).searchParams.get('y'));
      return lat > 37 ? json({}, 503) : json({ value: '1.5' });
    }
    if (url.includes('open-meteo')) {
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      return json({ elevation: Array(n).fill(12) });
    }
    throw new Error(`unexpected ${url}`);
  };

  const manifest = await build({ fetchImpl, log: () => {}, gridSize: 2, dataDir: dir });
  const assets = JSON.parse(readFileSync(path.join(dir, 'assets.geojson'), 'utf8'));
  const samples = JSON.parse(readFileSync(path.join(dir, 'land-samples.json'), 'utf8'));

  // One OSM node per query, but only inside each area's bbox: the node is in Norfolk only.
  assert.equal(assets.features.length, 1);
  assert.equal(assets.features[0].properties.elevationM, 1.5);
  assert.equal(samples.samples.norfolk.length, 4);
  assert.deepEqual(samples.samples.williamsburg, [12, 12, 12, 12]);
  assert.ok(manifest.sources.elevation['usgs-3dep'] >= 1);
});
