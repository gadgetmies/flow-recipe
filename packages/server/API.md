# Server ↔ client API (v2)

The server is the planning authority: it holds the session (dishes, inventory, policy, participants, event log),
runs `@flow-recipe/scheduler` on every change and broadcasts the resulting `Plan`. Clients render the plan and emit
events. Shapes referenced below (`Session`, `Inventory`, `Policy`, `Plan`, `Event`) are defined in
`packages/scheduler/README.md`.

Times are epoch milliseconds everywhere.

## REST

| Method & path | Body / params | Response |
|---|---|---|
| `GET /api/recipes` | | `[{ id, title, serving }]` from every `recipes/*.xml` except operations.xml |
| `GET /api/recipes/:id` | | the recipe XML (`application/xml`) |
| `GET /api/operations` | | operations.xml (`application/xml`) |
| `GET /api/inventory/default` | | `Inventory` JSON |
| `POST /api/sessions` | `{ sessionId, dishes: [{ recipeId, scale?, serveTime? }], inventory?, policy?, startTime? }` | `201 { session }`; `409` if it exists. Default: one dish, serveTime = now + 90 min |
| `GET /api/sessions/:id` | | `{ session: SessionView, plan: Plan \| null }` |
| `GET /api/sessions/:id/events` | | `[Event]` |

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
```
`completed_tasks` is replaced by `events` (`taskDone` rows). Legacy columns `scale`, `mise_en_place`,
`session_started`, `recipe_name` stay for compatibility with old clients during the transition but new code reads
`status`/`dishes`.
