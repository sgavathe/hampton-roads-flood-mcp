import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent, mapActionFrom, toOpenAiTools, validateQuestion } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { testData } from './fixtures.js';

const data = testData();
const conditions = async (area) => ({ area: area.id, weather: null, tide: null, note: 'context' });
const quiet = { error: () => {} };

// Scripted chat model: returns the given responses in order and records every request.
function scriptedChat(responses) {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          requests.push(structuredClone(req));
          const next = responses[requests.length - 1];
          if (!next) throw new Error('model called more times than scripted');
          return typeof next === 'function' ? next(req) : next;
        },
      },
    },
  };
}
const toolCall = (id, name, args) => ({
  choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }],
  usage: { total_tokens: 100 },
});
const final = (text) => ({ model: 'gpt-4.1-mini', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { total_tokens: 50 } });

test('agent calls the MCP tool, feeds the real result back, and returns a map action', async () => {
  const chat = scriptedChat([
    toolCall('c1', 'flood_exposure', { area: 'norfolk', water_level_m: 2 }),
    (req) => {
      const toolMsg = req.messages.find((m) => m.role === 'tool');
      const result = JSON.parse(toolMsg.content);
      return final(`At +2 m, ${result.totals.exposed} of ${result.totals.facilities} facilities are exposed (what-if).`);
    },
  ]);
  const ask = createAgent({ data, conditions, chat, deployment: 'flood-agent', logger: quiet });
  const r = await ask('What floods in Norfolk at 2 meters?');

  assert.equal(r.answer, 'At +2 m, 2 of 5 facilities are exposed (what-if).');
  assert.deepEqual(r.toolCalls, [{ name: 'flood_exposure', args: { area: 'norfolk', water_level_m: 2 }, isError: false }]);
  assert.deepEqual(r.mapAction, { area: 'norfolk', waterLevelM: 2, focus: null, highlightIds: ['osm:node/1', 'osm:way/3'] });
  assert.equal(r.tokens, 150);

  // The model was offered all six MCP tools, with the MCP input schemas as parameters.
  const offered = chat.requests[0].tools.map((t) => t.function.name).sort();
  assert.deepEqual(offered, ['compare_scenarios', 'current_conditions', 'facility_details', 'find_facilities', 'flood_exposure', 'list_areas']);
  assert.equal(chat.requests[0].messages[0].role, 'system');
  assert.match(chat.requests[0].messages[0].content, /Never invent numbers/);
});

test('tool errors and malformed arguments go back to the model, which can recover', async () => {
  const chat = scriptedChat([
    toolCall('c1', 'flood_exposure', { area: 'richmond', water_level_m: 1 }),
    toolCall('c2', 'flood_exposure', '{not json'),
    (req) => {
      const tools = req.messages.filter((m) => m.role === 'tool');
      assert.match(tools[0].content, /^Error: Unknown area/);
      assert.match(tools[1].content, /not valid JSON/);
      return final('Richmond is not one of the study areas.');
    },
  ]);
  const ask = createAgent({ data, conditions, chat, deployment: 'd', logger: quiet });
  const r = await ask('What floods in Richmond?');
  assert.equal(r.answer, 'Richmond is not one of the study areas.');
  assert.equal(r.toolCalls.every((c) => c.isError), true);
  assert.equal(r.mapAction, null);
});

test('agent stops after maxSteps tool rounds', async () => {
  const loop = toolCall('c', 'list_areas', {});
  const chat = scriptedChat([loop, loop]);
  const ask = createAgent({ data, conditions, chat, deployment: 'd', maxSteps: 2, logger: quiet });
  const r = await ask('Keep calling tools forever');
  assert.match(r.answer, /more steps than I allow/);
  assert.equal(r.toolCalls.length, 2);
});

test('content filter blocks surface as a 400-style AskError', async () => {
  const chat = scriptedChat([{ choices: [{ finish_reason: 'content_filter', message: {} }] }]);
  const ask = createAgent({ data, conditions, chat, deployment: 'd', logger: quiet });
  await assert.rejects(() => ask('something blocked'), { name: 'AskError', message: /content filter/ });
});

test('facility_details focuses the map on that facility', () => {
  const action = mapActionFrom(
    [
      { name: 'flood_exposure', args: { area: 'norfolk', water_level_m: 3 }, isError: false },
      { name: 'facility_details', args: { id: 'osm:way/3' }, isError: false, result: { id: 'osm:way/3', area: 'norfolk', coordinates: [-76.29, 36.85] } },
    ],
    data,
  );
  assert.deepEqual(action, { area: 'norfolk', waterLevelM: 3, focus: [-76.29, 36.85], facilityId: 'osm:way/3', highlightIds: ['osm:way/3'] });
  assert.deepEqual(mapActionFrom([{ name: 'compare_scenarios', args: { area: 'williamsburg', water_levels_m: [1, 4] }, isError: false }], data).waterLevelM, 4);
});

test('find_facilities highlights what it found and shows the asked-about level', async () => {
  // Mirrors the real question: "which schools in Norfolk flooded above 1.2 m, show me on the map".
  const chat = scriptedChat([
    toolCall('c1', 'find_facilities', { area: 'norfolk', category: 'power', max_elevation_m: 1.2 }),
    final('One power facility is at or below 1.2 m.'),
  ]);
  const ask = createAgent({ data, conditions, chat, deployment: 'd', logger: quiet });
  const r = await ask('Which power facilities in Norfolk flood at 1.2 m? Show me on the map.');
  assert.deepEqual(r.mapAction, {
    area: 'norfolk', waterLevelM: 1.2, focus: [-76.29, 36.85], facilityId: 'osm:node/1', highlightIds: ['osm:node/1'],
  });

  // Several matches: highlight them all, no single focus; the map fits them in view.
  const many = mapActionFrom(
    [{ name: 'find_facilities', args: { area: 'norfolk', max_elevation_m: 3 }, isError: false,
       result: { facilities: [{ id: 'a', coordinates: [0, 0] }, { id: 'b', coordinates: [1, 1] }] } }],
    data,
  );
  assert.deepEqual(many, { area: 'norfolk', waterLevelM: 3, focus: null, facilityId: undefined, highlightIds: ['a', 'b'] });
});

test('question validation and tool conversion', () => {
  assert.throws(() => validateQuestion('hi'), /Ask a question/);
  assert.throws(() => validateQuestion('x'.repeat(501)), /500 characters/);
  assert.throws(() => validateQuestion(5), /must be a string/);
  const [t] = toOpenAiTools([{ name: 'a', description: 'd', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }]);
  assert.deepEqual(t, { type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: { x: { type: 'number' } } } } });
});

test('POST /api/ask: 503 when AI is off, 400 on bad input, 200 with answer', async () => {
  const run = async (ask, body) => {
    const app = createApp({ data, conditions, logger: quiet, ask });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  assert.equal((await run(null, { question: 'What floods in Norfolk?' })).status, 503);

  const chat = scriptedChat([final('Hello from the map.')]);
  const ask = createAgent({ data, conditions, chat, deployment: 'd', logger: quiet });
  assert.equal((await run(ask, { question: '' })).status, 400);
  const ok = await run(ask, { question: 'Say hello' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.answer, 'Hello from the map.');

  const failing = async () => { throw Object.assign(new Error('throttled'), { status: 429 }); };
  assert.equal((await run(failing, { question: 'busy?' })).status, 429);
});
