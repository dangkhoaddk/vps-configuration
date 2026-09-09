# Parity exceptions

Rendered config must reproduce what production serves. This is the complete list
of places that rule is deliberately broken, and why.

Anything not listed here is a bug.

## What the parity gate compares

Comments and blank lines are normalised away before comparison, so wording
changes in comments are not exceptions and are not listed. Directives are never
reordered, because order is significant in nginx and a sorted comparison would
pass a reordering that changed behaviour.

## Reproduced faithfully, though wrong

Round one is an extraction, not a cleanup. These are carried over unchanged so the
migration can be proven safe. Each is a round-two candidate.

### `booking_limit` is a dead rate-limit zone

`upstreams.conf` declares:

```nginx
limit_req_zone $binary_remote_addr zone=booking_limit:10m rate=2r/m;
```

No `limit_req` directive anywhere references it. It reserves 10 MB of shared
memory for a rate limit that never applies. Verified by grepping all three deploy
scripts: `global_limit` is declared and used once, `booking_limit` is declared and
never used.

Rendered anyway. Removing it changes output and fails the gate. Removal is a
one-line change plus a baseline update whenever someone wants it.

### `upstreams.conf` and site files disagree about where upstreams go

`api` declares its upstream in `upstreams.conf`. `web` and `admin` declare theirs
inline in their own site file. Nothing motivates the difference; it is an artefact
of three scripts written at different times.

`apps.yml` reproduces it with an ugly `declareIn` field whose docstring says so.
New apps should use `site`. Normalising the three onto one convention is a
round-two change: purely cosmetic in effect, but it changes rendered output.

### The port-80 ACME block omits admin's domains

`http.conf` lists api's and web's domains but not admin's. Admin's ACME challenge
works only because that block is the sole `listen 80` server and therefore nginx's
default server.

That is fragile. A future app adding another port-80 block ahead of it would
silently break admin's certificate renewal, and nothing would report it until a
certificate expired.

Reproduced exactly via `acme.httpServerNameApps: [api, web]`. The fix is to
include every app, which changes rendered output.

### Comments differ in wording

The templates carry better explanations than the heredocs they replace, including
the upstream-resolution rule that previously existed only as an inline note. The
normaliser strips comments, so this does not register as a difference.

One curiosity worth recording: the original `upstreams.conf` comment reads
`# ... and the later  errors.` with a doubled space. The heredoc it came from
contained `` `nginx -s reload` `` in backticks, unquoted, so bash executed it on
the host during every deploy and substituted the empty output. Harmless, since it
is a comment and `nginx` is not on the host's PATH, but it means reading the
script was never the same as knowing its output. Templates remove that whole class
of bug.

## Deliberate improvements

These change behaviour on purpose. None of them alter rendered nginx config, so
the parity gate is unaffected.

| Change | Why |
|---|---|
| certbot gained a restart policy | `docker-compose.sa.yml` gave `nginx` and `monitor` restart policies but gave certbot none, so the renewal loop did not survive a reboot or an OOM kill. Nothing reports that; it surfaces weeks later as an expired certificate. `compose.edge.yml` sets `restart: unless-stopped`. |
| Log rotation | The original had none, so container logs grew unbounded on a small VPS. All three services now use `json-file` with 10 MB x 3, matching what the web app's compose file already did. |
| The compose project name is explicit | Compose derives the project name from the directory and prefixes volume names with it. Left implicit, checking the repo out somewhere else would silently orphan Netdata's stored metrics. `name: vps-edge` is set explicitly. See `stack/README.md` for the volume migration this implies at cutover. |
| Netdata's hostname is a variable | Was hardcoded to `balispacafe-vps`. Cosmetic, shows in the dashboard, and a hardcoded site name in a reusable edge stack is wrong. |
| `cert issue` passes `--cert-name` | certbot names the certificate directory after the first `-d` domain. The renderer and the existing-certificate guard both use `primaryDomain`. Today's `apps.yml` keeps those aligned by coincidence; nothing enforced it, and drift would have broken certificate loading and burned the Let's Encrypt duplicate quota at the same time. |
| Reload no longer recreates nginx on a failing config test | The old scripts ran `nginx -t && nginx -s reload \|\| force-recreate`, recreating even when the config test failed. Recreating a container whose config nginx cannot load means nginx does not come back, turning a bad config into a total outage. `vpsctl` recreates only when the container is not running, or when the config tests clean but the reload fails. See [architecture.md](architecture.md). |
| The netdata upstream is conditional | Previously rendered unconditionally. Because nginx resolves upstreams at config-load time, a stopped monitoring container would have stopped nginx starting and taken all three sites down. `vpsctl` omits the `netdata` upstream and the `/monitor/` snippet when the container is not resolvable. Site blocks include the snippet through a wildcard, which tolerates zero matches, so `/monitor/` stops resolving and everything else keeps serving. Output is identical whenever the monitor is up, which is the normal case, so the gate holds. |

## Still outstanding

The baseline is currently derived from the three deploy scripts, not from the
running server. Until `nginx -T` is captured from the VPS, any drift between what
the scripts write and what nginx actually loaded is unknown. See
`baseline/README.md`. **Cutover is blocked on that capture.**
