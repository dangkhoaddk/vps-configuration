# Runbook

For when something is broken and you want commands, not prose.

All commands run from `~/vps-configuration` on the VPS.

## First look

```sh
./bin/vpsctl status                  # edge containers
docker ps --format '{{.Names}}\t{{.Status}}'
./bin/vpsctl diff --live             # does rendered config match what nginx loaded?
docker logs --tail 50 nginx_proxy
```

## A site returns 502 or connection refused

Almost always the app container, not nginx.

```sh
docker ps --filter name=spa-api --filter name=bali-spa-cafe --filter name=spa-admin
docker network inspect ext_network --format '{{range .Containers}}{{.Name}} {{end}}'
```

Start the missing container from its own repo, then:

```sh
./bin/vpsctl apply --app <name>
```

`apply` skips any app whose upstream does not resolve, so if a container was down
during an earlier apply, its site block is simply absent until you re-apply.

## `invalid PID number ""` on reload

nginx previously failed to start, exited before writing `/run/nginx.pid`, and
every reload since has failed against the empty file. Retrying will not help.

```sh
./bin/vpsctl apply        # its reload step recreates the container for this case
```

If that does not clear it, find out why nginx would not start in the first place:

```sh
docker logs nginx_proxy | tail -30
./bin/vpsctl validate     # tests the rendered config in a throwaway container
```

## nginx will not start at all

Usually an upstream naming a container that is not on the network. See
[architecture.md](architecture.md) for why that stops nginx entirely rather than
breaking one site.

```sh
docker logs nginx_proxy | grep -i 'host not found'
```

Start the named container, then `./bin/vpsctl apply`.

## A certificate is expiring or expired

Check the renewal loop is alive first. It is the thing that silently stops.

```sh
docker logs --tail 30 certbot
docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' certbot
```

Inspect what is on disk:

```sh
set -a; . stack/.env; set +a
ls -l "$CERTS_ROOT/conf/live/"
openssl x509 -enddate -noout -in "$CERTS_ROOT/conf/live/<domain>/fullchain.pem"
```

Issue a certificate for a site that has none:

```sh
./bin/vpsctl cert issue <app>
./bin/vpsctl apply --app <app>      # so nginx picks it up
```

`cert issue` refuses when a certificate already exists. That guard is deliberate:
Let's Encrypt allows five duplicate certificates per week, and removing it would
exhaust the quota within a day of normal deploys. Renewal is certbot's job, not
this command's.

## Rolling back a bad routing change

Config is in git, so roll back the commit and re-apply:

```sh
git log --oneline -- apps.yml templates/
git revert <commit>
./bin/vpsctl apply
```

To check before committing to it:

```sh
./bin/vpsctl apply --dry-run
```

## `Timed out waiting for .vpsctl.lock`

Another apply is running, possibly from an app's pipeline. The error names the
holder and when it started. Wait for it.

If nothing is actually running, the holder died:

```sh
cat .vpsctl.lock      # who took it, and when
rm -f .vpsctl.lock
```

A lock older than fifteen minutes is taken over automatically, so this is only
needed when you do not want to wait. Interrupting `vpsctl` with Ctrl-C releases
it; a `kill -9` does not.

## `Directory does not exist` from bin/vpsctl

A path in `stack/.env` is wrong. The shim refuses to start rather than letting
docker create the directory empty, which would leave nginx serving nothing.

```sh
set -a; . stack/.env; set +a
ls -d "$NGINX_CONF_DIR" "$SNIPPETS_DIR" "$CERTS_ROOT"
```

Every path must be a literal absolute path. `${HOME}` resolves from the invoking
process's environment, so it works from your shell and expands to an empty string
under cron or systemd. A literal `~` is never expanded at all.

## Full edge restart

```sh
./bin/vpsctl down
./bin/vpsctl up
./bin/vpsctl status
```

Expect a few seconds where all sites are unreachable. Nothing else is affected:
certificates and config live on the host filesystem, not in the containers.

## Where things live

| | |
|---|---|
| Certificates | `$CERTS_ROOT/conf/live/<primary-domain>/` |
| Rendered nginx config | `$NGINX_CONF_DIR` |
| Location snippets | `$SNIPPETS_DIR` |
| Paths themselves | `stack/.env` |

**Certificates currently live inside the `spa-api` checkout.** Deleting or
re-provisioning that directory destroys the certificates for every domain. This is
known round-one debt, tracked in [known-issues.md](known-issues.md). Back them up
before touching anything near it:

```sh
tar czf ~/certbot-backup-$(date +%F).tgz -C "$(dirname "$CERTS_ROOT")" "$(basename "$CERTS_ROOT")"
# then copy it off the host
```

## Periodic checks

Nothing alerts on these, so they need a human.

- **Certificate expiry.** certbot renews automatically, but only while its
  container is running. Check it survived the last reboot.
- **Disk.** `/monitor/` shows it, or `df -h`.
- **`vpsctl diff --live` returns clean.** A difference means something wrote
  config outside this repo. This is also the only single place that answers
  "did anything change routing recently": app pipelines call `vpsctl apply` from
  their own SSH sessions, so those runs are logged in the app's repository
  rather than this one.

## The docker socket

`bin/vpsctl` mounts `/var/run/docker.sock`. That is root-equivalent access to the
host: anyone who can run the script can run any container, including one that
mounts `/`. It is required, because driving docker is what the tool does. Restrict
who can run it accordingly.
