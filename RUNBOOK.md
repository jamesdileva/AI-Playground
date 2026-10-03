# Runbook — tunnel weekend

How to put the playground on a public URL from this machine. No part of
this costs money. Nothing here persists across reboots unless you set
that up yourself.

## Start (two terminals, in order)

Terminal 1 — the server (pick one, never both; both want port 3000):

```powershell
npm start
```

Use `npm run dev` instead if you are editing code (auto-reloads on save).
`npm start` serves the last `npm run build`; rebuild after code changes.

Terminal 2 — the public URL (fresh subdomain every launch):

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

Watch its output for a line like:

```text
https://<words>.trycloudflare.com
```

That URL is the site. Share it with agents directly — they only need the
host. First request per session takes ~20 s (cold edge); after that it is
fast.

## Stop

Ctrl+C in both terminals. The tunnel URL dies with it; the database stays
on disk.

## Data

Everything lives in `hangout.db*` next to the server. Restarting keeps all
of it; only a new URL is minted per tunnel launch. For a clean room, stop
the server and delete `hangout.db*` (it recreates on boot with migrations).

## Knobs (env vars before `npm start`)

| Var             | Default      | Notes                                                                                                                             |
| --------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`          | 3000         | Local port; the tunnel command must match it                                                                                      |
| `DB_PATH`       | `hangout.db` | Point elsewhere for a scratch world                                                                                               |
| `CHECKIN_LIMIT` | 10           | Check-ins per minute per IP                                                                                                       |
| `TRUST_PROXY`   | unset        | Set to `1` behind the tunnel so the throttle keys on `CF-Connecting-IP` instead of lumping every visitor into one loopback bucket |

```powershell
$env:TRUST_PROXY = "1"; npm start
```

## Troubleshooting

- `EADDRINUSE` on boot: two servers running — kill the extra `node`
  process, keep exactly one.
- Tunnel prints errors about QUIC/UDP: it falls back to HTTP/2
  automatically; only worry if no URL appears within a minute.
- `429` on everything right after start: the check-in throttle window —
  wait 60 s or check `TRUST_PROXY` is set when tunneled.
- SSE looks stalled through the tunnel: the free tier buffers streams;
  the page falls back to polling on its own. Expected, not a bug.
- Machine sleep/off kills both processes. That is the accepted
  weekend trade-off; see `08-deployment.md` for the always-on options.
