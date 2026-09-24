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

## Deliberate divergences from what the scripts wrote

These **do** change rendered nginx config. The baseline was updated in the same
commit as each one, so the gate stays green, but that means the baseline no
longer reproduces the deploy scripts byte for byte.

| Change | Effect on rendered output | Behaviour |
|---|---|---|
| `booking_limit` removed | `upstreams.conf` loses one `limit_req_zone` | None. No `limit_req` referenced it. Frees 10 MB of shared memory |
| admin added to `acme.httpServerNameApps` | `http.conf` `server_name` gains admin's two domains | None today. That block is the sole `listen 80` server, so it already caught admin's challenges as nginx's default |
| `declareIn` removed | `nestjs_backend` moves from `upstreams.conf` into `api-ssl.conf` | None. nginx resolves upstreams after parsing all of `conf.d`, verified by `vpsctl validate` |

**These three are the expected differences** between what the VPS currently
serves and what this repo now renders. Anything beyond them is real drift.

They are encoded, one entry each, in `tests/accepted-divergences.ts`, so the gate
compares against the unedited live capture and still passes. Adding a row here
means adding an entry there, in the same pull request.

## Real drift the live capture found

Not an exception. Recorded because the next person will want to know what the
capture was worth.

| Drift | Resolution |
|---|---|
| `admin-ssl.conf` served `spa-admin:5001`; `apps.yml` declared port `3000` | `apps.yml` corrected to `5001`. Live wins |

The admin container sets `PORT=5001` and serves from nginx. Rendering port `3000`
would have passed `nginx -t` — the hostname resolves either way — and 502'd the
admin site on the first apply. The deploy-script baseline could not have caught
it, because the script and the registry carried the same wrong number.
