# Multi-Chef Meal Scheduling Algorithm Specification

Status: proposal, v0.1. Companion to `RECIPE.spec.md`.

This document specifies the algorithm that turns one or more recipes, a set of participants, a kitchen inventory and
target serving times into a per-participant work plan, and keeps that plan valid while the cooking is happening.

It replaces the placement logic in `packages/client/src/timelineScheduler.js`. The lane/timeline data structure that
the UI consumes (`timelines[lane][index] = { uuid, start, end, title, task, timer, dependencies }`) is kept and
extended (see §9), so the UI can migrate incrementally.

---

## 1. Goals, non-goals and design principles

### 1.1 Goals

1. Every dish finishes inside its serving window, and all portions of the same dish finish close enough together that
   hot food is still hot and cold food is still cold when served.
2. Work is shared fairly: no participant idles for long while others are busy, and nobody carries all of the tedious
   work (cleaning, measuring) unless they chose to.
3. Participants are used efficiently, but efficiency ranks below fairness. Shortening the session by five minutes is
   not worth leaving one person idle for twenty.
4. Task switching is discouraged. Moving from one context to another has a real time cost and a cognitive cost; both
   are modelled.
5. Repetitive per-unit work (portion dough, roll balls, place on sheet, brush with egg) is organised into pipelines or
   parallel cells, chosen according to tools, people and timing.
6. Limited tools and appliances are respected, including the fact that a tool must be rinsed or washed between some
   uses. Cleaning is either a dedicated role or shared work, by configuration.
7. Time-critical events (take the sheet out of the oven) are planned so that somebody is free exactly then. When
   reality drifts, an interrupt mechanism pulls the cheapest-to-interrupt participant away from their current task.
8. The scheduler runs in two modes with one engine. **Offline**, it produces the complete plan before anyone
   starts, from the recipes, the serve times and the expected participants and inventory, so the host can review
   it, change inputs and re-plan. **Online**, once the session is started, it keeps that plan current as tasks are
   started and finished early or late, people join or leave, and timers fire, changing as little as possible.

### 1.2 Non-goals

- The scheduler does not decide *what* to cook or how to scale a recipe. Scaling is an input (the existing `scale`).
- The recipe document does not contain scheduling directives. See §1.3 and §10.
- Optimality is not required. The problem is a resource-constrained project scheduling problem with time windows,
  maximum lags, sequence-dependent setup times and multi-skill resources. That is NP-hard; the spec asks for a
  good heuristic that runs in well under a second in a browser and re-runs on every event.

### 1.3 Separation of concerns

| Concern | Lives in | Examples |
|---|---|---|
| What the dish needs | Recipe XML | ingredients, amounts, steps, tools used, temperatures, durations, how long an intermediate result stays good |
| How an operation behaves | Operation catalogue (`operations.xml` / `operations.js`) | active vs. passive time, per-unit time, whether work is divisible, how urgent its completion is, how dirty it leaves a tool |
| Who, when, with what | Session input + scheduler | participants, serve times, tool counts, oven capacity, cleaning policy, weights |

The rule for adding anything to the recipe format: it must be a fact about the food, the step or the tool that is
true in every kitchen. "Whipped cream holds for 30 minutes" is a fact. "Two people should roll the buns" is not.

---

## 2. Inputs

### 2.1 Recipes

One or more recipe documents conforming to `recipe.xsd`, each already scaled. §10 proposes additions to the format
and the operation catalogue; the algorithm is written against the enhanced model but degrades gracefully: every
proposed attribute has a default.

### 2.2 Session

```
Session {
  startTime?: Time                    // when people can start; if absent, derived (§5.3)
  dishes: [{
    recipeId, scale,
    serveTime: Time,                  // target T_d
    earlyTolerance: Duration = 0,     // may finish this much before T_d (holding permitting)
    lateTolerance:  Duration = 5 min, // hard limit after T_d
  }],
  participants: [{
    id, name,
    availability: [[from, to]] = [[-inf, +inf]],
    speed: number = 1.0,              // 0.5 = twice as slow; applies to active durations
    capabilities: Set<string> = all,  // e.g. "knife", "hot-pan", "oven"; tasks may require one
    role: "cook" | "cleaner" | "spectator" = "cook",
    targetShare: number = 1.0,        // fairness weight; 0.5 = "light duty"
    maxConcurrentTimers: number = 2,
  }],
  inventory: {
    tools:      [{ type, count, capacity?, properties }],   // e.g. { type:"baking-sheet", count:3, capacity:{ buns:16 } }
    appliances: [{ type, slots, modes?, modeSwitchTime? }], // e.g. oven: slots=2 sheets, modes by temperature
    stations:   [{ type, count }],                          // sink, counter, hob burner
    holding:    [{ type, slots, keeps: "hot"|"cold"|"ambient", maxHold }], // warming drawer, fridge
    cleaning:   { rinseTime, washTime, dishwasher?: { slots, cycleTime } },
  },
  policy: Policy                     // §11
}
```

### 2.3 Operation catalogue

Per operation, the metadata in §10.2. The existing `timeline(node, scale)` functions remain the source of durations;
the new attributes add shape (per-unit vs. fixed), attention, divisibility, urgency and soiling.

---

## 3. Model

### 3.1 Task instances

The scheduler works on an expanded, scaled task graph. Expansion follows the existing `expandNode` mechanism
(`bake-in-oven` → `preheat-oven`, `put-into-oven`, `take-out-of-oven`; `split` → N units) and adds:

- **Quantity propagation.** Amounts flow backwards from the dish's final output as today (`amountsLeft`). The result
  is, for every task, the number of *units* it handles (`n_j`) and the number of *batches* the tool capacity forces
  (`ceil(n_j / capacity)`; e.g. 64 buns, sheets of 16 → 4 sheet-batches; oven holds 2 sheets → 2 bake rounds).
- **Batch instantiation.** A task whose tool capacity forces batches is instantiated once per batch, each with its own
  precedence links, so the oven rounds are separate tasks with separate completion events.
- **Join flattening.** `<join>` groups (see `buns.xml`) become one task whose duration is the sum of the children and
  whose instruction text concatenates them.
- **Cleaning tasks** are not in the recipe; the scheduler generates them (§3.5).
- **Dish sinks.** Each dish gets a virtual `serve` task consuming all of its final outputs (§3.8).

Each task instance `j` carries:

| Field | Meaning | Source |
|---|---|---|
| `a_j` | active (hands-on) duration at speed 1 | operation `timeline().active`, time model (§3.2) |
| `p_j` | passive duration after the active part (baking, rising, chilling) | `timeline().passive` |
| `n_j` | number of units handled | quantity propagation |
| `attention` | `attended`, `monitored(interval, checkDuration)`, `unattended` | operation |
| `divisible` | `none`, `units(minChunk)`, `team(maxPeople, speedup)` | operation (§3.2) |
| `preemptible` | `never`, `units`, `anywhere(resumeCost)` | operation |
| `tools` | list of `{type, qty, mode, soilAfter}`; mode is `active` (held during `a_j`), `reserved` (held until the output is consumed) or `consumed` | recipe `<tool>` + operation defaults |
| `appliance` | `{type, slots, mode}` e.g. oven, 1 slot, 225 °C | recipe options |
| `hold_j` | how long the task's output stays good before its consumer must start | recipe output `hold` (§10.1), default ∞ |
| `completion` | for `p_j > 0`: `{ urgency, earlyTol, lateTol, activeDuration }` of the event that ends the passive phase | operation (§3.6) |
| `context_j` | `(dish, station, primaryTool)` used for switching cost | derived |
| `requires` | capabilities needed | operation |
| `tedium` | weight 0.5–2 used in the fairness load | operation, default 1 |
| `ES_j, LS_j, LF_j, r_j` | earliest start, latest start, latest finish, release time | computed (§5.3) |

