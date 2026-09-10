import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Trace } from './trace.js';

export const services = ['inbox', 'crm', 'catalog', 'quotes'] as const;
export type Service = typeof services[number];
export type Endpoints = Partial<Record<Service, string>>;
export type DiscoveredTool = { name: string; description?: string; inputSchema: Record<string, unknown> };
export class ToolFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// Explicit retry allowlist. Every write on this list has a server-side idempotency constraint.
const retryableTools = new Set(['inbox__list', 'inbox__get', 'crm__find', 'catalog__get', 'quotes__prepare', 'quotes__get']);
export class Hub {
  private clients = new Map<Service, Client>();
  readonly tools = new Map<string, DiscoveredTool>();
  constructor(readonly trace = new Trace(), private readonly timeoutMs = 3000) {}

  async connect(endpoints: Endpoints): Promise<void> {
    try {
      for (const service of services) {
        if (!endpoints[service]) continue;
        const client = new Client({ name: 'kadran-proof', version: '0.1.0' });
        this.clients.set(service, client);
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoints[service]!)), { timeout: this.timeoutMs });
        const listing = await client.listTools({}, { timeout: this.timeoutMs });
        for (const tool of listing.tools) this.tools.set(`${service}__${tool.name}`, { ...tool, name: `${service}__${tool.name}` });
        this.trace.add('mcp.discovery', { service, tools: listing.tools.map(t => ({ name: t.name, inputSchema: t.inputSchema })) });
      }
    } catch (error) { await this.close(); throw error; }
  }

  async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.tools.has(name)) {
      this.trace.add('policy.denied', { tool: name, reason: 'Tool not discovered / not exposed' });
      throw new ToolFailure('TOOL_NOT_ALLOWED', `Tool not exposed: ${name}`);
    }
    const [service, tool] = name.split('__');
    const client = this.clients.get(service as Service)!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = performance.now();
      this.trace.add('mcp.call', { name, args, attempt });
      try {
        const result = await client.callTool({ name: tool!, arguments: args }, { timeout: this.timeoutMs });
        const content = result.content as Array<{ type: string; text?: string }>;
        const raw = content.find(part => part.type === 'text')?.text;
        let data: any;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch {
          if (result.isError) throw new ToolFailure('INVALID_ARGUMENTS', raw ?? 'Invalid tool input');
          throw new ToolFailure('INVALID_RESPONSE', 'Tool did not return valid JSON');
        }
        this.trace.add('mcp.result', { name, attempt, durationMs: Math.round(performance.now() - start), isError: !!result.isError, data });
        if (result.isError) throw new ToolFailure(data.code ?? 'TOOL_ERROR', data.message ?? raw);
        return data as T;
      } catch (error) {
        const transient = !(error instanceof ToolFailure) || error.code === 'SERVICE_UNAVAILABLE';
        this.trace.add('mcp.error', { name, attempt, code: error instanceof ToolFailure ? error.code : 'TRANSPORT_ERROR' });
        if (!transient || !retryableTools.has(name) || attempt === 3) throw error;
        this.trace.add('mcp.retry', { name, nextAttempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
      }
    }
    throw new Error('Unreachable retry state');
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    this.clients.clear(); this.tools.clear();
  }
}
