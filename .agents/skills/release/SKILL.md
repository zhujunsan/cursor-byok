---
name: release
description: Prepare, authorize, publish, troubleshoot, and verify Cursor BYOK desktop GitHub Releases. Use for version bumps, release tags, GitHub Actions release runs, updater manifests, signing, or release-readiness checks.
---

# Desktop release

Release through `.github/workflows/release.yml`. Preserve both updater formats: Tauri uses `latest.json`; legacy `v0.0.49` clients use `update.json`.

## Publication authority

- Only the repository author, GitHub user `zhujunsan`, may authorize a live release.
- Before any live mutation, require an explicit release instruction from the author in the current task and verify `gh api user --jq .login` returns `zhujunsan`.
- Treat all of these as publication actions: pushing a `v*` tag, rerunning the release workflow, and publishing or editing a GitHub Release. Pushing a release commit to `main` only prepares the release and must never trigger publication by itself.
- Without that authorization, restrict work to inspection, local edits, validation, and a release-ready commit or branch. Do not infer publication permission from requests such as “prepare”, “check”, or “ready to release”.
- Never print, commit, or upload `~/.tauri/cursor-byok-updater.key` or its `.password` file anywhere except the repository's `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions Secrets when the author explicitly requests that secret configuration.
- Never delete, replace, or move an existing tag or published Release without separate explicit authorization.

## Version and GitHub Release policy

- Do not use GitHub prereleases. Keep `prerelease: false` for every release and publish the completed release as Latest.
- This fork releases as `vBASE-san.N`, where `BASE` is the upstream version the fork is based on and `N` is a numeric counter, for example `v1.0.1-san.1`, `v1.0.1-san.2`. Keep the dot before `N` so SemVer compares it numerically. Never take a bare `vMAJOR.MINOR.PATCH`; those belong to upstream. After rebasing onto upstream `X.Y.Z`, restart at `vX.Y.Z-san.1`.
- Never use `+build` metadata to distinguish releases; SemVer ignores it when comparing versions, so the updater cannot see it as newer.
- Every `-san.N` release is still a normal GitHub Release, not a GitHub prerelease.
- This normal-Release rule is required because both installed update clients resolve assets through GitHub's `/releases/latest/download/` path, which excludes GitHub prereleases.
- Windows builds must use the NSIS bundle. WiX/MSI rejects nonnumeric prerelease identifiers such as `san.1`; do not weaken the SemVer tag to accommodate MSI.
- Release only from a `v*` tag whose commit is contained in `origin/main`. The tag must equal `v<version>` from the desktop manifests.
- Keep ordinary `main` pushes and manual workflow dispatch disabled as release triggers. The author pushes the matching tag only after the release commit is present on `origin/main`.
- Never republish an already published version. Select a new version instead.

## Release sources

Keep the desktop version identical in the manifests and their locks:

```text
cursor-byok/
├── Cargo.lock
├── apps/desktop/
│   ├── package.json
│   ├── package-lock.json
│   └── src-tauri/
│       ├── Cargo.toml
│       └── tauri.conf.json
├── scripts/cursor-proto/proto/
│   ├── agent_v1.proto
│   └── aiserver_v1.proto
└── .github/workflows/release.yml
```

The two listed Proto files are required build inputs and must be committed. Keep the other locally extracted Proto files ignored unless the build starts depending on them.

## Prepare and validate

1. Inspect `git status`, fetch `origin/main`, and preserve unrelated user changes. Confirm the release commit is based on the current remote head.
2. Pick the next `BASE-san.N` version. Update the desktop version in both manifests and lockfiles; do not change the independent `cursor-server` version merely to release the desktop app.
3. Confirm the updater public key in `tauri.conf.json` matches `~/.tauri/cursor-byok-updater.key.pub` without exposing the private key.
4. Confirm `TAURI_SIGNING_PRIVATE_KEY` exists in GitHub Actions. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be absent when the local key has no password.
5. Confirm neither the intended tag nor Release already exists.
6. From `apps/desktop`, run:

   ```bash
   npm run check
   npm run tauri:build -- --debug --no-bundle
   ```

7. Validate the workflow YAML and inspect the staged diff. Ensure signing keys, unrelated local files, and unrelated user changes are not staged.
8. Use the `tauri-action@v1` input `uploadUpdaterJson: true`; `includeUpdaterJson` is not a valid v1 input.

## Publish and verify

After the author explicitly authorizes publication:

1. Commit only the reviewed release set and push it to `main`. Confirm the release commit is present in `origin/main`; this push must not start the release workflow.
2. Create the matching tag on that commit, for example `v1.0.1-san.1`, and push only that tag. This tag push is the publication trigger.
3. Follow the triggered `Release desktop app` run through completion. Report the run URL and stop on failure; diagnose locally before asking the author to authorize another live attempt.
4. Verify `v<version>` exists, is published rather than draft, has `prerelease: false`, and is the repository's Latest release.
5. Verify the Release contains signed Tauri updater artifacts plus `latest.json`, and the legacy platform archives plus `update.json`.
