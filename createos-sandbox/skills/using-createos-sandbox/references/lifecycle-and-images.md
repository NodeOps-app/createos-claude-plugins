# Box lifecycle, images, and the primitives `cos` doesn't wrap

Read this when a box needs to outlive one command: parking it cheaply, branching it, booting it pre-provisioned, or driving it with a `createos` verb `cos` has no shortcut for.

## Contents

- [pause and resume](#pause-and-resume)
- [Idle auto-pause](#idle-auto-pause)
- [fork — branch a warm box](#fork--branch-a-warm-box)
- [Images: built-in rootfs and custom templates](#images-built-in-rootfs-and-custom-templates)
- [Environment variables](#environment-variables)
- [Remote editor: Zed, Cursor, VS Code](#remote-editor-zed-cursor-vs-code)
- [Letting a job end its own box](#letting-a-job-end-its-own-box)
- [Single-file transfer](#single-file-transfer)
- [What the numbers actually are](#what-the-numbers-actually-are)

## pause and resume

```bash
cos pause     # snapshot disk + memory, free the host, stop compute billing
cos resume    # restore exactly — files, deps, and running processes
```

Pause is the answer to "I'm done for now but I don't want to rebuild this tomorrow." It snapshots the whole VM — disk, memory, and process state — so a box with a warm toolchain costs nothing while parked and comes back as it was. `cos down` destroys instead, which means the next session reinstalls everything.

Through the CLI, both `cos pause` and `cos resume` land around 6–8 seconds end to end (measured on a 1 GiB box). The platform-side restore itself is much faster than that when the snapshot lands back on the same host; it slows down when the memory image has to be pulled to a different one.

`cos pause` stops the file sync and any tunnels first, since a paused box serves no traffic and they would only spin on errors. Re-run `cos sync` / `cos tunnel` / `cos expose` after resuming.

`cos run` against a paused box stops with a clear message rather than resuming silently — resuming restarts compute billing, so it stays an explicit choice.

## Idle auto-pause

`cos up` creates the project box with a 30-minute idle auto-pause as a cost backstop, so a box forgotten at the end of a session parks itself rather than billing overnight.

The platform accepts anything from 60 seconds to 24 hours, and it can be changed on a live box:

```bash
createos sandbox edit <id> --auto-pause 4h    # longer leash for a running demo
createos sandbox edit <id> --auto-pause off   # never auto-pause
```

Raising it is the right move when a box is serving an exposed URL that people will hit intermittently — the default 30 minutes will park a demo box between visitors and the URL will appear dead until something resumes it.

## fork — branch a warm box

```bash
cos fork    # pauses briefly, clones the snapshot, resumes the original
```

The clone is a fully independent box with its own id, IP, and quota ledger. The original is untouched. This is how you try N variants from one prepared state without redoing setup N times.

Two things to know:

- A fork is **not** tracked as the project box, so `cos down` leaves it running. It *is* recorded in the statefile: `cos status` lists forks, `cos down` names the survivors, and `cos down -f` reaps them. Otherwise destroy it yourself with `createos sandbox rm -y <id>`.
- **Mounted disks do not carry across a fork.** If the source box had an S3 disk attached, re-attach it on the clone.

## Images: built-in rootfs and custom templates

Built-ins are kept warm on the hosts, so they boot with no image pull:

| Rootfs | Notes |
|---|---|
| `devbox:1` | Debian, batteries included, the default — has `sshd`, which `sync` and the editor path need |
| `ubuntu:26.04` | plain Ubuntu |
| `debian:13` | trixie |
| `alpine:3.20` | musl + busybox, far smaller; expect glibc-linked binaries and wheels not to work |

`createos sandbox rootfs` lists what the account can actually boot.

When the same install prelude runs at the start of every offload, move it into a template instead:

```bash
cos template submit myimage -f Dockerfile   # preflights, submits, streams build logs
cos template ls
cos up -r myimage                           # or: cos offload -r myimage . '<cmd>'
```

The build service enforces constraints that would otherwise only surface as a rejection after upload, so `cos template submit` checks them locally first:

- exactly one `FROM` — builds are single-stage
- the base image must be an operator-allowlisted one, written literally (no `ARG` substitution)
- **no `COPY` or `ADD`** — no build context is uploaded, so fetch what you need inside a `RUN`
- 64 KiB of Dockerfile source at most
- two builds run concurrently per account

Resubmitting the same name builds a new version; new boxes pick up the latest one that reached `ready`. A custom image is slow on its first boot on each host, because that host has to fetch it, and fast on every boot after.

## Environment variables

Values a command needs (API keys, tokens, config) have to be declared when the box is created:

```bash
createos sandbox create --shape s-1vcpu-1gb --env OPENAI_API_KEY=… --env STAGE=dev
```

Per-exec overrides only work for keys that were declared at create time — passing `--env NEW_KEY=…` to `exec` for an undeclared key is rejected. For a one-off value, inline it instead: `bash -c 'TOKEN=… ./run.sh'`.

Limits are 64 entries, 4 KiB per value, 64 KiB total.

Do not put the user's real credentials in a box unless the task genuinely requires it, and never echo a secret into a command line that ends up in a transcript or in `ps`.

## Remote editor: Zed, Cursor, VS Code

`cos` has no wrapper for this; the CLI verb is direct:

```bash
createos sandbox editor <box> --via tunnel --editor zed --yes
createos sandbox editor --remove <box>    # tear down the ~/.ssh/config entry
```

It generates a per-box SSH key, starts `sshd` in the box, writes a `~/.ssh/config` block so plain `ssh <alias>` works, and launches the editor pointed at the remote. It needs a rootfs with `sshd` (`devbox:1` has it) and a shape with more than 2 GiB of RAM — language servers OOM on a 1 GiB box.

This is the right tool when the user wants to *work in* the sandbox rather than have an agent drive it. It launches a GUI editor, so it belongs to the user, not to an agent command.

## Letting a job end its own box

A long batch job can end its own box when it finishes, which is the cleanest defence against a box left billing because an agent run died halfway:

```bash
# from inside the box, no credentials needed — loopback only
curl -sX POST 'http://127.0.0.1:1029/self/delete?reason=batch-done'
curl -sX POST 'http://127.0.0.1:1029/self/pause?reason=idle'

# or via the FIFO
echo retire > /run/self    # delete
echo park   > /run/self    # pause
```

Append this to the end of a long unattended command and the box cleans itself up whether or not anything is still watching.

## Single-file transfer

`offload -o` tars a whole directory back, which is usually what you want. For one file, the CLI is more direct:

```bash
createos sandbox push <box> ./local.py /work/local.py
createos sandbox pull <box> /work/result.csv ./result.csv
createos sandbox pull <box> /work/result.csv - | head -5    # '-' streams to stdout
```

Remote paths must be absolute; parent directories are created automatically; 500 MiB per file.

## What the numbers actually are

Useful for setting expectations, and for not overpromising to the user:

- **Create to first command runs: roughly 200 ms** (median; the guest kernel itself boots in tens of milliseconds, but the round trip through the control plane dominates).
- **Pause and resume: around 6–8 seconds each, end to end through the CLI** (measured on a 1 GiB box; the platform-side operations are faster, the CLI polls for the state transition). Resume is slower when the snapshot has to move to a different host than it was taken on. **Fork: around a second** for the snapshot copy, plus the pause and resume around it.
- **Concurrency:** external API keys have been observed to allow 2 boxes running at once, with a daily creation cap. Neither number is published policy — treat them as observed behaviour, budget `cluster` and `fanout` against them, and expect excess jobs to queue rather than fail.
- **Bandwidth:** 5 GiB of box-initiated egress per box by default, topped up additively.

CreateOS Sandbox is in alpha and carries no SLA. Behaviour and limits can change — when a number matters to a decision, check it live rather than quoting this file.
