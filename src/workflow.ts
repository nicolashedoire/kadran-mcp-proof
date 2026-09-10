import { Hub, ToolFailure } from './hub.js';
import type { Customer, Inquiry, Product } from './fixtures.js';
import type { Quote } from './quotes.js';

export type Outcome = { messageId: string; status: 'draft_prepared' | 'human_review'; reason?: string; quote?: Quote };

// Deliberately deterministic integration scenario, NOT an LLM agent. See agent.ts for real model decisions.
export async function runScenario(hub: Hub, messageId: string): Promise<Outcome> {
  try {
    const inquiry = await hub.call<Inquiry>('inbox__get', { id: messageId });
    const customer = await hub.call<Customer | null>('crm__find', { email: inquiry.sender });
    if (!customer) return { messageId, status: 'human_review', reason: 'UNKNOWN_CUSTOMER' };
    if (inquiry.items.some(i => i.quantity === null)) return { messageId, status: 'human_review', reason: 'MISSING_QUANTITY' };
    for (const item of inquiry.items) {
      const product = await hub.call<Product>('catalog__get', { sku: item.sku });
      if (item.quantity! > product.available) return { messageId, status: 'human_review', reason: 'INSUFFICIENT_STOCK' };
    }
    const quote = await hub.call<Quote>('quotes__prepare', { messageId, customerId: customer.id, items: inquiry.items });
    return { messageId, status: 'draft_prepared', quote };
  } catch (error) {
    return { messageId, status: 'human_review', reason: error instanceof ToolFailure ? error.code : 'SERVICE_UNAVAILABLE' };
  }
}
