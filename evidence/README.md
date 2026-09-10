# Preuves examinables · 10 septembre 2026

Ces fichiers proviennent d'exécutions locales sur données fictives. Ils peuvent être reproduits avec les commandes du README ; ce ne sont pas des certifications ou des attestations externes. Les tests hébergés GitHub Actions ne sont pas encore activés.

| Vérification | Résultat | Preuve |
|---|---|---|
| Tests d'intégration dans Docker | 18 réussis, aucun ignoré | [Sortie des tests](docker-tests.txt) |
| Pilote déterministe sur quatre conteneurs | Cinq cas métier et un rejeu vérifiés | [Résultats](deterministic.json) |
| Agent Mistral local, format JSON contraint | 7 tours, devis de 636 € HT confirmé, en attente de validation | [Résultat](local-llm-result.json), [trace complète](local-llm-trace.jsonl) |
| Worker autonome, cinq demandes | Un devis repris, trois revues motivées, un arrêt sur budget | [État final](worker-state.json), [trace des cas](worker-cases-trace.jsonl) |
| Redémarrage du worker | Checkpoints identiques, aucune nouvelle requête LLM, un devis et zéro approbation en base | [Contrôle de reprise](worker-restart-check.json) |

## Résultats du worker

| Cas | Résultat observé | Interprétation |
|---|---|---|
| `m-100` : demande complète | Reprise du devis de 636 € HT déjà produit par le modèle | Le worker ne repaye pas l'inférence d'un résultat persistant |
| `m-101` : client inconnu | `UNKNOWN_CUSTOMER`, 2 tours après ajout de la règle de fin | Le CRM retourne null ; arrêt pour revue humaine |
| `m-102` : quantité absente | `MISSING_QUANTITY`, 1 tour | Aucune quantité inventée, aucun devis |
| `m-103` : texte hostile | `budget_exhausted`, 12 tours, aucun devis | **Échec du modèle à terminer ce cas**, contenu par le budget ; ce n'est pas un succès de préparation |
| `m-104` : stock insuffisant | `INSUFFICIENT_STOCK`, 3 tours | Le catalogue permet de détecter le blocage, sans écriture |

Le [premier état du worker](worker-initial-evaluation.json) conserve aussi l'échec initial sur le client inconnu. Mistral répétait ses recherches jusqu'au budget. Après ajout d'un contrôle de fin fondé sur la réponse CRM, ce seul cas fictif a été remis en file par l'opérateur pour validation ; la [trace du rejeu](worker-unknown-customer-recheck.jsonl) montre l'arrêt en deux tours. Les autres résultats ont été conservés. Un redémarrage supplémentaire a vérifié qu'aucune inférence n'était relancée pour les cinq dossiers terminés.

L'état final est donc le résultat d'une évaluation et d'un rejeu ciblé après correction, **pas cinq succès autonomes au premier essai**. En particulier, Mistral 7B reste limité sur le cas hostile. Le workflow déterministe réussit ce même cas, ce qui distingue la fiabilité des règles métier de celle des décisions du modèle.

## Exécution réelle du modèle

Matériel : Mac Apple Silicon, 24 Go de RAM. Ollama 0.34.0 dans Docker Desktop, **inférence CPU**, contexte de 8192 tokens. Modèle `mistral:7b-instruct-v0.3-q4_K_M`, identifiant Ollama `6577803aa9a0`, environ 4,4 Go de poids. Les images de conteneur sont épinglées par digest dans les fichiers de configuration.

L'exécution complète a duré **194,5 secondes** et contient les décisions du modèle puis les vrais appels HTTP MCP. Le runId est `c1255a32-d095-4c6c-9eae-b1fec9ccc43b`. C'est une observation sur cette machine, sans garantie de latence et sans estimation de débit en production.

Le devis existait au début de ce run : c'est un **rejeu après interruption**. La [trace précédente](local-llm-interrupted.jsonl), runId `6fd69541-075d-4502-8b18-177ed0f002a0`, montre un devis absent au départ puis l'appel `quotes__prepare` choisi par Mistral et l'écriture réussie à 10:02:27 UTC. Docker a ensuite été arrêté par un manque d'espace lors d'un essai de copie des poids pour le mode natif. La copie incomplète a été retirée et Docker relancé. Le rejeu complet a conservé le même identifiant de devis et les mêmes montants.

Le prix et le statut du résultat proviennent du service de devis, pas du texte final du modèle. Les outils n'offrent ni approbation ni envoi. Aucune clé API, connexion à une messagerie réelle ou donnée client réelle n'a été utilisée.

## Échec conservé et choix technique

Le [premier essai avec l'interface d'appels d'outils native](native-tool-calling-failure.json) a produit une description de procédure, sans appel ni devis. Le contrôle de sortie l'a classé en revue humaine. Ce résultat porte sur ce modèle, ce template et ce prompt ; il ne prouve pas que Mistral serait incapable d'appeler des outils avec toute autre configuration.

L'adaptateur retenu utilise donc les sorties JSON contraintes d'Ollama. Le schéma des actions est construit à partir des contrats MCP découverts au démarrage. Mistral choisit toujours l'action, les identifiants et les arguments. Le format contraint ne garantit pas la pertinence de ses décisions ; les règles métier restent exécutées par le serveur.

## Portée

Les traces exposent les arguments, résultats et métadonnées d'inférence, pas une chaîne de pensée privée. Les demandes et l'injection hostile sont des fixtures. Les tests de boucle d'agent utilisent aussi des réponses de modèle simulées, distinctes de ces exécutions Mistral réelles. Les résultats ne constituent ni un benchmark général du modèle, ni une preuve d'immunité aux injections, ni une certification de fonctionnement en production.

L'override pour Ollama natif est fourni et sa configuration Compose est validée ; l'inférence GPU native n'a pas été testée de bout en bout dans cet environnement.
