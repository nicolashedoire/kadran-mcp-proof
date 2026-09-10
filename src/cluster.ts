import { Hub, type Endpoints } from './hub.js';
import { startService, type ServiceOptions } from './server.js';
import { QuoteStore } from './quotes.js';

// Test/local convenience only. Docker starts each service in its own container/process.
export async function startCluster(database = ':memory:', overrides: Partial<Record<'catalog' | 'quotes', Partial<ServiceOptions>>> = {}) {
  const running: Awaited<ReturnType<typeof startService>>[] = [];
  const authority = new Hub();
  const store = new QuoteStore(database);
  const endpoints: Endpoints = {};
  const close = async () => { await authority.close(); await Promise.all(running.map(s => s.close())); store.close(); };
  try {
    for (const service of ['inbox', 'crm', 'catalog'] as const) {
      const instance = await startService({ service, ...(service === 'catalog' ? overrides.catalog : {}) });
      running.push(instance); endpoints[service] = instance.url;
    }
    await authority.connect(endpoints);
    const quotes = await startService({ service: 'quotes', store, authority, ...overrides.quotes });
    running.push(quotes); endpoints.quotes = quotes.url;
    return { endpoints, store, close };
  } catch (error) { await close(); throw error; }
}
