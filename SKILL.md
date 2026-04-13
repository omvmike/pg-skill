---
name: postgres
description: Use whenever the user asks to query, read, count, inspect, or summarize data from a project's postgres database(s). Enforces read-only access, asks which target (local/prod/stage/etc.) to use, and inspects schema before querying.
allowed-tools: Bash(node *)
allow_implicit_invocation: true
---

# postgres skill

Read-only postgres access. Works in Claude Code and Codex CLI from the same files.

All access goes through `bin/query.mjs` in this skill's directory, which:

- enforces read-only access (allowed leading keywords: SELECT / EXPLAIN / WITH / SHOW)
- rejects forbidden keywords (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, COPY, VACUUM, REINDEX, CLUSTER, MERGE, CALL)
- wraps every query in `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = ...; <query>; ROLLBACK;`
- auto-appends `LIMIT` to bare SELECTs
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
- "check prod for bar"

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

### 2. Bootstrap (only if no targets exist)

```bash
node <SKILL>/bin/query.mjs --bootstrap
```

Creates `.db.local` at the project root, prefilled from `.env` with `DB_HOST=db` rewritten to `localhost`. Inform the user the file was created and ask them to review and fill in any missing credentials before proceeding.

If `.env` doesn't exist, ask the user for connection details, then create the `.db.<name>` file manually with these keys:
```
DB_HOST=...
DB_PORT=...
DB_USER=...
DB_PASSWORD=...
DB_NAME=...
DB_SSL=true                        # optional
DB_SSL_REJECT_UNAUTHORIZED=false   # optional, for self-signed certs
```

### 3. Inspect schema before writing SQL

Never guess column names. Inspect first:

```bash
node <SKILL>/bin/query.mjs --target <name> --list-tables
node <SKILL>/bin/query.mjs --target <name> --describe <table>
```

`--describe` accepts `schema.table` (default schema `public`) and outputs columns, indexes, and foreign keys.

### 4. Query

```bash
node <SKILL>/bin/query.mjs --target <name> --sql "SELECT ..."
```

For multi-line queries, write to a file and use `--file`:
```bash
node <SKILL>/bin/query.mjs --target <name> --file /tmp/q.sql
```

Optional flags:
- `--format json` for structured output (parseable, no truncation of cell values)
- `--limit N` to override the default LIMIT
- `--no-auto-limit` if you genuinely need every row (still capped at `maxRows` from config)

## Exit codes

Branch on these in your reasoning:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error |
| 2 | Safety violation — query rejected (do NOT try to bypass) |
| 3 | Statement timeout exceeded |
| 4 | Target file missing or invalid |
| 5 | Connection error |

When you hit code 2, the user asked for something the skill is designed to refuse. Tell the user what was rejected and suggest the proper path (migration, seed, or running it manually outside the skill).

## Safety configuration

`config.json` in the skill directory controls:

- `allowedLeadingKeywords` / `forbiddenKeywords` — statement allowlist/denylist
- `statementTimeoutMs` — hard cap (default 10s)
- `defaultLimit` — auto-LIMIT value (default 100)
- `maxRows` — post-query truncation cap (default 1000)
- `cellMaxLength` — table cell truncation (default 80 chars)

If the user asks to widen any limit, edit `config.json` rather than working around it in queries.

## Runtime requirement

The script resolves `pg` (node-postgres) from the user's project. If it fails with `Cannot find module 'pg'`, the project needs `npm install pg` (or `yarn add pg`).
