---
description: Manage a cluster of CreateOS boxes on one private network (name-addressable). For multi-machine Linux testing — distributed systems, DB replication, p2p meshes, load tests.
argument-hint: "up <N> [-s shape] [-p preset] | run [<name|idx>|-a] <cmd> | ls | down"
allowed-tools: Bash
---

Spin up N sandboxes on one private overlay network. Members reach each other **by name** (e.g. `curl http://cos-cl-<key>-2:8080`) — no IPs needed. `run` execs on one member (index `1..N`, its name, or `-a` for all). Clusters count against quota (2 running at once on external keys) — keep N small.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" cluster $ARGUMENTS`

Report member names/IPs above. Tear the whole cluster down with `/createos-sandbox:cluster down` (also happens on `/createos-sandbox:down`).
