import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResult } from './agent.js';
import type { Trace } from './trace.js';
import { cleanText, inspectTrace, money, statusLabel, reasonLabel, actionLabel } from './terminal.js';

const md = (value: unknown) => cleanText(value).replace(/[\\`*_{}\[\]()<>|]/g, '\\$&');
export function writeRunReports(directory: string, trace: Trace, result: AgentResult, existedBefore: boolean): void {
  const state = inspectTrace(trace);
  const quote = result.quote;
  const quoteLines = [
    `# ${quote ? `Devis ${md(quote.id)}` : 'Aucun devis créé'}`, '',
    '**Données fictives de démonstration · Aucun envoi externe ni paiement**', '',
    `- Exécution : ${md(trace.runId)}`,
    `- Demande : ${md(result.messageId)}`,
    `- Client : ${md(state.customer?.company ?? state.inquiry?.sender ?? 'Non identifié')}`,
    `- Résultat : ${md(statusLabel(result.status))}`,
    `- Devis déjà présent au démarrage : ${existedBefore ? 'oui — démonstration rejouée, aucune nouvelle vente' : 'non'}`,
    '',
  ];
  if (quote) {
    quoteLines.push(`Statut du devis : **${md(statusLabel(quote.status))}**`, '',
      '| Produit | Référence | Quantité | Prix unitaire HT | Total HT |',
      '|---|---|---:|---:|---:|');
    for (const item of quote.items) quoteLines.push(`| ${md(state.products.get(item.sku)?.label ?? item.sku)} | ${md(item.sku)} | ${item.quantity} | ${money(item.unitPriceCents)} | ${money(item.quantity * item.unitPriceCents)} |`);
    quoteLines.push('', `## Total hors taxes : ${money(quote.totalExVatCents)}`, '',
      'Les montants et le statut sont lus dans le service devis. Cette démonstration ne calcule ni TVA ni total TTC.',
      'Ce document est un brouillon de devis. La validation humaine est une action distincte du travail de l’agent.');
  } else quoteLines.push(`Motif de vérification : ${md(reasonLabel(result.reason ?? result.summary))}`);
  const activity = [
    '# Journal des actions', '', `Exécution : ${md(trace.runId)}`, '',
    `Résultat : **${md(statusLabel(result.status))}** · ${result.steps} étapes du modèle.`, '',
    'IA : outil choisi par le modèle. CONTRÔLE : vérification automatique du programme. Ce journal décrit les actions et leurs résultats observables, sans prétendre exposer le raisonnement interne du modèle.', '',
  ];
  for (const [index, action] of state.actions.entries()) {
    activity.push(`## ${index + 1}. ${action.origin === 'model' ? 'IA' : 'CONTRÔLE'} — ${md(actionLabel(action.tool))} (${md(action.tool)})`, '',
      `Heure (UTC) : ${action.time} · ${action.error ? 'Erreur du service' : 'Réponse du service reçue'}`, '',
      'Paramètres transmis :', '', `    ${JSON.stringify(action.input)}`, '', `Résultat observé : ${md(action.outcome)}`, '');
  }
  if (result.reason) activity.push(`Motif final de vérification : ${md(reasonLabel(result.reason))}`, '');
  activity.push('La trace JSONL contient les événements structurés complets. La réussite d’un appel d’outil ne suffit pas à prouver la réussite de toute la demande.');
  writeFileSync(join(directory, 'quote.md'), quoteLines.join('\n') + '\n');
  writeFileSync(join(directory, 'activity.md'), activity.join('\n') + '\n');
}
