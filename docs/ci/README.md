# Configuration GitHub Actions prête à activer

`verify.yml` exécute les tests Docker puis le parcours sur quatre conteneurs et conserve les résultats comme artifact. Il ne télécharge pas de modèle et ne prétend pas évaluer Mistral.

Cette configuration est fournie ici mais **n'est pas active sur GitHub** : lors de la publication initiale, la connexion OAuth disponible disposait du droit de publier le dépôt, mais pas du scope `workflow`. Les preuves du dossier `evidence/` sont donc des résultats locaux, pas des résultats de CI hébergée.

Une fois un accès GitHub autorisé à gérer les workflows disponible :

```sh
mkdir -p .github/workflows
cp docs/ci/verify.yml .github/workflows/verify.yml
git add .github/workflows/verify.yml
git commit -m "Enable Docker verification on GitHub Actions"
git push
```

Vérifier le premier run dans l'onglet Actions avant d'ajouter un badge de réussite.