### 3.2 Time model

Active duration is `a_j = (fixed_j + perUnit_j × n_j) / speed_p`, where the operation defines which of `fixed` and
`perUnit` are non-zero. The current `timeline(node, scale)` functions encode this implicitly (`60 * scale`,
`60 * Math.sqrt(scale)`); the catalogue should make the shape explicit so the scheduler can split units:

- `fixed`: mixing a dough. Time does not change much with quantity; cannot be split across people.
- `per-unit`: rolling buns, dipping ladyfingers. Linear in units; can be split across people at unit boundaries.
- `sub-linear`: measuring, spreading. `fixed + perUnit × sqrt(n)`; treated as not divisible.

Switching setup time (§3.7) is added on top when the participant's previous context differs.

### 3.3 Precedence

Three kinds of edges, all derived from input/output references:

1. **Finish-to-start (FS).** Default. `s_k ≥ f_j` when `k` consumes an output of `j`.
2. **Streaming (SS + FF with lags).** When both `j` and `k` are per-unit over the same unit stream (bun 1..64), `k` may
   start after the first unit is through `j`: `s_k ≥ s_j + perUnit_j + handoff`, and `f_k ≥ f_j + perUnit_k`. This is
   what makes pipelines possible. How far `j` may run ahead of `k` is bounded by the **buffer** between them, which is
   physical: the sheets, plates, bowls or counter space that hold units in between (§3.9). `j` may not start unit `i`
   until the carrier that held unit `i − B` has been released, where `B` is the buffer's capacity in units.
3. **Maximum lag (freshness).** `s_k ≤ f_j + hold_j`. The consumer must start before the output degrades. Whipped
   cream, beaten egg white, hot caramel, anything "serve immediately".

### 3.4 Resources

| Resource | Capacity | Notes |
|---|---|---|
| Participant | 1 (or 2+ for team tasks) | availability windows, speed, capabilities, role |
| Tool instance | 1 per instance; `count` instances per type | has a clean state (§3.5); may be `reserved` across the passive phase and until consumption (existing `reserved="true"`) |
| Appliance | `slots` per instance, plus a `mode` | oven: slots = sheets, mode = temperature; changing mode costs `modeSwitchTime` and is itself a (passive) task (`preheat-oven`). Two dishes needing different temperatures cannot share the oven |
| Station | `count` | sink, hob burner, counter area; needed by cleaning and some operations |
| Holding | `slots`, `keeps`, `maxHold` | fridge, warming drawer. Extends `hold_j` for outputs of the matching temperature class, at the cost of a `transfer` task |

Tools and appliances with `capacity` properties (sheet holds 16 buns, bowl holds 4 l) drive batch counts in §3.1. The
bowl-size question in `buns.xml` is answered by the same mechanism: the recipe states the dough volume (a fact), the
inventory states bowl volumes, and the scheduler picks an instance that fits or splits into several.

### 3.5 Tool state and cleaning

Every tool instance is a small state machine:

```
clean ──(bound to task)──▶ in-use ──(released)──▶ dirty(level) ──(cleaning task)──▶ clean
                                       └──(released, soil=none)──▶ clean
```

- `soilAfter` ∈ `{none, rinse, wash}` comes from the operation default and may be overridden per tool reference in the
  recipe when the ingredient makes it a fact (raw egg → `wash`). Compatible consecutive uses (flour then flour) are
  `none`; the catalogue holds a small compatibility table keyed by ingredient class.
- Cleaning time per tool type and level comes from `inventory.cleaning` (defaults: rinse 20 s, wash 90 s, large
  appliance parts 180 s). Cleaning needs the `sink` station and one participant, or a dishwasher slot and no
  participant for most of its duration.
- **Allocation rule.** When a task needs a tool type: prefer a clean instance; otherwise, pick the dirty instance that
  has been dirty longest and insert a cleaning task with release = time it became dirty and deadline = the task's
  start. Only if no instance can be cleaned in time does the task wait.
- **Policies** (`policy.cleaning`):
  - `dedicated`: all cleaning tasks go to participants with `role: cleaner`. Their load counts in fairness like any
    other work (tedium-weighted). If the cleaner is behind, the scheduler may still assign cleaning to cooks but pays
    a penalty.
  - `shared` (default): cleaning tasks are scheduled like any other task. Tie-breaker: the participant who dirtied
    the tool, if that does not worsen the fairness term.
  - `deferred`: clean only when a tool is needed again; nothing else is cleaned during the session.
  - `end-of-session` (additive flag): everything dirty gets a cleaning task with deadline = last serve time + `X`.
    These tasks are ideal fillers for idle stretches and improve fairness at no cost to the dishes.

### 3.6 Completion events, urgency and appointments

A task with a passive phase (`p_j > 0`) ends with a **completion event** at `f_j = s_j + a_j + p_j`. The event has an
active follow-up (take out of the oven, remove from heat, stop the whisk), a window, and an urgency class:

| Urgency | Window after `f_j` | Example | Planner behaviour |
|---|---|---|---|
| `critical` | ≤ 60 s | take out of oven, caramel, deep-frying | reserve an **appointment**; never left to chance |
| `timed` | ≤ 5 min | take out of fridge, stop rising, drain pasta | appointment with a soft window |
| `relaxed` | tens of minutes | chilling overnight, soaking | no appointment; becomes an ordinary ready task |

An **appointment** is a fixed interval `[f_j − lead, f_j + activeDuration]` placed in exactly one participant's lane
when the passive task is scheduled (§5.5, step 6). `lead` (default 30 s) is the hands-free transition time. Later
tasks placed on that lane must either end before it, start after it, or be preemptible at unit boundaries, in which
case they are split around it with a small resume cost. The holder of the appointment also owns the timer.

`monitored` tasks ("simmer, stirring every 3 minutes") generate a series of short appointments at the given interval
with `timed` urgency and a flexible window of ± half the interval.

The planner aims for **zero planned interrupts**: every critical event has a holder who is free by construction.
Interrupts are a runtime mechanism (§6.3) for when the plan drifts.

### 3.7 Contexts and switching cost

`context_j = (dish, station, primaryToolOrOutput)`. The cost of a participant moving from context `c1` to `c2` is
`switch(c1, c2)` seconds, added to the lane as setup time *and* counted in the objective:

| Transition | Default setup time |
|---|---|
| same context (next unit, next stage on the same output) | 0 |
| same dish, same station, different output | 15 s |
| same dish, different station | 30 s |
| different dish | 60 s |
| from cleaning or raw-meat/egg handling to any food prep | +30 s (wash hands) |
| any transition at all | +10 s (read the new instruction) |

The matrix is a policy parameter. The objective adds `λ_switch` per switch beyond the time cost to discourage
fragmentation even where setup time is tiny, and a minimum-run preference: chunks of divisible work should be at
least `minChunk` minutes (default 3) unless a deadline forces smaller.

### 3.8 Dish sinks and serving windows

Each dish `d` gets a virtual `serve_d` task with no duration, consuming every final output of the dish (all portions,
all batches). Its window is `[T_d − earlyTolerance, T_d + lateTolerance]`. Maximum-lag edges from each final output to
`serve_d` carry the output's `hold`: for a hot dish the default is `policy.hotHold` (10 min), for cold
`policy.coldHold` (20 min out of the fridge; unbounded while in the fridge, which is a holding resource), ambient ∞.

Because every portion's output has the same lag into the same sink, "all portions finish roughly together" falls out
of the model: the spread between the first and last portion is bounded by `hold`. When the oven forces sequential
batches whose spread exceeds `hold`, the scheduler first tries a holding resource (warming drawer, oven on low after
the last batch), then reports a soft violation with the actual spread so the host can decide (§5.7).

