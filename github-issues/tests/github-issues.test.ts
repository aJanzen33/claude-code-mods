import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  SPINNER_SVG,
  age,
  assignedToast,
  byOwner,
  chips,
  excerpt,
  fitCards,
  cmuxSurface,
  commandsFor,
  fitThread,
  parseThread,
  isSameRepo,
  issueArgs,
  issueCommands,
  nextSort,
  paneBackground,
  issuesArgs,
  labelDot,
  labelInk,
  labelOptions,
  labelPills,
  matchesQuery,
  newlyAssigned,
  parseIssuesPage,
  parseRemote,
  parseRepos,
  pickKey,
  pickPr,
  reposArgs,
  runGroups,
  searchQuery,
  spinnerFrame,
  textWidth,
  workPrompt,
} from '../hooks/lib'

const NOW = Date.parse('2026-10-06T10:00:00Z')
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
// The card's own Work on it button shows only with no issue commands set.
const NO_COMMANDS = { options: { commands: '' } }

const TITLES: Record<number, string> = { 42: 'Crash on launch', 7: 'Dark mode' }

const ISSUE_NODES = [
  {
    number: 42,
    title: 'Crash on launch',
    url: 'https://github.com/acme/widgets/issues/42',
    state: 'OPEN',
    updatedAt: '2026-10-01T10:00:00Z',
    author: { login: 'ada' },
    assignees: { nodes: [{ login: 'marco' }] },
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
    comments: { totalCount: 2 },
    closedByPullRequestsReferences: {
      nodes: [{ number: 50, url: 'https://github.com/acme/widgets/pull/50', state: 'OPEN', isDraft: true }],
    },
  },
  {
    number: 7,
    title: 'Dark mode',
    url: 'https://github.com/acme/widgets/issues/7',
    state: 'OPEN',
    updatedAt: '2026-09-01T10:00:00Z',
    author: { login: 'bob' },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
  },
]

/** The GraphQL answer to the issues request, `mine` the person's assigned issue numbers. */
function issuesPage(mine: readonly number[], extraLabels = 0, bulky = 0, runLabel?: string) {
  // #7 carries `runLabel` when a test gives one.
  const nodes = runLabel === undefined ? ISSUE_NODES : [ISSUE_NODES[0], { ...ISSUE_NODES[1], labels: { nodes: [{ name: runLabel, color: '1d76db' }] } }]
  const more = Array.from({ length: extraLabels }, (_, index) => ({ name: `area/${index}`, color: '0e8a16' }))
  const heavy = Array.from({ length: bulky }, (_, index) => ({
    ...ISSUE_NODES[1],
    number: 1000 + index,
    title: `Long ${index} ${'word '.repeat(400)}`,
    url: `https://github.com/acme/widgets/issues/${1000 + index}`,
  }))

  return {
    data: {
      list: { issueCount: 2 + bulky, nodes: [...nodes, ...heavy] },
      mine: {
        issueCount: mine.length,
        nodes: mine.map(number => ({
          number,
          title: TITLES[number] ?? 'Untitled',
          url: `https://github.com/acme/widgets/issues/${number}`,
        })),
      },
      repository: { labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: 'a2eeef' }, ...more] } },
    },
  }
}

const REPOS = {
  data: {
    viewer: {
      repositories: {
        nodes: [
          { nameWithOwner: 'other/thing', isPrivate: true, isArchived: false, hasIssuesEnabled: true, pushedAt: '2026-10-06T08:00:00Z', issues: { totalCount: 1 } },
          { nameWithOwner: 'acme/widgets', isPrivate: false, isArchived: false, hasIssuesEnabled: true, pushedAt: '2026-10-01T10:00:00Z', issues: { totalCount: 2 } },
          { nameWithOwner: 'acme/old', isPrivate: false, isArchived: true, hasIssuesEnabled: true, pushedAt: '2020-01-01T00:00:00Z', issues: { totalCount: 9 } },
          { nameWithOwner: 'acme/no-issues', isPrivate: false, isArchived: false, hasIssuesEnabled: false, pushedAt: '2026-01-01T00:00:00Z', issues: { totalCount: 0 } },
        ],
      },
    },
  },
}

