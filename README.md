# pg-skill

Read-only postgres access as an Agent Skill. One codebase, works in **Claude Code** and **Codex CLI**.

Drop-in replacement for the `postgres` MCP server, but safer: every query is validated, wrapped in `BEGIN TRANSACTION READ ONLY`, and subject to a hard `statement_timeout`.

## What it does

- Single Node CLI: `bin/query.mjs`
- Target selection via `.db.<name>` files at your project root (KEY=VALUE, same format as `.env`)
- Auto-discovers any `.db.*` file as a target — drop in `.db.stage` and it shows up
- Enforces read-only via: leading-keyword allowlist + forbidden-keyword denylist + `BEGIN TRANSACTION READ ONLY` + server-side statement timeout. The query is sent on its own in Postgres's extended protocol, so Postgres itself refuses a second statement (no `; COMMIT; ...` escape, however it is hidden)
- Reaches databases behind an SSH bastion by itself (system `ssh`, no local port opened), reusing the SSH connection for 10 minutes
- Several queries per call on one connection (`--sql` repeated)
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

Targets behind an SSH bastion also need the OpenSSH client (`ssh`, `ssh-keygen`, `ssh-keyscan`) in your PATH.

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

Add `.db.*` to your project's `.gitignore` so credentials never get committed. Keep comments on their own line — text after a value (even after `#`) is part of the value, so passwords may contain `#`. `DB_SSL` / `DB_SSL_REJECT_UNAUTHORIZED` take `true` or `false`; anything else is rejected.

Use a read-only database role (no superuser, no `pg_signal_backend`, no `dblink`). The read-only transaction stops writes, but some functions act outside it — `pg_terminate_backend`, `pg_cancel_backend`, `dblink_exec`, session advisory locks — and only the role's privileges stop those.

### Databases behind an SSH bastion

Add the bastion to the target file. `DB_HOST`/`DB_PORT` are the database as seen *from the bastion*:

```bash
# .db.staging
DB_HOST=mydb.abc123.us-west-2.rds.amazonaws.com
DB_PORT=5432
DB_USER=analytic
DB_PASSWORD=...
DB_NAME=mydb
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
DB_SSH_HOST=203.0.113.10          # bastion IP, hostname, or a ~/.ssh/config alias
DB_SSH_USER=ec2-user              # optional if the alias sets it
DB_SSH_KEY=~/.ssh/bastion.pem     # optional if the alias or ssh-agent provides it
DB_SSH_PORT=22                    # optional
DB_SSH_REUSE=false                # optional: no shared SSH connection
```

How it works: for each call the skill runs `ssh -W <DB_HOST>:<DB_PORT> <bastion>` and uses that process's stdin/stdout as the database socket — TLS to the database still runs end to end. No local port is opened. With reuse on (default), OpenSSH keeps one shared connection open (`ControlMaster`/`ControlPersist`, socket `~/.ssh/pgsk-<hash>`, a directory other users can't write) for 10 minutes after the last call, so later calls skip the SSH login (roughly 4 s → 2 s per call over a transatlantic link). `--close-tunnel` closes it immediately.

ssh always runs with `BatchMode=yes`, so it never waits for a prompt. If the bastion's host key isn't in your `known_hosts` yet, the call stops with exit 6 `HOST_KEY_UNKNOWN` and prints the fingerprint; after checking it, accept with:

```bash
node ~/.claude/skills/postgres/bin/query.mjs --target staging --accept-host-key SHA256:...
```

That command re-scans the bastion and writes only the key with that exact fingerprint. A *changed* host key is never accepted by the skill — resolve that yourself (`ssh-keygen -R <host>`) once you've confirmed the bastion was rebuilt.

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

# Several queries on one connection (stops at the first failing one)
node ~/.claude/skills/postgres/bin/query.mjs --target prod \
  --sql "SELECT count(*) FROM users" \
  --sql "SELECT status, count(*) FROM orders GROUP BY 1"

# Multi-line query from file (one statement)
node ~/.claude/skills/postgres/bin/query.mjs --target prod --file ./scripts/q.sql

# Connection diagnostics, close the shared SSH connection
node ~/.claude/skills/postgres/bin/query.mjs --target staging --verbose --sql "SELECT 1"
node ~/.claude/skills/postgres/bin/query.mjs --target staging --close-tunnel
```

## Configuration

`config.json` in the skill directory holds the safety knobs.

| Key | Default | Notes |
|-----|---------|-------|
| `allowedLeadingKeywords` | SELECT, EXPLAIN, WITH, SHOW | First keyword must match |
| `forbiddenKeywords` | INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COPY, VACUUM, REINDEX, CLUSTER, MERGE, CALL | Any occurrence outside strings/comments rejects |
| `wrapInReadOnlyTx` | true | Run each query inside `BEGIN TRANSACTION READ ONLY` + `SET LOCAL statement_timeout` |
| `statementTimeoutMs` | 10000 | Hard server-side timeout |
| `connectTimeoutMs` | 10000 | Connect timeout for targets without a bastion |
| `defaultLimit` | 100 | Auto-appended to bare SELECTs |
| `maxRows` | 1000 | Post-query truncation |
| `cellMaxLength` | 80 | Table cell truncation (use `--format json` for full values) |
| `ssh.controlPersistSeconds` | 600 | Idle time before the shared SSH connection closes |
| `ssh.connectTimeoutSeconds` | 10 | SSH login timeout |
| `ssh.serverAliveIntervalSeconds` / `ssh.serverAliveCountMax` | 5 / 2 | Detect a dead SSH connection after ~10 s |
| `ssh.pgConnectTimeoutMs` | 20000 | Database connect timeout through the bastion |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error, or the SQL failed (`ERROR: … (SQLSTATE …)`) |
| 2 | Safety violation |
| 3 | Statement timeout |
| 4 | Target file missing or invalid (`TARGET: …`) |
| 5 | Connection error — unreachable, wrong password, unknown database, or `pg` not installed (`CONNECTION: …`) |
| 6 | SSH tunnel error (`SSH <KIND>: …` — host key unknown/changed, auth failed, bastion or DB unreachable) |

## How project root is detected

The script walks up from `process.cwd()` (the directory you ran `claude` / `codex` from) and stops at the first directory containing any of: `.git`, `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`. If nothing matches, it falls back to CWD. `.db.*` target files live in that project root.

## Tests

```bash
# unit tests (no database needed)
node --test 'test/*.test.mjs'

# live tests against a real project (read-only; creates and removes temporary .db.live_* fixtures)
node test/live.mjs --project <dir> --local <target> [--remote <bastion-target>] \
  [--baseline <previous skill checkout>] [--unknown-host <bastion name not in known_hosts>] \
  [--db-ok <db>] [--db-denied <db>] [--report report.md]

# wall-clock benchmark of whole CLI calls (read-only)
node test/bench.mjs --project <dir> --remote <bastion-target> --local <target> --runs 20 --out bench.json
```

## License

MIT
