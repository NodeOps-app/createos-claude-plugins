# Offload, fanout, and the egress firewall

Read this when an offload needs tuning: restricting what a build can reach, sizing a box for a heavy compile, controlling what gets uploaded, or fanning work across boxes.

## Contents

- [Offload flags](#offload-flags)
- [What gets uploaded](#what-gets-uploaded)
- [Egress: how the firewall actually behaves](#egress-how-the-firewall-actually-behaves)
- [Egress presets](#egress-presets)
- [Fanout](#fanout)
- [Heavy builds: OOM, disk, and bandwidth](#heavy-builds-oom-disk-and-bandwidth)

## Offload flags

Flags come **before** the `<dir> <cmd>` positionals — `cos` parses with `getopts`, which stops at the first positional.

| Flag | Effect |
|---|---|
| `-s <shape>` | box size (default `s-1vcpu-1gb`); list with `createos sandbox shapes` |
| `-r <rootfs>` | base image or custom template (default `devbox:1`) |
| `-o <path>` | tar this path out of `/work` back into the local dir after the run |
| `-w <GB>` | try to add a swapfile (best-effort — see below) |
| `-K` | keep the box if the command exits non-zero, so the cache survives for a retry |
| `-e <domain>` | allow one outbound destination (repeatable) |
| `-p <preset>` | apply an egress preset (repeatable, composes with `-e`) |
| `-E` | explicitly unrestricted egress |
| `-x <glob>` | extra upload exclude (repeatable) |

The box is destroyed on success, failure, or interrupt. Two things override that: `-K` on a failing command, and an infra/stream error — both keep the box so the build cache survives, and `cos` prints the reconnect and destroy commands.

Long, quiet builds survive a dropped connection. The command runs detached inside the box with a heartbeat watcher; if the exec stream dies the build keeps running and the watcher re-attaches. The real exit code is preserved either way.

## What gets uploaded

The local tree goes to `/work` in the box, one-way. Box-side changes never touch the local directory unless you ask for them with `-o <path>`.

Excluded from the upload by default: `.git`, `target`, `node_modules`, `__pycache__`, `.venv`, `.mypy_cache`, `.pytest_cache`, `.gradle`, `.cargo/registry`, `dist`, `build`, `.next`, `.turbo`, and large media (`*.gif`, `*.mp4`, `*.mov`, `*.zst`). Add more with `-x <glob>`.

Dependencies are meant to be built *inside* the box, not shipped into it — that is why `node_modules` and friends are excluded rather than uploaded.

## Egress: how the firewall actually behaves

**The default is unrestricted.** A fresh box can reach any host on the internet. `cos` prints a one-line UNRESTRICTED notice so this is never silent. Restricting is opt-in: `-p <preset>`, `-e <domain>`, or both.

The rule grammar is allow-list only — there is no deny token, so every destination a job needs must be enumerated. Rules can be `host`, `host:port`, `*.host`, `ip`, `ip:port`, `cidr`, `cidr:port`, or `*` (which means allow everything).

Enforcement is not uniform, and the difference matters when the threat model is exfiltration:

- **IP and CIDR rules take effect immediately** and cannot be bypassed from inside the box.
- **Domain rules take roughly 30 seconds to apply** after being set, and they are a strong control for HTTPS traffic but a weak one for cleartext HTTP.

So: a domain allow-list is the right tool for "this build should only reach pypi and crates.io." For an adversarial workload where blocking exfiltration is the actual goal, prefer IP/CIDR rules, and expect the 30-second window after any domain-rule change.

DNS keeps resolving even for blocked destinations — a blocked connection fails as a connection error (for example `curl` exit 35), not as a name-resolution failure. Debugging a restricted build by checking whether DNS works will mislead you.

## Egress presets

| Preset | Opens |
|---|---|
| `python-uv` | `astral.sh`, `releases.astral.sh`, `pypi.org`, `files.pythonhosted.org` |
| `rust-cargo` | `crates.io`, `static.crates.io`, `index.crates.io`, `static.rust-lang.org`, `cdn.pyke.io` |
| `npm` | `registry.npmjs.org` |
| `github` | `github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `codeload.github.com` |

`cdn.pyke.io` is the non-obvious one: `ort-sys` (ONNX Runtime, pulled in by a lot of ML crates) downloads prebuilt binaries from it, so a `cargo build` that looks pure-Rust fails without it. It is already in `rust-cargo`.

Presets compose. A Python project with a Rust extension and a git dependency wants `-p python-uv -p rust-cargo -p github`.

## Fanout

`cos fanout [-j N] [flags] <dir> <cmd1> [cmd2] …` stages `<dir>` once and runs each command in its **own** throwaway box, concurrently, then reports per-job exit codes and log paths and destroys every box.

The jobs share no network — that is the difference from `cluster`, where boxes are wired together on purpose. Fanout is for a test matrix, a config sweep, or a batch where isolation between jobs is the point.

`-j` defaults to 2 because that matches the concurrent-box limit observed on external API keys. Raising it past what the account allows does not fail — the extra jobs just queue, so a 3-way fanout with `-j 3` silently serializes into 2 + 1. One very long build is still better served by a single `offload`.

## Heavy builds: OOM, disk, and bandwidth

**Shape rejection.** Picking a shape the account cannot use fails fast with a `not allowed … Allowed: [...]` line; pick from that list, or run `createos sandbox shapes`. (The rejection is real and reproducible on external keys; the exact policy behind it is not documented, so treat the allowed list as authoritative rather than guessing.)

**Swap is best-effort.** `-w <GB>` tries to add a swapfile, but `devbox:1` cannot currently `swapon` — it stays at 0 MB, `cos` warns, and continues. If a compiled-extension build (pyo3/maturin, torch) is OOMing, the fix is a bigger shape or less work per run: build the extension separately, or install only the extra/group you actually need.

**Disk fills fast.** `pip install --all-extras` or an unconstrained `uv sync` can pull CUDA and torch wheels measured in gigabytes and hit `No space left on device` on a small box. Install only what the job needs; `--disk-mib` at create time raises the ceiling if you control it.

**Bandwidth is quota'd.** Every box starts with a fixed egress allowance (5 GiB by default) covering traffic the box initiates. A big model download, a `docker pull`, or a large dataset fetch can exhaust it, after which the box is flagged capped and outbound traffic stops. The quota is topped up additively — `createos sandbox edit <id>` has an interactive top-up — and clears a few seconds after the top-up lands. The control channels that carry exec, file transfer, and tunnels are exempt, so a blown quota degrades the workload without cutting off access to the box.
