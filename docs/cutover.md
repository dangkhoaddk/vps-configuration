# Cutover

Migrating from three deploy scripts writing nginx config to this repo owning it.

Two independent moves, in this order. Fusing them would put a zero-risk change
behind a downtime window.

| | What moves | Downtime | Reversible | Jump to |
|---|---|---|---|---|
| **A** | Who writes the config | none | per app, instantly | [A. Config authorship](#a-config-authorship) |
| **B** | Who owns the containers | ~30s, all sites | yes, two commands | [B. Container ownership](#b-container-ownership) |

## The baseline is captured

`baseline/nginx-T.baseline.conf` holds what the running proxy actually loaded,
and the parity gate runs against it. It found one real drift, admin's upstream
port, now fixed in `apps.yml`. See `baseline/README.md`.

## Before any apply: check `stack/.env` on the VPS

`bin/vpsctl` creates `stack/.env` from `stack/.env.example` when it is missing, so
a checkout always has *a* `.env` — not necessarily a correct one. The paths there
decide which directory `apply` writes into, and a wrong one fails silently: the
render succeeds, nginx never sees it, and the deploy reports success.

```sh
set -a; . stack/.env; set +a
ls -d "$NGINX_CONF_DIR" "$SNIPPETS_DIR" "$CERTS_ROOT"
docker inspect nginx_proxy --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

`NGINX_CONF_DIR`, `SNIPPETS_DIR` and `CERTS_ROOT` must match what nginx mounts.
If they do not, nothing below is doing what it appears to.

---

## A. Config authorship

Zero downtime. No container is created, destroyed or restarted; `vpsctl` writes
into the same directory the scripts do and reloads the same running nginx.

Order: **admin, then web, then api.** Admin is lowest-traffic and simplest. Api
goes last because it owns the shared files (`http.conf`, `upstreams.conf`, the
monitor snippet), and until it migrates, an api deploy keeps rewriting those
underneath the migrated apps. Parity makes that safe, but the window is not fully
closed until api moves.

### What `--app` does, and does not do

`apply --app <name>` renders and writes **every** file, not just that app's. All
apps share one config directory, so rendering a subset would leave the others'
files to be pruned and silently drop their routing. The flag only decides whose
absence is fatal: the named app must resolve, or the command fails rather than
reporting a deploy that changed no routing.

Two consequences for what follows:

- The **first** apply, whichever app triggers it, converts the whole directory.
  The per-app order below still limits which pipeline runs first, but it does not
  stage the config change app by app.
- That first apply is therefore **not** a no-op. It writes the three deliberate
  divergences in [parity-exceptions.md](parity-exceptions.md): admin's domains
  into `http.conf`, and `booking_limit` and `nestjs_backend` out of
  `upstreams.conf`. All three are argued behaviorally inert and are covered by
  `vpsctl validate`.

### Per app

**1. Check the diff is only what you expect.**

```sh
./bin/vpsctl apply --app <name> --dry-run
```

For the first app, expect `~ conf.d/http.conf` and `~ conf.d/upstreams.conf` and
nothing else. For every app after it, expect no changes. **Any other file, stop.**
Parity is not real, and nothing below is safe.

**2. Apply.**

```sh
./bin/vpsctl apply --app <name>
```

The first app reloads nginx. The rest report "no changes; nginx not reloaded".

**3. Verify live.**

```sh
curl -sSI https://<domain> | head -20      # status and security headers
./bin/vpsctl diff --live                    # expect clean
```

**4. Strip the app's deploy script.** Remove the nginx heredoc, the `certonly`
block, the `$API_DIR` guard, the `up -d nginx --force-recreate`, and the reload
block. What remains is "start my own container".

- **admin**: reduces to `docker compose pull admin && docker compose up -d admin`.
- **web**: keep `db:bootstrap`, the `--env-file .env.production` handling and the
  build-before-run ordering. That is application logic. Remove only nginx,
  certificate and reload steps.
- **api**: the largest edit. Also removes `rm -f default.conf` and the comment
  explaining why `nextjs_frontend`/`admin_frontend` are omitted from
  `upstreams.conf`, since `vpsctl`'s guard replaces it. Leave the
  `docker-compose.sa.yml` calls until part B.

**5. Add the apply step** to that app's pipeline, after its container starts:

```sh
cd ~/vps-configuration && git pull
./bin/vpsctl apply --app <name>
```

Order matters. The container must be running first, or nginx cannot resolve its
upstream. `apply --app <name>` fails loudly in that case rather than reporting a
deploy that changed no routing.

**6. Deploy for real** by pushing to that app's branch. Watch the run, confirm the
site stays up.

**7. Soak.** At least a day and one real deploy before the next app.

### Rollback

Each app's script is in git history. `git revert` in that repo restores it. The
other two apps are untouched.

---

## B. Container ownership

**The only step with downtime.** All three services set an explicit
`container_name`, so docker refuses to run the new stack beside the old one. There
is no side-by-side trial and no zero-downtime path without renaming the
containers, which would break every `docker exec nginx_proxy` reference.

Nothing about the served config changes: same image, same mounts, same
certificates at the same paths. Only the compose project owning the containers.

### Preconditions

- [ ] Part A complete for all three apps, each soaked with a real deploy
- [ ] `./bin/vpsctl diff --live` clean
- [ ] `docker compose --env-file stack/.env -f stack/compose.edge.yml config` parses
- [ ] Every path in `stack/.env` verified with `ls -d`. Docker creates a missing
      bind-mount source as an empty directory rather than failing, so a typo gives
      a running nginx serving nothing
- [ ] Certificates backed up **off the host**
- [ ] **Netdata volume decision made** (below)
- [ ] `docker-compose.sa.yml` untouched in spa-api, ready as rollback
- [ ] No CI runs in flight in any of the four repos
- [ ] Low-traffic window

### The Netdata volume decision

Compose prefixes volume names with the project name. The old stack is project
`spa-api` with volumes `spa-api_netdatalib`; this one is `vps-edge`. Netdata's
metrics database is in `/var/lib/netdata`, so starting the new stack as-is gives it
empty volumes and **silently discards all history**.

Either carry it over, with both stacks stopped:

```sh
for v in netdataconfig netdatalib netdatacache; do
  docker run --rm -v "spa-api_$v":/from -v "vps-edge_$v":/to \
    alpine sh -c 'cd /from && cp -a . /to'
done
```

Or accept the reset, which costs retained history, not monitoring.

### Procedure

```sh
# 1. Record the before state
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | tee /tmp/pre-cutover.txt
docker exec nginx_proxy nginx -T > /tmp/pre-cutover-nginx-T.conf

# 2. Back up certificates, then copy the archive off the host
set -a; . stack/.env; set +a
tar czf ~/certbot-backup-$(date +%F).tgz -C "$(dirname "$CERTS_ROOT")" "$(basename "$CERTS_ROOT")"

# 3. Stop the old edge. DOWNTIME STARTS.
cd ~/spa-api
docker compose -f docker-compose.sa.yml stop nginx certbot monitor
docker compose -f docker-compose.sa.yml rm -f nginx certbot monitor

# (Netdata volume migration here, if carrying history over)

# 4. Start the new edge
cd ~/vps-configuration
./bin/vpsctl up

# 5. Verify. DOWNTIME ENDS when these pass.
docker exec nginx_proxy nginx -T > /tmp/post-cutover-nginx-T.conf
diff /tmp/pre-cutover-nginx-T.conf /tmp/post-cutover-nginx-T.conf    # expect empty
curl -sSI https://balispacafe.com
curl -sSI https://api.balispacafe.com
curl -sSI https://admin.balispacafe.com
curl -sS -o /dev/null -w '%{http_code}\n' https://balispacafe.com/monitor/
```

Step 5's `diff` is the real acceptance test: identical resolved config before and
after proves ownership moved and nothing else did.

### Rollback

```sh
cd ~/vps-configuration && ./bin/vpsctl down
cd ~/spa-api && docker compose -f docker-compose.sa.yml up -d nginx certbot monitor
```

Seconds. Restore the certificate archive first if anything touched it.

### Done: 2026-09-25

**Measured downtime: about 20 seconds** (stop issued 09:19:15 UTC, all three
containers running by 09:19:32). Run mid-afternoon local time rather than in the
traffic trough, a deliberate trade for having someone watching.

The acceptance test passed: `nginx -T` **byte-identical** before and after, so
ownership moved and nothing else did. Verified afterwards:

| Check | Result |
|---|---|
| `nginx -T` before vs after | identical |
| All sites | 200 |
| Container ownership | all three now project `vps-edge` |
| certbot renewal loop | alive, `restart: unless-stopped` now set |
| Netdata host metrics | `pid=host`, `SYS_ADMIN`/`SYS_PTRACE`, `/host/proc` mounted |
| Netdata history | retained from 2026-09-06, ~19 days, carried across volumes |
| Certificate fingerprints | unchanged on all three domains |
| `vpsctl diff --live` | clean |

Worth knowing for next time: Netdata's metrics database is in
`/var/cache/netdata`, not `/var/lib/netdata`. The `netdatacache` volume is the
1.2 GB one and the one that actually matters; `netdatalib` is 48 KB of metadata.
The migration loop copies all three, so this changes nothing, but anyone
spot-checking `netdatalib` sizes would wrongly conclude the history was lost.

### Afterwards

1. `docker logs certbot` — confirm the renewal loop is alive. The new stack adds
   the restart policy the old one lacked.
2. Confirm Netdata still reports **host** metrics, not just container ones. That
   verifies `pid: host` and the `/host` mounts survived the port.
3. Remove `nginx`, `certbot` and `monitor` from `spa-api/docker-compose.sa.yml`,
   and the remaining `docker-compose.sa.yml` calls from `spa-api/tool/deploy.sh`.
   **Not yet.** That file is the rollback, and a rollback is worth keeping until
   the new stack has survived a reboot and a certificate renewal. The old
   `spa-api_netdata*` volumes are still on the host for the same reason.
5. Certificates are still at `$CERTS_ROOT` inside the spa-api checkout. That is
   unchanged by design and remains open in
   [known-issues.md](known-issues.md).