const PANE = {
  plugin: 'github-issues',
  component: 'Pane',
  requestId: 'github-issues',
  props: {
    title: 'Issues',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** Types `/issues <args>` at the prompt. */
function slashIssues($: Engine, args = '') {
  return $.command.run({
    command: 'issues',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

/** Unfolds the filters (tabs, run filters, search, label) when they are folded away. */
async function showFilters(ui: { find: (query: { key: string }) => Promise<unknown>; press: (target: { key: string }) => Promise<unknown> }) {
  if ((await ui.find({ key: 'filter:open' })) === undefined) await ui.press({ key: 'toggle-filters' })
}

/** Opens the picker the way a person does from the session's repository: Switch repo. */
async function openPicker($: Engine) {
  await slashIssues($, '.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'switch' })
  await ui.unmount()
}

/** A `process.run` answer, as the host would give it. */
function ran(stdout: string, exitCode = 0, stderr = '') {
  return { value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }
}

/** The value of `-f name=value` in a gh argv. */
function variable(argv: readonly string[], name: string): string | undefined {
  return argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

type Fake = {
  clock: MockClock
  calls: string[][]
  searches: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  mine: number[]
  extraLabels: number
  bulky: number
  isPaneOpen: boolean
  surfaces: ('terminal' | 'desktop')[]
  invalidations: number
  gate: Promise<void> | undefined
  failing: boolean
  runLabel: string | undefined
  // Whether cmux answers; false stands for a terminal outside cmux.
  hasCmux: boolean
  // The argv of every run that was not gh.
  opened: string[][]
  // The id of every pane opened.
  panes: string[]
}

/** Fakes the surface, the session's git remote and the `gh` CLI. */
function fakeGitHub(on: On, remote: string | null = 'git@github.com:acme/widgets.git'): Fake {
  const fake: Fake = {
    clock: mock.clock(on, { now: NOW }),
    calls: [],
    searches: [],
    toasts: [],
    statuses: [],
    mine: [42],
    extraLabels: 0,
    bulky: 0,
    isPaneOpen: true,
    surfaces: ['desktop'],
    invalidations: 0,
    gate: undefined,
    failing: false,
    runLabel: undefined,
    hasCmux: true,
    opened: [],
    panes: [],
  }

  mock.store(on)
  on('ui.open', ($, e) => {
    fake.panes.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: fake.isPaneOpen
      ? [{ id: 'github-issues', title: 'Issues', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.toast', ($, e) => {
    fake.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    fake.statuses.push(e.text)

    return { value: undefined }
  })
  on('session.repo', () => ({
    value: remote === null ? null : { root: '/work/widgets', remote, internal: false, name: null },
  }))
  on('session.surfaces', () => ({ value: fake.surfaces }))
  on('ui.invalidate', () => {
    fake.invalidations += 1

    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    fake.calls.push([...e.argv])
    const [program = '', command, verb] = e.argv
    if (program.endsWith('cmux') || program === 'open') {
      fake.opened.push([...e.argv])
      if (program === 'open') return ran('')
      if (!fake.hasCmux) return ran('', 1, 'cmux is not running')
      if (command === 'browser' && verb === 'open') return ran('OK surface=surface:7 pane=pane:3 placement=split')
      return ran('OK')
    }
    if (command === '--version') return ran('gh version 2.80.0')
    if (command === 'issue' && verb === 'view' && e.argv.at(-1)?.includes('title')) {
      const number = Number(e.argv[3])
      return ran(JSON.stringify({
        number,
        title: TITLES[number] ?? 'Untitled',
        url: `https://github.com/acme/widgets/issues/${number}`,
        state: 'OPEN',
        author: { login: 'ada' },
        createdAt: '2026-10-01T10:00:00Z',
        labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'run:implement', color: '0e8a16' }],
        body: 'It crashes **every** time.',
        comments: [{ author: { login: 'bob' }, createdAt: '2026-10-02T10:00:00Z', body: 'Same here.' }],
      }))
    }
    if (command === 'issue' && verb === 'view') {
      return ran(JSON.stringify({ number: 42, body: 'It crashes **every** time.', comments: [{}, {}] }))
    }
    if (command === 'api' && verb === 'graphql') {
      if (variable(e.argv, 'query')?.includes('viewer')) return ran(JSON.stringify(REPOS))
      const q = variable(e.argv, 'q')
      if (q !== undefined) fake.searches.push(q)
      if (q !== undefined && fake.gate !== undefined) await fake.gate
      if (q !== undefined && fake.failing) return ran('', 1, 'HTTP 502: Bad Gateway')

      return ran(JSON.stringify(issuesPage(fake.mine, fake.extraLabels, fake.bulky, fake.runLabel)))
    }

    return ran('', 1, 'unexpected gh call')
  })

  return fake
}

describe('issues', () => {
  test('cards show title, number, assignee, age, comments, linked PR and labels on every surface', NO_COMMANDS, async ($, on) => {
    fakeGitHub(on)
    const opened = await slashIssues($, '.')
    expect(opened.text).toBe('Showing acme/widgets issues.')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await showFilters(ui)
      expect(await ui.find({ type: 'Text', text: 'acme / ' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^widgets$/ }))?.props).toMatchObject({ bold: true })
      expect(await ui.find({ type: 'Text', text: /^2 open$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Crash on launch' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: '#42' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^· @marco · 5d · 2 comments$/ })).toBeDefined()
      expect((await ui.find({ type: 'Link', text: 'PR #50' }))?.props).toMatchObject({
        href: 'https://github.com/acme/widgets/pull/50',
      })
      expect((await ui.find({ type: 'Text', text: /^draft$/ }))?.props).toMatchObject({ color: '#808080' })
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: ' bug' })).toBeDefined()
        expect((await ui.find({ type: 'Text', text: '●' }))?.props).toMatchObject({ color: '#d73a4a' })
      } else {
        const pills = await ui.find({ type: 'Svg' })
        expect(pills?.props).toMatchObject({ alt: 'Labels: bug', height: 20 })
        expect(String(pills?.props.source)).toContain('>bug</text>')
      }
      expect((await ui.find({ key: 'work:42' }))?.props).not.toHaveProperty('dimColor')
      // Two rows per issue, no card frame: the open mark and the title, then number, meta and actions.
      expect((await ui.find({ key: 'issue:42' }))?.props).not.toHaveProperty('borderStyle')
      expect(await ui.find({ type: 'Text', text: '○' })).toBeDefined()
      expect((await ui.find({ key: 'filter:open' }))?.props).toMatchObject({ variant: 'primary' })
      expect((await ui.find({ key: 'filter:assigned' }))?.text).toBe('Assigned · 1')
      expect(await ui.findAll({ type: 'Button', text: 'Work on it' })).toHaveLength(2)
      const hasFields = surface !== 'mobile'
      expect(await ui.find({ key: 'issue-search' })).toEqual(hasFields ? expect.anything() : undefined)
      expect(await ui.find({ key: 'label-filter' })).toEqual(hasFields ? expect.anything() : undefined)
      await ui.unmount()
    }
  })

  test('Details shows the issue body under a divider', async ($, on) => {
    fakeGitHub(on)
    await slashIssues($, '.')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.press({ key: 'details:42' })
      expect((await ui.find({ key: 'body:42' }))?.text).toContain('It crashes **every** time.')
      expect(await ui.find({ type: 'Text', text: /^─{56}$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 comments' })).toBeDefined()
      await ui.press({ key: 'details:42' })
      expect(await ui.find({ key: 'body:42' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('Work on it submits a prompt naming the issue and marks its card', NO_COMMANDS, async ($, on) => {
    fakeGitHub(on)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)

      return { text: e.text }
    })
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'work:42' })

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('Work on GitHub issue #42 in acme/widgets: "Crash on launch"')
    expect(submitted[0]).toContain('gh issue view 42 -R acme/widgets --comments')
    expect((await ui.find({ type: 'Text', text: 'Crash on launch' }))?.props).toMatchObject({ color: 'claude' })
    expect((await ui.find({ key: 'work:42' }))?.text).toBe('● Working on it')
    expect(await ui.findAll({ type: 'Text', text: '●' })).toHaveLength(1)
    expect((await ui.find({ type: 'Text', text: '●' }))?.props).toMatchObject({ color: 'claude' })
  })

  test('Work on it while Claude is busy shows Queued until the turn starts, and a second tap sends nothing', NO_COMMANDS, async ($, on) => {
    const fake = fakeGitHub(on)
    const submitted: string[] = []
    let start = () => {}
    const turn = new Promise<void>(resolve => {
      start = resolve
    })
    on('prompt.submit', async ($, e) => {
      submitted.push(e.text)
      await turn

      return { text: e.text }
    })
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    const pressed = ui.press({ key: 'work:42' })
    await fake.clock.settle()
    await fake.clock.advance(600)
    expect((await ui.find({ key: 'work:42' }))?.text).toBe('◷ Queued')
    expect(fake.toasts).toEqual(['#42 is queued: Claude starts on it once it finishes the current task.'])

    start()
    await pressed
    expect((await ui.find({ key: 'work:42' }))?.text).toBe('● Working on it')

    await ui.press({ key: 'work:42' })
    expect(submitted).toHaveLength(1)
    expect(fake.toasts.at(-1)).toBe('Claude is already on #42.')
  })

  test('Work on it in a session of another repository sends nothing and says why', NO_COMMANDS, async ($, on) => {
    const fake = fakeGitHub(on)
    const submitted: string[] = []
    on('prompt.submit', ($, e) => {
      submitted.push(e.text)

      return { text: e.text }
    })
    await slashIssues($, 'other/thing')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'work:42' })

    expect(submitted).toEqual([])
    expect(fake.toasts.at(-1)).toContain('This session works in acme/widgets, not other/thing.')
    expect((await ui.find({ key: 'work:42' }))?.text).toBe('Work on it')
  })

  test('the filters fold away under one button; folded, the header counts and a line names what narrows', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect(await ui.find({ key: 'filter:open' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^2 open$/ })).toBeDefined()
    expect((await ui.find({ key: 'toggle-filters' }))?.text).toBe('Filter ▸')

    await ui.press({ key: 'toggle-filters' })
    await ui.press({ key: 'filter:assigned' })
    await ui.press({ key: 'run-group:Plan' })
    await ui.press({ key: 'toggle-filters' })
    expect(await ui.find({ key: 'filter:open' })).toBeUndefined()
    expect((await ui.find({ key: 'toggle-filters' }))?.text).toBe('Filter ▸ 2')
    expect(await ui.find({ type: 'Text', text: 'Assigned · Plan' })).toBeDefined()

    await ui.press({ key: 'clear-all' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:created-desc')
    expect(await ui.find({ key: 'clear-all' })).toBeUndefined()
  })

  test('tabs search for the matching issues', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await showFilters(ui)
    await ui.press({ key: 'filter:assigned' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open assignee:@me sort:created-desc')
    expect(await ui.find({ type: 'Text', text: /^2 assigned to you$/ })).toBeDefined()

    await ui.press({ key: 'filter:closed' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:closed sort:created-desc')
  })

  test('the search box and the label picker narrow the list; Clear resets both', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await showFilters(ui)
      await ui.input({ key: 'issue-search', text: 'crash' })
      expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open crash sort:created-desc')
      expect(await ui.find({ type: 'Text', text: /^matching "crash"$/ })).toBeDefined()

      await ui.select({ key: 'label-filter', value: 'bug' })
      expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open label:"bug" crash sort:created-desc')
      expect(await ui.find({ type: 'Text', text: 'matching "crash", label bug' })).toBeDefined()

      await ui.press({ key: 'clear-filters' })
      expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:created-desc')
      expect(await ui.find({ key: 'clear-filters' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a repository with more labels than a Select holds still draws, its used labels first', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.extraLabels = 170
    await slashIssues($, '.')

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await showFilters(ui)
      const options = (await ui.find({ key: 'label-filter' }))?.props.options as { value: string }[]
      expect(options).toHaveLength(64)
      expect(options.slice(0, 2).map(option => option.value)).toEqual(['', 'bug'])
      await ui.unmount()
    }
  })

  test('cards stop short of the engine size bound, so a heavy list still draws', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.bulky = 48
    await slashIssues($, '.')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(JSON.stringify(await ui.drawn()).length).toBeLessThan(100_000)
      expect(await ui.find({ key: 'issue:42' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /more didn't fit in the pane/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a spinner shows while issues load: an SVG that turns itself, frames on the terminal', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.surfaces = ['terminal']
    let release = () => {}
    fake.gate = new Promise<void>(resolve => {
      release = resolve
    })
    const opened = slashIssues($, '.')
    await fake.clock.settle()

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await desktop.find({ type: 'Svg' }))?.props).toMatchObject({ alt: 'Loading', isInteractive: true })
    expect(await desktop.find({ type: 'Text', text: 'Loading issues…' })).toBeDefined()
    await desktop.unmount()
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await terminal.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeDefined()
    await terminal.unmount()

    const before = fake.invalidations
    await fake.clock.advance(300)
    expect(fake.invalidations).toBeGreaterThanOrEqual(before + 3)

    release()
    await opened
    await fake.clock.settle()
    const after = fake.invalidations
    await fake.clock.advance(1_000)
    expect(fake.invalidations).toBe(after)
  })

  test('on the desktop alone the spinner never redraws the pane', async ($, on) => {
    const fake = fakeGitHub(on)
    let release = () => {}
    fake.gate = new Promise<void>(resolve => {
      release = resolve
    })
    const opened = slashIssues($, '.')
    await fake.clock.settle()
    await fake.clock.advance(1_000)
    expect(fake.invalidations).toBe(0)
    release()
    await opened
  })

  test('a background refresh that finds nothing new does not redraw, so no tap is dropped', async ($, on) => {
    const fake = fakeGitHub(on)
    on('command.register', () => ({ value: { command: 'issues' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work/widgets', surface: 'desktop', isInteractive: true })
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    await showFilters(ui)
    const before = JSON.stringify(await ui.drawn())
    await fake.clock.advance(2 * 60_000)
    expect(fake.searches).toHaveLength(2)
    expect(JSON.stringify(await ui.drawn())).toBe(before)

    fake.mine = [42, 7]
    await fake.clock.advance(2 * 60_000)
    expect((await ui.find({ key: 'filter:assigned' }))?.text).toBe('Assigned · 2')
  })

  test('a background refresh keeps the list when gh fails; a pressed Refresh shows the error', async ($, on) => {
    const fake = fakeGitHub(on)
    on('command.register', () => ({ value: { command: 'issues' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work/widgets', surface: 'desktop', isInteractive: true })
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

    fake.failing = true
    await fake.clock.advance(2 * 60_000)
    expect(await ui.find({ key: 'issue:42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /HTTP 502/ })).toBeUndefined()

    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /^HTTP 502: Bad Gateway$/ })).toBeDefined()
  })

  test('a gh failure shows its first line', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('session.repo', () => ({
      value: { root: '/w', remote: 'https://github.com/acme/widgets', internal: false, name: null },
    }))
    on('process.run', ($, e) =>
      e.argv[1] === '--version'
        ? ran('gh version 2.80.0')
        : ran('', 1, 'HTTP 401: Bad credentials\nTry gh auth login'),
    )
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /^HTTP 401: Bad credentials$/ })).toBeDefined()
  })
})

describe('issue commands', () => {
  test('each card offers the set commands; a press runs one with the issue and marks it', async ($, on) => {
    fakeGitHub(on)
    const ran: string[] = []
    on('command.run', ($, e, next) => {
      if (e.command === 'issues') return next(e)
      ran.push(`/${e.command} ${e.args}`)

      return { text: '' }
    })
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ key: 'work:42' })).toBeUndefined()
    expect((await ui.find({ key: 'run:implement:42' }))?.text).toBe('/implement')
    expect((await ui.find({ key: 'run:wayfinder:42' }))?.text).toBe('/wayfinder')

    await ui.press({ key: 'run:wayfinder:42' })
    expect(ran).toEqual(['/wayfinder #42 https://github.com/acme/widgets/issues/42'])
    expect((await ui.find({ key: 'run:wayfinder:42' }))?.text).toBe('● /wayfinder')
    expect((await ui.find({ key: 'run:implement:42' }))?.text).toBe('/implement')

    await ui.press({ key: 'run:implement:42' })
    expect(ran).toHaveLength(1)
  })

  test('the sort button steps from number descending to ascending to last update', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ key: 'sort' }))?.text).toBe('#↓')
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:created-desc')
    await ui.press({ key: 'sort' })
    expect((await ui.find({ key: 'sort' }))?.text).toBe('#↑')
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:created-asc')
    await ui.press({ key: 'sort' })
    expect((await ui.find({ key: 'sort' }))?.text).toBe('Updated')
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:updated-desc')
    await ui.press({ key: 'sort' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:open sort:created-desc')
    expect(nextSort('updated-desc')).toBe('number-desc')
  })

  test('the run filters search for their labels; All drops them', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await showFilters(ui)
    expect((await ui.find({ key: 'run-group:*' }))?.props).toMatchObject({ variant: 'primary' })
    await ui.press({ key: 'run-group:Plan' })
    expect(fake.searches.at(-1)).toBe(
      'repo:acme/widgets is:issue is:open label:"run:wayfinder","run:research" sort:created-desc',
    )
    expect((await ui.find({ key: 'run-group:Plan' }))?.props).toMatchObject({ variant: 'primary' })

    await ui.press({ key: 'filter:closed' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:closed label:"run:wayfinder","run:research" sort:created-desc')

    await ui.press({ key: 'run-group:Implement' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:closed label:"run:implement" sort:created-desc')

    await ui.press({ key: 'run-group:*' })
    expect(fake.searches.at(-1)).toBe('repo:acme/widgets is:issue is:closed sort:created-desc')
  })

  test('with no run filters set, the row is not drawn', { options: { runGroups: '' } }, async ($, on) => {
    fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await showFilters(ui)
    expect(await ui.find({ key: 'run-group:*' })).toBeUndefined()
  })

  test('a run: label picks the card\'s command and leaves the chips; a card without one offers the setting\'s', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.runLabel = 'run:research'
    await slashIssues($, '.')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ key: 'run:research:7' }))?.text).toBe('/research')
      expect(await ui.find({ key: 'run:implement:7' })).toBeUndefined()
      expect(await ui.find({ key: 'run:wayfinder:7' })).toBeUndefined()
      expect(await ui.find({ key: 'labels:7' })).toBeUndefined()
      expect(await ui.find({ key: 'run:implement:42' })).toBeDefined()
      expect(await ui.find({ key: 'run:wayfinder:42' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('an unknown command hands nothing over and says why', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')

    // Nothing answers /implement here, so the run rejects as for a command the session lacks.
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'run:implement:42' })
    expect(fake.toasts.at(-1)).toMatch(/^#42 was not handed to \/implement\. ./)
    expect((await ui.find({ key: 'run:implement:42' }))?.text).toBe('/implement')
  })
})

describe('pane background', () => {
  test('with a background set, the pane body sits in a Box of that color', { options: { background: '#000000' } }, async ($, on) => {
    fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(box => box.props.backgroundColor === '#000000')).toHaveLength(1)
    await ui.unmount()
  })

  test('left empty, the pane keeps Claude Code\'s own background', async ($, on) => {
    fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(box => box.props.backgroundColor !== undefined)).toHaveLength(0)
    await ui.unmount()
  })
})

describe('open in browser', () => {
  test('↗ opens a cmux browser split, and the next issue reuses it', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'open:42' })
    await ui.press({ key: 'open:7' })
    expect(fake.opened).toEqual([
      ['cmux', 'browser', 'open', 'https://github.com/acme/widgets/issues/42', '--focus', 'false'],
      ['cmux', 'browser', '--surface', 'surface:7', 'navigate', 'https://github.com/acme/widgets/issues/7'],
    ])
  })

  test('↗ in the header opens the repository on GitHub', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'open-repo' })
    expect(fake.opened.at(-1)).toEqual(['cmux', 'browser', 'open', 'https://github.com/acme/widgets', '--focus', 'false'])
  })

  test('outside cmux, ↗ opens the default browser', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.hasCmux = false
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'open:42' })
    expect(fake.opened.at(-1)).toEqual(['open', 'https://github.com/acme/widgets/issues/42'])
  })

  test('set to system, ↗ goes straight to the default browser', { options: { browser: 'system' } }, async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    await ui.press({ key: 'open:42' })
    expect(fake.opened).toEqual([['open', 'https://github.com/acme/widgets/issues/42']])
  })
})

