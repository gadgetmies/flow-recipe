# Server ↔ client API (v2)

The server is the planning authority: it holds the session (dishes, inventory, policy, participants, event log),
runs `@flow-recipe/scheduler` on every change and broadcasts the resulting `Plan`. Clients render the plan and emit
events. Shapes referenced below (`Session`, `Inventory`, `Policy`, `Plan`, `Event`) are defined in
`packages/scheduler/README.md`.

Times are epoch milliseconds everywhere.

## REST

| Method & path | Body / params | Response |
|---|---|---|
| `GET /api/recipes` | | `[{ id, title, serving, source: 'builtin'\|'imported', sourceUrl }]`: every `recipes/*.xml` except operations.xml (sorted by id), then the user recipes from the `user_recipes` table |
| `GET /api/recipes/:id` | | the recipe XML (`application/xml`), built-in file first, else user recipe; `404` |
| `GET /api/operations` | | operations.xml (`application/xml`) |
| `GET /api/inventory/default` | | `Inventory` JSON |
| `POST /api/sessions` | `{ sessionId, dishes: [{ recipeId, scale?, serveTime? }], inventory?, policy?, startTime? }` | `201 { session }`; `409` if it exists. Default: one dish, serveTime = now + 90 min |
| `GET /api/sessions/:id` | | `{ session: SessionView, plan: Plan \| null }` |
| `GET /api/sessions/:id/events` | | `[Event]` |

### Recipe import and user recipes

Shapes `Source`, `CheckResult`, `ImportResult` are defined by `@flow-recipe/importer` (see its README /
the design contract); the server loads it with a dynamic `import()` and answers `503` when it is not available.
Endpoints marked (auth) require `Authorization: Bearer <FLOW_UPLOAD_TOKEN>` when that env variable is set (reads stay
open). JSON bodies are limited to 2 MB, pasted `text` to 1 MB and `xml` to 256 kB (`FLOW_CHECK_MAX_BYTES`) (`413`).

