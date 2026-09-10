import test from 'node:test';
import { request, createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startCluster } from '../src/cluster.js';
import { Hub, ToolFailure } from '../src/hub.js';
import { runScenario } from '../src/workflow.js';
import { runAgent, ollamaChat, type Chat } from '../src/agent.js';
import type { Quote } from '../src/quotes.js';
import { startService } from '../src/server.js';

const valid = { messageId: 'm-100', customerId: 'c-atelier', items: [{ sku: 'SENSOR-01', quantity: 3 }, { sku: 'HUB-01', quantity: 1 }] };
test('HTTP transport outage exhausts retries, without fabricating a tool result', async () => {
  const service = await startService({ service: 'catalog' });
  const hub = new Hub();
  try {
    await hub.connect({ catalog: service.url });
    await service.close();
    await assert.rejects(hub.call('catalog__get', { sku: 'SENSOR-01' }));
    assert.equal(hub.trace.events.filter(e => e.event === 'mcp.error').length, 3);
    assert.equal(hub.trace.events.filter(e => e.event === 'mcp.result').length, 0);
  } finally { await hub.close(); if (service.server.listening) await service.close(); }
});

test('HTTP services reject untrusted browser origins and host headers', async () => {
  const service = await startService({ service: 'catalog' });
  try {
    assert.equal((await fetch(service.url, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(service.url, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403);
  } finally { await service.close(); }
});
async function setup(t: test.TestContext, overrides: Parameters<typeof startCluster>[1] = {}) {
  const cluster = await startCluster(':memory:', overrides);
  const hub = new Hub(); await hub.connect(cluster.endpoints);
  t.after(async () => { await hub.close(); await cluster.close(); });
  return { ...cluster, hub };
}

test('HTTP MCP discovery exposes six typed tools and no approval/send capability', async t => {
  const { hub, endpoints } = await setup(t);
  assert.equal(hub.tools.size, 6);
  assert.deepEqual([...hub.tools.keys()].sort(), ['catalog__get', 'crm__find', 'inbox__get', 'inbox__list', 'quotes__get', 'quotes__prepare']);
  assert.ok(hub.tools.get('quotes__prepare')!.inputSchema.required);
  // Bypass the agent allowlist: the server itself must not expose approval or send.
  const raw = new Client({ name: 'adversarial-test', version: '1' });
  await raw.connect(new StreamableHTTPClientTransport(new URL(endpoints.quotes!)));
  t.after(() => raw.close());
  for (const name of ['approve', 'send']) {
    await assert.rejects(raw.callTool({ name, arguments: { messageId: 'm-100' } }), /not found/);
  }
});

test('quote service independently verifies sources via MCP and calculates 636 EUR excluding VAT', async t => {
  const { hub, store } = await setup(t);
  const quote = await hub.call<Quote>('quotes__prepare', valid);
  assert.equal(quote.totalExVatCents, 63600);
  assert.equal(quote.status, 'pending_human_review');
  assert.equal(store.count(), 1);
  assert.equal(hub.trace.events.filter(e => e.event === 'mcp.discovery').length, 4);
});

test('unknown customer, incomplete intake and stock shortage become human review without writes', async t => {
  const { hub, store } = await setup(t);
  for (const [id, reason] of [['m-101', 'UNKNOWN_CUSTOMER'], ['m-102', 'MISSING_QUANTITY'], ['m-104', 'INSUFFICIENT_STOCK']]) {
    assert.equal((await runScenario(hub, id!)).reason, reason);
  }
  assert.equal(store.count(), 0);
});

test('server rejects forged customer, altered quantities, duplicate lines and insufficient stock', async t => {
  const { hub, store } = await setup(t);
  for (const [args, code] of [
    [{ ...valid, customerId: 'c-studio' }, 'CUSTOMER_MISMATCH'],
    [{ ...valid, items: [{ sku: 'SENSOR-01', quantity: 1 }] }, 'REQUEST_MISMATCH'],
    [{ ...valid, items: [{ sku: 'SENSOR-01', quantity: 1 }, { sku: 'SENSOR-01', quantity: 1 }] }, 'INVALID_LINES'],
    [{ ...valid, messageId: 'm-102' }, 'MISSING_QUANTITY'],
    [{ messageId: 'm-104', customerId: 'c-studio', items: [{ sku: 'HUB-01', quantity: 99 }] }, 'INSUFFICIENT_STOCK'],
  ] as const) {
    await assert.rejects(hub.call('quotes__prepare', args), (e: unknown) => e instanceof ToolFailure && e.code === code);
  }
  assert.equal(store.count(), 0);
});

test('strict MCP schemas reject price injection, invalid quantities and extra fields', async t => {
  const { hub, store } = await setup(t);
  for (const args of [{ ...valid, totalExVatCents: 1 }, { ...valid, approved: true },
    { ...valid, items: [{ sku: 'SENSOR-01', quantity: -1 }] },
    { ...valid, items: [{ sku: 'SENSOR-01', quantity: 1.5 }] }]) {
    await assert.rejects(hub.call('quotes__prepare', args), (e: unknown) => e instanceof ToolFailure && e.code === 'INVALID_ARGUMENTS');
  }
  assert.equal(store.count(), 0);
  assert.equal(hub.trace.events.filter(e => e.event === 'mcp.retry').length, 0);
});

test('malicious inbox body cannot change price or authorize send in the deterministic fixture', async t => {
  const { hub, store } = await setup(t);
  const outcome = await runScenario(hub, 'm-103');
  assert.equal(outcome.quote?.totalExVatCents, 25800);
  assert.equal(outcome.quote?.status, 'pending_human_review');
  await assert.rejects(hub.call('quotes__send', {}), /Tool not exposed/);
  assert.equal(store.count(), 1);
});

test('concurrent replay produces exactly one quote; changed payload conflicts', async t => {
  const { hub, store } = await setup(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => hub.call<Quote>('quotes__prepare', valid)));
  assert.ok(results.every(q => q.id === results[0]!.id));
  assert.equal(store.count(), 1);
  await assert.rejects(hub.call('quotes__prepare', { ...valid, customerId: 'c-studio' }), (e: unknown) => e instanceof ToolFailure && e.code === 'IDEMPOTENCY_CONFLICT');
});

test('transient dependency failure retries and recovers with bounded attempts', async t => {
  let attempts = 0;
  const { hub } = await setup(t, { catalog: { beforeCall: () => { if (++attempts < 3) throw new ToolFailure('SERVICE_UNAVAILABLE', 'Injected outage'); } } });
  await hub.call('catalog__get', { sku: 'SENSOR-01' });
  assert.equal(attempts, 3);
  assert.equal(hub.trace.events.filter(e => e.event === 'mcp.retry').length, 2);
});

test('persistent service failure stops after three attempts and creates no quote', async t => {
  let attempts = 0;
  const { hub, store } = await setup(t, { catalog: { beforeCall: () => { attempts++; throw new ToolFailure('SERVICE_UNAVAILABLE', 'Injected outage'); } } });
  const result = await runScenario(hub, 'm-100');
  assert.equal(result.reason, 'SERVICE_UNAVAILABLE');
  assert.equal(attempts, 3); assert.equal(store.count(), 0);
});

test('lost acknowledgement after commit retries without duplicating a quote', async t => {
  let lost = false;
  const { hub, store } = await setup(t, { quotes: { afterCall: name => {
    if (name === 'prepare' && !lost) { lost = true; throw new ToolFailure('SERVICE_UNAVAILABLE', 'Injected lost acknowledgement'); }
  } } });
  const quote = await hub.call<Quote>('quotes__prepare', valid);
  assert.equal(quote.totalExVatCents, 63600); assert.equal(store.count(), 1);
  assert.equal(hub.trace.events.filter(e => e.event === 'mcp.retry').length, 1);
});

test('SQLite restart retains idempotency and explicit operator approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadran-proof-'));
  try {
    for (let pass = 0; pass < 2; pass++) {
      const cluster = await startCluster(join(dir, 'quotes.sqlite')); const hub = new Hub();
      try {
        await hub.connect(cluster.endpoints);
        const quote = await hub.call<Quote>('quotes__prepare', valid);
        assert.equal(quote.status, pass === 0 ? 'pending_human_review' : 'approved');
        if (pass === 0) cluster.store.approve('m-100');
        assert.equal(cluster.store.count(), 1);
      } finally { await hub.close(); await cluster.close(); }
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('agent reports actual stored state, never an invented successful model response', async t => {
  const { hub } = await setup(t);
  const chat: Chat = async () => ({ message: { role: 'assistant', content: 'Le devis a été créé et envoyé.' } });
  const result = await runAgent(hub, 'm-100', chat);
  assert.equal(result.status, 'human_review'); assert.equal(result.quote, null);
});

test('agent blocks out-of-scope writes and bounds a looping model', async t => {
  const { hub, store } = await setup(t);
  const chat: Chat = async () => ({ message: { role: 'assistant', content: '', tool_calls: [
    { function: { name: 'quotes__prepare', arguments: valid } },
    { function: { name: 'quotes__send', arguments: {} } },
  ] } });
  const result = await runAgent(hub, 'm-103', chat, 2, 3);
  assert.equal(result.status, 'budget_exhausted'); assert.equal(store.count(), 0);
});

test('agent forwards real MCP results to the next model turn and verifies persisted draft', async t => {
  const { hub } = await setup(t);
  let turn = 0;
  const chat: Chat = async (messages, tools) => {
    assert.equal(tools.length, 6);
    if (++turn === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'quotes__prepare', arguments: valid } }] } };
    assert.equal(JSON.parse(messages.at(-1)!.content).totalExVatCents, 63600);
    return { message: { role: 'assistant', content: 'Devis préparé, à valider.' } };
  };
  const result = await runAgent(hub, 'm-100', chat);
  assert.equal(result.status, 'draft_prepared'); assert.equal(result.steps, 2);
});

test('Ollama adapter derives decision grammar from MCP schemas and forwards the selected call', async t => {
  const { hub } = await setup(t);
  let requestBody: any;
  const fakeOllama = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({ tool: 'inbox__get', arguments: { id: 'm-100' } }) } }));
  });
  await new Promise<void>(resolve => fakeOllama.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { fakeOllama.close(() => resolve()); fakeOllama.closeAllConnections(); }));
  const address = fakeOllama.address() as { port: number };
  const tools = [...hub.tools.values()].map(tool => ({ type: 'function', function: { ...tool, parameters: tool.inputSchema } }));
  const reply = await ollamaChat(`http://127.0.0.1:${address.port}`, 'test-model')([
    { role: 'system', content: 'Prepare a draft.' }, { role: 'user', content: 'Process m-100' },
  ], tools);
  assert.equal(requestBody.format.oneOf.length, 7);
  const quoteChoice = requestBody.format.oneOf.find((choice: any) => choice.properties.tool.const === 'quotes__prepare');
  assert.equal(quoteChoice.properties.arguments.additionalProperties, false);
  assert.deepEqual(reply.message.tool_calls, [{ function: { name: 'inbox__get', arguments: { id: 'm-100' } } }]);
});
