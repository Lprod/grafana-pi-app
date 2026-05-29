---
name: influx-datasource
description: Query InfluxDB datasources through Grafana using read-only Flux, InfluxQL, or InfluxDB SQL.
---

# InfluxDB Datasource Skill

Use this skill when the user asks about InfluxDB, Flux, InfluxQL, InfluxDB SQL, buckets, measurements, or time-series query results from an InfluxDB datasource.

## Rules

- Discover InfluxDB datasources before selecting a datasource UID.
- Use `query_influx` for read-only queries only.
- Prefer bounded time filters such as `range(start: -1h)` in Flux, `$timeFilter` in InfluxQL, or `$__timeFrom`/`$__timeTo` in InfluxDB SQL.
- Do not attempt writes, deletes, retention policy changes, schema changes, or outbound side effects.
- Keep query results focused. Summarize rows and mention when the tool result is truncated.