### 3.9 Buffers, carriers and blocking

Units between two stages have to sit somewhere. That somewhere is a **carrier** (a baking sheet, a plate, a bowl, a
rack) or a **station area** (counter space). Both are finite, and a carrier is not free again when the next stage
starts on it but when a later task hands it back: a sheet holding buns is occupied from "place on sheet" through
brushing, waiting for the oven, baking and taking out, until "transfer to rack" releases it. The recipe already
expresses release points: a `<tool ref>` listed in a task's `<outputs>` means that task returns the tool.

- **Buffer** `buf(j → k)` for a streaming edge: carrier type `c` (or station), capacity per carrier `cap_c` in units,
  and the number of carriers `C` the inventory provides, so `B = C × cap_c`. If no carrier is declared the counter
  station's area is the buffer.
- **Carrier cycle.** `T_c` = time from the first unit placed on a carrier to its release task finishing, including
  every wait in between. Carriers circulate; their throughput is `C × cap_c / T_c` units per second and bounds the
  chain's throughput no matter how many people roll buns.
- **Blocking.** When the buffer is full, the producing stage **pauses**. In the plan this is a `blocked` interval on
  the producer's lane ("waiting for a free sheet"); the participant is released to another ready task if the block is
  longer than the switch would cost, otherwise they wait. **Starvation** is the mirror case (consumer waits for
  units) and is already covered by the start-to-start lag.
- **Where the limit shows up.** Blocked time is lopsided idle and counts in `I` (§4.2); more importantly, Phase D
  sizes the workforce so that no stage produces faster than the slowest sink downstream can take, and Phase E
  simulates the buffer counts so the plan never shows two people rolling buns while every sheet is in the oven.

---

## 4. Constraints and objective

### 4.1 Hard constraints

1. Precedence (FS, streaming lags, maximum lags) as in §3.3.
2. A participant works on at most one task at a time (team tasks count once per member) and only within availability.
3. Tool instances, appliance slots, stations and holding slots are never over-allocated; an appliance in mode `m`
   serves only tasks needing `m`. Carrier buffers are never over-filled: a per-unit producer blocks when its buffer
   is full (§3.9).
4. A tool is used only when clean enough for the task (`soil` state ≤ required).
5. Every task starts at or after its release time and finishes at or before its latest finish (`LF_j`, §5.3).
6. Every dish's `serve_d` falls within its window.
7. Appointments are never overlapped by non-preemptible work on the same lane.
8. Capability requirements are met.
9. Cognitive load: a participant holds at most `maxConcurrentTimers` live appointments at once.

If no schedule satisfies 1–9, the repair ladder in §5.7 relaxes 6 (then 9) in a controlled, reported way. It never
relaxes 1–5, 7 or 8.

### 4.2 Objective

Minimise `W_fair·F + W_idle·I + W_switch·S + W_interrupt·N + W_robust·R + W_span·M + W_stable·C`, with default weights
chosen so the terms rank as: feasibility ≫ fairness and idle ≫ switching ≫ robustness ≫ makespan.

| Term | Definition |
|---|---|
| `F` fairness | Let `L_p = Σ tedium_j·a_j` over tasks (incl. cleaning, appointments and setup time) assigned to `p`, and `E_p = targetShare_p × availability_p / Σ(targetShare × availability) × Σ L`. `F = Σ_p max(0, L_p/E_p − 1)² + Σ_p max(0, 1 − L_p/E_p)²`. Overload and underload both count. Optionally add a variety term so nobody gets only one operation type. |
| `I` idle | Σ over every idle interval of a participant that exceeds `policy.maxIdleStretch` (default 8 min) **while at least one other participant is busy**: `(length − maxIdleStretch)²`. Blocked intervals (§3.9) count as idle. Everybody waiting for the oven together is not penalised. |
| `S` switching | number of context switches, plus `Σ switch(c1,c2)` setup time already paid in the lanes. |
| `N` interrupts | number of appointments whose holder had to be given a split task, plus number of appointments with less than `lead` free time before them. A proxy for runtime interrupt risk. |
| `R` robustness | negative slack: `Σ_j max(0, buffer − (LF_j − f_j))` for critical-chain tasks, so the plan keeps `policy.slackBuffer` (default 10 % of active time, min 2 min) before hard deadlines. |
| `M` makespan | `max_p (last finish) − min_p (first start)`. Low weight by design. |
| `C` stability | only during re-planning: number of tasks whose participant or start (by more than 2 min) changed versus the previous plan within the next `policy.stabilityHorizon` (15 min). |

Defaults: `W_fair = 10, W_idle = 8, W_switch = 3, W_interrupt = 5, W_robust = 2, W_span = 1, W_stable = 4`. All loads
and durations are normalised to minutes before weighting.

---

## 5. Algorithm

### 5.0 Overview

```
A. Normalise & expand       recipe XML → task instances, batches, dish sinks
B. Quantify & bind counts   units per task, batch counts from tool/appliance capacity
C. Backward pass            latest start/finish per task from serve windows; release times from hold
D. Pipeline construction    for per-unit chains: cell vs. pipeline vs. hybrid, stage→participant groups
E. Forward dispatch         time-stepped list scheduling with resources, cleaning insertion, appointments
F. Improvement              bounded local search over priorities/assignments, re-running E
G. Repair                   if E/F cannot satisfy windows: controlled relaxation, reported
H. Emit                     lanes, timers, appointments, handoffs, diagnostics
```

A–C are deterministic preprocessing. D–F form the search; E is the schedule generation scheme that both the offline
plan and every online re-plan use. Offline mode runs the full pipeline with nothing frozen; online mode (§6) re-enters
at C with the past and the present frozen.

### 5.1 Phase A: normalise and expand

1. Parse each recipe; apply `scale`; assign stable instance ids (`<recipe>#<task uuid>#<batch>#<chunk>`).
2. Run operation `expand` functions to fixpoint (existing behaviour).
3. Flatten `<join>` into single tasks.
4. Attach operation metadata (§10.2) and recipe facts (`hold`, `soil`, capacities) to each task.
5. Resolve every `<input ref>` to its producing task or ingredient; build FS edges. Mark edges between per-unit tasks
   over the same unit stream as streaming edges. Add maximum-lag edges where the producer has a finite `hold`.
6. Add `serve_d` sinks with their windows and maximum lags (§3.8).
7. Validate: acyclic, every input resolvable, every task has an operation with a time model.

### 5.2 Phase B: quantities and batch counts

1. Propagate amounts backward from each sink as the current `calculateDependencies` does, producing `n_j`.
2. For each streaming edge, derive its buffer (§3.9): the carrier type from the producer's tool reference, the release
   task from the `<tool>` in some downstream task's `<outputs>`, `cap_c` from the tool's `capacity` property and `C`
   from the inventory. Without a carrier, use the counter station's area. Record the carrier cycle path (producer →
   release task) so Phase D can estimate `T_c`.
3. For each task with a capacity-bearing tool or appliance: `batches_j = ceil(n_j / capacity)`. Instantiate one task
   per batch; streaming edges connect batch `b` of stage `k` to batch `b` of stage `j`.
4. Compute `a_j`, `p_j` from the time model at `speed = 1`; participant speed is applied at assignment time.
5. Derive `context_j`.

### 5.3 Phase C: backward pass (ALAP windows)

Reverse topological order from each sink:

```
LF[serve_d] = T_d + lateTolerance_d
for j in reverse topological order:
  LF[j] = min over successors k of:
            FS edge:        LS[k]
            streaming edge: LF[k] − perUnit_k            (FF lag)
  LS[j] = LF[j] − (a_j + p_j)
  for streaming successors k: LS[j] = min(LS[j], LS[k] − perUnit_j − handoff)   (SS lag)
  // freshness: the consumer must start within hold_j of f_j, so j may not start much earlier than LS_j
  r[j]  = (hold_j finite) ? LS[j] − hold_j : −inf
```

