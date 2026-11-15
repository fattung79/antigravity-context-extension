# Antigravity Context Viewer (`antigravity-context-extension`)

## Release SOP (VS Code Marketplace & Open VSX / Antigravity)

Publishing is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml) on any `v*` tag push, using GitHub repo secrets `VS_MARKETPLACE_TOKEN` (Azure DevOps PAT, 1-year max lifetime) and `OPEN_VSX_TOKEN` (both backed up in Bitwarden).

To release a new version:
1. Bump version in `package.json` & `package-lock.json`: `npm version <patch|minor|major> --no-git-tag-version`
2. Add a `## X.Y.Z` entry to `CHANGELOG.md`.
3. Verify: `npm run typecheck && npm test`
4. Commit, tag, and push:
   ```bash
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: release vX.Y.Z (...)"
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. Watch the `Release Extension` workflow (`gh run list --workflow=release.yml`) to confirm both `Publish to VS Code Marketplace` and `Publish to Open VSX (Antigravity)` pass.
