# Bundled Git resource

Desktop builds can include a portable Git runtime here so end users do not need to install Git globally.

Expected layout:

```text
resources/git/<platform>-<arch>/bin/git
resources/git/win32-x64/bin/git.exe
```

At runtime the Electron main process injects `VIFORGE_GIT_BIN` pointing at this binary. For development, set `VIFORGE_GIT_BIN=/path/to/git` or rely on `git` from `PATH` when running the API directly.

Release packaging runs `pnpm --filter @viforge/desktop prepare:git` and fails if the target bundle is missing. Set `VIFORGE_GIT_BUNDLE_SOURCE` to copy a prepared portable Git distribution into the expected platform directory before packaging. The Windows GitHub Actions workflow resolves the runner Git for Windows root and copies it into `resources/git/win32-x64` before building the installer.