Then a forward pass over `ES_j` from `startTime` (if given) with the same edges but no resources. The critical-path
check is `ES_j ≤ LS_j` for all `j`; if it fails for a given `startTime`, the session cannot finish on time even with
unlimited people, and the repair ladder (§5.7) runs immediately with that diagnosis. If `startTime` is absent,
`startTime = min_j LS_j − policy.slackBuffer` is the proposal shown to the host, refined after Phase E.

Tasks fall into two classes, which the dispatcher treats differently:

- **Anchored** (`r_j > −inf`, i.e. a finite hold somewhere downstream): must run inside `[r_j, LS_j]`. Whipping cream,
  baking, plating.
- **Floating** (`r_j = −inf`): may run any time after `ES_j`. Measuring, chopping, greasing a tin, cleaning. These are
  the material the scheduler uses to fill gaps and balance load. The host's `miseEnPlace` preference becomes a bias
  on floating tasks toward the start of the session instead of a separate code path.

### 5.4 Phase D: pipeline construction

Input: a **chain** of per-unit stages `S_1 → S_2 → … → S_m` over the same unit stream (detected via streaming edges;
in `buns.xml`: split → spherify → place-on-sheet → brush → sprinkle, then per-sheet bake). Per stage: per-unit time
`u_s`, tool requirements with instance counts `q_s` (∞ if tool-free), and the number of participants `k` the
dispatcher expects to have free during the chain's window (from Phase C and current lane loads).

Three organisations are considered:

1. **Cell.** Each participant takes a contiguous slice of the units and performs all stages on it. Throughput `k / Σu`,
   zero switches, no hand-offs. Feasible only if every stage has `q_s ≥ k` (or is tool-free).
2. **Pipeline.** Stages are grouped into `k` contiguous groups; each participant performs one group on every unit.
   Throughput `1 / max_g Σ_{s∈g} u_s`, fill latency `Σ_g (group time)`, `m − 1` hand-offs, one context per person.
   Feasible if every stage has `q_s ≥ 1`. This is assembly-line balancing (SALBP-2) with `m ≤ ~8`, `k ≤ ~6`: enumerate.
3. **Hybrid.** Any stage `s` may be replicated `d_s ≤ q_s` times across participants, and stages may be grouped. The
   search enumerates `(grouping, replication)` combinations; cell and pipeline are its two extremes.

**Sinks and buffers bound the useful rate.** Before scoring, compute the chain's **sink rate** `r*`: the slowest of
(a) every downstream resource the units flow into, e.g. an oven with `slots × cap_c` units per bake duration,
(b) every carrier buffer's circulation rate `C × cap_c / T_c` (§3.9), and (c) the rate the serve window requires.
`T_c` is estimated from the carrier cycle path: the stage times on the carrier, the expected wait for the sink, the
sink's own duration, and the release task. Any stage group producing faster than `r*` blocks; the surplus people
are wasted on this chain and are better used elsewhere.

Scoring per candidate, in order: (a) the chain's finish `≤ LF` of its last stage; (b) effective cycle time
`max(max_g Σ_{s∈g} u_s / d_s, 1 / r*)`, simulated against the buffers so that blocked time is included;
(c) **workforce**: among candidates that satisfy (a), the smallest `k' ≤ k` that still does, found by removing
replicas one at a time while the chain's finish stays inside its window, so that `k − k'` people are returned to the
dispatcher for other work; (d) balance `max_g − min_g` of per-person per-unit load among the `k'` kept, which directly
feeds `F`; (e) hand-offs and switches, which feed `S`; (f) fill latency, which matters when the window is tight. The
best candidate is materialised as chunked tasks (cell slices or stage groups) with streaming edges and their buffers,
and handed to Phase E. Phase F may revisit the choice as one of its moves.

Buffers make the chain bursty: it fills `B` units, blocks until carriers return, then fills again. Workforce is
therefore sized **per burst**, not once. A burst that is off the critical path (the first sheets, filled during the
rise with time to spare) gets the minimum staff; a burst that is on it (the sheets that come back 15 minutes before
serving) gets everyone free, because every minute of filling there delays the last bake. Phase D emits one chunk per
burst with its own window, and the dispatcher's blocking rule (§5.5 step 4f) does the interleaving with other work.
Phase D's job is to stop over-staffing the bursts that have slack.

Worked numbers are in §8.

### 5.5 Phase E: forward dispatch

A parallel schedule-generation scheme: advance a clock over event times, and at each time assign ready tasks to free
participants and resources. Priority is by latest start (least slack), assignment is by cost.

```
t = startTime
state: lanes[p], toolInstances (with clean state), applianceSlots, stations, holdingSlots,
       appointments[p] (blocked intervals), loads L[p], lastContext[p], liveTimers[p]
unscheduled = all tasks

while unscheduled not empty:
  1. Release: for every task finishing at t, free its participant(s), release tools (→ dirty(soilAfter) or clean),
     release appliance/station slots, mark successors' edges satisfied (FS at finish; SS at start + lag; FF at finish + lag).
     A released carrier decrements every buffer it served and wakes producers blocked on it (step 4f).
  2. Ready set = tasks with all incoming edges satisfied and r_j ≤ t and ES_j ≤ t.
     Appointments whose window opens at t join the ready set at the front with their fixed holder.
     Freshness: once a producer j with finite hold_j is placed, each consumer k gets
     LS'_k = min(LS_k, f_j + hold_j) and LF'_k = LS'_k + a_k + p_k. Phase C's release times make this
     satisfiable when k runs by LS_k; the tightened values catch resource contention that delays k.
  3. Sort ready by key (urgencyRank, LS'_j, −tedium_j, id).   // deterministic
  4. For each ready task j in order:
     a. Tools: bind instances (§3.5). If a needed instance is dirty and none is clean:
        create cleaning task c with release = dirtySince, LF = LS_j; push c into unscheduled/ready; skip j this round.
     b. Appliance: if mode differs from the slot's current mode, the preheat/mode-switch task must precede; it is
        already a task from expansion, so this is just a precedence check. Bind a slot.
     c. Candidates = participants free at t, available through t + a_j (or preemptible), with capabilities,
        with liveTimers < max if j has a completion event.
        cost(p, j) = switch(lastContext[p], context_j)
                   + λ_fair × (L[p] − mean L) / mean L
                   + λ_speed × (a_j / speed_p − a_j)
                   + λ_role × (j is cleaning and role_p ≠ cleaner, when policy = dedicated)
                   + λ_same × (0 if j continues a chain p is already on, else 1)
        If j is divisible(units) and ≥2 candidates are free and either slack is tight or the fairness term improves,
        split j into chunks ≥ minChunk and assign the chunks to the cheapest candidates; otherwise assign to argmin.
        If no candidate: leave j in ready.
     d. Place: s_j = t + switch setup; f_j = s_j + a_j/speed_p (+ p_j for the passive phase). Add setup time to L[p].
        If the lane has an appointment inside [s_j, f_j): if j is preemptible(units), split j around it and add
        resumeCost; otherwise reject this candidate and try the next.
     e. Feasibility: if f_j > LF_j, record a violation (Phase G) but keep placing; the search needs a complete
        schedule to score.
     f. Buffers: a per-unit task advances unit by unit against its outgoing buffer count (units placed minus
        carriers released × cap_c). When the count reaches B the task enters `blocked` at that unit: its lane shows
        a blocked interval until the next carrier release event. If the predicted block exceeds
        switch(context_j, next ready task) + minChunk, the participant is released to the dispatcher with the task
        left `paused` at a unit boundary and a `resume` item queued on the release event; otherwise they wait.
        Carrier release tasks (the ones listing the carrier in <outputs>) get a priority boost proportional to the
        number of producers blocked on that carrier, so sheets come back as early as possible.
  5. Completion events: for each task placed in 4 with p_j > 0 and urgency ∈ {critical, timed}:
        holder = argmin over participants of
                   λ_fair × (L[p] − mean L)/mean L
                 + switch(expected context of p at f_j, context_j)
                 + λ_timer × liveTimers[p]
                 + λ_free × (p's lane already has planned work overlapping [f_j − lead, f_j + dur])   // normally 0 at this point
        Block [f_j − lead, f_j + completionDuration] in lanes[holder]; attach the timer to the holder.
        For monitored tasks: block the periodic check intervals similarly.
  6. Fillers: for each participant still free at t with no ready task: if policy.endOfSessionCleaning and dirty tools
     exist whose owners are not about to need them, assign a cleaning task. (This is what keeps people busy and fair
     during long passive phases.)
  7. t = next event: min(next finish, next release r_j, next ES_j, next appointment open, next availability change).
```

