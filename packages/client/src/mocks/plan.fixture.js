// A realistic Plan (scheduler README §6) for three participants and two dishes: Buns (64 buns on 4 sheets) and
// Rum Negroni (4 drinks). ~30 items across every kind, including appointments with timers, a blocked item, a resume
// item after an interrupt and hand-offs between lanes. All times are epoch ms relative to `base`.

import { defaultBase } from './session.fixture'

const M = 60_000

export function makePlanFixture(base = defaultBase(), status = 'draft') {
  const t = (min) => base + min * M

  const item = (uuid, kind, startMin, endMin, extra = {}) => ({
    uuid,
    taskId: uuid.replace(/@.*$/, '').replace(/\/c\d+.*$/, '').replace(/:blocked$/, ''),
    kind,
    start: t(startMin),
    end: t(endMin),
    status: 'planned',
    title: uuid,
    instructions: '',
    dishId: null,
    context: { dish: null, station: 'counter', tool: null },
    units: null,
    inputsFrom: [],
    outputsTo: [],
    preemptible: 'anywhere',
    urgency: null,
    window: null,
    timer: null,
    dependencies: [],
    tools: [],
    passiveUntil: null,
    ...extra,
  })
  const buns = (extra) => ({ dishId: 'buns', context: { dish: 'buns', station: 'counter', tool: null }, ...extra })
  const negroni = (extra) => ({ dishId: 'negroni', context: { dish: 'negroni', station: 'bar', tool: null }, ...extra })

  const alice = {
    participantId: '0',
    report: { load: 44 * 60, expectedLoad: 46 * 60, switches: 3, longestLopsidedIdle: 33 * 60, timersHeld: 1 },
    items: [
      item('negroni:garnish#b1', 'work', 0, 3, negroni({
        title: 'Cut orange peel',
        instructions: 'Cut 4 strips of orange peel with the knife, avoiding the white pith. Put them on a plate.',
        tools: [{ type: 'knife', instanceId: 'knife#1' }, { type: 'plate', instanceId: 'plate#1' }],
        outputsTo: [{ outputId: 'orange-peel', participantId: 'p1', byTime: t(5) }],
        preemptible: 'anywhere',
      })),
      item('buns:measure#b1', 'work', 3, 8, buns({
        title: 'Measure dough ingredients',
        instructions: 'Weigh 1000 g flour, 150 g sugar, 10 g salt and 50 g yeast into the large bowl. Warm 500 ml milk to lukewarm.',
        tools: [{ type: 'large-bowl', instanceId: 'large-bowl#1' }, { type: 'kitchen-scale', instanceId: 'kitchen-scale#1' }],
        dependencies: [],
      })),
      item('buns:mix-dough#b1', 'work', 8, 16, buns({
        title: 'Mix the dough',
        instructions: 'Add the milk and 150 g soft butter to the bowl and knead for 8 minutes until smooth and elastic. Cover with a towel and leave to rise.',
        tools: [{ type: 'large-bowl', instanceId: 'large-bowl#1' }, { type: 'towel', instanceId: 'towel#1' }],
        dependencies: ['buns:measure#b1'],
        passiveUntil: t(56),
        timer: { title: 'Dough rising', durationSeconds: 40 * 60, firesAt: t(56) },
        urgency: 'timed',
        outputsTo: [
          { outputId: 'dough', participantId: '0', byTime: t(57) },
          { outputId: 'dough', participantId: 'p1', byTime: t(57) },
        ],
      })),
      item('clean:knife#1', 'cleaning', 16, 17, {
        title: 'Wash the knife',
        instructions: 'Rinse and wash the knife, put it back on the counter.',
        context: { dish: null, station: 'sink', tool: 'knife' },
        tools: [{ type: 'knife', instanceId: 'knife#1' }],
        dependencies: ['negroni:garnish#b1'],
      }),
      item('idle:0#1', 'idle', 17, 50, { title: 'Idle', preemptible: 'anywhere' }),
      item('buns:preheat#b1', 'setup', 50, 51, buns({
        title: 'Preheat the oven',
        instructions: 'Turn the oven to 225 °C, both racks in.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        tools: [{ type: 'oven', instanceId: 'oven#1' }],
      })),
      item('buns:mix-dough#b1@done', 'appointment', 56, 57, buns({
        title: 'Dough has risen',
        instructions: 'Check the dough: it should have doubled. Punch it down and divide it between the two rollers.',
        urgency: 'timed',
        window: { earliest: t(54), latest: t(60) },
        timer: { title: 'Dough rising', durationSeconds: 40 * 60, firesAt: t(56) },
        dependencies: ['buns:mix-dough#b1'],
        preemptible: 'never',
      })),
      item('buns:roll#b1/c1', 'work', 57, 73, buns({
        title: 'Roll buns',
        instructions: 'Roll 32 buns of about 50 g each and place them on baking sheets, 16 per sheet.',
        units: { from: 1, to: 32, of: 64 },
        preemptible: 'units',
        inputsFrom: [{ outputId: 'dough', participantId: '0', byTime: t(57) }],
        outputsTo: [
          { outputId: 'rolled-buns#s1', participantId: 'placeholder-1', byTime: t(65) },
          { outputId: 'rolled-buns#s2', participantId: 'placeholder-1', byTime: t(73) },
        ],
        tools: [{ type: 'baking-sheet', instanceId: 'baking-sheet#1' }, { type: 'baking-sheet', instanceId: 'baking-sheet#2' }],
        dependencies: ['buns:mix-dough#b1@done'],
      })),
      item('buns:roll#b1/c1:blocked', 'blocked', 73, 75, buns({
        title: 'Waiting for a free baking sheet',
        instructions: 'All four sheets are in use. A sheet frees up when the first batch comes out of the oven.',
        context: { dish: 'buns', station: 'counter', tool: 'baking-sheet' },
        dependencies: ['buns:roll#b1/c1'],
      })),
      item('clean:large-bowl#1', 'cleaning', 75, 77, {
        title: 'Wash the dough bowl',
        instructions: 'Scrape out the large bowl and wash it.',
        context: { dish: null, station: 'sink', tool: 'large-bowl' },
        tools: [{ type: 'large-bowl', instanceId: 'large-bowl#1' }],
        dependencies: ['buns:roll#b1/c1'],
      }),
    ],
  }

  const bob = {
    participantId: 'p1',
    report: { load: 40 * 60, expectedLoad: 41 * 60, switches: 2, longestLopsidedIdle: 42 * 60, timersHeld: 1 },
    items: [
      item('negroni:measure#b1', 'work', 0, 5, negroni({
        title: 'Measure negroni ingredients',
        instructions: 'Measure 4 × 30 ml rum, 4 × 30 ml sweet vermouth and 4 × 30 ml Campari into the mixing glass.',
        tools: [{ type: 'mixing-glass', instanceId: 'mixing-glass#1' }, { type: 'jug', instanceId: 'jug#1' }],
      })),
      item('negroni:stir#b1', 'work', 5, 9, negroni({
        title: 'Stir with ice',
        instructions: 'Fill the mixing glass with ice and stir with the bar spoon for about 30 seconds until well chilled.',
        tools: [{ type: 'mixing-glass', instanceId: 'mixing-glass#1' }, { type: 'bar-spoon', instanceId: 'bar-spoon#1' }],
        inputsFrom: [{ outputId: 'orange-peel', participantId: '0', byTime: t(5) }],
        dependencies: ['negroni:measure#b1', 'negroni:garnish#b1'],
      })),
      item('negroni:serve#b1', 'work', 9, 13, negroni({
        title: 'Strain into glasses and garnish',
        instructions: 'Strain into 4 rocks glasses over fresh ice, twist an orange peel over each and drop it in.',
        units: { from: 1, to: 4, of: 4 },
        preemptible: 'units',
        tools: [{ type: 'strainer', instanceId: 'strainer#1' }, { type: 'rocks-glass', instanceId: 'rocks-glass#1' }],
        inputsFrom: [{ outputId: 'iced-glasses', participantId: 'placeholder-1', byTime: t(9) }],
        dependencies: ['negroni:stir#b1', 'negroni:ice#b1'],
        urgency: 'relaxed',
        window: { earliest: t(13), latest: t(25) },
      })),
      item('clean:mixing-glass#1', 'cleaning', 13, 15, {
        title: 'Rinse the mixing glass and strainer',
        instructions: 'Rinse the mixing glass, bar spoon and strainer under hot water.',
        context: { dish: null, station: 'sink', tool: 'mixing-glass' },
        tools: [{ type: 'mixing-glass', instanceId: 'mixing-glass#1' }],
        dependencies: ['negroni:serve#b1'],
      }),
      item('idle:p1#1', 'idle', 15, 57, { title: 'Idle' }),
      item('buns:roll#b1/c2', 'work', 57, 80, buns({
        title: 'Roll buns',
        instructions: 'Roll 32 buns of about 50 g each and place them on baking sheets, 16 per sheet.',
        units: { from: 33, to: 64, of: 64 },
        preemptible: 'units',
        inputsFrom: [{ outputId: 'dough', participantId: '0', byTime: t(57) }],
        outputsTo: [
          { outputId: 'rolled-buns#s3', participantId: 'placeholder-1', byTime: t(78) },
          { outputId: 'rolled-buns#s4', participantId: 'placeholder-1', byTime: t(83) },
        ],
        tools: [{ type: 'baking-sheet', instanceId: 'baking-sheet#3' }, { type: 'baking-sheet', instanceId: 'baking-sheet#4' }],
        dependencies: ['buns:mix-dough#b1@done'],
      })),
      item('buns:bake#b1@done', 'appointment', 80, 81, buns({
        title: 'Take sheet 1 out of the oven',
        instructions: 'The buns on sheet 1 should be golden brown. Take the sheet out with the towel and put it on the counter.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        urgency: 'critical',
        window: { earliest: t(79.5), latest: t(81) },
        timer: { title: 'Sheet 1 baking', durationSeconds: 12 * 60, firesAt: t(80) },
        tools: [{ type: 'oven', instanceId: 'oven#1' }, { type: 'towel', instanceId: 'towel#2' }],
        outputsTo: [{ outputId: 'baked-buns#s1', participantId: 'placeholder-1', byTime: t(81) }],
        dependencies: ['buns:bake#b1'],
        preemptible: 'never',
      })),
      item('buns:roll#b1/c2/r1', 'resume', 81, 83, buns({
        title: 'Resume rolling buns',
        instructions: 'Finish the last buns and put them on sheet 4.',
        units: { from: 59, to: 64, of: 64 },
        preemptible: 'units',
        tools: [{ type: 'baking-sheet', instanceId: 'baking-sheet#4' }],
        dependencies: ['buns:bake#b1@done', 'buns:roll#b1/c2'],
      })),
      item('clean:baking-sheet#1', 'cleaning', 83, 85, {
        title: 'Wash baking sheet 1',
        instructions: 'Once the buns are off, wash sheet 1 and dry it.',
        context: { dish: null, station: 'sink', tool: 'baking-sheet' },
        tools: [{ type: 'baking-sheet', instanceId: 'baking-sheet#1' }],
        dependencies: ['buns:cool#b1'],
      }),
    ],
  }

  const cleo = {
    participantId: 'placeholder-1',
    report: { load: 36 * 60, expectedLoad: 46 * 60, switches: 5, longestLopsidedIdle: 49 * 60, timersHeld: 2 },
    items: [
      item('buns:line-sheets#b1', 'work', 0, 4, buns({
        title: 'Line baking sheets',
        instructions: 'Line 4 baking sheets with parchment paper.',
        tools: [{ type: 'parchment-paper', instanceId: 'parchment-paper#1' }],
      })),
      item('negroni:ice#b1', 'work', 4, 6, negroni({
        title: 'Fill glasses with ice',
        instructions: 'Fill 4 rocks glasses with large ice cubes and put them in the freezer.',
        tools: [{ type: 'rocks-glass', instanceId: 'rocks-glass#1' }],
        outputsTo: [{ outputId: 'iced-glasses', participantId: 'p1', byTime: t(9) }],
      })),
      item('buns:egg-wash#b1', 'work', 6, 8, buns({
        title: 'Whisk the egg wash',
        instructions: 'Whisk 1 egg with a splash of milk in a cup.',
        tools: [{ type: 'cup', instanceId: 'cup#1' }, { type: 'fork', instanceId: 'fork#1' }],
      })),
      item('idle:placeholder-1#1', 'idle', 8, 65, { title: 'Idle' }),
      item('buns:brush#b1', 'work', 65, 67, buns({
        title: 'Brush sheet 1 with egg',
        instructions: 'Brush the 16 buns on sheet 1 with egg wash.',
        units: { from: 1, to: 16, of: 64 },
        preemptible: 'units',
        tools: [{ type: 'pastry-brush', instanceId: 'pastry-brush#1' }],
        inputsFrom: [{ outputId: 'rolled-buns#s1', participantId: '0', byTime: t(65) }],
        dependencies: ['buns:roll#b1/c1', 'buns:egg-wash#b1', 'buns:line-sheets#b1'],
      })),
      item('buns:bake#b1', 'work', 67, 68, buns({
        title: 'Put sheet 1 in the oven',
        instructions: 'Put sheet 1 on the upper rack. Bake for 12 minutes at 225 °C.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        tools: [{ type: 'oven', instanceId: 'oven#1' }],
        passiveUntil: t(80),
        urgency: 'critical',
        timer: { title: 'Sheet 1 baking', durationSeconds: 12 * 60, firesAt: t(80) },
        dependencies: ['buns:brush#b1', 'buns:preheat#b1'],
      })),
      item('buns:bake#b1:check1', 'check', 74, 75, buns({
        title: 'Check sheet 1',
        instructions: 'Peek at sheet 1: rotate it if the buns are browning unevenly.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        window: { earliest: t(73), latest: t(76) },
        dependencies: ['buns:bake#b1'],
      })),
      item('buns:brush#b2', 'work', 75, 77, buns({
        title: 'Brush sheet 2 with egg',
        instructions: 'Brush the 16 buns on sheet 2 with egg wash.',
        units: { from: 17, to: 32, of: 64 },
        preemptible: 'units',
        tools: [{ type: 'pastry-brush', instanceId: 'pastry-brush#1' }],
        inputsFrom: [{ outputId: 'rolled-buns#s2', participantId: '0', byTime: t(73) }],
        dependencies: ['buns:roll#b1/c1', 'buns:egg-wash#b1'],
      })),
      item('buns:bake#b2', 'work', 77, 78, buns({
        title: 'Put sheet 2 in the oven',
        instructions: 'Put sheet 2 on the lower rack. Bake for 12 minutes at 225 °C.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        tools: [{ type: 'oven', instanceId: 'oven#2' }],
        passiveUntil: t(90),
        urgency: 'critical',
        timer: { title: 'Sheet 2 baking', durationSeconds: 12 * 60, firesAt: t(90) },
        dependencies: ['buns:brush#b2'],
      })),
      item('buns:brush#b3:blocked', 'blocked', 78, 81, buns({
        title: 'Waiting for sheet 3 from Bob',
        instructions: 'Sheet 3 is still being rolled.',
        context: { dish: 'buns', station: 'counter', tool: 'baking-sheet' },
        inputsFrom: [{ outputId: 'rolled-buns#s3', participantId: 'p1', byTime: t(78) }],
        dependencies: ['buns:roll#b1/c2'],
      })),
      item('buns:cool#b1', 'work', 81, 83, buns({
        title: 'Move sheet 1 buns to the cooling rack',
        instructions: 'Lift the buns from sheet 1 onto the cooling rack with the spatula.',
        units: { from: 1, to: 16, of: 64 },
        preemptible: 'units',
        tools: [{ type: 'cooling-rack', instanceId: 'cooling-rack#1' }, { type: 'spatula', instanceId: 'spatula#1' }],
        inputsFrom: [{ outputId: 'baked-buns#s1', participantId: 'p1', byTime: t(81) }],
        dependencies: ['buns:bake#b1@done'],
      })),
      item('buns:bake#b2@done', 'appointment', 90, 91, buns({
        title: 'Take sheet 2 out of the oven',
        instructions: 'Take sheet 2 out with the towel and put it on the counter.',
        context: { dish: 'buns', station: 'oven', tool: 'oven' },
        urgency: 'critical',
        window: { earliest: t(89.5), latest: t(91) },
        timer: { title: 'Sheet 2 baking', durationSeconds: 12 * 60, firesAt: t(90) },
        tools: [{ type: 'oven', instanceId: 'oven#2' }, { type: 'towel', instanceId: 'towel#2' }],
        dependencies: ['buns:bake#b2'],
        preemptible: 'never',
      })),
      item('buns:serve', 'work', 91, 93, buns({
        title: 'Serve the buns',
        instructions: 'Pile the buns on the serving plates and bring them to the table.',
        tools: [{ type: 'serving-plate', instanceId: 'serving-plate#1' }],
        dependencies: ['buns:cool#b1', 'buns:bake#b2@done'],
        urgency: 'timed',
        window: { earliest: t(90), latest: t(95) },
      })),
      item('clean:pastry-brush#1', 'cleaning', 93, 95, {
        title: 'Wash the pastry brush and cup',
        instructions: 'Wash the pastry brush and the egg cup.',
        context: { dish: null, station: 'sink', tool: 'pastry-brush' },
        tools: [{ type: 'pastry-brush', instanceId: 'pastry-brush#1' }, { type: 'cup', instanceId: 'cup#1' }],
        dependencies: ['buns:brush#b2'],
      }),
    ],
  }

  return {
    mode: status === 'draft' ? 'offline' : 'online',
    status,
    seed: 1,
    computedAt: base + 10 * M,
    now: base,
    startTime: base,
    endTime: t(95),
    diagnostics: [
      { code: 'SERVE_LATE', message: 'Buns are planned 3 min after the target time (tolerance 5 min): the oven fits two sheets at a time.', dish: 'buns', delta: 180 },
      { code: 'INTERRUPT_RISK', message: 'Bob holds the "sheet 1 out" appointment while rolling buns; he may be interrupted mid-batch.', task: 'buns:bake#b1', delta: null },
      { code: 'PLACEHOLDER_LANE', message: 'Lane "Cook 3" is a placeholder. If nobody joins before Start, its work is redistributed.', delta: null },
    ],
    diff: null,
    lanes: [alice, bob, cleo],
    dishes: [
      { dishId: 'buns', serveTarget: t(90), plannedServe: t(93), spread: 120, holdUsed: 0, late: 180 },
      { dishId: 'negroni', serveTarget: t(15), plannedServe: t(13), spread: 0, holdUsed: 120, late: 0 },
    ],
    report: {
      fairness: 0.86,
      loads: {
        '0': { load: 44 * 60, expected: 46 * 60 },
        p1: { load: 40 * 60, expected: 41 * 60 },
        'placeholder-1': { load: 36 * 60, expected: 46 * 60 },
      },
      switches: 10,
      interruptsRisk: 1,
      makespan: 95 * 60,
    },
    shoppingList: [
      { name: 'flour', amount: 1000, unit: 'g' },
      { name: 'milk', amount: 520, unit: 'ml' },
      { name: 'sugar', amount: 150, unit: 'g' },
      { name: 'butter', amount: 150, unit: 'g' },
      { name: 'yeast', amount: 50, unit: 'g' },
      { name: 'salt', amount: 10, unit: 'g' },
      { name: 'egg', amount: 1, unit: 'pcs' },
      { name: 'rum', amount: 120, unit: 'ml' },
      { name: 'sweet vermouth', amount: 120, unit: 'ml' },
      { name: 'Campari', amount: 120, unit: 'ml' },
      { name: 'orange', amount: 1, unit: 'pcs' },
      { name: 'ice', amount: 1, unit: 'kg' },
    ],
  }
}

/** A sample online diff, used by the mock after Start. */
export function makeDiffFixture(base = defaultBase()) {
  return [
    {
      participantId: '0',
      changes: [
        { uuid: 'buns:preheat#b1', field: 'start', from: base + 50 * M, to: base + 48 * M, reason: 'the oven takes longer to heat than planned' },
      ],
    },
    {
      participantId: 'p1',
      changes: [
        { uuid: 'buns:bake#b1@done', field: 'next', from: 'Roll buns', to: 'Take sheet 1 out of the oven', reason: 'Cook 3 is still brushing sheet 2' },
      ],
    },
  ]
}

const planFixture = makePlanFixture()
export default planFixture
