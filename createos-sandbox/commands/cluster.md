---
description: Manage a cluster of CreateOS boxes on one private network (name-addressable). For multi-machine Linux testing — distributed systems, DB replication, p2p meshes, load tests.
argument-hint: "up <N> [-s shape] [-e dom|-p preset|-E] | run [<name|idx>|-a] <cmd> | ls | down"
allowed-tools: Bash
---

Spin up N sandboxes on one private overlay network. Members reach each other by name — but the name must be **fully qualified**: `curl http://cos-cl-<key>-2.fc.local:8080` resolves, the bare `cos-cl-<key>-2` returns NXDOMAIN. Egress defaults to unrestricted on every member; `-e`/`-p` restrict to an exact set, `-E` to keep it explicitly unrestricted. `run` execs on one member (index `1..N`, its name, or `-a` for all). Clusters count against quota (2 running at once on external keys) — keep N small.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" cluster $ARGUMENTS`

Report member names/IPs above. Tear the whole cluster down with `/createos-sandbox:cluster down` (also happens on `/createos-sandbox:down`).
