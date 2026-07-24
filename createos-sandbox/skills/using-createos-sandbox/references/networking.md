# Reaching the box, and wiring boxes together

Read this when something needs to talk to a sandbox: a browser, a teammate, another box, or the user's laptop.

## Contents

- [Choosing between tunnel, expose, cluster, and VPN](#choosing-between-tunnel-expose-cluster-and-vpn)
- [tunnel — private, to 127.0.0.1](#tunnel--private-to-127001)
- [expose — public HTTPS URL](#expose--public-https-url)
- [cluster — N boxes on one private network](#cluster--n-boxes-on-one-private-network)
- [vpn — the laptop joins the private network](#vpn--the-laptop-joins-the-private-network)

## Choosing between tunnel, expose, cluster, and VPN

| Need | Reach for |
|---|---|
| Hit a box-side dev server from this machine's browser | `tunnel` |
| Give a teammate a link, or point a webhook at the box | `expose` |
| Boxes that need to talk to each other (replication, p2p, load generator → target) | `cluster` |
| The laptop needs the whole private network, not one port | `vpn` |

`tunnel` and `expose` operate on the project box, so `cos up` first. `cluster` manages its own set of boxes. `cos down` tears down tunnels, the public URL, and the cluster along with the project box.

## tunnel — private, to 127.0.0.1

```bash
cos run 'npm run dev &'    # start the server in the box
cos tunnel 3000            # → http://127.0.0.1:3000 (local port defaults to the remote one)
cos tunnel 5432 15432      # box:5432 → 127.0.0.1:15432
```

Private to this machine — nothing is published. It runs in the background and is tracked in the statefile, so `cos status` lists it and `cos down` stops it. A service reached this way can bind loopback inside the box; the tunnel terminates in the box's network namespace.

Prefer this for dev loops. It needs no SSH key and no public exposure.

## expose — public HTTPS URL

```bash
cos expose 8080     # prints https://<id>-8080.<region-domain>
cos unexpose        # revoke
```

Things worth knowing before handing the link to anyone:

- **The service must bind `0.0.0.0:<port>`, not `127.0.0.1`.** Ingress arrives on the box's network interface, not loopback. A server on loopback will pass every in-box health check and still return nothing through the URL. `cos expose` probes the URL after enabling ingress and tells you which case you are in.
- **The URL is the credential.** There is no token and no auth layer — the unguessable id in the hostname is the entire access control. Anyone who has the link can reach the service, and a link pasted into a public channel is a public service. Treat it accordingly, and `cos unexpose` when the demo is over.
- **It lives as long as the box does.** The URL is stable for the box's lifetime, and dies with it. It does not survive a destroy, and a paused box serves nothing.
- **HTTP-aware, not raw TCP.** WebSockets and SSE work through it. The `Host` header is rewritten to `localhost:<port>` on the way in, which means Django's `ALLOWED_HOSTS` and Rails' host authorization pass without configuration.
- **TLS on the wildcard domain may not be provisioned.** If `https://` fails to connect, try the same URL over `http://` before assuming the service is broken.

Use `expose` for sharing a preview, demoing to the team, or giving an external service a webhook target. Use `tunnel` for everything else.

## cluster — N boxes on one private network

```bash
cos cluster up 3               # cos-cl-<key>-1..3, all on cos-net-<key>
cos cluster run 1 'ip -4 addr' # exec on member 1 (index or name)
cos cluster run -a 'uname -a'  # fan a command across every member
cos cluster ls                 # members + private IPs
cos cluster down               # destroy members + delete the network
```

Members resolve each other by name over the shared overlay — no IP wrangling. **The name must be fully qualified**; the bare short name is not in the guest's search path and returns NXDOMAIN (verified — this is the single most common way to conclude, wrongly, that cluster networking is broken):

- `<box-name>.fc.local` — scoped to networks the caller belongs to
- `<box-name>.<network-name>.fc.local` — when a name is ambiguous across networks
- `<sandbox-id>.fc.local` — always unambiguous

So from member 1, `curl http://cos-cl-<key>-2.fc.local:8080` works, while `curl http://cos-cl-<key>-2:8080` does not resolve. Names in a network the caller does not belong to return NXDOMAIN too — cross-network traffic is blocked at the host, not merely unrouted.

Good for distributed-system tests, database primary/replica setups, gossip and p2p meshes, and load generators pointed at a target box. Every member counts against the concurrent-box limit, so keep N small — `cos` refuses N > 8 outright.

## vpn — the laptop joins the private network

```bash
cos vpn register my-laptop   # one-time per machine, no sudo
cos vpn up                   # connect; needs wg-quick + sudo; blocks until Ctrl-C
```

This is real kernel WireGuard, and it is a whole-network L3 connection rather than the single forwarded port `tunnel` gives you. The private key is generated locally and never sent anywhere.

Two operational notes: it needs `wg-quick` installed and sudo for route changes, and **it blocks until interrupted** — hand `cos vpn up` to the user to run in their own terminal rather than launching it as an agent command. It refuses to start if its routes would collide with an existing VPN or LAN route (Tailscale on the same CGNAT range is the common case) instead of hijacking traffic.