describe('reader', () => {
  test('≡ opens the issue in a reader pane: title, body, comments and its run: command', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    const list = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await list.press({ key: 'read:42' })
    expect(fake.panes.at(-1)).toBe('github-issue')

    const reader = await $.ui.mount({ ...PANE, requestId: 'github-issue', props: { ...PANE.props, title: '#42' }, surface: 'terminal' })
    expect(await reader.find({ type: 'Text', text: 'Crash on launch' })).toBeDefined()
    expect((await reader.find({ key: 'reader-body' }))?.text).toContain('It crashes **every** time.')
    expect((await reader.find({ key: 'comment-body:0' }))?.text).toBe('Same here.')
    expect(await reader.find({ type: 'Text', text: /@bob/ })).toBeDefined()
    expect(await reader.find({ key: 'reader-run:implement' })).toBeDefined()
    expect(await reader.find({ key: 'reader-run:wayfinder' })).toBeUndefined()
    expect(await reader.find({ key: 'reader-open' })).toBeDefined()
  })

  test('with nothing chosen, the reader says how to fill it', async ($, on) => {
    fakeGitHub(on)
    const reader = await $.ui.mount({ ...PANE, requestId: 'github-issue', surface: 'terminal' })
    expect(await reader.find({ type: 'Text', text: /Press ≡ on an issue/ })).toBeDefined()
  })
})

