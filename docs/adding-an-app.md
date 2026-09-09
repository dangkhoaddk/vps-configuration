# Adding an app

Putting a new site on this VPS. Roughly fifteen minutes, most of it DNS.

| Step | What happens |
|---|---|
| [1. Add it to the registry](#1-add-it-to-the-registry) | One entry in `apps.yml` |
| [2. Open a pull request](#2-open-a-pull-request) | Update the baseline files the change actually touches |
| [3. Merge and deploy](#3-merge-and-deploy) | `deploy.yml` applies on the VPS, or do it by hand |
| [4. Issue a certificate](#4-issue-a-certificate) | `vpsctl cert issue`, then re-apply |
| [5. Wire up the app's deploy pipeline](#5-wire-up-the-apps-deploy-pipeline) | Add the apply step after the app's own container starts |

## Before you start

- The app's container runs on the `ext_network` docker network and listens on a
  port inside the container. It must **not** publish that port to the host; nginx
  reaches it across the network.
- Its container name is stable. `apps.yml` refers to it by name.
- Its domains already resolve to this VPS. Certificate issuance fails otherwise.

## 1. Add it to the registry

One entry in `apps.yml`:

```yaml
  - name: shop
    domains:
      - shop.example.com
      - www.shop.example.com
    primaryDomain: shop.example.com
    upstream:
      name: shop_frontend
      container: shop-web
      port: 3000
    frameOptions: DENY
    websockets: true
    includeMonitor: false
```

Notes on the fields that are not obvious:

- `primaryDomain` must appear in `domains`. It names the certificate directory and
  the `ssl_certificate` path.
- `websockets: true` emits the `Upgrade`/`Connection` proxy headers. Set it false
  if the app does not need them.
- `includeMonitor` serves the Netdata dashboard under `/monitor/` on this domain.
  Leave it false unless you specifically want that, and read the
  [known issue](known-issues.md) about it being unauthenticated first.
- `clientMaxBodySize` and `rateLimit` are optional. Omitted, the app inherits the
  global `client_max_body_size 1M` and no rate limit.

Add it to `acme.httpServerNameApps` as well, so its domains appear in the port-80
block that serves the ACME challenge:

```yaml
acme:
  httpServerNameApps: [api, web, shop]
```

Skipping this happens to work today, because that block is the only `listen 80`
server and therefore nginx's default. Do not rely on it.

## 2. Open a pull request

**CI will fail**, with the parity gate reporting that rendered config does not
match `baseline/`. That is correct: you changed what the server will serve.

Three files change when you add an app, and they need different treatment.

> **Never regenerate the whole baseline directory.** A blanket
> `cp rendered/conf.d/*.conf baseline/.../conf.d/` overwrites the existing apps'
> baselines with renderer output, which makes the gate compare the renderer
> against itself. It would pass forever and prove nothing. Copy only the files
> that genuinely changed.

```sh
pnpm run build
node dist/cli.js render --out /tmp/rendered

# 1. The new app's file. Nothing to preserve, so this is simply its first snapshot.
cp /tmp/rendered/conf.d/shop-ssl.conf baseline/from-deploy-scripts/conf.d/

# 2. http.conf, because the new domains join the port-80 ACME block.
diff baseline/from-deploy-scripts/conf.d/http.conf /tmp/rendered/conf.d/http.conf
cp /tmp/rendered/conf.d/http.conf baseline/from-deploy-scripts/conf.d/
```

Read each diff before copying. For the existing apps' files the diff must be
exactly the new domains and nothing else. Anything more means you changed
behaviour for a site you were not touching.

Then add the new file to `OWNED_FILES` in `tests/parity.spec.ts`, so the gate
covers it from now on.

> A new app's server block has no golden file protecting it until you commit that
> first snapshot. Read the generated block once, in full, with attention to the
> security headers. After that the gate holds it in place.

### Adding an app before cutover

Don't, if you can avoid it. Until the migration completes,
`baseline/from-deploy-scripts/` is the evidence that this repo reproduces what the
old deploy scripts produced, and editing it weakens that evidence. Finish
[cutover](cutover.md) first.

## 3. Merge and deploy

Merging to `main` triggers `.github/workflows/deploy.yml`, which applies on the
VPS. Or do it by hand:

```sh
cd ~/vps-configuration && git pull
./bin/vpsctl apply --dry-run
./bin/vpsctl apply
```

`apply` skips any app whose container is not resolvable, so start the app's
container first. Its site block is simply absent until you re-apply.

## 4. Issue a certificate

```sh
./bin/vpsctl cert issue shop
./bin/vpsctl apply --app shop
```

The second command is needed because the server block references certificate paths
that only exist after issuance.

If issuance fails, the usual causes are DNS not yet pointing at this host, or the
port-80 ACME block not serving this domain (step 1).

## 5. Wire up the app's deploy pipeline

In the app's own CI, after it starts its container over SSH:

```sh
cd ~/vps-configuration
git pull
./bin/vpsctl apply --app shop
```

Order matters. The container must be running before `apply`, or nginx cannot
resolve its upstream and the site block is skipped. `apply --app shop` fails
loudly in that case rather than reporting a successful deploy that changed no
routing.

No token or cross-repo trigger is needed: the app's pipeline already has an SSH
session on this host. Concurrent deploys are serialised by a lock inside `vpsctl`.

## Removing an app

Delete its entry from `apps.yml` and from `acme.httpServerNameApps`, regenerate
the baseline, merge, and apply. `apply` prunes config files it no longer renders
and logs each removal.

Certificates are not deleted. Remove them by hand from `$CERTS_ROOT/conf/live/`
once you are sure.
