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
| 6 | Dead nginx config in spa-web | Delete `spa-web/deploy/nginx/bali-spa.conf` |
| 8 | `stack/.env.example` shipped paths that do not exist on the host | Fixed in the example; the VPS `.env` still needs correcting before any apply |
| 9 | App pipelines 403 pulling the vpsctl image and run a cached one | Grant each app repo read access to the package, or make it public |

## Open

### 0. Routine applies do not appear in this repo's history

App pipelines call `vpsctl apply` over their own SSH session, so those runs show
up in the calling app's Actions log, not here. This repo's `deploy.yml` fires on
its own pushes to `main`, not on theirs.

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

### 6. Dead nginx config in spa-web

`spa-web/deploy/nginx/bali-spa.conf` is an orphaned port-80 template proxying to
`127.0.0.1:3000`. Nothing references it, and it contradicts the real config, so
anyone reading it to understand the setup is misled.

Flagged rather than deleted: it is in another repository and outside this round's
scope.

*Fix:* delete the file.

### 8. `stack/.env.example` pointed at paths that do not exist

The example shipped `/home/deploy/spa-api/...`. There is no `deploy` user on the
host, and `nginx_proxy` mounts `/root/spa-api/...`.

That would be a typo, except `bin/vpsctl` creates `stack/.env` from the example
when it is missing. The VPS checkout therefore already had the wrong paths, and
an earlier run wrote a full set of rendered config into
`/home/deploy/spa-api/nginx/conf`, a directory nothing reads. `CERTS_ROOT` there
does not exist at all, so a `vpsctl up` would have had docker create it empty and
brought nginx up with no certificates — the failure `stack/README.md` warns about,
already latent on the host.

The example is fixed. Two things remain:

*Fix:* correct `stack/.env` on the VPS before any apply, and delete the stray
`/home/deploy` tree once it is confirmed unreferenced. Consider whether
auto-creating `.env` from an example of absolute paths is worth its convenience,
given the failure is silent.

### 9. App pipelines cannot pull the vpsctl image

Every app deploy that calls `vpsctl` fails to pull the image:

```
failed to resolve reference "ghcr.io/dangkhoaddk/vps-configuration:latest":
  403 Forbidden
```

Each app's workflow logs in to GHCR with **its own repository's**
`GITHUB_TOKEN`. That token can read that repository's packages, not this one's.
Adding the `docker login` step made the app's own image pull work and left this
one failing, which is why it was not obvious.

Until this is fixed, the VPS runs whatever `vpsctl` image is already cached. It
happens to match `main` today, so applies are correct. The moment `src/` changes,
app deploys will run stale code against current `apps.yml` and report success.
A stale renderer producing config that no longer matches the registry is the
precise failure this repo exists to prevent.

`bin/vpsctl` no longer hides it: a failed pull with a cached image warns loudly
with the cached image's build date, and a failed pull with no cached image exits
non-zero. That is containment, not a fix. The pull still fails every time.

*Fix:* grant each app repository read access to the `vps-configuration` package,
or make the package public. Both are in the package's settings on GitHub, and
neither is a code change. Afterwards, confirm an app deploy log no longer
contains `403 Forbidden`.

## Fixed

### The edge deploy raced the image build

`deploy.yml` and `ci.yml` both triggered on `push` to `main`, as separate
workflows with no ordering between them, so the deploy raced the image build and
usually won. On 2026-09-25 the deploy finished at 07:45:01 and `build-and-push`
did not publish until 07:45:30: the VPS pulled 29 seconds before the new image
existed and then ran a `vpsctl` older than the commit being deployed. Both
workflows reported success, because neither was wrong about its own work.

Caught only by checking the image contents on the host rather than trusting two
green checkmarks, which is not a control.

`deploy.yml` now triggers on `workflow_run` of CI completing. That is the only
way to order two workflows: `needs` works within one, not across them. CI's last
job pushes the image, so waiting for CI is waiting for the image. The job guards
on `event == 'push'`, `head_branch == 'main'` and `conclusion == 'success'`, so
a passing PR check never reaches production.

The `paths` filter went with it. It listed `apps.yml`, `templates/`, `src/` and
the compose file, which silently excluded `bin/vpsctl` — the script every deploy
runs — so a change to it never triggered a deploy. Applying on every successful
CI run costs one no-op render for a docs-only push and removes a list that is
wrong whenever someone forgets to update it.

### A no-op apply left nginx proxying to a destroyed container

Caused a production outage on 2026-09-25: a web deploy recreated its container,
`apply --app web` rendered byte-identical config, printed
`no changes; nginx not reloaded`, and `balispacafe.com` served 502 for about
eight minutes. nginx was still holding the old container's address, because it
resolves upstream hostnames at config-load time.

The upstream-resolution rule was already documented and already guarded in the
*render* path. It was not carried through to the *reload* path, where a config
diff of zero is not the same as nothing having changed.

`apply --app <name>` now reloads even on a no-op, since that flag means the
named app's container has just been started or recreated. Covered by
`tests/plan-reload.spec.ts` and explained in
[architecture.md](architecture.md).

### Cutover was blocked on a live baseline capture

`docker exec nginx_proxy nginx -T` is captured and committed to
`baseline/nginx-T.baseline.conf`, and the parity gate now runs against it.

It earned its keep immediately: `admin-ssl.conf` served `spa-admin:5001` while
`apps.yml` declared `3000`. The deploy-script baseline agreed with `apps.yml`, so
only the live capture could have found it, and rendering would have 502'd the
admin site on the first apply.

The three deliberate divergences are applied on top of the unedited capture in
`tests/accepted-divergences.ts` rather than edited into it, so the file stays
evidence rather than an artifact of making tests pass.

### The port-80 ACME block omitted admin's domains

Admin's renewal worked only because that block is the sole `listen 80` server and
so becomes nginx's default. A second port-80 block added ahead of it would have
broken renewal silently, surfacing weeks later as an expired certificate.

`acme.httpServerNameApps` now lists every app. Behaviourally a no-op the day it
landed, which is what made it safe to change.

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
