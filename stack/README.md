# Edge stack

`compose.edge.yml` runs the three containers that make up the VPS edge:

| Service | Container | Role |
|---|---|---|
| `nginx` | `nginx_proxy` | TLS termination and reverse proxy for every site |
| `certbot` | `certbot` | Let's Encrypt issuance and a 12-hour renewal loop |
| `monitor` | `monitor` | Netdata host agent, reachable only via nginx at `/monitor/` |

Ported from `spa-api/docker-compose.sa.yml`.

## Setup

```sh
cp .env.example .env     # then fill in every CHANGEME
```

Every path in `.env` must be a **literal absolute path**.

`${HOME}` resolves from the environment of whichever process invokes docker compose.
From an interactive shell it works, which is what makes it dangerous: from cron or a
systemd unit, where `HOME` is usually unset, it expands to an empty string and produces
a path like `/spa-api/nginx/conf` with no error. A literal `~` is never expanded and is
treated as a relative path segment. Docker then compounds either mistake by creating a
missing bind-mount source as an empty directory rather than failing, so nginx starts and
serves nothing.

Check before starting:

```sh
set -a; . ./.env; set +a
ls -d "$NGINX_CONF_DIR" "$SNIPPETS_DIR" "$CERTS_ROOT/conf" "$CERTS_ROOT/www" "$NGINX_LOG_DIR"
docker compose --env-file .env -f compose.edge.yml config >/dev/null && echo OK
```

## Intended differences from `docker-compose.sa.yml`

Everything else is carried over unchanged, comments included.

1. **Bind-mount sources are env vars.** The original used paths relative to `~/spa-api`.
   Round one points them straight back there, so taking over the containers does not
   also move the certificates. One variable at a time.

2. **`certbot` gains `restart: unless-stopped`.** The original had no restart policy
   while `nginx` and `monitor` both did. The renewal loop therefore does not survive a
   host reboot or an OOM kill, and nothing reports it: the failure only surfaces weeks
   later when a certificate expires. This is a fix, not a port, and is recorded in
   `docs/parity-exceptions.md`. It changes no rendered nginx config.

3. **Log rotation on all three services** (`json-file`, 10 MB × 3). The original had
   none, so container logs grow without bound on a small VPS. `spa-web/compose.yaml`
   already does this; the values match it.

4. **`hostname` is `${MONITOR_HOSTNAME}`** instead of the hardcoded `balispacafe-vps`,
   so the stack is reusable on another host. Cosmetic, shows in the Netdata UI.

5. **Explicit `name: vps-edge`.** See below.

## Project name and Netdata's stored metrics

Compose prefixes volume names with the project name. The existing stack runs as project
`spa-api` (from its directory), so its volumes are `spa-api_netdataconfig`,
`spa-api_netdatalib`, `spa-api_netdatacache`. This stack declares `name: vps-edge`, so
it creates `vps-edge_*`.

Netdata's metrics database lives in `/var/lib/netdata`. **Starting this stack without
migrating volumes gives Netdata empty ones and loses all historical metrics.** Nothing
warns about it; the dashboard simply starts from zero.

Decide deliberately during phase 09. To carry the history over, with both stacks
stopped:

```sh
for v in netdataconfig netdatalib netdatacache; do
  # -v creates the destination volume if it does not exist.
  # cp -a preserves dotfiles, ownership and timestamps.
  docker run --rm \
    -v "spa-api_$v":/from -v "vps-edge_$v":/to \
    alpine sh -c 'cd /from && cp -a . /to'
done
```

Or accept the reset, which costs only retained history, not monitoring itself.

`name` is set explicitly rather than inherited from the directory so that volume names
do not silently change when the repo is checked out somewhere else.

## Container name collision

All three services set an explicit `container_name`. Docker refuses duplicate container
names regardless of project, so **this stack cannot run beside the spa-api one**. There
is no side-by-side trial, and no zero-downtime takeover without renaming the containers,
which would break every `docker exec nginx_proxy` reference including the ones still in
the unmigrated deploy scripts.

That is why cutover is split: config authorship moves first with zero downtime, and only
container ownership needs a window. See `docs/cutover.md`.

## Known gap

`monitor` runs with `pid: host`, `SYS_ADMIN`, `SYS_PTRACE` and unconfined AppArmor,
which is what Netdata needs for host metrics. Port 19999 is deliberately unpublished so
the dashboard never appears on the public IP, but `/monitor/` is served over HTTPS with
no authentication. Carried over unchanged. Tracked in `docs/known-issues.md`.
