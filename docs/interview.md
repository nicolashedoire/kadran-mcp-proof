# Démonstration de cinq minutes

1. **Partir du problème PME.** Une demande arrive, les informations sont dispersées, un collaborateur doit vérifier le client, les références et les prix avant de préparer le devis.
2. **Montrer les services.** `docker compose ps` montre quatre frontières métier ; ouvrir les schémas MCP dans `src/server.ts`.
3. **Lancer l'agent local.** Montrer les événements `llm.response` et `mcp.call` puis le devis persistant. Préciser le modèle, le matériel et la durée réellement observés.
4. **Faire échouer une entrée.** Le client inconnu ou la quantité absente laisse le dossier en revue. Le prix n'est jamais une valeur libre décidée par le modèle.
5. **Rejouer le cas et examiner les tests.** Expliquer l'unicité SQLite, la réponse perdue après commit et le test de reprise. Terminer par les limites et les prochaines étapes pour raccorder un service réel.

## Formulation possible dans la candidature

« J'ai construit un démonstrateur public d'agent local pour PME : Mistral via Ollama, quatre services MCP en Docker, préparation de devis, contrôles métier côté serveur et reprise idempotente. Le dépôt fournit le code, les tests et des traces d'exécution examinables. »

Adapter cette phrase aux résultats présents dans `evidence/README.md`. Ne pas annoncer un taux de succès ou un gain financier sans mesure. Ce projet permet au recruteur d'évaluer du code et au candidat d'expliquer ses décisions ; il ne garantit pas une embauche.

## Points à maîtriser

- Pourquoi MCP est ici une frontière d'intégration, et pourquoi il ne choisit pas les outils à la place du modèle.
- Différence entre le pilote de tests déterministe et la boucle de décision Mistral.
- Pourquoi le service métier recalcule le prix et revérifie le client.
- Pourquoi une instruction hostile peut tromper un modèle sans donner accès à une capacité absente.
- Ce que garantit l'idempotence et ce qu'elle ne garantit pas : pas de doublon par message, pas de réservation de stock ni de traitement exactement une fois distribué.
- Limites de CPU Docker sur Mac et intérêt de Metal en mode natif.
- Ce qui manque pour connecter une vraie PME : authentification, adaptateurs réels, file robuste, revue utilisateur et évaluation plus large.
