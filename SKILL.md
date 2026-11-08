---
name: postgres
description: Use whenever the user asks to query, read, count, inspect, or summarize data from a project's postgres database(s) — local, staging, dev or prod, including databases that are only reachable through an SSH bastion / jump host. Enforces read-only access, asks which target to use, inspects schema before querying, and opens the SSH tunnel itself, so use it instead of running psql or opening ssh tunnels by hand.
allowed-tools: Bash(node *)
allow_implicit_invocation: true
---

# postgres skill

Read-only postgres access. Works in Claude Code and Codex CLI from the same files.

All access goes through `bin/query.mjs` in this skill's directory, which:

- enforces read-only access (allowed leading keywords: SELECT / EXPLAIN / WITH / SHOW), one statement per `--sql`
- rejects forbidden keywords (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COPY, VACUUM, REINDEX, CLUSTER, MERGE, CALL)
- runs every query inside `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`, and sends the query itself on its own so Postgres accepts exactly one statement
- auto-appends `LIMIT` to bare SELECTs
- connects through an SSH bastion when the target says so, and reuses that SSH connection for 10 minutes
- formats output as a markdown table (default) or JSON (`--format json`)

## Skill directory

Examples below use `<SKILL>` as a placeholder — substitute the path where this skill is installed:

- Claude Code personal: `~/.claude/skills/postgres` (in Claude Code you can also use `${CLAUDE_SKILL_DIR}`)
- Claude Code project:  `.claude/skills/postgres`
- Codex personal:       `~/.agents/skills/postgres`
- Codex project:        `.agents/skills/postgres`

## When to use

Trigger this skill when the user says things like:
- "show me X from the database"
- "how many users have Y"
- "query the db for Z"
- "what's in the foo table"
- "check prod / staging / the dev database for bar"

## When NOT to use

- For pure ORM/model-structure questions, read the project's model files directly — they're the source of truth for application code and avoid hitting the DB.
- For schema migrations or data mutations: refuse and suggest the project's migration tooling.

## Workflow

Always run these steps in order. Do not skip steps.

### 1. Discover targets

```bash
node <SKILL>/bin/query.mjs --list-targets
```

- If output is `(none)`: run `--bootstrap` (next step), then re-list.
- If output lists multiple targets (e.g. `local`, `prod`, `stage`): **ask the user** which target to use. Never silently pick prod.
- If only one target exists: use it.
- A target shown as `name  (via bastion user@host)` is reached through SSH — see "Targets behind an SSH bastion".

### 2. Bootstrap (only if no targets exist)

```bash
node <SKILL>/bin/query.mjs --bootstrap
```

Creates `.db.local` at the project root, prefilled from `.env` with `DB_HOST=db` rewritten to `localhost`. Inform the user the file was created and ask them to review and fill in any missing credentials before proceeding.

If `.env` doesn't exist, ask the user for connection details, then create the `.db.<name>` file manually (mode 600) with these keys:
```
DB_HOST=...
DB_PORT=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
DB_SSL=true                        # optional
DB_SSL_REJECT_UNAUTHORIZED=false   # optional, for self-signed certs
```
Comments must be on their own line: text after a value, even after `#`, becomes part of the value (passwords may contain `#`). `DB_SSL` / `DB_SSL_REJECT_UNAUTHORIZED` take `true` or `false`.

Recommend a read-only database role for every target (no superuser, no `pg_signal_backend`, no `dblink`): the read-only transaction blocks writes, but not functions that act outside it, such as `pg_terminate_backend`.

### 3. Inspect schema before writing SQL

Never guess column names. Inspect first:

```bash
node <SKILL>/bin/query.mjs --target <name> --list-tables
node <SKILL>/bin/query.mjs --target <name> --describe <table>
```

`--describe` accepts `schema.table` (default schema `public`) and outputs columns, indexes, and foreign keys. With `--format json` it prints one document: `{ target, table, columns, indexes, foreignKeys }`.

### 4. Query

```bash
node <SKILL>/bin/query.mjs --target <name> --sql "SELECT ..."
```

Each `--sql` holds exactly one statement — a second statement (`SELECT 1; SELECT 2`) is rejected with exit 2, because it could end the read-only transaction early. When you already know several queries you need, pass them in one call; they run in order on one connection and the output has a `# Query N of M` section per query:

```bash
node <SKILL>/bin/query.mjs --target <name> \
  --sql "SELECT count(*) FROM users" \
  --sql "SELECT status, count(*) FROM orders GROUP BY 1"
```

The batch stops at the first failing query (the error says which one and which were not run) and exits with that query's code. A forbidden statement anywhere in the batch rejects the whole batch before anything runs.

For long queries, write one statement to a file and use `--file`:
```bash
node <SKILL>/bin/query.mjs --target <name> --file /tmp/q.sql
```

Optional flags:
- `--format json` for structured output (parseable, no truncation of cell values)
- `--limit N` to override the default LIMIT
- `--no-auto-limit` if you genuinely need every row (still capped at `maxRows` from config)
- `--verbose` prints connection diagnostics to stderr (useful when a bastion connection misbehaves)

Values of type `date` and `timestamp` (without time zone) print exactly as the server stores them (`2026-11-02`); `timestamptz` prints as UTC ISO.

