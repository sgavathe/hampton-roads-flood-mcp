// Synthetic test data. Facility names and elevations are invented for tests and
// are NOT real Hampton Roads facilities; the real dataset comes from build-data.mjs.
import { readFileSync } from 'node:fs';
import { buildIndex } from '../src/exposure.js';

export const config = JSON.parse(readFileSync(new URL('../../data/areas.json', import.meta.url), 'utf8'));

const pt = (id, area, category, elevationM, lon = -76.29, lat = 36.85) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, name: `Test ${category} ${id}`, category, area, elevationM, elevationSource: 'usgs-3dep', osmUrl: 'x' },
});

export const assets = [
  pt('osm:node/1', 'norfolk', 'power', 0.4),
  pt('osm:node/2', 'norfolk', 'power', 2.5),
  pt('osm:way/3', 'norfolk', 'hospital', 1.2),
  pt('osm:node/4', 'norfolk', 'fire_ems', 3.0),
  pt('osm:node/5', 'norfolk', 'school', 6.0),
  pt('osm:node/6', 'williamsburg', 'school', 25.0, -76.7, 37.27),
];

// 10 samples: 2 water (<= 0), 8 land at 0.5, 1, 1.5, 2, 2.5, 3, 5, 10
export const land = { gridSize: 0, samples: { norfolk: [-1, 0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10], williamsburg: [20, 30] } };

export const manifest = { generatedAt: '2026-11-05T00:00:00Z' };

export function testData() {
  return buildIndex({ config, assets, land, manifest });
}