Notes:

- Team tasks (`divisible: team`) take `maxPeople` participants if free and shorten by `speedup`; otherwise one.
- The anchored/floating split means the dispatcher does not start whipping cream at the beginning of the session just
  because a participant and a whisk are free: `r_j` forbids it.
- The dispatcher never produces a planned interrupt: step 5 reserves the holder's lane before any later task can be
  placed there, and step 4d refuses to overlap a non-preemptible task with an appointment.

### 5.6 Phase F: improvement

Representation: a priority vector (one key per task, initialised from `LS_j`) and an assignment-preference vector
(per task, an ordered list of participants, initialised empty = "use cost"). Phase E is deterministic given these
vectors, so search over them. Moves:

1. Swap the preferred participant of a task or chunk between two participants whose loads differ most.
2. Shift a floating task's priority earlier/later (moves it into or out of an idle stretch).
3. Re-chunk a divisible task (merge two chunks, split one) to lengthen runs or balance load.
4. Change a chain's organisation (Phase D candidate rank 2, 3, …).
5. Change an appointment holder.
6. Swap the order of two adjacent tasks on one lane with no precedence between them.
7. Change a chain's workforce by one (add or remove a replica) when its lanes show blocked time or starvation.

Simulated annealing (or late acceptance) with a seeded PRNG, evaluated by the objective in §4.2 plus a large penalty
per hard-constraint violation. Time budget `policy.searchBudgetMs` (default 400 ms initial plan, 120 ms re-plan),
run in a Web Worker. Determinism matters because the app is peer-to-peer: the host computes the plan and broadcasts
it, and every peer that replays the same event log with the same seed obtains the same plan.

### 5.7 Phase G: repair

Run when the best schedule still violates a hard window, or when Phase C's critical-path check fails. Steps are
tried in order, each reported in the diagnostics with its effect:

1. Drop the slack buffer (`R` is a soft term; this just reports it).
2. Chunk divisible tasks below `minChunk` and allow more switches (raise `k` in Phase D).
3. Use holding resources to decouple portions from the serve time (extends `hold` on final outputs).
4. Serve-window spread: if sequential oven batches cannot all be hot, report the spread per dish; schedule batches
   back-to-back ending at `T_d` so the spread is minimal.
5. Delay `T_d` for the latest-finishing dish by the minimum amount; if several dishes share a serve time, delay all
   together so the meal stays coherent. Report the new time.
6. Propose an earlier `startTime` (if it was given) or more participants, with the computed shortfall.

Steps 5 and 6 are proposals to the host, not silent changes. The plan shown is the one after step 4 with the violations
highlighted until the host accepts 5 or 6.

### 5.8 Phase H: emit

See §9 for the schema. Besides lanes, emit: appointments and timers per participant, hand-off points (which output
goes from whom to whom), the cleaning tasks created and why, a fairness report (`L_p / E_p` per participant, longest
idle stretch, number of switches), and diagnostics from Phase G.

---

## 6. Operating modes, execution, re-planning and interrupts

### 6.0 Offline and online mode

The same engine (Phases C–H) serves both modes. What differs is the clock, the frozen set and what is reported.

| | Offline (before start) | Online (after start) |
|---|---|---|
| `now` | the planned `startTime` (given, or proposed by Phase C) | wall-clock time of the triggering event |
| Frozen | nothing | completed tasks, in-progress tasks and their holders, near-future appointments |
| Participants | the expected roster; names may be placeholders ("Cook 2") | the connected roster; a placeholder lane is remapped to the person who joins (§6.0.3) |
| Actuals | none; every duration is the catalogue estimate | reported starts/finishes replace estimates; remaining work is re-estimated |
| Objective | §4.2 without the stability term | §4.2 with `W_stable` |
| Output | the full plan plus diagnostics and the fairness report | a plan diff per participant plus the full plan |
| Trigger | any input change, with a small debounce | the events in §6.1, debounced (§6.2) |

#### 6.0.1 Plan lifecycle

```
draft ──(host presses Start)──▶ running ──(all serve_d reached)──▶ done
  ▲  └── inputs change: re-plan, stays draft        │
  └──────────── host presses Reset ◀────────────────┘
```

- **Draft.** Offline mode. The host (and anyone with the link) sees the complete plan: every lane end to end, every
  appointment, timers, hand-offs, the projected serve time per dish and the fairness report. Changing a serve time,
  adding a participant, toggling a policy or editing the inventory re-runs the plan from scratch (no frozen set) with
  the same seed, so edits are comparable. The draft is also the "what-if" tool: plan with four people before
  anyone has arrived, or compare dedicated versus shared cleaning.
- **Running.** Online mode. Pressing Start records `startTime = now` and, if that differs from the planned start by
  more than `policy.replanThreshold`, triggers the first online re-plan. From then on §6.1 events drive updates. The
  full plan stays visible; each participant additionally sees a diff on every update.
- **Done.** All dish sinks reached or the host ends the session. Metrics (§12) are flushed for calibration.

A late start is handled like any other drift: the planned start passes, `now` moves, floating tasks lose slack first,
and only when the critical path no longer fits does Phase G report a serve-time delay.

#### 6.0.2 What a task event changes

`taskStarted(p, j, t)` and `taskDone(p, j, t)` are the primary online inputs. Each is applied to the plan state before
the re-plan decides whether anything needs to move:

| Event | State change | Then |
|---|---|---|
| started on time (± threshold) | `j.status = started`, `actualStart = t` | no re-plan |
| started late | as above; the lane's later items shift by the delay | re-plan if the shift crosses an appointment, a release time or the threshold |
| started early | as above; later items pull forward only if their predecessors and `r_j` allow | re-plan (usually a small gain for fairness fillers) |
| done, duration ≈ planned | `status = done`, `actualEnd = t`; successors' edges satisfied at `t` | no re-plan |
| done early/late | as above; `p` is free from `t`; successors' earliest start moves | re-plan from `t` |
| started by someone other than planned | `j.participant = p'`; the planned holder's lane loses the item | re-plan, with `W_stable` keeping the rest put |
| done without started | infer `actualStart = t − a_j` and apply both rules | as for done |
| paused (interrupt, §6.3) | `status = paused`, remaining units recorded; a `resume` item is created | re-plan |

Per-unit progress reports also update buffer occupancy, so a producer that is about to block in reality is shown
"waiting for a free sheet" live, and a carrier release done early wakes it early.

In-progress tasks are never reassigned by a re-plan; their remaining duration is `max(0, a_j − (now − actualStart))`
for fixed tasks and `(units left) × perUnit` for per-unit tasks with reported progress. A task overdue by more than
`2 × a_j` is flagged in the holder's UI ("still rolling?") but not reassigned; only an explicit pause or done changes it.

