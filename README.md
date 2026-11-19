# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bg4sgp/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bg4sgp/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in pure Node — no git binary, no dependencies, one process. It implements git's object model (blobs, trees, commits, annotated tags), packfiles (read with OFS/REF delta resolution, written plain) and the smart-HTTP wire itself: upload-pack protocol v2 (advertisement, ls-refs, fetch with haves/shallow/deepen planning) and receive-pack v0 with fast-forward enforcement and report-status. On top of the same content-addressed store sit the other three surfaces: REST v3 (repositories, branches, commits, contents, labels, issues, comments, pull requests with three-way squash merges), GraphQL v4 (viewer/repository/node queries, issue and pull-request connections with cursors, the create/close/merge mutations, `__type` introspection) and an MCP endpoint (server discovery, initialize, and six repository tools). Bearer-token auth guards everything but the health probe; state is in memory and timestamps come from a logical clock, so a trial replays deterministically.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, serves until the env answers `{"done": true}` on `/done`, then exits 0. For local poking, `createApp()` from `app.ts` is a plain `node:http` server you can listen on any port.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — HTTP framing and routing: auth, body reading, JSON, the request-id header.
- `store.ts` — the object store, repositories, the logical clock, global ids.
- `git.ts` — pkt-lines, packfiles, advertisements, ls-refs, fetch planning, receive-pack.
- `rest.ts` — REST v3 resources; contents writes and merges are real git operations.
- `graphql.ts` — a small GraphQL parser/executor for the v4 surface.
- `mcp.ts` — the JSON-RPC MCP endpoint and its six tools.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ww39pck3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