describe('assignment alerts', () => {
  test('the first look is quiet; a newly assigned issue toasts, and the status line counts them', async ($, on) => {
    const fake = fakeGitHub(on)
    await slashIssues($, '.')
    expect(fake.toasts).toEqual([])

    fake.mine = [42, 7]
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await showFilters(ui)
    await ui.press({ key: 'refresh' })
    expect(fake.toasts).toEqual(['Assigned to you: #7 Dark mode'])
    expect((await ui.find({ key: 'filter:assigned' }))?.text).toBe('Assigned · 2')

    await ui.press({ key: 'refresh' })
    expect(fake.toasts).toHaveLength(1)

    fake.mine = []
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ key: 'filter:assigned' }))?.text).toBe('Assigned')
    expect(fake.statuses).toEqual([])
  })

  test('with the pane closed, nothing is checked', async ($, on) => {
    const fake = fakeGitHub(on)
    fake.isPaneOpen = false
    on('command.register', () => ({ value: { command: 'issues' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work/widgets', surface: 'desktop', isInteractive: true })
    await fake.clock.advance(10 * 60_000)

    expect(fake.calls.filter(argv => argv[1] === 'api')).toEqual([])
    expect(fake.statuses).toEqual([undefined])
    expect(fake.toasts).toEqual([])
  })

  test('while the picker shows, the timer checks assigned issues alone', async ($, on) => {
    const fake = fakeGitHub(on)
    on('command.register', () => ({ value: { command: 'issues' } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work/widgets', surface: 'desktop', isInteractive: true })
    await openPicker($)

    await fake.clock.advance(2 * 60_000)
    expect(fake.toasts).toEqual([])

    fake.mine = [42, 7]
    await fake.clock.advance(2 * 60_000)
    expect(fake.toasts).toEqual(['Assigned to you: #7 Dark mode'])
    const last = fake.calls.at(-1) ?? []
    expect(variable(last, 'mine')).toBe('repo:acme/widgets is:issue is:open assignee:@me')
    expect(variable(last, 'q')).toBeUndefined()
    expect(fake.statuses).toEqual([undefined])
  })
})

describe('picker', () => {
  test('outside a GitHub repository the pane opens on the picker', async ($, on) => {
    fakeGitHub(on, null)
    const opened = await slashIssues($, '.')
    expect(opened.text).toBe('Choose a repository in the Issues pane.')

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Choose a repository' })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0)
  })

  test("/issues alone shows the issues of the folder's repository; outside one, the picker", async ($, on) => {
    const fake = fakeGitHub(on)
    const opened = await slashIssues($)
    expect(opened.text).toBe('Showing acme/widgets issues.')
    expect(fake.searches.at(-1)).toContain('repo:acme/widgets ')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Link', text: '#42' })).toBeDefined()
  })

  test('/issues alone outside a GitHub repository opens the picker', async ($, on) => {
    fakeGitHub(on, null)
    const opened = await slashIssues($)
    expect(opened.text).toBe('Choose a repository in the Issues pane.')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: 'Choose a repository' })).toBeDefined()
  })

  test('Switch repo lists repositories to pick, the session one first', async ($, on) => {
    fakeGitHub(on)
    await openPicker($)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: 'Choose a repository' })).toBeDefined()
      const picks = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('pick:'))
      expect(picks.map(one => one.key)).toEqual([pickKey('acme/widgets'), pickKey('other/thing')])
      expect(await ui.find({ type: 'Text', text: 'This session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^other$/ })).toBeDefined()
      // The repository shown when Switch repo was pressed is marked.
      expect((await ui.find({ key: pickKey('acme/widgets') }))?.text).toBe('● acme/widgets')
      expect((await ui.find({ key: pickKey('other/thing') }))?.text).toBe('thing')
      expect(await ui.find({ type: 'Text', text: /^2 open · 5d$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^1 open · private · 2h$/ })).toBeDefined()
      expect(await ui.find({ key: 'repo-filter' })).toEqual(surface === 'mobile' ? undefined : expect.anything())
      await ui.unmount()
    }
  })

  test('picking a repository shows its issues; Switch repo and Back move between them', async ($, on) => {
    const fake = fakeGitHub(on)
    await openPicker($)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: pickKey('other/thing') })
    expect(fake.searches.at(-1)).toContain('repo:other/thing ')
    expect(await ui.find({ type: 'Text', text: 'other / ' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '#42' })).toBeDefined()

    await ui.press({ key: 'switch' })
    expect(await ui.find({ type: 'Text', text: 'Choose a repository' })).toBeDefined()
    expect((await ui.find({ key: pickKey('other/thing') }))?.text).toBe('● thing')

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: 'other / ' })).toBeDefined()
    expect(await ui.find({ key: 'switch' })).toBeDefined()
  })

  test('the picker filter narrows the list, and Enter opens a match or any owner/name', async ($, on) => {
    const fake = fakeGitHub(on)
    await openPicker($)

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      await ui.input({ key: 'repo-filter', text: 'thi', kind: 'change' })
      const picks = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('pick:'))
      expect(picks.map(one => one.key)).toEqual([pickKey('other/thing')])

      await ui.input({ key: 'repo-filter', text: 'nothing-like-it', kind: 'change' })
      expect(await ui.find({ type: 'Text', text: /^No match/ })).toBeDefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.input({ key: 'repo-filter', text: 'thing' })
    expect(fake.searches.at(-1)).toContain('repo:other/thing ')

    await ui.press({ key: 'switch' })
    await ui.input({ key: 'repo-filter', text: 'brand/new-repo' })
    expect(fake.searches.at(-1)).toContain('repo:brand/new-repo ')
  })

  test('/issues owner/name pins another repository, /issues . unpins it', async ($, on) => {
    const fake = fakeGitHub(on)

    const pinned = await slashIssues($, 'other/thing')
    expect(pinned.text).toBe('Showing other/thing issues.')
    expect(fake.searches.at(-1)).toContain('repo:other/thing ')

    const back = await slashIssues($, '.')
    expect(back.text).toBe('Showing acme/widgets issues.')

    const wrong = await slashIssues($, 'not a repo')
    expect(wrong.text).toContain('is not a repository')
  })
})