#### 6.0.3 Reconciling placeholder lanes

An offline plan may have lanes for people who have not joined. When a participant connects, they take the placeholder
lane with the closest matching profile (speed, capabilities, role); if none matches, the cheapest lane by `W_stable`.
Lanes for people who never arrive are removed at Start and their work redistributed by the first online re-plan, which
is reported as a Phase G diagnostic if the serve window no longer fits.

### 6.1 Events

The plan is a forecast. The host session collects events:

- `taskStarted(p, j, t)`, `taskDone(p, j, t)` from the "Done, next!" button (existing).
- `timerFired(j)`, `appointmentAcknowledged(p, j)`.
- `participantJoined/Left(p, t)`, `participantPaused(p, t, duration)` (bathroom, phone call).
- `resourceChanged` (oven turned out to hold one sheet, a bowl broke).
- `deadlineChanged(d, T_d)` (guests are late).

### 6.2 Re-planning

Trigger: any event that moves a planned time by more than `policy.replanThreshold` (default 90 s) or changes
resources/participants/deadlines. Debounced to at most one re-plan per `policy.replanDebounce` (10 s).

Procedure (online mode): freeze the past and the present, re-run C–F from `now`:

- Completed tasks are removed; in-progress tasks keep their participant and get `a_j` = remaining estimate (reported
  progress for divisible tasks, else elapsed-based).
- Appointments within `policy.stabilityHorizon` keep their holder unless the holder cannot make it; then §6.3 applies.
- `W_stable` penalises moving near-future tasks between people, so small drifts produce small plan changes.
- Participants see a diff: "your next task changed from X to Y because the oven is running late".

### 6.3 Interrupts

An interrupt is needed when a `critical` or `timed` event's window is about to open and its holder is not free. The
dispatcher looks ahead by `lead + policy.reactionTime` (default 30 s + 30 s).

```
onEventImminent(e):
  holder = e.holder
  if holder is free or on a task ending before e.window.open: notify holder (normal timer alert); return
  candidates = all participants; for each p:
    cost(p) = switch(p.currentContext, e.context)
            + preemptionCost(p.currentTask):   free → 0
                                               preemptible(units) → resumeCost + (time to unit boundary)
                                               preemptible(anywhere) → resumeCost
                                               never (pouring hot caramel, carrying a tray) → ∞
            + (p.currentTask.urgency == critical ? ∞ : 0)
            + λ_timer × liveTimers[p]
            + walkingTime(p.station, e.station)
  target = argmin cost; if cost == ∞ for all: broadcast to everyone (someone is always at least "preemptible anywhere")
  send interrupt(target, e); start acknowledgement timer policy.ackTimeout (15 s)
  on timeout: remove target from candidates, repeat
onInterruptAccepted(p, e):
  pause p's current task at the next unit boundary; insert a resume item for it after e; trigger re-plan
```

The UI treatment of an interrupt differs from a normal task change: full-screen alert with sound, a single "I'm on
it" button, and the paused task shown as "resume: 23 buns left to roll". The interrupted task's remaining units may be
re-chunked to another participant by the re-plan if that is cheaper.

Planned interrupts should be rare. The diagnostics count runtime interrupts per session; a high count means the
duration estimates in the operation catalogue need calibration (§12).

---

## 7. Fairness, idle and switching: rationale and tuning

- **Why both over- and under-load count in `F`.** Penalising only overload lets the search park a slow or new
  participant with nothing to do. The product goal is that everybody cooks.
- **Why idle is measured against others being busy.** During a 20-minute rise with nothing else to do, everyone is
  idle together; that is a break, not unfairness. The term only fires when idleness is lopsided.
- **Tedium weights** let one minute of washing up count for 1.5 minutes of rolling buns in the load. Defaults:
  cleaning 1.5, measuring 1.2, monitored checks 0.8, everything else 1.0. Session policy can override; a participant
  who enjoys washing up can have the cleaning weight lowered for them.
- **Why switching is a cost and a count.** Setup time alone would let the search fragment work into many tiny pieces
  with near-zero setup each. The per-switch constant and `minChunk` prevent that.
- **Fairness vs. switching tension.** Balancing load by handing half of a long task to someone else introduces a
  switch for the second person. The weights make a 3-minute imbalance acceptable but a 10-minute one not; `minChunk`
  sets the granularity. These are the main knobs for the host.
- **Speed.** A participant with `speed 0.5` is expected to do half the active minutes for the same *share*. `E_p` is
  therefore expressed in speed-normalised minutes so that a slower cook is not overloaded in wall-clock terms.

---

## 8. Worked example: buns, three participants

Recipe `buns.xml`, scaled to 64 buns. Inventory: 1 oven with 2 sheet slots, 4 sheets (capacity 16), 2 bowls, 1 pastry
brush, 1 sink. Serve at 18:00, hot dish, `hotHold` 10 min. Participants A, B, C, equal speed.

**Phases A–C.** Expansion gives: 7 measure tasks (floating), heat milk, crumble+incorporate (joined), incorporate,
mix-in-steps, incorporate butter, raise (20 min passive, `timed` completion), split into 64 units, 4 line-sheet tasks,
the per-unit chain spherify (15 s/unit) → place-on-sheet (5 s) → brush (5 s) → sprinkle (5 s) streaming into 4 sheet
batches, 2 bake rounds of 2 sheets (15 min passive, `critical` completion, oven mode 250 °C), preheat (floating but
anchored to the first bake by the oven mode), and `serve`. Backward pass: last bake must end in `[17:50, 18:05]`;
both rounds would need to end ≤ 10 min apart to be inside the hold, but one oven and 15-minute bakes force a
15-minute gap. The backward pass places round 2 ending 18:00 and round 1 ending 17:45 and flags the 15-minute spread
against the 10-minute hold. Phase G step 4 reports it; the host accepts (or turns the oven to 80 °C as a
holding resource after round 2, which the inventory would have to declare).

**Phase D, the chain.** Stages `u = (15, 5, 5, 5)`, total 30 s/unit, `k = 3`. Brush has `q = 1`; the others are
tool-free or have ≥ 3 instances.

| Candidate | Per-person load per unit | Cycle | 64 units | Switches / hand-offs |
|---|---|---|---|---|
| Cell (each does all stages on ~21 buns) | 30 / 30 / 30 | 10 s | 10.7 min | infeasible: one brush |
| Pipeline A=spherify, B=place+brush, C=sprinkle | 15 / 10 / 5 | 15 s | 16 min | 2 hand-offs, C idle 2/3 of the time |
| Hybrid A,B = spherify+place on own slices; C = brush+sprinkle | 20 / 20 / 10 per unit, but A+B together deliver 1 unit / 10 s | 10 s | 10.7 min | 1 hand-off, balanced |

The hybrid wins: it meets the cell's throughput while respecting the single brush, and A and B's load (20 s/unit on
32 units = 10.7 min each) matches C's (10 s/unit on 64 units = 10.7 min). Fill latency is 20 s.

**Buffers.** The sheet is the carrier between "place on sheet" and the oven; it is released by "transfer to rack"
after take-out. With 4 sheets of 16 and a 2-slot oven the buffer is 64 units, the whole batch, so nothing blocks and
the chain above runs at its people-limited rate. **With only 2 sheets** the buffer is 32 units and the carrier cycle
is about 18 minutes (fill 3 min, wait, bake 15 min, take out, transfer), so carriers circulate at 32 / 18 ≈ 1.8 buns
per minute while three people could roll 6. The chain becomes two bursts of 32. The first burst has slack (it only
has to be ready when the oven is hot), so Phase D keeps one person on it in cell mode (16 minutes, 2 buns per minute)
and returns two people to the dispatcher for the other dish's floating tasks and cleaning. The second burst starts
when the sheets come back at about 17:40 and is on the critical path, so all three fill it in 5 minutes and the last
bake still ends before 18:00. Without the per-burst sizing the plan would either show two people rolling for five
minutes and standing still for thirteen, or one person filling the second burst for 16 minutes and the buns 11 minutes
late.

