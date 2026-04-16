---
title: "Playwright MCP — T2: Docker infra (sidecar + orchestrator.yaml)"
status: todo
created: 2026-04-14
depends_on: []
agents_completed: []
agents_pending: [implementer]
---

## Objectif

Créer l'infrastructure Docker pour le sidecar `playwright-mcp` : image dérivée,
service Compose sous profile opt-in, réseau isolé, et section
`playwright_mcp` dans `orchestrator.yaml`.

**Parallélisable avec T1** — aucune dépendance mutuelle.

---

## Changements

### Nouveau fichier : `Dockerfile.playwright-mcp`

```dockerfile
# Dockerfile.playwright-mcp
# Image dérivée de l'image officielle Playwright Microsoft.
# Ne PAS modifier le tag v1.50.0 sans vérifier la compatibilité avec @playwright/mcp@0.0.70.
#
# Build : docker build -f Dockerfile.playwright-mcp -t harmoven-playwright-mcp:0.0.70 .
# Digest : docker inspect --format='{{index .RepoDigests 0}}' harmoven-playwright-mcp:0.0.70
# -> mettre le digest dans PLAYWRIGHT_MCP_DIGEST dans .env

FROM mcr.microsoft.com/playwright:v1.50.0

# Installer @playwright/mcp en version pinnée.
# --no-update-notifier : évite la vérification npm au démarrage (réseau inutile).
RUN npm install -g @playwright/mcp@0.0.70 --no-update-notifier

USER pwuser
```

### `docker-compose.yml`

Après le service `marketplace-cron`, ajouter :

```yaml
  playwright-mcp:
    # Image construite depuis Dockerfile.playwright-mcp (base officielle Microsoft Playwright v1.50.0
    # + @playwright/mcp@0.0.70 pré-installé).
    # Pinner le digest dans .env : PLAYWRIGHT_MCP_DIGEST=sha256:<digest>
    # Voir Dockerfile.playwright-mcp pour la procédure de build et d'inspection du digest.
    image: harmoven-playwright-mcp@${PLAYWRIGHT_MCP_DIGEST:-sha256:0000000000000000000000000000000000000000000000000000000000000000}
    command:
      - node
      - /usr/local/lib/node_modules/@playwright/mcp/cli.js
      - --port=3100
      - --host=0.0.0.0      # Bind toutes interfaces dans le container (pas juste ::1)
      - --headless
      - --isolated          # Profil browser en mémoire — ne persiste pas sur disque
      - --no-sandbox        # Requis sans SYS_ADMIN dans Docker — JAMAIS en dehors
    environment:
      - NODE_ENV=production
      # Aucun secret app, DB, LLM ne doit figurer ici.
    networks:
      - playwright_net      # Accès internet (browser en a besoin). PAS sur app_net.
    deploy:
      resources:
        limits:
          memory: 1g
          cpus: "0.5"
    shm_size: 256m          # Chrome crash sans /dev/shm suffisant (défaut 64 MB)
    restart: unless-stopped
    healthcheck:
      # Pas de endpoint /health — TCP check uniquement.
      test: ["CMD-SHELL", "node -e \"require('net').createConnection(3100,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\""]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    profiles:
      - playwright-mcp      # opt-in : docker compose --profile playwright-mcp up
```

Dans le service `app`, ajouter `playwright_net` à `networks` :

```yaml
    networks:
      - app_net
      - litellm_net
      - playwright_net    # ← ajouter
```

Dans la section `networks` en bas du fichier, ajouter :

```yaml
  playwright_net:
    driver: bridge
    # NOT internal — le browser a besoin d'accès internet.
    # playwright-mcp n'est pas sur app_net → ne peut pas joindre db:5432.
```

### `orchestrator.yaml`

Ajouter la section après la dernière clé existante :

```yaml
playwright_mcp:
  enabled: false          # Passer à true + fournir PLAYWRIGHT_MCP_DIGEST dans .env
  max_nav_per_node: 10    # Limite d'appels browser par nœud WRITER
  # Pour activer :
  #   1. docker build -f Dockerfile.playwright-mcp -t harmoven-playwright-mcp:0.0.70 .
  #   2. docker inspect ... → copier le digest dans .env PLAYWRIGHT_MCP_DIGEST
  #   3. Mettre enabled: true ici
  #   4. docker compose --profile playwright-mcp up -d
```

---

## Points d'attention

- `--host=0.0.0.0` est **obligatoire** : sans ce flag, `@playwright/mcp` bind sur `::1`
  (IPv6 loopback uniquement) et n'est pas joignable depuis le container `app`.
  Vérifié par test live le 2026-04-14.
- `shm_size: 256m` est valide en Docker Compose v2.35.x. Testé : résout en `268435456`.
- Le `deploy.resources` fonctionne en mode standalone (pas Swarm). En Swarm, utiliser `mem_limit` + `cpus` au niveau service.
- La section `profiles:` rend le service invisible à `docker compose up` sans `--profile playwright-mcp`.
  Le service `app` peut toujours démarrer sans le sidecar — T4 gère la tolérance de panne.

---

## Critères d'acceptation

- [ ] `Dockerfile.playwright-mcp` présent à la racine du projet
- [ ] `docker compose --profile playwright-mcp config` ne retourne aucune erreur YAML
- [ ] `docker compose config` (sans profile) ne démarre pas `playwright-mcp` — le service est absent
- [ ] Le réseau `playwright_net` est déclaré dans `docker-compose.yml`
- [ ] `orchestrator.yaml` contient la section `playwright_mcp` avec `enabled: false`
- [ ] Le service `app` a `playwright_net` dans ses `networks`
