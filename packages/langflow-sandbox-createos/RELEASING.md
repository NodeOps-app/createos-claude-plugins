# Releasing `langflow-sandbox-createos`

Publishing runs in GitHub Actions with **PyPI Trusted Publishing**. There is no
API token in the repository's secrets — PyPI mints a short-lived credential for
this one workflow file on this one repository, so there is nothing to leak,
nothing to rotate, and nothing a fork can use.

## One-time setup

Do this before the first release. Nothing in the workflow can do it for you.

### 1. Register the publisher on PyPI

The project does not exist on PyPI yet, so register a **pending** publisher —
the project is created on first upload.

Go to <https://pypi.org/manage/account/publishing/> and add:

| Field | Value |
| --- | --- |
| PyPI project name | `langflow-sandbox-createos` |
| Owner | `NodeOps-app` |
| Repository name | `createos-plugin` |
| Workflow name | `langflow-sandbox-createos-release.yml` |
| Environment name | `pypi` |

Repeat on <https://test.pypi.org/manage/account/publishing/> with environment
name `testpypi` if you want the dry run below.

The environment name matters: the workflow's `publish` job runs in an
environment named `pypi` (or `testpypi`), and PyPI checks it. A mismatch fails
with an unhelpful `invalid-publisher` error.

### 2. Create the GitHub environments

In **Settings → Environments**, create `pypi` and `testpypi`.

Add a required reviewer on `pypi`. A tag push then pauses for a human before
anything reaches the index, which is the cheapest possible guard against a
mistyped tag.

## Cutting a release

```sh
cd packages/langflow-sandbox-createos

# 1. Bump the version. This is the single source of truth; the tag is checked
#    against it and the release fails before building if they disagree.
$EDITOR pyproject.toml

# 2. Bump it in the extension manifest too — Langflow shows this one in the UI.
$EDITOR src/langflow_sandbox_createos/extension.json

# 3. Prove it locally.
uvx ruff check src tests && uvx ruff format --check src tests
CREATEOS_SANDBOX_API_KEY=test-key .venv/bin/python -m pytest tests/ -q

# 4. Commit, tag, push. The tag is package-scoped because this is a monorepo.
git commit -am "release(langflow-sandbox-createos): v0.3.0"
git tag langflow-sandbox-createos-v0.3.0
git push origin main langflow-sandbox-createos-v0.3.0
```

The workflow then:

1. checks the tag version against `pyproject.toml`, and **refuses a version
   already on PyPI** — PyPI never allows reusing a version, not even a deleted
   one, so this check exists to stop an unrecoverable mistake rather than to be
   tidy;
2. re-runs lint and tests against the tagged commit;
3. builds the sdist and wheel, and **inspects the built wheel** for all three
   entry-point groups, `extension.json`, and the component module — a wheel
   that builds cleanly while registering nothing has already happened here
   once, caused by a stray `force-include`;
4. waits for approval if you configured a reviewer;
5. uploads via OIDC.

## Dry run first

For the first release, publish to TestPyPI from the Actions tab:

**Actions → langflow-sandbox-createos release → Run workflow → target:
`testpypi`**

Then check the artifact installs and registers:

```sh
uv venv --python 3.12 /tmp/rc && \
uv pip install --python /tmp/rc/bin/python \
  --index-url https://test.pypi.org/simple/ \
  --extra-index-url https://pypi.org/simple/ \
  langflow-sandbox-createos
/tmp/rc/bin/python -c "
import importlib.metadata as m
for g in ('lfx.sandbox_backends','langflow.extensions','lfx.executors'):
    print(g, [e.name for e in m.entry_points().select(group=g)])
"
```

`--extra-index-url` is required: TestPyPI does not carry `lfx` or `httpx`.

## What CI does not cover

The unit tests use `httpx.MockTransport` against a recorded fake control plane.
They need no CreateOS credential and touch no real sandbox, which is why they
are safe to run on pull requests from forks.

They therefore cannot catch what only a live control plane shows. Everything
below was found by running against production, and none of it would have failed
a green CI run:

- CreateOS accepts hostname egress rules and does not enforce them;
- Langflow reserves `template["code"]` for a component's own source;
- `self.ctx` is scoped to one graph run, so it cannot carry a session;
- a component's dependencies must exist in the executor's guest image.

Before a release that changes behaviour, run the live checks by hand against a
real box. A green CI badge means the wiring is sound, not that the platform
behaved.
