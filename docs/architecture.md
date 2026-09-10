# Décisions d'architecture

## Frontières réelles

Quatre instances du SDK MCP officiel exposent des outils sur Streamable HTTP. Le transport sans session crée une instance serveur par requête et utilise la compatibilité HTTP du SDK v2. Les tests et les clients n'appellent pas directement les fonctions métier des autres services. La version de SDK ne signifie pas que toutes les fonctionnalités de la spécification MCP sont implémentées par ce projet.

Les services métier sont accessibles uniquement sur un réseau Docker interne. Les conteneurs applicatifs sont non root, sans capacités Linux, sans élévation de privilèges et avec un système de fichiers en lecture seule. Seul le service de devis monte sa base SQLite. Les autres services servent des jeux de données immuables.

Le service Ollama a également un réseau sortant pour télécharger les poids, mais aucun port publié. Le mode natif est une exception explicite à l'isolement réseau de l'agent. Les garde-fous Host et Origin limitent les appels provenant d'un navigateur ; ils ne remplacent pas une authentification.

## Modèle et orchestration

L'adaptateur Ollama utilise `/api/chat` avec `format` JSON Schema. Il construit les alternatives de décision à partir des outils découverts sur MCP : un nom d'outil et des arguments, ou une décision de fin avec résumé. La grammaire contraint la forme, pas l'ordre des étapes ni la justesse des choix. Les schémas sont également donnés au modèle et les résultats des outils sont réinjectés dans la conversation. Il ne contient pas de routeur métier qui choisirait les outils à la place de Mistral. Le pilote `workflow.ts` est distinct et sert aux tests reproductibles.

Ce choix répond à un échec observé : lors du premier essai en appels d'outils natifs, Mistral 7B a renvoyé une explication de procédure sans effectuer d'appel. Le format JSON contraint est donc l'interface d'exécution retenue pour ce petit modèle. Voir la [documentation officielle Ollama](https://docs.ollama.com/capabilities/structured-outputs).

Les limites sont 12 tours, 24 appels d'outils, 768 tokens générés par tour et 240 secondes par requête de modèle. Ce plafond peut être long sur CPU : la limite d'étapes évite une boucle infinie, elle n'est pas un SLA. Aucune réussite ne se déduit du seul texte de réponse : la CLI relit le devis persistant. Un résultat absent reste à examiner, même si le modèle affirme avoir terminé.

Le texte libre est conservé pour démontrer une entrée non fiable. Les lignes demandées proviennent d'un formulaire structuré. Cette version ne revendique pas l'extraction fiable de lignes depuis un email arbitraire, un PDF ou une pièce jointe.

## Autorité et effets

Le service de devis revérifie le demandeur auprès de l'inbox, le client auprès du CRM et les prix/stock auprès du catalogue via MCP. Le modèle fournit uniquement des identifiants et des quantités. Le serveur exige une correspondance exacte avec le formulaire. Des champs supplémentaires tels que `approved` ou `totalExVatCents` sont rejetés par les schémas stricts.

La clé d'idempotence est l'identifiant du message. Une empreinte SHA-256 du contenu normalisé permet de distinguer une répétition d'une requête contradictoire. L'unicité SQLite et un insert atomique empêchent les doublons concurrents. La transaction est courte ; les consultations MCP se font avant l'écriture. Une réponse perdue après commit peut être rejouée sans créer un second devis.

Les devis sont des instantanés. Un rejeu renvoie l'instantané existant même si le catalogue a changé. Une nouvelle version métier nécessiterait un identifiant de révision explicite. Le stock n'est ni réservé ni décrémenté. Un devis approuvé conserve son approbation lors des rejeux.

## Résilience et traçabilité

Le client réessaie les erreurs de transport et `SERVICE_UNAVAILABLE` trois fois au maximum, avec attente exponentielle courte. Seuls les outils de lecture et l'écriture idempotente déclarée sont éligibles. Les erreurs métier et de schéma ne sont pas réessayées. Les appels internes du service de devis utilisent aussi ce client ; les délais peuvent donc se cumuler en cas de panne.

Les traces JSONL contiennent runId, séquence, horodatage, arguments, réponses, durée des outils, tentatives, métadonnées d'inférence et résultat du modèle. Elles sont adaptées aux données fictives, non expurgées et modifiables localement : elles ne constituent pas un audit inviolable. Pour des données réelles, prévoir minimisation, masquage, rétention et stockage d'audit appropriés.

## Limites pour un déploiement réel

L'absence d'authentification est acceptable ici car aucun service n'est publié et toutes les données sont fictives. Il faudrait des identités de service, OAuth/scopes selon les connecteurs, séparation des tenants, gestion de secrets et contrôles d'accès avant un raccordement réel. L'opérateur qui a accès à Docker est administrateur du démonstrateur, pas un utilisateur métier authentifié.

Il faudrait aussi des entrées versionnées, une file avec verrouillage de jobs, une interface de revue, une stratégie de rétention, des tests de charge et un jeu d'évaluation LLM plus large. Le mode worker est un consommateur unique avec checkpoints atomiques, pas un système distribué. SQLite et `node:sqlite` conviennent à cette portée de démonstration ; leur emploi ici ne prouve pas une capacité de montée en charge.
