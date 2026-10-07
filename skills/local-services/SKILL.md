---
name: local-services
description: Use when a task touches the local container services on this machine, such as starting or restarting Docker containers, managing stacks in Portainer, reading or rotating a secret in Infisical, or opening DbGate. Covers the Docker Engine, Portainer, Infisical, and DbGate.
---

# Local services

The machine runs container-backed services on the Docker Engine inside Ubuntu WSL2. `dev-setup-starter` owns their Compose files and their documentation. The container stack is the same on every machine, so its service list, addresses, and ports are general. This skill keeps the general Docker and Compose practice.

| Service | Job | Address |
| --- | --- | --- |
| Docker Engine | Container runtime | WSL only, no TCP port |
| Infisical | Secrets, the source of truth | `http://localhost:8088` |
| Portainer CE | Container and Compose stack management | `https://localhost:9443` |
| DbGate | Database manager | `http://localhost:3000` |

## Where commands run

Docker is installed only in WSL. Windows has no `docker` command, so every `docker` command runs in the Ubuntu shell. The UIs open in a Windows browser through the WSL2 localhost forward.

The ports publish on the WSL2 NAT network, which is not routable from the LAN, so the services stay local to this machine. Do not bind a published port to `127.0.0.1`, because the WSL2 localhost forward only reaches ports that listen on all interfaces.

## Docker

The four services are `infisical-backend`, `infisical-db`, `infisical-redis`, `portainer`, and `dbgate`.

| Need | Command |
| --- | --- |
| List running containers | `docker ps` |
| Read recent logs | `docker logs <container> --tail 50` |
| Restart one service | `docker restart <container>` |
| Open a shell in a container | `docker exec -it <container> sh` |
| Recreate a service from its Compose file | `docker compose -f services/<name>/docker-compose.yml up -d` |

The Compose files are under `dev-setup-starter/services/<name>/`. Infisical needs `ENCRYPTION_KEY` and `AUTH_SECRET` from its own gitignored `.env` before the first start, and it cannot decrypt its database without them.

After a Windows or WSL restart, the localhost forward can miss ports that Docker published during boot. If a service does not load at `localhost`, restart the containers so the forward picks them up.

```bash
docker restart infisical-backend portainer dbgate
```

## Portainer CE

`https://localhost:9443` manages the local environment and Compose stacks. Accept the self-signed certificate. Portainer keeps its state in the `portainer_data` volume.

On a new machine, the first run asks for a setup token:

```bash
docker logs portainer 2>&1 | grep setup_token
```

The token expires five minutes after the container starts, so read it and create the admin promptly. If it times out, `docker restart portainer` and read the fresh token.

## Infisical

Infisical is the source of truth for integration secrets. The UI is `http://localhost:8088`; the CLI is installed on both runtimes.

The CLI reads the machine identity from the environment for login, and `export` needs the token that login returns.

```bash
infisical login --method=universal-auth --plain --silent
infisical export --token "$TOKEN" --projectId "$INFISICAL_PROJECT_ID" --env dev --format json
```

The loaders do this for you. WSL loads the workspace `.envrc` through direnv; Windows runs `just import-secrets -Apply` in `dev-setup-starter`. See `dev-setup-starter/docs/secrets.md`.

Secrets are rotated in Infisical, then the loader is rerun and the runtime restarted. Never write a value into a repository.

## DbGate

`http://localhost:3000` views and edits databases. To inspect the Infisical PostgreSQL, attach DbGate to the Infisical network, then connect to host `db` on port `5432` with the credentials from `services/infisical/.env`.

```bash
docker network connect infisical_infisical dbgate
```

## Rules

- Run `docker` in the Ubuntu shell, never in Windows `cmd` or PowerShell.
- Reach the UIs through the Windows browser at `localhost`.
- Read secrets from Infisical through the loaders. Never write a value into a repository.
- Restart the runtime after a secret change so it inherits the new values.
