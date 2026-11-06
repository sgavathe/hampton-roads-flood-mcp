import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetDetails,
  buildIndex,
  compare,
  depthAt,
  exposure,
  findFacilities,
  landFloodedPct,
  parseLevel,
  resolveArea,
} from '../src/exposure.js';
import { config, testData } from './fixtures.js';

const data = testData();

test('depth is level minus ground, null when dry', () => {
  assert.equal(depthAt(0.4, 1), 0.6);
  assert.equal(depthAt(1, 1), 0);
  assert.equal(depthAt(2.5, 1), null);
});

test('exposure counts facilities at or below the water level by category', () => {
  const r = exposure(data, 'norfolk', 2);
  assert.equal(r.totals.facilities, 5);
  assert.equal(r.totals.exposed, 2); // 0.4 and 1.2
  assert.equal(r.totals.deep, 1); // 0.4 -> 1.6 m deep
  const power = r.byCategory.find((c) => c.id === 'power');
  assert.deepEqual([power.total, power.exposed, power.deep], [2, 1, 1]);
  assert.equal(r.exposed[0].id, 'osm:node/1'); // deepest first
  assert.equal(r.exposed[0].depthClass, 'deep');
  assert.equal(r.exposed[1].depthClass, 'shallow');
});

test('land flooded % only counts samples above 0 m', () => {
  assert.deepEqual(landFloodedPct([-1, 0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10], 2), { pct: 50, sampled: 8 });
  assert.deepEqual(landFloodedPct([], 2), { pct: null, sampled: 0 });
  assert.equal(exposure(data, 'norfolk', 3).landFloodedPct, 75);
});

test('compare returns one row per level, increasing exposure', () => {
  const r = compare(data, 'norfolk', '1,2,3');
  assert.deepEqual(r.scenarios.map((s) => s.exposed), [1, 2, 4]);
  assert.equal(r.facilities, 5);
  assert.equal(r.scenarios[2].byCategory.fire_ems, 1);
});

test('area lookup accepts ids and names; bad input raises InputError', () => {
  assert.equal(resolveArea(data, 'Virginia Beach').id, 'virginia-beach');
  assert.equal(resolveArea(data, 'NORFOLK').id, 'norfolk');
  assert.throws(() => resolveArea(data, 'richmond'), { name: 'InputError' });
  assert.throws(() => parseLevel(9), { name: 'InputError' });
  assert.throws(() => parseLevel('abc'), { name: 'InputError' });
});

test('facility details include the flood-onset level and per-scenario depth', () => {
  const r = assetDetails(data, 'osm:way/3');
  assert.equal(r.floodsAtLevelM, 1.2);
  assert.deepEqual(r.scenarios.map((s) => s.status), ['dry', 'shallow', 'deep']);
  assert.throws(() => assetDetails(data, 'osm:node/999'), { name: 'InputError' });
});

test('find facilities filters by category and elevation, lowest first', () => {
  const r = findFacilities(data, 'norfolk', { maxElevationM: 3 });
  assert.deepEqual(r.facilities.map((f) => f.elevationM), [0.4, 1.2, 2.5, 3]);
  assert.equal(findFacilities(data, 'norfolk', { category: 'power' }).count, 2);
  assert.throws(() => findFacilities(data, 'norfolk', { category: 'bakery' }), { name: 'InputError' });
});

test('engine refuses to answer when data has not been generated', () => {
  const empty = buildIndex({ config, assets: [], land: { samples: {} }, manifest: null });
  assert.equal(empty.ready, false);
  assert.throws(() => exposure(empty, 'norfolk', 1), /not been generated/);
});
