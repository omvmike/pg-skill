# pg-skill

Read-only postgres access as an Agent Skill. One codebase, works in **Claude Code** and **Codex CLI**.

Drop-in replacement for the `postgres` MCP server, but safer: every query is validated, wrapped in `BEGIN TRANSACTION READ ONLY`, and subject to a hard `statement_timeout`.

## What it does

- Single Node CLI: `bin/query.mjs`
- Target selection via `.db.<name>` files at your project root (KEY=VALUE, same format as `.env`)
- Auto-discovers any `.db.*` file as a target — drop in `.db.stage` and it shows up
- Enforces read-only via: leading-keyword allowlist + forbidden-keyword denylist + `BEGIN TRANSACTION READ ONLY` wrap + server-side statement timeout
- Markdown table output by default, JSON with `--format json`
- Zero third-party dependencies in the skill itself; resolves `pg` from your project's `node_modules`

## Install

Pick the location for the tool you use. Both tools read the exact same files.

### Claude Code

```bash
# personal (available in every project)
git clone https://github.com/omvmike/pg-skill ~/.claude/skills/postgres

# or project-scoped (committed with your repo)
git clone https://github.com/omvmike/pg-skill .claude/skills/postgres
```

Invoke with `/postgres` or let Claude trigger it automatically when you ask about DB data.

### Codex CLI

```bash
# personal
git clone https://github.com/omvmike/pg-skill ~/.agents/skills/postgres

# or project-scoped
git clone https://github.com/omvmike/pg-skill .agents/skills/postgres
```

Invoke with `$postgres` or let Codex trigger it automatically.

### Update

```bash
cd <install-dir> && git pull
```

## Runtime requirement

Your project needs `pg` (node-postgres) installed. The skill resolves it from your project's `node_modules`:

```bash
npm install pg      # or: yarn add pg
```

If it's missing, the script exits with a clear message pointing at your project root.

## Setup a target

The fastest path — if your project already has a `.env` with `DB_*` keys:

```bash
node ~/.claude/skills/postgres/bin/query.mjs --bootstrap
```

This reads `.env`, copies the `DB_*` keys to `.db.local`, and rewrites `DB_HOST=db` → `DB_HOST=localhost` (so it works from your host, not just inside a docker-compose network).

Or add targets manually:

```bash
# .db.prod
DB_HOST=some.prod.host
DB_PORT=5432
DB_USER=analytic
DB_PASSWORD=...
DB_NAME=mydb
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
```

Add `.db.*` to your project's `.gitignore` so credentials never get committed.

## Daily use

Replace the install path with wherever you cloned.

```bash
# What targets do I have?
node ~/.claude/skills/postgres/bin/query.mjs --list-targets

# What tables exist?
node ~/.claude/skills/postgres/bin/query.mjs --target local --list-tables

# Schema for one table
node ~/.claude/skills/postgres/bin/query.mjs --target local --describe users

# Run a query
node ~/.claude/skills/postgres/bin/query.mjs --target local --sql "SELECT id, email FROM users LIMIT 5"

# JSON output
node ~/.claude/skills/postgres/bin/query.mjs --target prod --sql "SELECT count(*) FROM enrollments" --format json

# Multi-line query from file
node ~/.claude/skills/postgres/bin/query.mjs --target prod --file ./scripts/q.sql
```

## Configuration

`config.json` in the skill directory holds the safety knobs.

| Key | Default | Notes |
|-----|---------|-------|
| `allowedLeadingKeywords` | SELECT, EXPLAIN, WITH, SHOW | First keyword must match |
| `forbiddenKeywords` | INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COPY, VACUUM, REINDEX, CLUSTER, MERGE, CALL | Any occurrence outside strings/comments rejects |
| `wrapInReadOnlyTx` | true | Wrap query in `BEGIN TRANSACTION READ ONLY; ...; ROLLBACK;` |
| `statementTimeoutMs` | 10000 | Hard server-side timeout |
| `defaultLimit` | 100 | Auto-appended to bare SELECTs |
| `maxRows` | 1000 | Post-query truncation |
| `cellMaxLength` | 80 | Table cell truncation (use `--format json` for full values) |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error |
| 2 | Safety violation |
| 3 | Statement timeout |
| 4 | Target file missing or invalid |
| 5 | Connection error (or `pg` not installed) |

## How project root is detected

The script walks up from `process.cwd()` (the directory you ran `claude` / `codex` from) and stops at the first directory containing any of: `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`. If nothing matches, it falls back to CWD. `.db.*` target files live in that project root.

## License

MIT