describe('lib', () => {
  test('parseRemote reads GitHub remotes in every spelling', () => {
    expect(parseRemote('git@github.com:AcmeLabs/orbit.git')).toBe('AcmeLabs/orbit')
    expect(parseRemote('https://github.com/jdoe/dotfiles.git')).toBe('jdoe/dotfiles')
    expect(parseRemote('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(parseRemote('ssh://git@github.com/acme/my.repo.git')).toBe('acme/my.repo')
    expect(parseRemote('https://token@github.com/acme/widgets/')).toBe('acme/widgets')
    expect(parseRemote('git@gitlab.com:acme/widgets.git')).toBeNull()
  })

  test('age rounds to the largest unit', () => {
    expect(age('2026-10-06T09:59:40Z', NOW)).toBe('just now')
    expect(age('2026-10-06T09:15:00Z', NOW)).toBe('45m')
    expect(age('2026-10-05T22:00:00Z', NOW)).toBe('12h')
    expect(age('2026-09-30T10:00:00Z', NOW)).toBe('6d')
    expect(age('2026-09-06T10:00:00Z', NOW)).toBe('4w')
    expect(age('2025-01-01T00:00:00Z', NOW)).toBe('1y')
    expect(age('not a date', NOW)).toBe('')
  })

  test('excerpt drops HTML comments and cuts long bodies', () => {
    expect(excerpt('<!-- template -->\n\nReal text')).toBe('Real text')
    expect(excerpt('   ')).toBe('_No description._')
    expect(excerpt('abcdef', 3)).toBe('abc…')
  })

  test('parseRepos keeps repositories with issues turned on, not archived', () => {
    expect(parseRepos(JSON.stringify(REPOS)).map(one => one.name)).toEqual(['other/thing', 'acme/widgets'])
    expect(parseRepos('{"data":{"viewer":{"repositories":{"nodes":[]}}}}')).toEqual([])
    expect(reposArgs()[3]).toContain('affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]')
  })

  test('label chips: three at most, a dot that shows on a light pane', () => {
    const labels = ['a', 'b', 'c', 'd', 'e'].map(name => ({ name, color: 'a2eeef' }))
    expect(chips(labels)).toEqual({ shown: labels.slice(0, 3), more: 2 })
    expect(labelDot('d73a4a')).toBe('#d73a4a')
    expect(labelDot('A2EEEF')).toBe('#71a7a7')
    expect(labelDot('fbca04')).toBe('#b08d03')
    expect(labelDot('')).toBe('#808080')
  })

  test('byOwner groups by owner in push order and filters by every word', () => {
    const repos = parseRepos(JSON.stringify(REPOS))
    expect(byOwner(repos, null, '').map(one => one.owner)).toEqual(['other', 'acme'])
    expect(byOwner(repos, 'acme/widgets', '').map(one => one.owner)).toEqual(['other'])
    expect(byOwner(repos, null, 'acme wid').flatMap(one => one.repos.map(repo => repo.name))).toEqual(['acme/widgets'])
    expect(matchesQuery('AcmeLabs/orbit', 'acme ORB')).toBe(true)
  })

  test('searchQuery spells each tab, a label and typed text', () => {
    expect(searchQuery('a/b', 'created')).toBe('repo:a/b is:issue is:open author:@me sort:updated-desc')
    expect(searchQuery('a/b', 'open', '  login bug ', 'needs "info"')).toBe(
      'repo:a/b is:issue is:open label:"needs info" login bug sort:updated-desc',
    )
    expect(issuesArgs('a/b', 'open')).toEqual(expect.arrayContaining(['owner=a', 'name=b']))
  })

  test('parseIssuesPage reads issues, the total, assigned issues and labels', () => {
    const page = parseIssuesPage(JSON.stringify(issuesPage([42])))
    expect(page.total).toBe(2)
    expect(page.issues.map(issue => [issue.number, issue.comments, issue.pr?.state ?? null])).toEqual([
      [42, 2, 'DRAFT'],
      [7, 0, null],
    ])
    expect(page.assigned).toEqual({
      total: 1,
      issues: [{ number: 42, title: 'Crash on launch', url: 'https://github.com/acme/widgets/issues/42' }],
    })
    expect(page.labels.map(one => one.name)).toEqual(['bug', 'ui'])
  })

  test('labelOptions: Any, the chosen one, the most used, then by name, 64 at most', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ name: `l${String(index).padStart(3, '0')}`, color: '' }))
    const used = [{ labels: [{ name: 'l050', color: '' }] }, { labels: [{ name: 'l050', color: '' }, { name: 'l070', color: '' }] }]
    const options = labelOptions(many, used, 'l099')
    expect(options).toHaveLength(64)
    expect(options.slice(0, 5).map(option => option.value)).toEqual(['', 'l099', 'l050', 'l070', 'l000'])
    expect(labelOptions([], [], '')).toEqual([{ key: 'label:any', value: '', label: 'Any label' }])
  })

  test('labelPills: 11px text on tinted pills in one SVG, wrapped, ink for light and dark panes', () => {
    const one = labelPills([{ name: 'platform: ios', color: '1d76db' }], 300)
    expect(one.height).toBe(20)
    expect(one.width).toBe(textWidth('platform: ios') + 16)
    expect(one.source).toContain("fill='#1d76db' stroke='#1d76db'")
    expect(one.source).toContain('font:500 11px')
    expect(one.source).toContain('@media(prefers-color-scheme:dark){.c0{fill:#8ebcf0}}')
    const three = [
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'platform: ios', color: '1d76db' },
      { name: 'platform: android', color: '0e8a16' },
    ]
    expect(labelPills(three, 400).height).toBe(20)
    expect(labelPills(three, 180).height).toBe(44)
    expect(labelPills([{ name: '<b>&', color: 'zz' }], 300).source).toContain('>&lt;b&gt;&amp;</text>')
    const ink = labelInk('fbca04')
    expect(ink.light).not.toBe('#fbca04')
    expect(ink.dark).toBe('#fde582')
    expect(labelInk('0e8a16').light).toBe('#0e8a16')
  })

  test('spinnerFrame steps through the frames on time', () => {
    expect(spinnerFrame(0)).toBe('⠋')
    expect(spinnerFrame(100)).toBe('⠙')
    expect(spinnerFrame(1_000)).toBe('⠋')
    expect(SPINNER_SVG).toContain('@keyframes')
  })

  test('fitCards keeps cards in order until the budget runs out', () => {
    const cards = ['aaaa', 'bbbb', 'cccc']
    expect(fitCards('top', cards, 30)).toEqual({ kept: ['aaaa', 'bbbb', 'cccc'], cut: 0 })
    expect(fitCards('top', cards, 20)).toEqual({ kept: ['aaaa', 'bbbb'], cut: 1 })
    expect(fitCards('top', cards, 5)).toEqual({ kept: [], cut: 3 })
  })

  test('pickKey keeps only characters the desktop passes through unchanged', () => {
    expect(pickKey('AcmeLabs/orbit')).toBe('pick:AcmeLabs_2forbit')
    expect(pickKey('acme/my.repo_x')).toBe('pick:acme_2fmy_2erepo_5fx')
    expect(pickKey('a/b')).not.toBe(pickKey('a_b'))
  })

  test('pickPr prefers open, then draft, then merged, then closed', () => {
    const pr = (number: number, state: string, isDraft = false) => ({ number, url: `https://x/${number}`, state, isDraft })
    expect(pickPr([pr(1, 'CLOSED'), pr(2, 'MERGED'), pr(3, 'OPEN', true), pr(4, 'OPEN')])?.number).toBe(4)
    expect(pickPr([pr(1, 'CLOSED'), pr(2, 'MERGED'), pr(3, 'OPEN', true)])?.state).toBe('DRAFT')
    expect(pickPr([pr(1, 'CLOSED'), pr(2, 'MERGED')])?.state).toBe('MERGED')
    expect(pickPr([])).toBeNull()
  })

  test('alerts: nothing on a first look, then each new issue', () => {
    const assigned = {
      total: 2,
      issues: [
        { number: 1, title: 'One', url: 'https://x/1' },
        { number: 2, title: 'Two', url: 'https://x/2' },
      ],
    }
    expect(newlyAssigned(assigned, undefined)).toEqual([])
    expect(newlyAssigned(assigned, [1]).map(issue => issue.number)).toEqual([2])
    expect(assignedToast('a/b', assigned.issues)).toBe('2 issues newly assigned to you in a/b')
    expect(assignedToast('a/b', [])).toBeUndefined()
  })

  test('isSameRepo: the same repository, or a fork of it', () => {
    expect(isSameRepo('acme/widgets', 'acme/widgets')).toBe(true)
    expect(isSameRepo('jdoe/Widgets', 'acme/widgets')).toBe(true)
    expect(isSameRepo('acme/gadgets', 'acme/widgets')).toBe(false)
    expect(isSameRepo(null, 'acme/widgets')).toBe(false)
  })

  test('workPrompt asks to read the issue and reference it', () => {
    expect(workPrompt('a/b', { number: 3, title: 'T', url: 'https://github.com/a/b/issues/3' })).toContain(
      'Reference #3',
    )
  })

  test('issueCommands reads the setting; issueArgs names the issue', () => {
    expect(issueCommands('implement, wayfinder')).toEqual(['implement', 'wayfinder'])
    expect(issueCommands(' /implement,,implement  mattpocock-skills:tdd bad!name')).toEqual(['implement', 'mattpocock-skills:tdd'])
    expect(issueCommands('')).toEqual([])
    expect(issueArgs({ number: 3, url: 'https://github.com/a/b/issues/3' })).toBe('#3 https://github.com/a/b/issues/3')
  })

  test('paneBackground takes #rrggbb and nothing else', () => {
    expect(paneBackground(' #1E1E1E ')).toBe('#1E1E1E')
    expect(paneBackground('')).toBeNull()
    expect(paneBackground('black')).toBeNull()
    expect(paneBackground('#fff')).toBeNull()
  })

  test('commandsFor: the run: labels name the commands, else the setting does', () => {
    const issue = (...names: string[]) => ({ labels: names.map(name => ({ name, color: '0e8a16' })) })
    const configured = ['implement', 'wayfinder']
    expect(commandsFor(issue('bug', 'run:implement'), configured)).toEqual(['implement'])
    expect(commandsFor(issue('run:wayfinder', 'run:research'), configured)).toEqual(['wayfinder', 'research'])
    expect(commandsFor(issue('bug'), configured)).toEqual(['implement', 'wayfinder'])
    expect(commandsFor(issue('run:'), configured)).toEqual(['implement', 'wayfinder'])
    expect(commandsFor(issue(), [])).toEqual([])
  })

  test('runGroups reads named groups and skips the broken ones', () => {
    expect(runGroups('Plan: wayfinder, research; Implement: implement')).toEqual([
      { name: 'Plan', commands: ['wayfinder', 'research'] },
      { name: 'Implement', commands: ['implement'] },
    ])
    expect(runGroups('no colon; : implement; Empty: ; Plan: wayfinder; Plan: research')).toEqual([
      { name: 'Plan', commands: ['wayfinder'] },
    ])
    expect(runGroups('')).toEqual([])
    expect(searchQuery('a/b', 'open', '', '', ['wayfinder', 'research'])).toBe(
      'repo:a/b is:issue is:open label:"run:wayfinder","run:research" sort:updated-desc',
    )
  })

  test('cmuxSurface reads the surface cmux opened', () => {
    expect(cmuxSurface('OK surface=surface:1000010023 pane=pane:1000010013 placement=split')).toBe('surface:1000010023')
    expect(cmuxSurface('OK')).toBeNull()
  })

  test('parseThread reads gh issue view; fitThread keeps comments in order until the budget runs out', () => {
    const thread = parseThread(JSON.stringify({
      number: 3, title: 'T', url: 'u', state: 'OPEN', author: { login: 'ada' }, createdAt: '2026-10-01T10:00:00Z',
      labels: [{ name: 'bug', color: 'd73a4a' }], body: 'Body',
      comments: [{ author: { login: 'bob' }, body: 'a'.repeat(30) }, { author: null, body: 'b'.repeat(30) }],
    }))
    expect(thread.author).toBe('ada')
    expect(thread.comments.map(one => one.author)).toEqual(['bob', ''])
    expect(fitThread(thread, 50)).toMatchObject({ body: 'Body', cut: 1 })
    expect(fitThread(thread).cut).toBe(0)
  })
})
