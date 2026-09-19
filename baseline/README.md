# Baseline

The config the parity gate renders against. Two sources, in ascending order of authority.

## 1. `from-deploy-scripts/` — present

Produced by `extract-from-deploy-scripts.sh`, which pulls only the `cat <<EOF > … EOF`
blocks out of the three app repos' deploy scripts and evaluates them with the same
variables those scripts set. No docker, no network, no certbot.

```sh
./extract-from-deploy-scripts.sh /tmp/out && diff -ru from-deploy-scripts /tmp/out
```

Sources:

| File | Written by |
|---|---|
| `conf.d/http.conf` | `spa-api/tool/deploy.sh` |
| `conf.d/upstreams.conf` | `spa-api/tool/deploy.sh` |
| `conf.d/api-ssl.conf` | `spa-api/tool/deploy.sh` |
| `conf.d/web-ssl.conf` | `spa-web/tool/deploy.sh` |
| `conf.d/admin-ssl.conf` | `spa-admin/tool/deploy.sh` |
| `snippets/monitor.conf` | `spa-api/tool/deploy.sh` |

This is a faithful reproduction of what the scripts *write*. It is not proof of what
the VPS currently *serves*.

## 2. `nginx-T.baseline.conf` — not yet captured

The authoritative source: what nginx actually loaded.

```sh
docker exec nginx_proxy nginx -T > nginx-T.baseline.conf
```

Until this exists the parity gate runs against source 1 only. **Drop the file in
this directory and the gate switches to it automatically** — no test change
needed. `tests/parity.spec.ts` names its source in the describe line, so the run
output says which one it used.

Any difference it then reports is real drift between the scripts and production,
and must be resolved before cutover. Live wins by default.

## Why the scripts alone are not enough

Two divergences are already known:

1. `spa-api/tool/deploy.sh` carries a commented-out `web-ssl.conf` heredoc. `spa-web`
   now writes that file instead. The scripts have already drifted from each other once.

2. **Backticks in those heredocs execute.** `spa-api/tool/deploy.sh:113` contains
   `` `nginx -s reload` `` inside an unquoted heredoc, so bash runs it on the VPS host
   during every deploy and substitutes its output. `nginx` is not on the host PATH,
   so the command fails to stderr and the comment lands as
   `# /run/nginx.pid) and the later  errors.` — not what the script appears to say.
   Reading the script is therefore not the same as knowing the output.

   The effect is harmless (it is a comment), but any backtick in those heredocs runs
   as the deploy user on every deploy. Templates remove that class of bug entirely.
