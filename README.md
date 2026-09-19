# vps-configuration

Single owner of the VPS edge: nginx routing, TLS issuance, and the
nginx/certbot/netdata stack that fronts every site on the host.

Before this repo, three application repositories each generated nginx config with
bash heredocs, wrote it into `~/spa-api/nginx/conf/` on the shared VPS, and
force-recreated the proxy. Nothing serialised them, and the config existed as a
file nowhere.

## What it owns

| | |
|---|---|
| `apps.yml` | The registry. The one file you edit to add a site |
| `templates/` | nginx config as templates, not as strings inside shell scripts |
| `src/`, `bin/vpsctl` | Renders, validates, applies, and requests certificates |
| `stack/` | Compose file for nginx, certbot and netdata |
| `baseline/` | What production serves, which rendering must reproduce |

## What it does not own

Application containers. Each app's own pipeline still builds and starts its
container, because that is application logic: `spa-web` runs a database bootstrap
before it starts, for instance. This repo takes over from the point the container
is running, and handles routing, certificates and reload.

## Quickstart

```sh
pnpm install
pnpm run build

cp stack/.env.example stack/.env    # then fill in every CHANGEME

./bin/vpsctl diff                   # rendered config vs the baseline
./bin/vpsctl validate               # real nginx -t, in a throwaway container
./bin/vpsctl apply --dry-run        # what would change on this host
```

`bin/vpsctl` runs the CLI in a container, so the VPS needs only docker and git.

## Documentation

| | |
|---|---|
| [architecture.md](docs/architecture.md) | How the edge fits together, and why each odd choice is that way |
| [runbook.md](docs/runbook.md) | Something is broken. What to run |
| [adding-an-app.md](docs/adding-an-app.md) | Putting a new site on this VPS |
| [cutover.md](docs/cutover.md) | Migrating off the old deploy scripts |
| [parity-exceptions.md](docs/parity-exceptions.md) | Every deliberate difference from what production served |
| [known-issues.md](docs/known-issues.md) | Open problems, with status |

## The parity rule

Rendered config must reproduce what production already serves. CI fails when it
does not, so changing routing means updating `baseline/` in the same pull
request, and every routing change arrives as a reviewable diff.

That is the whole design. See [parity-exceptions.md](docs/parity-exceptions.md)
for the short list of places it is deliberately broken, and why.

## Repository visibility

This repo contains production hostnames, ports and filesystem paths. No keys, no
credentials: `apps.yml` holds `${ENV_VAR}` references and CI greps for anything
that looks like a secret. It is still written on the assumption that it stays
private.
