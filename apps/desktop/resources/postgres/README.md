# Bundled PostgreSQL Resources

Place platform PostgreSQL distributions here before packaging desktop installers.

Expected layout:

```text
resources/postgres/<platform>-<arch>/bin/initdb
resources/postgres/<platform>-<arch>/bin/pg_ctl
resources/postgres/<platform>-<arch>/bin/postgres
```

Windows uses `.exe` suffixes. Example:

```text
resources/postgres/win32-x64/bin/initdb.exe
resources/postgres/win32-x64/bin/pg_ctl.exe
resources/postgres/win32-x64/bin/postgres.exe
```

The packaging script also accepts an external distribution root:

```bash
VIFORGE_POSTGRES_BUNDLE_SOURCE=/path/to/postgresql-root pnpm --filter @viforge/desktop prepare:postgres
```

Do not commit extracted runtime database data or user-created PostgreSQL data directories.
