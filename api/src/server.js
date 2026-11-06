import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { AzureOpenAI } from 'openai';
import { createAgent } from './agent.js';
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
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT = 'flood-agent',
  AZURE_OPENAI_API_VERSION = '2024-10-21',
} = process.env;

const data = loadData(DATA_DIR);
if (!data.ready) {
  console.warn(`No facility data in ${DATA_DIR}. Run: node scripts/build-data.mjs`);
}

const conditions = createConditions();

// Azure OpenAI via Entra ID: the Container App's managed identity (AZURE_CLIENT_ID)
// in Azure, `az login` locally. The account has key auth disabled.
let ask = null;
if (AZURE_OPENAI_ENDPOINT) {
  const chat = new AzureOpenAI({
    endpoint: AZURE_OPENAI_ENDPOINT,
    apiVersion: AZURE_OPENAI_API_VERSION,
    deployment: AZURE_OPENAI_DEPLOYMENT,
    azureADTokenProvider: getBearerTokenProvider(new DefaultAzureCredential(), 'https://cognitiveservices.azure.com/.default'),
  });
  ask = createAgent({ data, conditions, chat, deployment: AZURE_OPENAI_DEPLOYMENT });
}

const allowAnonymousMcp = ALLOW_ANONYMOUS_MCP === 'true';
const app = createApp({
  data,
  conditions,
  ask,
  staticDir: STATIC_DIR,
  mcpApiKey: MCP_API_KEY,
  allowAnonymousMcp,
  publicConfig: { arcgisApiKey: ARCGIS_API_KEY || null, buildingsLayerUrl: BUILDINGS_LAYER_URL },
});

const facilities = [...data.byArea.values()].reduce((n, a) => n + a.length, 0);
const mcp = MCP_API_KEY ? 'bearer-key' : allowAnonymousMcp ? 'anonymous (local only)' : 'disabled';
const ai = ask ? `azure-openai/${AZURE_OPENAI_DEPLOYMENT}` : 'off';
app.listen(Number(PORT), () => console.log(`Listening on :${PORT} (facilities=${facilities}, mcp=${mcp}, ai=${ai})`));
