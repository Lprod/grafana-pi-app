---
name: rqlite-datasource
description: Query rqlite SQLite-compatible datasources through Grafana using read-only SQL and schema inspection tools.
---

# rqlite Datasource Skill

Use this skill when the user asks about rqlite, SQLite, SQL query results, database tables, or table columns.

## Rules

- Discover rqlite datasources before selecting a datasource UID.
- Inspect tables and columns before writing SQL unless the user provides a complete query.
- Use `query_rqlite` only for read-only SQL: `SELECT`, `WITH ... SELECT`, `VALUES`, `EXPLAIN SELECT`, or `PRAGMA table_info`.
- Do not attempt writes, schema changes, transactions, or maintenance statements.
- Keep query results focused. Summarize rows and mention when the tool result is truncated.
