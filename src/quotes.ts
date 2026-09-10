import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Customer, Inquiry, Product } from './fixtures.js';
import { ToolFailure, type Hub } from './hub.js';

export type PrepareInput = { messageId: string; customerId: string; items: { sku: string; quantity: number }[] };
export type Quote = { id: string; messageId: string; customerId: string; status: 'pending_human_review' | 'approved';
  currency: 'EUR'; totalExVatCents: number; items: { sku: string; quantity: number; unitPriceCents: number }[] };

export class QuoteStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quotes (message_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (quote_id TEXT PRIMARY KEY, at TEXT NOT NULL);`);
  }
  get(messageId: string): Quote | null {
    const row = this.db.prepare('SELECT payload FROM quotes WHERE message_id=?').get(messageId);
    return row ? JSON.parse(row.payload as string) as Quote : null;
  }
  count(): number { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM quotes').get()!.n); }

  async prepare(input: PrepareInput, authority: Hub): Promise<Quote> {
    const normalized = { ...input, items: [...input.items].sort((a, b) => a.sku.localeCompare(b.sku)) };
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const previous = this.db.prepare('SELECT fingerprint, payload FROM quotes WHERE message_id=?').get(input.messageId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ToolFailure('IDEMPOTENCY_CONFLICT', 'Existing inquiry has different quote parameters');
      return JSON.parse(previous.payload as string) as Quote;
    }
    // Re-fetch authoritative data through MCP. The model's claimed prices/customer/context are never authoritative.
    const inquiry = await authority.call<Inquiry>('inbox__get', { id: input.messageId });
    const customer = await authority.call<Customer | null>('crm__find', { email: inquiry.sender });
    if (!customer || customer.id !== input.customerId) throw new ToolFailure('CUSTOMER_MISMATCH', 'Sender is not the requested CRM customer');
    if (new Set(input.items.map(line => line.sku)).size !== input.items.length) throw new ToolFailure('INVALID_LINES', 'Duplicate SKU');
    if (inquiry.items.some(line => line.quantity === null)) throw new ToolFailure('MISSING_QUANTITY', 'Human clarification required');
    const expected = [...inquiry.items].sort((a, b) => a.sku.localeCompare(b.sku));
    if (JSON.stringify(expected) !== JSON.stringify(normalized.items)) throw new ToolFailure('REQUEST_MISMATCH', 'Lines differ from the structured customer request');
    const items: Quote['items'] = [];
    for (const line of normalized.items) {
      const product = await authority.call<Product>('catalog__get', { sku: line.sku });
      if (line.quantity > product.available) throw new ToolFailure('INSUFFICIENT_STOCK', 'Human stock review required');
      items.push({ ...line, unitPriceCents: product.unitPriceCents });
    }
    const quote: Quote = { id: `q-${input.messageId}`, messageId: input.messageId, customerId: customer.id,
      status: 'pending_human_review', currency: 'EUR', totalExVatCents: items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0), items };
    // A single atomic insert prevents concurrent duplicates. Losers verify the winning fingerprint.
    this.db.prepare('INSERT OR IGNORE INTO quotes VALUES (?, ?, ?)').run(input.messageId, fingerprint, JSON.stringify(quote));
    const saved = this.db.prepare('SELECT fingerprint, payload FROM quotes WHERE message_id=?').get(input.messageId)!;
    if (saved.fingerprint !== fingerprint) throw new ToolFailure('IDEMPOTENCY_CONFLICT', 'Concurrent conflicting request');
    return JSON.parse(saved.payload as string) as Quote;
  }

  // Operator CLI only: this function is deliberately absent from the MCP tools.
  approve(messageId: string): Quote {
    const quote = this.get(messageId);
    if (!quote) throw new ToolFailure('NOT_FOUND', 'Quote not found');
    quote.status = 'approved';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE quotes SET payload=? WHERE message_id=?').run(JSON.stringify(quote), messageId);
      this.db.prepare('INSERT OR IGNORE INTO approvals VALUES (?, ?)').run(quote.id, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return quote;
  }
  close(): void { this.db.close(); }
}
