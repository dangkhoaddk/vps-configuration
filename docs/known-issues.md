# Known issues

Problems found while extracting the edge, with current status. Nothing here
disappears quietly; when something is fixed it moves rather than vanishes.

## Open at a glance

| # | Issue | Fix |
|---|---|---|
| 0 | Routine applies don't appear in this repo's history | Revisit cross-repo dispatch via a GitHub App, if audit trail becomes priority |
| 1 | Certificates live inside `spa-api`'s checkout | Move to a named docker volume or a path this repo owns |
| 2 | `/monitor/` is unauthenticated | HTTP basic auth or IP allowlist in `templates/snippets/monitor.conf` |
| 3 | `SSH_KEY` stored in `vars`, not `secrets`, in two app repos | Move to `secrets`, update workflow refs, rotate the key |
| 4 | Port-80 ACME block omits admin's domains | Include every app in `acme.httpServerNameApps` |
| 6 | Dead nginx config in spa-web | Delete `spa-web/deploy/nginx/bali-spa.conf` |
| 7 | Cutover blocked on a live baseline capture | Capture `docker exec nginx_proxy nginx -T` from the VPS, resolve any diff |

## Open

### 0. Routine applies do not appear in this repo's history

App pipelines call `vpsctl apply` over their own SSH session, so those runs show
up in the calling app's Actions log, not here. This repo's `deploy.yml` only
fires on changes to its own files.

The trade was deliberate: a cross-repo trigger would have needed a token in all
three app repos with enough scope to push to this one, which is a larger blast
radius than an SSH key that can only run already-reviewed code. But it means
"did anything change routing today" spans four repositories.

`./bin/vpsctl diff --live` on the VPS answers it directly, which is the check
worth having in the periodic list.

*Fix:* if the audit trail becomes the priority, revisit the cross-repo dispatch
with a GitHub App rather than a personal access token.

### 1. Certificates live inside an application repository

`CERTS_ROOT` points at `~/spa-api/certbot`. Let's Encrypt state for **every**
domain sits inside one app's checkout. Deleting or re-provisioning that directory
destroys the certificates for all sites.

Deliberate round-one debt: keeping the path fixed means taking over the containers
does not also move the certificates, so only one variable changes at a time.

*Fix:* move to a named docker volume or a path this repo owns. Back up first, and
copy the backup off the host.

### 2. `/monitor/` is unauthenticated

The Netdata dashboard is served over HTTPS on `balispacafe.com/monitor/` and
`api.balispacafe.com/monitor/` with no authentication. Port 19999 is deliberately
unpublished, so it is not on the public IP, but the reverse proxy exposes it to
anyone who knows the path.

The container runs with `pid: host`, `SYS_ADMIN`, `SYS_PTRACE` and a read-only
mount of `/`, so what it exposes is host processes, container names, disk layout
and network activity.

*Fix:* HTTP basic auth or an IP allowlist in `templates/snippets/monitor.conf`.
Both are a few lines and a baseline update.

### 3. `SSH_KEY` is stored in `vars`, not `secrets`

In `spa-api` and `spa-admin`'s workflows, the deploy key is read from
`vars.SSH_KEY`. GitHub variables are not secrets: they are visible in the UI and
printed in logs. `spa-web` uses `secrets.SSH_KEY` correctly.

This repo's own workflow uses `secrets` throughout. The app repos still need
fixing, which is a change in those repos, not this one.

*Fix:* move the value to `secrets`, update the three workflow references, rotate
the key, since it should be assumed exposed.

### 4. The port-80 ACME block omits admin's domains

Admin's certificate renewal works only because that block is the sole `listen 80`
server and so becomes nginx's default. Another app adding a port-80 block ahead of
it would silently break renewal.

Reproduced faithfully for parity. See
[parity-exceptions.md](parity-exceptions.md).

*Fix:* include every app's domains in `acme.httpServerNameApps`.

### 6. Dead nginx config in spa-web

`spa-web/deploy/nginx/bali-spa.conf` is an orphaned port-80 template proxying to
`127.0.0.1:3000`. Nothing references it, and it contradicts the real config, so
anyone reading it to understand the setup is misled.

Flagged rather than deleted: it is in another repository and outside this round's
scope.

*Fix:* delete the file.

### 7. Cutover is blocked on a live baseline capture

The parity gate currently runs against config reconstructed from the three deploy
scripts, not from the running server. Two known reasons the two might differ are
recorded in `baseline/README.md`.

*Fix:* capture `docker exec nginx_proxy nginx -T` from the VPS, commit it, and
resolve any difference before cutover. Live wins.

## Fixed

### `booking_limit` was a dead rate-limit zone

Declared in `upstreams.conf`, referenced by no `limit_req` directive, reserving
10 MB of shared memory for a rate limit that never applied. Carried through round
one for parity, then removed with a baseline update in the same commit.

`global_limit`, which `api` actually uses, is untouched.

### Concurrent deploys raced on nginx config

Three pipelines wrote into one config directory and force-recreated nginx with
nothing serialising them. `vpsctl` now takes a filesystem lock before mutating
anything, covering app pipelines and manual runs alike. Verified by four
concurrent processes taking the lock 160 times with no overlap.

Two things it deliberately does not cover:

- An app repo still writing config with its own deploy script never takes the
  lock. Keep the migration window short.
- `apply --dry-run` does not take it either, since it writes nothing. Its report
  can therefore reflect a half-applied state if a real apply is running.

### The upstream-resolution rule was folklore

nginx resolving upstreams at config-load time, and what that does to a config
referencing an absent container, existed only as comments inside bash heredocs and
three separate ad-hoc workarounds. Now one guard in `vpsctl` and a section in
[architecture.md](architecture.md).

### certbot had no restart policy

The renewal loop did not survive a reboot or an OOM kill, and would have surfaced
only as an expired certificate weeks later. `compose.edge.yml` sets
`restart: unless-stopped`.

### A stopped monitoring container would have taken down every site

The `netdata` upstream was rendered unconditionally, and nginx refuses to start
when an upstream does not resolve. `vpsctl` now omits it and the `/monitor/`
snippet when the container is absent, so the dashboard degrades and the sites keep
serving.

### Backticks inside the deploy heredocs executed on the host

`spa-api/tool/deploy.sh` contained `` `nginx -s reload` `` inside an unquoted
heredoc, so bash ran it on the VPS during every deploy and substituted the output
into the config file. Harmless here, since it landed in a comment and `nginx` is
not on the host's PATH, but any backtick in those heredocs ran as the deploy user.

Fixed by construction: templates are data, not shell.

### Container logs grew unbounded

No log rotation on any edge service. All three now cap at 10 MB × 3.