When the automatic LIMIT was hit, the summary line says `(limit 100 reached; more rows may exist)` (JSON: `"limitReached": true`) — narrow the query, aggregate, or pass `--limit N` before drawing conclusions from the row count. In JSON, a repeated column name gets a suffix (`id`, `id_2`).

Pass one action per call (`--sql`/`--file`, `--describe`, `--list-tables`, ...); mixing them is a usage error.

## Targets behind an SSH bastion

A target whose file contains `DB_SSH_HOST` is reached through that bastion. The skill runs the system `ssh` client for you, so do not open your own tunnel (`ssh -L`, `psql`) for such a target — that would skip the read-only checks. Extra keys:

```
DB_HOST=<database host as seen from the bastion>
DB_PORT=5432
DB_SSH_HOST=<bastion IP, hostname, or ~/.ssh/config alias>
DB_SSH_USER=ec2-user            # optional if the alias sets it
DB_SSH_KEY=~/.ssh/bastion.pem   # optional if the alias or ssh-agent provides it
DB_SSH_PORT=22                  # optional
DB_SSH_REUSE=false              # optional: don't keep a shared SSH connection
```

The first call opens the SSH connection (a few seconds); later calls within 10 minutes reuse it and are faster, so batching several `--sql` in one call still saves time. Its control socket lives in `~/.ssh/pgsk-<hash>`. To close it right away: `node <SKILL>/bin/query.mjs --target <name> --close-tunnel`.

### When a bastion call exits with code 6

The first stderr line is `SSH <KIND>: ...`. What to do:

| Kind | Meaning | Your action |
|------|---------|-------------|
| `HOST_KEY_UNKNOWN` | ssh has never seen this bastion's host key | Ask the user (below). |
| `HOST_KEY_CHANGED` | the stored key differs from what the bastion presents | Stop and tell the user: possible interception, or the bastion was rebuilt. Do not remove or replace the key; the user confirms with the bastion owner. |
| `HOST_KEY_MISMATCH` | the bastion no longer presents the fingerprint being accepted | Stop and tell the user; nothing was written. |
| `AUTH_FAILED` | bastion rejected the login | Tell the user to check `DB_SSH_USER` / `DB_SSH_KEY`; a passphrase key needs `ssh-add`. |
| `KEY_PERMISSIONS` | ssh refuses a key with loose file permissions | Tell the user to run `chmod 600 <key>`. |
| `BASTION_UNREACHABLE` | network, VPN, or IP allow-list | Tell the user; timeouts were already retried once. |
| `DB_UNREACHABLE` | the bastion could not reach `DB_HOST:DB_PORT` | Tell the user to check those values. |
| `TUNNEL_FAILED` / `SSH_NOT_FOUND` | anything else / no `ssh` in PATH | Relay the message. |

**Unknown host key — always ask, never accept on your own.** The message shows the key type and fingerprint and the exact accept command. If it shows no fingerprint (e.g. the bastion is reached through `ProxyJump`), tell the user to connect once with `ssh` themselves and verify the key; there is nothing to accept through the skill. Ask the user with your question tool if you have one (two options: **Accept** — adds this key to their known_hosts and retries; **Reject** — stop), otherwise ask in plain text and stop until they answer. Include the target, the bastion and the fingerprint in the question. On Accept run the printed command:

```bash
node <SKILL>/bin/query.mjs --target <name> --accept-host-key SHA256:...
```

then re-run the original query. On Reject, stop. Never pass `StrictHostKeyChecking`, `UserKnownHostsFile` or similar overrides, and never edit `known_hosts` or run `ssh-keygen -R` yourself.

## Exit codes

Branch on these in your reasoning:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error, or the SQL itself failed (`ERROR: ... (SQLSTATE ...)`) |
| 2 | Safety violation — query rejected (do NOT try to bypass) |
| 3 | Statement timeout exceeded |
| 4 | Target file missing or invalid (incl. a `DB_SSH_KEY` that doesn't exist); first line `TARGET: ...` |
| 5 | Connection error, incl. wrong password or unknown database; first line `CONNECTION: ... (SQLSTATE ...)` — report it, don't rewrite the SQL |
| 6 | SSH tunnel error — see the table above |

When you hit code 2, the user asked for something the skill is designed to refuse. Tell the user what was rejected and suggest the proper path (migration, seed, or running it manually outside the skill). If it was rejected only for holding two statements, split them into separate `--sql` flags.

## Safety configuration

`config.json` in the skill directory controls:

- `allowedLeadingKeywords` / `forbiddenKeywords` — statement allowlist/denylist
- `statementTimeoutMs` — hard cap (default 10s)
- `connectTimeoutMs` — connect timeout for targets without a bastion (default 10s)
- `defaultLimit` — auto-LIMIT value (default 100)
- `maxRows` — post-query truncation cap (default 1000)
- `cellMaxLength` — table cell truncation (default 80 chars)
- `ssh.controlPersistSeconds` — how long the shared SSH connection stays open when idle (default 600)
- `ssh.connectTimeoutSeconds` / `ssh.pgConnectTimeoutMs` — SSH login and database connect timeouts (10 s / 20 s)

If the user asks to widen any limit, edit `config.json` rather than working around it in queries.

## Runtime requirement

The script resolves `pg` (node-postgres) from the user's project. If it fails with `Cannot find module 'pg'`, the project needs `npm install pg` (or `yarn add pg`). Bastion targets also need the OpenSSH client (`ssh`, `ssh-keygen`, `ssh-keyscan`) in PATH.