**Phase E, the big picture.** Measuring is spread over all three at the start (floating, filler). Mixing the dough is
fixed-time and non-divisible: one person (A, least loaded after measuring) does it while B lines sheets and C beats the
brushing egg and heats the milk earlier. During the 20-minute rise everyone is idle together (no `I` penalty); with
`endOfSessionCleaning` the two bowls and the scale are washed now by B and C, and the oven preheat appointment (a
floating task anchored by mode) is placed so that the oven is at 250 °C when sheet 2 is full. The rise's `timed`
completion ("check the dough") is an appointment for A. The chain runs as above; sheets 1–2 go in as soon as both are
full (streaming into bake round 1), sheets 3–4 follow. The two `critical` take-out appointments are given to B and C
respectively (A holds the dough timer; `maxConcurrentTimers` and fairness), with 30 s lead each. Final fairness report:
loads within 6 % of each other, longest lopsided idle 3 min, 4 switches in total.

---

## 9. Output schema

```
Plan {
  mode: "offline" | "online", status: "draft" | "running" | "done",
  seed, computedAt, now, startTime, diagnostics: [ { code, message, dish?, task?, delta? } ],
  diff?: [{ participantId, changes: [{ uuid, field, from, to, reason }] }],   // online only, vs. the previous plan
  lanes: [{                                    // one per participant, same order as session.participants
    participantId,
    items: [{
      uuid,                                    // task instance id (recipe#task#batch#chunk)
      kind: "work" | "cleaning" | "appointment" | "check" | "setup" | "resume" | "idle",
      start, end,                              // planned, absolute (UI may still render relative to serve time)
      status: "planned" | "started" | "paused" | "done",
      actualStart?, actualEnd?, progress?,     // online only; progress = units done for per-unit tasks
      title, instructions,                     // as today
      task,                                    // XML node reference for the UI helpers
      context: { dish, station, tool },
      units?: { from, to, of },                // for chunks: "buns 1–32 of 64"
      inputsFrom: [{ outputId, participantId, byTime }],   // hand-offs
      outputsTo:  [{ outputId, participantId, byTime }],
      preemptible: "never" | "units" | "anywhere",
      urgency?: "critical" | "timed" | "relaxed",
      window?: { earliest, latest },           // for appointments/checks
      timer?: { title, duration, firesAt },    // the holder owns it
      dependencies: [uuid],                    // kept for the existing graph view
      tools: [{ type, instanceId }],
    }],
    report: { load, expectedLoad, switches, longestLopsidedIdle, timersHeld }
  }],
  dishes: [{ dishId, serveTarget, plannedServe, spread, holdUsed }],
}
```

The existing UI's `timelines[lane][index]` maps onto `lanes[lane].items[index]`; `start/end` become absolute and
`kind` is new. Items of kind `idle` are optional and only for rendering.

---

## 10. Recipe and operation format enhancements

All additions are optional and have defaults. Nothing here tells the scheduler *who* or *when*.

### 10.1 Recipe XML (`recipe.xsd`)

| Addition | Where | Why it is a fact | Example |
|---|---|---|---|
| `<serving temperature="hot|cold|ambient" hold="10" hold-unit="minutes"/>` | `<recipe>` | how long the finished dish stays servable | buns: hot, 10 min; tiramisu: cold, 20 min out of the fridge |
| `hold` / `hold-unit` attributes | `<output>` | how long an intermediate result stays good before its consumer must start | `<output id="whipped-cream" hold="30" hold-unit="minutes">` |
| `soil="none|rinse|wash"` | task-level `<tool ref>` | the ingredient makes the tool need washing (raw egg, meat, allergen) | `<tool ref="bowl" soil="wash"/>` |
| `<property name="capacity">` with a unit | `<tool>` definition | physical size | sheet: 16 buns; bowl: 4 l; tin: 1 cake |
| `<property name="volume">` on outputs or `volume` option on mix tasks | `<output>` | lets the scheduler pick a bowl that fits a dough that doubles (the `buns.xml` TODO) | `<output id="dough" volume="2.5" volume-unit="liters">` |
| `unit="bun"` on per-unit outputs | `<output>` | names the unit stream so streaming edges can be detected | `<output id="dough-sphere" unit="bun">` |
| `<tool ref>` inside `<outputs>` (existing) | task | the task returns the carrier; defines the buffer's release point (§3.9) | `<outputs><output id="buns-on-rack"/><tool ref="baking-sheet"/></outputs>` |
| `requires="knife|hot-pan|..."` | `<task>` | a safety fact about the step, used for capabilities | `<task operation="slice" requires="knife">` |
| `<batch>` | keep, but semantics become "the contained tasks apply per unit of the input"; the scheduler decides parallelisation | the current element already means this; the TODOs in `buns.xml` about parallel processing move to the scheduler | — |
| `<join>` | keep; flattened by Phase A | — | — |

Not added, on purpose: anything naming participants, counts of people, "do this in parallel", priorities, lane hints.

### 10.2 Operation catalogue (`operations.xsd` / `operations.js`)

| Attribute | Values | Default | Used by |
|---|---|---|---|
| `time-model` | `fixed`, `per-unit`, `sub-linear` | from the existing `timeline` function shape | §3.2 |
| `attention` | `attended`, `monitored` (with `check-interval`, `check-duration`), `unattended` | `attended` if `passive = 0`, else `unattended` | §3.6 |
| `divisible` | `none`, `units` (with `min-chunk`), `team` (with `max-people`, `speedup`) | `units` for `per-unit`, else `none` | §5.4, §5.5 |
| `preemptible` | `never`, `units`, `anywhere` (with `resume-cost`) | `units` for per-unit ops, `anywhere` for long attended ops like `whip`, `never` for `pour`, `transfer`, `take-out-of-oven` | §6.3 |
| `completion-urgency`, `completion-early`, `completion-late`, `completion-duration` | see §3.6 | `relaxed` | §3.6 |
| `soil` | per tool role: `none`, `rinse`, `wash` | `rinse` | §3.5 |
| `station` | `counter`, `hob`, `oven`, `sink`, `fridge` | `counter` | §3.7 |
| `tedium` | 0.5–2 | 1 | §4.2 |
| `requires` | capability | none | §4.1 |

`operations.xml` already exists with `timeline active/passive`; these attributes extend it, and `operations.js` reads
them so a recipe author never has to repeat them.

---

## 11. Session policy parameters

| Parameter | Default | Effect |
|---|---|---|
| `weights` (`W_fair`, `W_idle`, `W_switch`, `W_interrupt`, `W_robust`, `W_span`, `W_stable`) | 10, 8, 3, 5, 2, 1, 4 | objective (§4.2) |
| `switchMatrix` | §3.7 table | setup times |
| `minChunk` | 3 min | smallest piece of divisible work |
| `maxIdleStretch` | 8 min | idle penalty threshold |
| `slackBuffer` | 10 %, min 2 min | robustness before hard deadlines |
| `hotHold`, `coldHold` | 10 min, 20 min | serving windows when the recipe gives none |
| `cleaning` | `shared` | `dedicated`, `shared`, `deferred`, plus `endOfSessionCleaning: true/false` |
| `miseEnPlace` | `false` | bias floating measure tasks to the start |
| `lead`, `reactionTime`, `ackTimeout` | 30 s, 30 s, 15 s | appointments and interrupts |
| `maxConcurrentTimers` | 2 per participant | cognitive load |
| `replanThreshold`, `replanDebounce`, `stabilityHorizon` | 90 s, 10 s, 15 min | runtime |
| `searchBudgetMs` | 400 initial, 120 re-plan | Phase F |
| `seed` | session id hash | determinism across peers |
| `teaching` | off | pairs a participant flagged `learning` with an experienced one on team-capable tasks, at reduced speedup |