| Method & path | Body / params | Response |
|---|---|---|
| `GET /api/llm` | | `{ server: { provider, model, baseUrl, hasKey } \| null, providers: ['anthropic','openai','openai-compatible','ollama'], available: bool }` — `server` is the env configuration (`FLOW_LLM_PROVIDER`, `FLOW_LLM_MODEL`, `FLOW_LLM_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, `FLOW_LLM_BASE_URL`), never the key (`baseUrl` without credentials or query); `available` = importer loaded |
| `GET /api/conversions` | | the density table (`DENSITIES`: `[{ id, names, gPerMl, kind, pieceGrams?, source? }]`) |
| (auth) `POST /api/import` | `{ url? \| text?, precisionScale?, servings?, notes?, llm?: { provider, model?, apiKey?, baseUrl? } }` | `202 { jobId }`. `llm` (the user's own configuration) wins over the server's; neither → `400 { error: 'No LLM configured' }`. `400` invalid input or a disallowed `llm.baseUrl` (see below), `429` too many running jobs (20 in total, 3 per client IP) |
| `GET /api/import/:jobId` | | `{ id, status: 'running'\|'done'\|'error', stage, detail, attempts, createdAt, finishedAt, result?: ImportResult, error? }`; `404` unknown or expired (jobs are kept 1 h after finishing) |
| (auth) `DELETE /api/import/:jobId` | | cancels a running job → the job view with `status: 'error', error: 'Cancelled'` |
| `POST /api/recipes/check` | `{ xml, precisionScale?, id?, metricize? }` | `CheckResult`; with `metricize: true` the XML is converted first and the response adds `{ xml, changes, conversionWarnings }`; XML the converter cannot parse → `422 { …CheckResult, error }` |
| `POST /api/recipes/convert` | `{ xml, precisionScale? }` | `{ xml, changes, warnings }` (`metricizeRecipeXml`); unparsable XML → `422 { error }` |
| (auth) `POST /api/recipes` | `{ xml, id?, overwrite? }` | `201 { id, title, check }`. `id` defaults to `<recipe id>`; the stored document's root `id` is rewritten to the saved id. `400` invalid id/xml, `409` built-in or reserved id (`operations`, case-insensitive match of a file) or existing id without `overwrite: true`, `422 { error, check }` when the check has errors |
| (auth) `PUT /api/recipes/:id` | `{ xml }` | `200 { id, title, check }` replaces a user recipe; `404` unknown, `409` built-in, `422 { error, check }` |
| (auth) `DELETE /api/recipes/:id` | | `200 { id, deleted: true }`; `403` built-in, `404` unknown |

Import jobs live in memory only. Stages reported by `stage`: `queued`, `fetching`, `generating`, `converting`,
`checking`, `repairing`, `done`; `attempts` counts LLM generations. Job failures (including timeouts after 10 min)
are captured in `error`. An API key sent in `llm` is used only by the running job: it is never stored, logged or
returned, it is scrubbed from error messages and dropped when the job ends. URLs are fetched only over http(s) and
never from private/loopback/link-local addresses (every redirect hop is checked) unless `FLOW_IMPORT_ALLOW_PRIVATE=1`.
The `mock` LLM provider (`llm: { provider: 'mock', mockResponse }`) is accepted only when `NODE_ENV=test` or
`FLOW_ALLOW_MOCK_LLM=1`. Other env knobs: `FLOW_IMPORT_MAX_JOBS` (20), `FLOW_IMPORT_MAX_JOBS_PER_IP` (3),
`FLOW_IMPORT_JOB_TTL_MS` (1 h), `FLOW_IMPORT_JOB_TIMEOUT_MS` (10 min).

**LLM base URLs.** A client-supplied `llm.baseUrl` (and Ollama's `http://localhost:11434/v1` default) must not
point at a private, loopback or link-local address: the server would otherwise be a proxy into its own network. The
check runs on the request (`400`) and again on every connection (DNS-rebinding safe). The operator can allow private
LLM hosts with `FLOW_LLM_ALLOW_PRIVATE=1`; a URL equal to the server's own `FLOW_LLM_BASE_URL` is always allowed.
**Ollama users:** configure your local Ollama as the server default (`FLOW_LLM_PROVIDER=ollama`,
`FLOW_LLM_BASE_URL=http://localhost:11434/v1`) — clients can then use it without sending a base URL — or set
`FLOW_LLM_ALLOW_PRIVATE=1` on a server only you can reach. `llm.baseUrl` must not contain credentials, a query or a
fragment. Errors from a client-supplied endpoint are reported with the HTTP status only, never the response body.

**Recipe XML safety.** Every check and save refuses documents with elements outside the recipe format, any
namespace other than `xmlns:xsi`, processing instructions other than the XML declaration (`<?xml-stylesheet?>`) and
DOCTYPEs. Recipe XML is served with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none';
sandbox` and `Content-Disposition: inline`.

**Cost limits.** `check`, `convert`, `POST`/`PUT /api/recipes` are rate-limited per client IP
(`FLOW_CHECK_RATE_LIMIT`, default 30 per minute, `429` with `Retry-After`); a check refuses recipes with more than
150 tasks or 100 ingredients before the scheduler dry run. Behind a reverse proxy set `FLOW_TRUST_PROXY` (e.g. `1`)
so per-IP limits see the client address. With a server LLM configured and no `FLOW_UPLOAD_TOKEN`, anyone who can
reach the server can spend the operator's key (a warning is logged at startup).

Sessions are stored in SQLite and survive a restart (the schema migration no longer drops the session tables on
boot).

Saving or deleting a user recipe drops the parsed model cached by `services/planning.js` (`forgetRecipe`). Sessions
can use user recipes like built-in ones (`dishes[].recipeId`).

```
SessionView = {
  id, status: 'draft'|'running'|'done', createdAt, startTime: ms|null,
  dishes: [{ id, recipeId, title, scale, serveTime, earlyTolerance, lateTolerance }],
  inventory: Inventory, policy: Policy,
  participants: [{ id, name, isSpectator, connected, placeholder, profile: { speed, capabilities, role, targetShare, maxConcurrentTimers } }],
}
```

Participant id `'0'` is the host. Placeholder participants (expected people who have not joined) have ids
`placeholder-<n>` and are created by the host from the settings page.

## Socket.IO, client → server

| Event | Payload | Who | Effect |
|---|---|---|---|
| `joinSession` | `{ sessionId, participantId, name, isSpectator }` | any | joins the room; server replies with `session`, `plan`, `connections`, `helpRequests` |
| `updateName` | `{ sessionId, participantId, name }` | self | |
| `updateParticipant` | `{ sessionId, participantId, profile: Partial<profile>, isSpectator? }` | self or host | triggers re-plan |
| `addPlaceholder` / `removePlaceholder` | `{ sessionId, participantId, name?, profile? }` / `{ sessionId, participantId: 'placeholder-n' }` | host | triggers re-plan |
| `updateDishes` | `{ sessionId, participantId, dishes: [{ id?, recipeId, scale, serveTime, earlyTolerance?, lateTolerance? }] }` | host | replaces the dish list; re-plan |
| `updateInventory` | `{ sessionId, participantId, inventory: Partial<Inventory> }` | host | merged over the default; re-plan |
| `updatePolicy` | `{ sessionId, participantId, policy: Partial<Policy> }` | host | re-plan |
| `startSession` | `{ sessionId, participantId }` | host | status → running, `startTime = now`, placeholder reconciliation, first online plan |
| `restart` | `{ sessionId }` | host | clears events, status → draft, offline plan |
| `event` | `Event` without `at` (server stamps it) — types: `taskStarted`, `taskDone`, `taskPaused`, `taskProgress` (`units`), `appointmentAcknowledged`, `participantPaused` (`payload.durationSeconds`) | self (host may act for anyone) | appended to the log; `applyEvent`; re-plan when needed; broadcast |
| `askForHelp` | `{ sessionId, participantId, requested }` | self | unchanged from v1 |

## Socket.IO, server → client

| Event | Payload |
|---|---|
| `session` | `SessionView` (on join and after every settings change) |
| `plan` | `Plan` (after every planning run; includes `diff` in online mode) |
| `connections` | `[{ id, name, isSpectator, connected, placeholder }]` (kept for the v1 UI pieces) |
| `interrupt` | `{ participantId, appointmentUuid, title, instructions, preempts: uuid \| null, deadline: ms }` — sent to the chosen participant; escalates to the next candidate after `policy.ackTimeoutSeconds` without `appointmentAcknowledged` |
| `helpRequests` | `[participantId]` |
| `error` | `{ message }` |

## Planning on the server

- `services/planning.js` keeps per-session in-memory `State` (from `@flow-recipe/scheduler` `createState`) rebuilt
  from the DB on demand: recipes parsed with `@xmldom/xmldom`, catalogue from operations.xml, session from the
  tables below.
- Draft: any settings change → `plan()` offline → broadcast.
- Running: every `event` → `applyEvent`; when `replanNeeded` or the debounce timer fires → `replan(state, now)` →
  broadcast `plan` with `diff`; appointments whose holder is not free at `firesAt − lead − reaction` →
  `chooseInterruptTarget` → `interrupt`.
- Planning is debounced (`policy.replanDebounceSeconds`) and never blocks the socket handler longer than the
  policy budget.

## Database (SQLite, `database.js`)

```
sessions(session_id PK, created_at, status, start_time, inventory_json, policy_json, plan_json, scale, mise_en_place, session_started, recipe_name)
dishes(id PK, session_id, recipe_id, title, scale, serve_time, early_tolerance, late_tolerance, position)
participants(session_id, participant_id, socket_id, name, joined_at, is_spectator, connected, placeholder, profile_json, PK(session_id, participant_id))
events(id PK AUTOINCREMENT, session_id, participant_id, type, uuid, units, payload_json, at)
help_requests(... unchanged)
user_recipes(id PK, title, xml, source_url, created_at, updated_at)   -- epoch ms; kept when the session tables are reset
```
`completed_tasks` is replaced by `events` (`taskDone` rows). Legacy columns `scale`, `mise_en_place`,
`session_started`, `recipe_name` stay for compatibility with old clients during the transition but new code reads
`status`/`dishes`.
