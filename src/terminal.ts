import { stripVTControlCharacters } from 'node:util';
import type { Trace } from './trace.js';
import type { AgentResult } from './agent.js';
import type { Inquiry, Customer, Product } from './fixtures.js';
import type { Quote } from './quotes.js';

// Presentation only: every displayed action is read from the actual MCP/LLM trace.
const palette = { ink: 255, muted: 245, cyan: 87, green: 114, amber: 221, red: 203 };
type Tone = keyof typeof palette;
export const cleanText = (value: unknown): string => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const fit = (text: unknown, width: number) => {
  const chars = Array.from(cleanText(text));
  return (chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : chars.join('')).padEnd(width);
};
export const money = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',')} EUR`;
const duration = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export const statusLabel = (value: string): string => ({
  draft_prepared: 'Brouillon de devis préparé', human_review: 'Intervention humaine nécessaire',
  budget_exhausted: 'Limite atteinte : traitement incomplet', pending_human_review: 'À valider par une personne', approved: 'Approuvé',
}[value] ?? value);
export const reasonLabel = (value: string): string => ({
  UNKNOWN_CUSTOMER: 'Client introuvable dans le fichier clients', MISSING_QUANTITY: 'Quantité manquante : demander une précision',
  INSUFFICIENT_STOCK: 'Stock insuffisant pour la quantité demandée', CUSTOMER_MISMATCH: 'Le client ne correspond pas à la demande',
  SERVICE_UNAVAILABLE: 'Un service est indisponible', JOB_SCOPE_VIOLATION: 'Écriture bloquée : autre demande',
}[value] ?? value);
export const actionLabel = (tool: string): string => ({
  inbox__list: 'Lister les demandes reçues', inbox__get: 'Lire la demande du client',
  crm__find: 'Identifier le client dans le CRM', catalog__get: 'Vérifier le prix et le stock',
  quotes__prepare: 'Préparer et enregistrer le devis', quotes__get: 'Vérifier le devis enregistré',
}[tool] ?? tool);

type ToolData = { service?: string; name?: string; args?: Record<string, unknown>; data?: unknown; isError?: boolean; step?: number; attempt?: number; message?: { tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] }; reason?: string };
export type Action = { time: string; tool: string; input: Record<string, unknown>; outcome: string; error: boolean; origin: 'model' | 'verification' };
export function inspectTrace(trace: Trace) {
  const connected = new Set<string>();
  const products = new Map<string, Product>();
  const actions: Action[] = [];
  const selected: { name: string; arguments: Record<string, unknown> }[] = [];
  const origins = new Map<string, 'model' | 'verification'>();
  const pending = new Map<string, Record<string, unknown>>();
  let inquiry: Inquiry | undefined, customer: Customer | undefined, quote: Quote | undefined;
  let turn = 0, thinking = false, calls = 0;
  for (const event of trace.events) {
    const d = event.data as ToolData;
    if (event.event === 'mcp.discovery' && d.service) connected.add(d.service);
    if (event.event === 'llm.request') { turn = d.step ?? turn; thinking = true; }
    if (event.event === 'llm.response') { thinking = false; selected.push(...(d.message?.tool_calls ?? []).map(call => call.function)); }
    if (event.event === 'mcp.call' && d.name) {
      const match = selected.findIndex(call => call.name === d.name && JSON.stringify(call.arguments) === JSON.stringify(d.args));
      if (match >= 0) { selected.splice(match, 1); origins.set(d.name, 'model'); }
      else if ((d.attempt ?? 1) === 1) origins.set(d.name, 'verification');
      pending.set(d.name, d.args ?? {}); calls++;
    }
    if (event.event !== 'mcp.result' || !d.name) continue;
    let outcome = d.data === null ? 'Aucun résultat trouvé' : 'Action terminée';
    if (d.isError) outcome = reasonLabel(cleanText((d.data as { code?: string })?.code ?? 'Erreur du service'));
    else if (d.name === 'inbox__get') {
      inquiry = d.data as Inquiry; outcome = `Demande de ${inquiry.sender} : ${inquiry.items.map(item => `${item.quantity ?? '?'} × ${item.sku}`).join(', ')}`;
    } else if (d.name === 'crm__find' && d.data) {
      customer = d.data as Customer; outcome = `Client trouvé : ${customer.company}`;
    } else if (d.name === 'catalog__get') {
      const product = d.data as Product; products.set(product.sku, product);
      outcome = `${product.sku} : ${money(product.unitPriceCents)} HT ; ${product.available} en stock`;
    } else if ((d.name === 'quotes__prepare' || d.name === 'quotes__get') && d.data) {
      quote = d.data as Quote;
      outcome = `${d.name === 'quotes__prepare' ? 'Enregistré ou réutilisé :' : 'Devis trouvé :'} ${quote.id}: ${money(quote.totalExVatCents)}, ${statusLabel(quote.status)}`;
    }
    actions.push({ time: event.timestamp.slice(11, 19), tool: d.name, input: pending.get(d.name) ?? {}, outcome: cleanText(outcome), error: !!d.isError, origin: origins.get(d.name) ?? 'verification' });
  }
  return { connected, products, actions, inquiry, customer, quote, turn, thinking, calls };
}

export class TerminalDashboard {
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private printed = 0;
  private started = Date.now();
  private closed = false;
  private animated: boolean;
  private useColor: boolean;
  private receipt = false;
  private exit = () => { process.stdout.write('\x1b[0m\x1b[?25h'); };
  private interrupt = () => { this.stop(); process.exit(130); };
  private terminate = () => { this.stop(); process.exit(143); };
  private resize = () => this.draw();
  constructor(private trace: Trace, private messageId: string, private model: string, plain = false) {
    this.animated = !!process.stdout.isTTY && process.env.TERM !== 'dumb' && !plain;
    this.useColor = this.animated && process.env.NO_COLOR === undefined;
  }
  private color(text: string, tone: Tone): string {
    if (!this.useColor) return text;
    const code = this.receipt ? String({ ink: 39, muted: 90, cyan: 36, green: 32, amber: 33, red: 31 }[tone]) : `38;5;${palette[tone]}`;
    return `\x1b[${code}m${text}\x1b[39m`;
  }
  start(): void {
    if (this.animated) {
      process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
      process.once('exit', this.exit); process.once('SIGINT', this.interrupt); process.once('SIGTERM', this.terminate);
      process.stdout.on('resize', this.resize);
    } else {
      console.log('\nK A D R A N  /  CONSOLE DE L’AGENT LOCAL');
      console.log(`Exécution réelle · ${cleanText(this.model)} · demande ${cleanText(this.messageId)}`);
      console.log('Objectif : lire une demande, vérifier le client et les produits, préparer un devis à valider.\n');
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), 200);
    this.timer.unref();
  }
  private draw(): void {
    if (this.closed) return;
    const state = inspectTrace(this.trace);
    if (!this.animated) {
      for (const action of state.actions.slice(this.printed)) console.log(`${action.time}  ${action.error ? '!' : '✓'}  [${action.origin === 'model' ? 'IA' : 'CONTRÔLE'}] ${actionLabel(action.tool)}\n          ${action.outcome}`);
      this.printed = state.actions.length;
      return;
    }
    const width = Math.max(32, Math.min(100, (process.stdout.columns || 90) - 1));
    const height = Math.max(10, process.stdout.rows || 28);
    const inner = width - 4;
    const lines: string[] = [];
    const row = (text: string, tone: Tone = 'ink') => lines.push(`${this.color('│', 'muted')} ${this.color(fit(text, inner), tone)} ${this.color('│', 'muted')}`);
    const rule = () => lines.push(this.color(`├${'─'.repeat(width - 2)}┤`, 'muted'));
    lines.push(this.color(`╭${'─'.repeat(width - 2)}╮`, 'cyan'));
    row('K A D R A N    /    CONSOLE DE L’AGENT LOCAL', 'cyan');
    row(`${this.model}  ·  ${duration((Date.now() - this.started) / 1000)} écoulées`, 'muted');
    row('Objectif : demande client → prix et stocks → devis à valider', 'muted');
    rule();
    row(['inbox', 'crm', 'catalog', 'quotes'].map((s, i) => `${state.connected.has(s) ? '●' : '○'} ${['MESSAGERIE', 'CLIENTS', 'CATALOGUE', 'DEVIS'][i]}`).join('   '), 'green');
    row(`${['◐', '◓', '◑', '◒'][this.frame++ % 4]} ${state.thinking ? 'L’IA CHOISIT LA PROCHAINE ACTION' : 'CONNEXION / ACTION EN COURS'}   ·   étape ${state.turn}/12   ·   ${state.calls} appels MCP`, 'amber');
    rule();
    row(`DEMANDE ${this.messageId}  ·  ${state.inquiry?.subject ?? 'En attente de la lecture de la demande'}`);
    row(`Client  ${state.customer?.company ?? state.inquiry?.sender ?? 'Pas encore recherché'}`, 'muted');
    rule();
    row('ACTIONS RÉELLEMENT EXÉCUTÉES  ·  IA : choix du modèle / CONTRÔLE : vérification', 'cyan');
    const activityCount = Math.max(1, Math.min(5, Math.floor((height - 24) / 2)));
    const recent = state.actions.slice(-activityCount);
    if (!recent.length) row('Découverte des services et de leurs outils…', 'muted');
    for (const action of recent) {
      row(`${action.error ? '!' : '✓'} [${action.origin === 'model' ? 'IA' : 'CONTRÔLE'}] ${actionLabel(action.tool)}`, action.error ? 'red' : 'ink');
      row(`    ${action.outcome}`, 'muted');
    }
    rule();
    row(state.quote ? 'DEVIS ENREGISTRÉ  /  EXÉCUTION ENCORE EN COURS' : 'DEVIS  /  EN ATTENTE D’UN RÉSULTAT VÉRIFIÉ', state.quote ? 'amber' : 'cyan');
    if (state.quote) {
      for (const item of state.quote.items.slice(0, 2)) row(`${item.quantity} × ${item.sku}  @ ${money(item.unitPriceCents)}  = ${money(item.quantity * item.unitPriceCents)}`);
      if (state.quote.items.length > 2) row(`+ ${state.quote.items.length - 2} autres lignes dans le rapport final`, 'muted');
      row(`TOTAL HT     ${money(state.quote.totalExVatCents)}`, 'green');
    } else {
      row('Les montants apparaissent après lecture du devis enregistré.', 'muted');
      row('Le service devis calcule les prix à partir du catalogue.', 'muted');
    }
    rule();
    row('Données fictives  ·  Validation humaine requise  ·  Aucun envoi réel', 'muted');
    lines.push(this.color(`╰${'─'.repeat(width - 2)}╯`, 'cyan'));
    // Never scroll the live frame in short terminals; the complete receipt is printed at the end.
    const frame = lines.slice(0, height - 1).join('\n');
    process.stdout.write(`\x1b[H\x1b[J${this.useColor ? '\x1b[48;5;234m' : ''}${frame}\x1b[0m`);
  }
  finish(result: AgentResult, existedBefore: boolean, artifacts: string): void {
    this.draw(); this.stop(); this.receipt = true;
    if (this.animated) process.stdout.write('\x1b[2J\x1b[H');
    const state = inspectTrace(this.trace);
    const quote = result.quote;
    const width = Math.max(40, Math.min(100, (process.stdout.columns || 100) - 1));
    const line = '─'.repeat(width);
    const print = (text = '', tone: Tone = 'ink') => console.log(this.color(cleanText(text), tone));
    print(line, 'cyan');
    print('K A D R A N    /    BILAN DE L’EXÉCUTION', 'cyan');
    print(`${statusLabel(result.status).toUpperCase()}  ·  ${result.steps} étapes du modèle  ·  ${duration((Date.now() - this.started) / 1000)} écoulées`, result.status === 'draft_prepared' ? 'green' : 'amber');
    print(`Demande ${this.messageId}  ·  ${state.customer?.company ?? state.inquiry?.sender ?? 'Client non identifié'}`);
    print(existedBefore ? 'Démonstration rejouée : ce devis existait déjà. Aucun doublon ni nouvelle vente.' : 'Aucun devis n’existait pour cette demande au démarrage.', 'muted');
    print(line, 'muted');
    if (quote) {
      print(`DEVIS ${quote.id}  /  ${statusLabel(quote.status).toUpperCase()}`, 'cyan');
      print('RÉFÉRENCE           QTÉ      PRIX UNITAIRE HT        TOTAL LIGNE HT', 'muted');
      for (const item of quote.items) {
        print(`${fit(item.sku, 18)}  ${String(item.quantity).padStart(3)}  ${money(item.unitPriceCents).padStart(17)}  ${money(item.quantity * item.unitPriceCents).padStart(19)}`);
        const product = state.products.get(item.sku); if (product) print(`  ${product.label}`, 'muted');
      }
      print(`TOTAL HORS TAXES : ${money(quote.totalExVatCents)}`, 'green');
      print('Brouillon à valider. Aucun calcul de TVA, paiement ou envoi externe.', 'amber');
    } else {
      print('AUCUN DEVIS CRÉÉ', 'amber'); print(reasonLabel(result.reason ?? result.summary));
    }
    print(line, 'muted');
    print('CE QUE L’IA A FAIT  /  ACTIONS ET RÉSULTATS OBSERVÉS', 'cyan');
    for (const [index, action] of state.actions.entries()) {
      print(`${String(index + 1).padStart(2, '0')}  [${action.origin === 'model' ? 'IA' : 'CONTRÔLE'}] ${actionLabel(action.tool)}  (${action.tool})`, action.error ? 'red' : 'ink');
      print(`    ${action.outcome}`, 'muted');
    }
    print('Les prix et le total proviennent du service devis, à partir du catalogue.', 'muted');
    print('IA = outil choisi par Mistral. CONTRÔLE = vérification automatique du programme.', 'muted');
    print(`Exécution ${this.trace.runId}`, 'muted');
    print(`Rapports détaillés : ${artifacts}/quote.md et ${artifacts}/activity.md`, 'cyan');
    print(line, 'cyan');
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.animated) {
      this.exit(); process.stdout.write('\n');
      process.off('exit', this.exit); process.off('SIGINT', this.interrupt); process.off('SIGTERM', this.terminate);
      process.stdout.off('resize', this.resize);
    }
  }
}