Suggested additional inputs that improve plans and are cheap to ask for in the UI: kitchen layout distances between
stations (feeds walking time), whether the oven has a fan (affects capacity to bake two sheets evenly, i.e. `slots`),
and a "stress limit" (max number of `critical` appointments within any 5-minute window across the whole session,
default 2) that the search treats as a soft constraint so the plan never asks three people to pull three things out
of the oven at 17:59.

---

## 12. Testing and evaluation

Property checks on every produced plan (run in unit tests and in a debug assertion at runtime):

- No participant, tool instance, appliance slot or station is double-booked.
- All precedence and lag constraints hold; every anchored task is inside `[r_j, LS_j]`.
- No non-preemptible item overlaps an appointment on the same lane.
- Every `critical` and `timed` completion has exactly one holder and a timer.
- Every `serve_d` is inside its window, or the diagnostics contain a Phase G entry for it.

Scenario suite (fixtures from `packages/server/src/recipes`):

| Scenario | What it exercises | Pass criterion |
|---|---|---|
| buns, 1 participant | degenerate case, appointments on the only lane, chain runs as a cell | plan equals a sensible single-cook order; no interrupt |
| buns, 3 participants, 1 brush | §8 | hybrid chosen; loads within 10 %; 2 take-out appointments on different lanes |
| buns + tiramisu, serve 18:00 and 18:30 | multi-dish, cold hold, fridge as holding | both windows met; tiramisu assembly not started before its `r_j` |
| cheese-cake with one bowl | cleaning insertion | cleaning task appears between incompatible uses; `dedicated` policy routes it to the cleaner |
| negroni ×6 | per-unit chain without an oven, tiny tasks | `minChunk` respected; few switches |
| buns, 3 participants, 2 sheets | buffer blocking, workforce sizing (§3.9, §5.4) | one person on the chain; no lane shows more than `switch + minChunk` of blocked time; sheet-return tasks scheduled first after take-out |
| late oven (runtime event) | re-plan stability | tasks within 15 min keep their holder; drift absorbed by floating tasks |
| holder busy at take-out time (runtime event) | interrupt | cheapest preemptible participant chosen; paused task resumed |

Metrics to log per real session for calibrating the catalogue: planned vs. actual durations per operation and per
participant, number of re-plans, number of interrupts, final lateness per dish, fairness `L_p / E_p`. The operation
`timeline` constants in `operations.js` are the biggest source of plan error today and should be fitted from these.

---

## 13. Implementation roadmap

1. **Core, offline mode (replaces `timelineScheduler.js`).** Phases A, B, C, E, H with FS edges, anchored/floating
   classes, fairness and switching costs, appointments for `critical`/`timed` completions, absolute times. Existing
   recipes work with catalogue defaults. The UI reads `lanes[].items[]` and shows the full draft plan before Start.
2. **Resources and cleaning.** Tool instances, capacities, batch instantiation, cleaning insertion and policies,
   appliance modes.
3. **Pipelines.** Streaming edges, Phase D, chunked per-unit tasks, hand-off display.
4. **Search and online mode.** Phase F in a Web Worker; Start, task start/done events, frozen-prefix re-planning
   with the stability term, placeholder-lane reconciliation, the per-participant diff, the interrupt flow and its UI.
5. **Calibration.** Session metrics, fitted durations, tuned default weights.

---

## 14. Open questions

- Should `hold` be allowed to depend on the holding resource in the recipe ("30 min at room temperature, 24 h
  refrigerated") or stay a single number with the inventory supplying the extension? The spec assumes the latter.
- How should the UI present a cell-mode chain to a participant: as one item "roll, place and brush buns 1–32" with a
  progress counter, or as three sequential items? The scheduler emits chunks per stage group; the presentation is the
  UI's choice, but the "Done, next!" granularity determines how precisely progress is known for re-planning.
- Team tasks and teaching mode need the recipe to say when two people *can* work on one task (a `team` divisibility on
  the operation is the proposal) and never that they *must*.
- Whether the host or every peer runs the search. The spec assumes host-authoritative with deterministic replay as a
  fallback for host loss.

---

## 15. Implementation notes (status of the code against this spec)

The engine lives in `packages/scheduler` (pure ESM JavaScript, contracts in its README). The server plans on behalf
of a session (`packages/server`, API in `packages/server/API.md`); the client renders the plan (`packages/client`).

| Spec section | Module | State |
|---|---|---|
| §2, §10 recipe format and catalogue | `recipe.xsd` v2, `operations.xsd` v2, `src/recipe`, `src/catalogue` | done; all nine recipes migrated and validated (`scripts/validate-recipes.js`) |
| §3, §5.1–5.2 model, expansion, batches, streams, buffers, sinks | `src/graph` | done; carriers follow their batch through streaming stages and are freed by the task that lists them in `<outputs>` |
| §5.3 windows, anchored / floating | `src/planner/windows.js` | done; floating work additionally keeps within `policy.floatWindowSeconds` of its latest start |
| §5.5 dispatch: people, tool instances, cleaning, appliances with modes and slots, stations, holding, appointments, chunking, buffers/blocking, fillers | `src/planner/dispatch.js`, `resources.js`, `cost.js` | done |
| §5.4 pipelines, §5.6 search, §5.7 repair | `src/planner/pipeline.js`, `search.js`, `repair.js`, `objective.js` | in progress; the float-window rung of the ladder is in `plan()` |
| §6 online mode, interrupts | `src/online` | done; `dueInterrupts` is polled by the server |
| §8 worked example | `scripts/plan-recipes.js buns 3`, `bin/demo.js --sheets 2` | reproduces the oven rounds, appointments and the two-sheet blocking |
| §12 property checks | `src/planner/check.js` (run on every plan; violations become an `INVARIANT` diagnostic) | done |
| simulation | `src/sim` (CLI `bin/demo.js`, in-app `/demo`) | done |

Decisions taken while implementing that refine the spec text:

- **Carrier identity is per producer batch.** A tool holding an output is bound under `${outputId}#b<n>`; a
  consumer takes the instances bound to its predecessors' keys, limited to the carriers its own units need, and
  re-binds them under its own key. Consumers that do not list the carrier still carry it (buns stay on the sheet
  through brushing). Only a task that lists the type in `<outputs>` frees it. A streaming consumer may re-bind an
  instance before the producer finishes, so finishing never overwrites a binding.
- **Shared containers.** Two tasks whose outputs feed the same consumer may share one reserved container when no
  other instance exists (flour and sugar measured into the same bowl).
- **Compatible reuse.** A dirty tool last used on the same dish and the same recipe step or unit stream needs no
  cleaning between uses (one pastry brush across four sheets). Instruments (scales, towels, racks, films) never
  soil.
- **Short passive phases** (under `policy.minAppointmentPassiveSeconds`, default 3 min) keep the cook at the pan
  instead of creating an appointment.
- **Hold placement matters.** The hold that limits how long buns may wait belongs on the baked output, not on the
  transfer to the rack; otherwise the planner delays the transfer to keep the *rack* fresh.
- **Container-level operations** (transfer, line, pour, cover, stack) use a fixed cost plus a small per-unit term;
  a per-bun transfer time made moving a sheet of buns take an hour.
- **Fair share is relative to work assigned so far** (with a floor), not to the recipe total, so setup and cleaning
  time count and early assignments are not over-penalised.
