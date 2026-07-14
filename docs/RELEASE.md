# Release Checklist

Use this checklist whenever preparing a new release version.

## Version Bump

- Update `manifest.json` `version`.
- Update the README version badge to the same version:
  `https://img.shields.io/badge/version-X.Y.Z-blue`
- Confirm both files show the same version.

## Pre-Release Checks

- Review the recent commits and summarize user-facing changes.
- Run available validation checks before committing. At minimum:
  - `git diff --check`
  - `node --check <changed-js-file>` for each changed JavaScript file
  - Any project-specific tests or manual checks relevant to the release
- Confirm `git status --short` only contains intended release files.

## Release Commit

Use an English commit title and a GitHub Releases-ready body.

Recommended format:

```text
release: Version X.Y.Z

Short release summary written for users.

- Notable fix or improvement.
- Another user-facing change.
- Compatibility or export behavior update, if relevant.
```

## Release Packages

After committing the release version, build both ZIP packages:

```sh
pwsh -File .\scripts\package.ps1 -Target store -Clean
pwsh -File .\scripts\package.ps1 -Target release -Clean
```

Before finishing, verify the final commit with:

```sh
git log -1 --pretty=full
git status --short
```
