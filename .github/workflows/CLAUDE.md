# CLAUDE.md — release workflows

**One workflow, `release.yml`, triggered by a `v*` tag.** A desktop release and the companion image it talks to are one version by construction, so the desktop's "your companion is behind" check (`versionCompare.ts`) compares two numbers that came from the same commit.

Three jobs:

| Job | Runs | Waits on |
|---|---|---|
| `release` | desktop installers, matrix over macOS + Windows + Linux → uploaded to a **draft** release | — |
| `image` | the companion container → `ghcr.io` | — |
| `publish` | flips the draft public, with notes | `[release, image]` |

`release` and `image` declare no dependency on each other, so they start together and the run costs the slower one, not the sum.

Cutting a release is therefore: bump `package.json` `version`, commit, `git tag vX.Y.Z && git push --tags`. Nothing else is manual. **Keep `package.json`'s version in sync with the tag you push** — electron-builder names artifacts from the manifest, not the tag, and a mismatch produces installers whose auto-update feed points at a version that doesn't exist.

> **This was two workflows** (`release.yml` + `companion-image.yml`) until v1.0.69. They shared the `v*` trigger, so every tag produced two runs that the Actions list titled identically — both take their title from the tag commit's message — which read as an accidental double-trigger. Merging them also let `publish` gate on the image, which two separate workflows structurally could not do.

## The `release` job — desktop installers

- **`npm run cli-tools` is its own top-level step**, not a postinstall inside `npm ci`. Nested, it dies with EPERM on the Windows runner. It provisions the bundled CLIs (`cli-tools/`, see `resources/built-in-skills/CLAUDE.md`) and removes npm's recursive self-link, which Windows' 7za can't resolve during NSIS packaging.
- **The macOS `npm run dist` step is separate solely to scope the signing secrets.** `CSC_LINK` / `CSC_KEY_PASSWORD` are electron-builder's *cross-platform* signing vars — exposed on the Windows runner they'd make it try, and fail, to sign the NSIS installer with the Apple certificate. Notarization (`mac.notarize: true`) needs all five Apple secrets.
- **Publishing is atomic, and that's what the `publish` job buys.** `package.json`'s `build.publish.releaseType` is **`draft`**, so every platform uploads into a draft; `publish` (with `needs: [release, image]`) flips it public. electron-updater only reads *published* releases, so clients cannot see a release until every artifact is there. It used to be `releaseType: "release"` and went public the moment the first platform finished — while `latest-mac.yml`, written last after ~10 minutes of notarization, was still missing, so Mac clients polling in that window got a 404 on the update feed. A failure anywhere now leaves an unpublished draft to inspect rather than a half-published release.
- **`publish` waits on the container too.** A desktop release that goes public without its matching companion image tells users to upgrade to a companion version `ghcr.io` doesn't have. The cost is that a Docker-only failure holds back a set of perfectly good installers — recoverable by re-running the failed job, since the draft and its artifacts survive.

### Release notes are commit subjects

electron-builder creates the draft with an **empty body**, and nothing filled it in through v1.0.36 — invisible on github.com, fatal to the app's "What's new" dialog, which reads `body` over the API (see "App updates" in `src/main/CLAUDE.md`). The `publish` job writes them before flipping the draft.

Two choices worth not re-litigating:

- **Not GitHub's `generate-notes`.** That endpoint summarizes merged pull requests and this repo commits straight to main — asked for v1.0.36 it returns a compare link and nothing else. Commit subjects here are already written as changelog lines, so they *are* the notes (`Release v*` commits are filtered out).
- **The previous tag comes from `git tag --sort=-v:refname`, not `releases/latest`.** At that point in the run our own release is still a draft, so "latest" *happens* to mean the previous one — true today and quietly wrong the first time a release doesn't get published.

The whole step is best-effort (`|| true` plus an emptiness check before `--notes-file`) on purpose: a hiccup writing notes must never strand a fully-built release as a draft. Shipping beats annotating. Needs `fetch-depth: 0` for the tag history.

## The `image` job — the companion container

Publishes `ghcr.io/stephengpope/shockwave-companion:<tag>` **and** `:latest`, multi-arch (`linux/amd64,linux/arm64`, hence the QEMU step — VPSes are amd64, some boxes aren't).

- **It carries its own `permissions` block** (`contents: read`, `packages: write`) because it pushes to the package registry, while the workflow default is the `contents: write` the other two jobs need for the Release. A job-level `permissions` **replaces** the workflow-level one outright rather than merging, so that block has to restate `contents` even though it only narrows it.
- **Build context is the repo root**, `file: api/Dockerfile`, because the image needs `agent-core/` and `resources/built-in-skills/` from outside `api/`.
- `VERSION=${{ github.ref_name }}` is baked in as `APP_VERSION` and surfaced by `GET /health` — that's the number the desktop's upgrade check reads, and it's `'dev'` for local builds.
- Both tags matter: fresh installs pull `:latest`, while a remote upgrade pins `SHOCKWAVE_TAG` to an exact tag so the compose files and the image are always the same release. See "Remote upgrade" in `api/CLAUDE.md`.

## What is not automated

The install-script path. `api/install.sh` and `updater/apply.sh` fetch runtime files from `raw.githubusercontent.com` at the tag, so **a release adding a host artifact needs it in both lists** — `tests/hostArtifacts.test.js` fails if they disagree, which is the guard, not the workflow. A release adding a *required* `.env` secret still needs users to re-run the install one-liner; the updater deliberately doesn't invent secrets.
