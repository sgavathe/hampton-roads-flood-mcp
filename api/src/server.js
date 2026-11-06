import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createConditions } from './conditions.js';
import { loadData } from './exposure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = '8080',
  DATA_DIR = path.resolve(here, '../../data'),
  STATIC_DIR,
  MCP_API_KEY,
  ALLOW_ANONYMOUS_MCP = 'false',
  ARCGIS_API_KEY = '',
  BUILDINGS_LAYER_URL = 'https://basemaps3d.arcgis.com/arcgis/rest/services/Open3D_Buildings_v1/SceneServer',
} = process.env;

const data = loadData(DATA_DIR);
if (!data.ready) {
  console.warn(`No facility data in ${DATA_DIR}. Run: node scripts/build-data.mjs`);
}

const allowAnonymousMcp = ALLOW_ANONYMOUS_MCP === 'true';
const app = createApp({
  data,
  conditions: createConditions(),
  staticDir: STATIC_DIR,
  mcpApiKey: MCP_API_KEY,
  allowAnonymousMcp,
  publicConfig: { arcgisApiKey: ARCGIS_API_KEY || null, buildingsLayerUrl: BUILDINGS_LAYER_URL },
});

const facilities = [...data.byArea.values()].reduce((n, a) => n + a.length, 0);
const mcp = MCP_API_KEY ? 'bearer-key' : allowAnonymousMcp ? 'anonymous (local only)' : 'disabled';
app.listen(Number(PORT), () => console.log(`Listening on :${PORT} (facilities=${facilities}, mcp=${mcp})`));
