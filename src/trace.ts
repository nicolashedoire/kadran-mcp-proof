import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type TraceEvent = { runId: string; sequence: number; timestamp: string; event: string; data: unknown };
export class Trace {
  readonly runId = randomUUID();
  readonly events: TraceEvent[] = [];
  constructor(private readonly file?: string) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }
  add(event: string, data: unknown): void {
    const row = { runId: this.runId, sequence: this.events.length + 1, timestamp: new Date().toISOString(), event, data };
    this.events.push(row);
    if (this.file) appendFileSync(this.file, JSON.stringify(row) + '\n');
  }
}
