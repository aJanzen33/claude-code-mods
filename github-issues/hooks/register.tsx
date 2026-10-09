import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  ActiveIssue,
  Issue,
  IssueDetail,
  IssueFilter,
  IssueLabel,
  IssuesPane,
  IssueView,
  OpenIssue,
  ReaderIssue,
  RepoChoice,
  RepoPicker,
  RunGroup,
} from '../types'
import {
  age,
  FILTERS,
  SPINNER_MS,
  SPINNER_SVG,
  assignedToast,
  byOwner,
  chips,
  excerpt,
  fitCards,
  isRepoName,
  isSameRepo,
  issueArgs,
  cmuxSurface,
  commandsFor,
  fitThread,
  parseThread,
  threadArgs,
  threadIssue,
  issueCommands,
  nextSort,
  SORTS,
  runGroups,
  runColor,
  sameAcross,
  splitSeries,
  RUN_LABEL,
  paneBackground,
  issuesArgs,
  labelDot,
  LABEL_CHIPS,
  labelChips,
  manifestVersion,
  milestoneChips,
  labelPills,
  matchesQuery,
  meta,
  mineArgs,
  newlyAssigned,
  parseAssigned,
  parseDetail,
  parseIssuesPage,
  parseRemote,
  parseRepos,
  pickKey,
  prBadge,
  repoMeta,
  reposArgs,
  spinnerFrame,
  viewArgs,
  workPrompt,
} from './lib'
import type { Assigned, IssuesPage } from './lib'

const PANE = 'github-issues'
// The second pane: one issue whole, opened by ≡ on its card.
const READER = 'github-issue'
const TITLE = 'Issues'
const REFRESH_MS = 2 * 60_000
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const CMUX_PATHS = ['cmux', '/Applications/cmux.app/Contents/Resources/bin/cmux']
// The default browser's openers, tried in turn: macOS, Linux, Windows.
const OPENERS: readonly string[][] = [['open'], ['xdg-open'], ['rundll32', 'url.dll,FileProtocolHandler']]
// GitHub's open and closed issue colors; both read on a light pane and on a dark one.
const OPEN_COLOR = '#3fb950'
// A faint gray between issues, on a light pane and on a dark one.
const DIVIDER = '#6e7681'
const CLOSED_COLOR = '#a371f7'

// The run filters from the settings; register sets them on every load.
let groups: RunGroup[] = []
// Where ↗ opens an issue, from the settings.
let browser: 'cmux' | 'system' = 'cmux'
// The cmux browser split ↗ opened, reused for the next issue while it stays open.
let browserSurface: string | undefined

const EMPTY_PAGE: IssuesPane = {
  repo: null,
  scope: { filter: 'open', search: '', label: '', run: '', sort: 'number-desc', milestone: '' },
  load: { kind: 'empty' },
  issues: [],
  total: 0,
  labels: [],
  milestones: [],
  assigned: 0,
}

const view = atom({ plugin: 'github-issues', key: 'view' } as const, 'issues')
const query = atom({ plugin: 'github-issues', key: 'query' } as const, '')
const picker = atom({ plugin: 'github-issues', key: 'picker' } as const, {
  load: { kind: 'empty' },
  repos: [],
  here: null,
})
const pinned = atom({ plugin: 'github-issues', key: 'pinned' } as const, null)
const page = atom({ plugin: 'github-issues', key: 'page' } as const, EMPTY_PAGE)
const searchDraft = atom({ plugin: 'github-issues', key: 'searchDraft' } as const, '')
const open = atom({ plugin: 'github-issues', key: 'open' } as const, null)
const active = atom({ plugin: 'github-issues', key: 'active' } as const, null)
const reading = atom({ plugin: 'github-issues', key: 'reading' } as const, null)
// Whether ⇥ closed the panes for the conversation's sake; a row above the prompt brings them back.
const collapsed = atom({ plugin: 'github-issues', key: 'collapsed' } as const, false)
// Whether the tabs, run filters, search and label picker show; folded away by default.
const filtersOpen = atom({ plugin: 'github-issues', key: 'filtersOpen' } as const, false)
// Whether the label row shows every label or only the first `LABEL_CHIPS`.
const labelsAll = atom({ plugin: 'github-issues', key: 'labelsAll' } as const, false)

type Gh = { ok: true; stdout: string } | { ok: false; message: string }

let ghPath: string | undefined
let generation = 0
let repoGeneration = 0
let spinner: Timer | undefined
// The mod's version from its plugin.json, shown in the header so a reload shows which one runs.
let version: string | null = null
const details = new Map<string, IssueDetail>()

/**
 * The setters write a value only when it changed. Every write redraws the
 * pane, and a redraw gives every Button a new handle, so a press already on
 * its way with the old one is dropped: the fewer redraws, the fewer lost taps.
 */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function setView($: EngineInterface, value: IssueView): Promise<void> {
  if (!same(await read($, view), value)) await update($, view, () => value)
}

async function setQuery($: EngineInterface, value: string): Promise<void> {
  if (!same(await read($, query), value)) await update($, query, () => value)
}

async function setPicker($: EngineInterface, value: RepoPicker): Promise<void> {
  if (!same(await read($, picker), value)) await update($, picker, () => value)
}

async function setPinned($: EngineInterface, value: string | null): Promise<void> {
  if (!same(await read($, pinned), value)) await update($, pinned, () => value)
}

async function setPage($: EngineInterface, value: IssuesPane): Promise<void> {
  if (!same(await read($, page), value)) await update($, page, () => value)
}

async function setSearchDraft($: EngineInterface, value: string): Promise<void> {
  if (!same(await read($, searchDraft), value)) await update($, searchDraft, () => value)
}

async function setOpen($: EngineInterface, value: OpenIssue | null): Promise<void> {
  if (!same(await read($, open), value)) await update($, open, () => value)
}

async function setActive($: EngineInterface, value: ActiveIssue | null): Promise<void> {
  if (!same(await read($, active), value)) await update($, active, () => value)
}

async function gh($: EngineInterface, args: string[]): Promise<Gh> {
  if (ghPath === undefined) {
    for (const candidate of GH_PATHS) {
      try {
        const probe = await $.process.run([candidate, '--version'], { timeoutMs: 5_000 })
        if (probe.exitCode === 0) {
          ghPath = candidate
          break
        }
      } catch {
        // not installed at this path
      }
    }
  }
  if (ghPath === undefined) {
    return { ok: false, message: 'The GitHub CLI (gh) was not found. Install it, then run `gh auth login`.' }
  }

  try {
    const ran = await $.process.run([ghPath, ...args], { timeoutMs: 30_000 })
    if (ran.exitCode === 0) return { ok: true, stdout: ran.stdout }
    const reason = ran.stderr.trim().split('\n')[0] ?? ''

    return { ok: false, message: reason || `gh exited with code ${ran.exitCode}` }
  } catch {
    return { ok: false, message: 'gh did not answer in time.' }
  }
}

/** Runs `argv`, true when it exited 0; false when it failed or is not installed. */
async function tryRun($: EngineInterface, argv: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10_000 })

    return { ok: ran.exitCode === 0, stdout: ran.stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * Shows `url` in a cmux browser split beside the terminal, the one ↗ opened
 * before while it is still open; with `browser` set to system, or outside
 * cmux, in the default browser, on macOS, Linux or Windows.
 */
async function openInBrowser($: EngineInterface, url: string): Promise<void> {
  if (browser === 'cmux') {
    for (const cmux of CMUX_PATHS) {
      if (browserSurface !== undefined) {
        if ((await tryRun($, [cmux, 'browser', '--surface', browserSurface, 'navigate', url])).ok) return
        browserSurface = undefined
      }
      const opened = await tryRun($, [cmux, 'browser', 'open', url, '--focus', 'false'])
      if (opened.ok) {
        browserSurface = cmuxSurface(opened.stdout) ?? undefined
        return
      }
    }
  }
  for (const opener of OPENERS) {
    if ((await tryRun($, [...opener, url])).ok) return
  }
  $.ui.toast(`Could not open ${url}.`)
}

async function detectRepo($: EngineInterface): Promise<string | null> {
  const found = await $.session.repo()
  const fromRemote = found?.remote ? parseRemote(found.remote) : null
  if (fromRemote !== null || found === null) return fromRemote

  const viewed = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

  return viewed.ok && isRepoName(viewed.stdout.trim()) ? viewed.stdout.trim() : null
}

/**
 * Reloads the issues shown; with no repository to show, opens the picker.
 * `isQuiet` (the timer, a finished turn): no spinner, the list kept on a
 * failure, and no redraw at all unless something changed.
 */
async function refresh($: EngineInterface, isQuiet = false): Promise<void> {
  if ((await read($, view)) !== 'issues') return
  try {
    await loadIssues($, isQuiet)
  } finally {
    await syncSpinner($)
  }
}

async function loadIssues($: EngineInterface, isQuiet: boolean): Promise<void> {
  const mine = ++generation
  const target = (await read($, pinned)) ?? (await detectRepo($))
  if (mine !== generation) return
  if (target === null) {
    await setPage($, EMPTY_PAGE)
    await showRepos($)
    return
  }

  const before = await read($, page)
  const isNewRepo = before.repo !== target
  let current: IssuesPane = isNewRepo
    ? { ...EMPTY_PAGE, repo: target, scope: { ...EMPTY_PAGE.scope, filter: before.scope.filter, run: before.scope.run ?? '', sort: before.scope.sort ?? 'number-desc' } }
    : before
  if (isNewRepo) {
    await setOpen($, null)
    await setActive($, null)
    await setSearchDraft($, '')
  }
  if (isNewRepo || !isQuiet || current.load.kind !== 'ready') {
    current = { ...current, load: { kind: 'loading' } }
    await setPage($, current)
    void syncSpinner($)
  }

  const { filter, search, label } = current.scope
  // State kept from before 0.6.0 has no run filter.
  const runs = groups.find(one => one.name === (current.scope.run ?? ''))?.commands ?? []
  const sort = current.scope.sort ?? 'number-desc'
  const listed = await gh($, issuesArgs(target, filter, search, label, runs, sort, current.scope.milestone ?? ''))
  if (mine !== generation) return
  const keepsList = isQuiet && current.load.kind === 'ready'
  if (!listed.ok) {
    if (!keepsList) await setPage($, { ...current, load: { kind: 'error', message: listed.message } })
    return
  }

  let parsed: IssuesPage
  try {
    parsed = parseIssuesPage(listed.stdout)
  } catch {
    const message = 'gh answered with something that is not JSON.'
    if (!keepsList) await setPage($, { ...current, load: { kind: 'error', message } })
    return
  }
  await noteAssigned($, target, parsed.assigned)
  await setPage($, {
    ...current,
    load: { kind: 'ready' },
    issues: parsed.issues,
    total: parsed.total,
    labels: parsed.labels,
    milestones: parsed.milestones,
    assigned: parsed.assigned.total,
  })
}

/** A toast for issues assigned since the last look at `target`, which the store keeps across sessions. */
async function noteAssigned($: EngineInterface, target: string, mine: Assigned): Promise<void> {
  const key = `seen:${target}`
  const toast = assignedToast(target, newlyAssigned(mine, await $.store.get(key)))
  if (toast !== undefined) $.ui.toast(toast, { timeoutMs: 8_000 })
  await $.store.set(
    key,
    mine.issues.map(issue => issue.number),
  )
}

/** The check while the picker shows instead of the list: only the person's assigned issues. */
async function checkAssigned($: EngineInterface): Promise<void> {
  const target = (await read($, pinned)) ?? (await detectRepo($))
  if (target === null) return
  const listed = await gh($, mineArgs(target))
  if (!listed.ok) return
  let mine: Assigned
  try {
    mine = parseAssigned(listed.stdout)
  } catch {
    return
  }
  await noteAssigned($, target, mine)
  const current = await read($, page)
  if (current.repo === target) await setPage($, { ...current, assigned: mine.total })
}

/** The timer: nothing while the pane is closed; the list, or the assigned check alone in the picker. */
async function tick($: EngineInterface): Promise<void> {
  if (!(await isOpen($))) return
  if ((await read($, view)) === 'issues') await refresh($, true)
  else await checkAssigned($)
}

/** Narrows the list: the new scope and the spinner in one write, the results in the next. */
async function rescope($: EngineInterface, change: Partial<IssuesPane['scope']>): Promise<void> {
  await setOpen($, null)
  const current = await read($, page)
  await setPage($, { ...current, scope: { ...current.scope, ...change }, load: { kind: 'loading' } })
  await refresh($)
}

async function submitSearch($: EngineInterface, text: string): Promise<void> {
  await setSearchDraft($, text)
  await rescope($, { search: text.trim() })
}

/** Back to every open issue: no tab but Open, no run filter, search or label. */
async function clearAll($: EngineInterface): Promise<void> {
  await setSearchDraft($, '')
  await rescope($, { filter: 'open', run: '', search: '', label: '', milestone: '' })
}

async function clearSearch($: EngineInterface): Promise<void> {
  await setSearchDraft($, '')
  await rescope($, { search: '', label: '', milestone: '' })
}

/** Switches the pane to the repository picker and loads its choices. */
async function showRepos($: EngineInterface): Promise<void> {
  try {
    await loadRepos($)
  } finally {
    await syncSpinner($)
  }
}

async function loadRepos($: EngineInterface): Promise<void> {
  const mine = ++repoGeneration
  // The list doesn't read these, so they redraw nothing until the view switches.
  const before = await read($, picker)
  await setPicker($, { ...before, load: { kind: 'loading' } })
  await setQuery($, '')
  await setView($, 'repos')
  void syncSpinner($)

  const session = await detectRepo($)
  const listed = await gh($, reposArgs())
  if (mine !== repoGeneration) return
  if (!listed.ok) {
    await setPicker($, { ...before, here: session, load: { kind: 'error', message: listed.message } })
    return
  }

  let parsed: RepoChoice[]
  try {
    parsed = parseRepos(listed.stdout)
  } catch {
    const message = 'gh answered with something that is not JSON.'
    await setPicker($, { ...before, here: session, load: { kind: 'error', message } })
    return
  }
  await setPicker($, { load: { kind: 'ready' }, repos: parsed, here: session })
}

/** Shows `name`'s issues: pinned, unless it is the session's own repository. */
async function chooseRepo($: EngineInterface, name: string): Promise<void> {
  const session = (await read($, picker)).here
  await setPinned($, name === session ? null : name)
  await backToIssues($)
}

/** Enter in the picker's filter: the name typed, else the first match. */
async function submitQuery($: EngineInterface, text: string): Promise<void> {
  const typed = text.trim()
  if (isRepoName(typed)) {
    await chooseRepo($, typed)
    return
  }
  const { here, repos } = await read($, picker)
  const names = [...(here === null ? [] : [here]), ...repos.map(one => one.name)]
  const first = names.find(name => matchesQuery(name, typed))
  if (first !== undefined) await chooseRepo($, first)
}

/** Back to the list: its spinner set while the picker still shows, so the switch is one redraw. */
async function backToIssues($: EngineInterface): Promise<void> {
  const current = await read($, page)
  await setPage($, { ...current, load: { kind: 'loading' } })
  await setView($, 'issues')
  await refresh($)
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

// The store key holding the pane's values between a /clear and the session after it.
const CARRIED = 'carried'

/** What a /clear would reset and the person would miss: the list as shown, the card opened, the reader, the folds. Not `active`: the work it marked ended with the conversation. */
type Carried = {
  view: IssueView
  pinned: string | null
  page: IssuesPane
  searchDraft: string
  open: OpenIssue | null
  reading: ReaderIssue | null
  collapsed: boolean
  filtersOpen: boolean
}

function isCarried(value: unknown): value is Carried {
  return typeof value === 'object' && value !== null && 'page' in value && 'view' in value
}

/** Writes the pane's values to the store, for `restore` in the session that follows a /clear. */
async function carry($: EngineInterface): Promise<void> {
  const carried: Carried = {
    view: await read($, view),
    pinned: await read($, pinned),
    page: await read($, page),
    searchDraft: await read($, searchDraft),
    open: await read($, open),
    reading: await read($, reading),
    collapsed: await read($, collapsed),
    filtersOpen: await read($, filtersOpen),
  }
  await $.store.set(CARRIED, carried)
}

/** Puts the carried values back and takes them off the store; false when there was nothing carried. */
async function restore($: EngineInterface): Promise<boolean> {
  const carried = await $.store.get(CARRIED)
  if (carried === undefined) return false
  await $.store.delete(CARRIED)
  if (!isCarried(carried)) return false
  await setView($, carried.view)
  await setPinned($, carried.pinned)
  await setPage($, carried.page)
  await setSearchDraft($, carried.searchDraft)
  await setOpen($, carried.open)
  await update($, reading, () => carried.reading)
  await update($, collapsed, () => carried.collapsed)
  await update($, filtersOpen, () => carried.filtersOpen)

  return true
}

async function openPane($: EngineInterface): Promise<void> {
  await update($, collapsed, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
  await $.store.set('isOpen', true)
}

/** Closes the list and the reader so the conversation gets the whole width; the row above the prompt reopens them. */
async function collapse($: EngineInterface): Promise<void> {
  await update($, collapsed, () => true)
  await $.ui.close({ id: READER })
  await $.ui.close({ id: PANE })
}

async function expand($: EngineInterface): Promise<void> {
  await openPane($)
  await refresh($, true)
}

/** Opens `number` of the listed repository in the reader pane, a tab beside the list, and loads it whole. */
async function openReader($: EngineInterface, number: number): Promise<void> {
  const repo = (await read($, page)).repo
  if (repo === null) return
  await update($, reading, (): ReaderIssue => ({ repo, number, load: { kind: 'loading' }, thread: null }))
  await $.ui.open({ id: READER, title: `#${number}` })
  await loadThread($, repo, number)
}

async function loadThread($: EngineInterface, repo: string, number: number): Promise<void> {
  const viewed = await gh($, threadArgs(repo, number))
  const still = (shown: ReaderIssue | null) => shown?.repo === repo && shown.number === number
  if (!still(await read($, reading))) return
  if (!viewed.ok) {
    await update($, reading, (shown): ReaderIssue | null =>
      still(shown) ? { repo, number, load: { kind: 'error', message: viewed.message }, thread: null } : shown,
    )
    return
  }
  try {
    const thread = parseThread(viewed.stdout)
    await update($, reading, (shown): ReaderIssue | null => (still(shown) ? { repo, number, load: { kind: 'ready' }, thread } : shown))
  } catch {
    const message = 'gh answered with something that is not JSON.'
    await update($, reading, (shown): ReaderIssue | null =>
      still(shown) ? { repo, number, load: { kind: 'error', message }, thread: null } : shown,
    )
  }
}

async function toggleDetail($: EngineInterface, number: number): Promise<void> {
  try {
    await loadDetail($, number)
  } finally {
    await syncSpinner($)
  }
}

/**
 * Keeps the terminal's spinner turning while anything loads: a redraw per
 * frame, and only then. Surfaces that draw SVG show one that turns by itself.
 */
async function syncSpinner($: EngineInterface): Promise<void> {
  const shown = await read($, open)
  const isBusy =
    (await read($, page)).load.kind === 'loading' ||
    (await read($, picker)).load.kind === 'loading' ||
    (shown !== null && shown.detail === null)
  const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
  const isTicking = isBusy && surfaces.includes('terminal')
  if (isTicking && spinner === undefined) {
    spinner = $.clock.every(SPINNER_MS, () => $.ui.invalidate('ui.render'))
  } else if (!isTicking && spinner !== undefined) {
    spinner.cancel()
    spinner = undefined
  }
}

async function loadDetail($: EngineInterface, number: number): Promise<void> {
  if ((await read($, open))?.number === number) {
    await setOpen($, null)
    return
  }
  const target = (await read($, page)).repo
  if (target === null) return
  const key = `${target}#${number}`
  const known = details.get(key) ?? null
  await setOpen($, { number, detail: known })
  if (known !== null) return
  void syncSpinner($)

  const viewed = await gh($, viewArgs(target, number))
  if ((await read($, open))?.number !== number) return
  let loaded: IssueDetail
  if (!viewed.ok) {
    loaded = { number, body: `Could not load this issue: ${viewed.message}`, comments: 0 }
  } else {
    try {
      loaded = parseDetail(viewed.stdout)
      details.set(key, loaded)
    } catch {
      loaded = { number, body: 'gh answered with something that is not JSON.', comments: 0 }
    }
  }
  await setOpen($, { number, detail: loaded })
}

/**
 * Hands `issue` to Claude as a prompt of its own. Claude Code starts a mod's
 * prompt once the session is idle, so while a turn runs it waits, and the
 * card says Queued until Claude's turn on it begins. Not sent, with a toast
 * saying why, when the session works in another repository, or when the
 * issue was already handed over. With `command`, the issue goes to that
 * slash command (`/implement #42 <url>`) in place of the prompt.
 */
async function workOn($: EngineInterface, issue: Issue, command?: string, repo?: string): Promise<void> {
  const target = repo ?? (await read($, page)).repo
  if (target === null) return
  const current = await read($, active)
  if (current?.number === issue.number) {
    const what = current.command === undefined ? 'Claude' : `/${current.command}`
    $.ui.toast(current.state === 'queued' ? `#${issue.number} is already queued for ${what}.` : `${what} is already on #${issue.number}.`)
    return
  }
  const session = await detectRepo($)
  if (!isSameRepo(session, target)) {
    $.ui.toast(
      `This session works in ${session ?? 'a folder with no GitHub repository'}, not ${target}. Open Claude Code in ${target}'s folder to hand Claude its issues.`,
      { timeoutMs: 10_000 },
    )
    return
  }

  await setActive($, { number: issue.number, state: 'queued', command })
  let outcome: 'started' | 'dropped' | undefined
  let why = ''
  const handed =
    command === undefined
      ? $.prompt.submit({ text: workPrompt(target, issue) }).then(result => result.drop === undefined)
      : $.command.run({ command, args: issueArgs(issue) }).then(() => true)
  const submitted = handed.then(
    started => {
      outcome = started ? 'started' : 'dropped'
    },
    (error: unknown) => {
      outcome = 'dropped'
      why = error instanceof Error ? error.message : ''
    },
  )
  await Promise.race([submitted, $.clock.sleep(500)])
  if (outcome === undefined) {
    $.ui.toast(`#${issue.number} is queued: Claude starts on it once it finishes the current task.`, { timeoutMs: 8_000 })
  }
  await submitted
  if ((await read($, active))?.number !== issue.number) return
  if (outcome === 'dropped') {
    await setActive($, null)
    $.ui.toast(`#${issue.number} was not handed to ${command === undefined ? 'Claude' : `/${command}`}.${why === '' ? '' : ` ${why}`}`)
    return
  }
  await setActive($, { number: issue.number, state: 'working', command })
}

export const register: Register = (on, options) => {
  groups = runGroups(typeof options.runGroups === 'string' ? options.runGroups : '')
  browser = options.browser === 'system' ? 'system' : 'cmux'
  const commands = issueCommands(typeof options.commands === 'string' ? options.commands : '')
  const background = paneBackground(typeof options.background === 'string' ? options.background : '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: "Show GitHub issues in a side pane: this folder's repository, or pick or name one",
      argumentHint: '[owner/name | .]',
    })
    const started = await next(e)
    void $.fs
      .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
      .then(text => {
        version = manifestVersion(text)
        $.ui.invalidate('ui.render')
      })
      .catch(() => undefined)
    // Versions before 0.1.0's release pinned a status line; take down any left from them.
    $.ui.status(undefined)

    $.clock.every(REFRESH_MS, () => tick($))
    if ((await $.store.get('isOpen')) === true) {
      void (async () => {
        await openPane($)
        await refresh($)
      })()
    }

    return started
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    let arg = e.args.trim()
    // Started in a folder whose repository is on GitHub, /issues alone shows its issues; elsewhere, the picker.
    if (arg === '' && (await detectRepo($)) !== null) arg = '.'
    if (arg === '') {
      await openPane($)
      await showRepos($)

      return { text: 'Choose a repository in the Issues pane.' }
    }
    if (arg !== '.' && !isRepoName(arg)) {
      return { text: `"${arg}" is not a repository. Use /issues owner/name, /issues . for this session's repository, or /issues to pick one.` }
    }

    await setPinned($, arg === '.' ? null : arg)
    await setView($, 'issues')
    await openPane($)
    await refresh($)

    const shown = (await read($, page)).repo

    return { text: shown === null ? 'Choose a repository in the Issues pane.' : `Showing ${shown} issues.` }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await isOpen($))) void refresh($, true)

    return done
  })

  // A /clear ends the session: its values go, the store stays. Carry the pane's over before they do.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await carry($)

    return next(e)
  })

  // The fresh session after a /clear gets no session.start; put the carried values back and bring the list up to date.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.source !== 'clear') return done
    void (async () => {
      const isRestored = await restore($)
      if (await isOpen($)) await refresh($, isRestored)
    })()

    return done
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('isOpen', false)
    if (e.id === READER) await update($, reading, () => null)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, collapsed))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { repo, issues, total, scope } = await read($, page)
    const noun = FILTERS.find(one => one.id === scope.filter)?.noun ?? scope.filter
    const counted = `${total > issues.length ? `${issues.length} of ${total}` : issues.length} ${noun}`

    return (
      <Box flexDirection="row" columnGap={1}>
        <Button key="expand" label="⇤ Issues" plain onPress={() => void expand($)} />
        {repo !== null && (
          <Text dimColor wrap="truncate-end">
            {`· ${repo.split('/')[1] ?? repo} · ${counted}`}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Link, Markdown, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    // The terminal's table answers Svg with an element that draws nothing, so ask the surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    // With a background set, the tree sits in a Box of that color filling the pane's body.
    const paint = (tree: JSX.Element) =>
      background === null ? (
        tree
      ) : (
        <Box
          flexDirection="column"
          width={e.props.bodyColumns}
          minHeight={e.props.scroll.bodyRows}
          backgroundColor={background}
        >
          {tree}
        </Box>
      )
    const now = await $.clock.now()
    const busy = (text: string) => (
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {Svg === undefined ? (
          <Text color="claude">{spinnerFrame(now)}</Text>
        ) : (
          <Svg source={SPINNER_SVG} alt="Loading" width={14} height={14} isInteractive />
        )}
        <Text dimColor>{text}</Text>
      </Box>
    )

    if ((await read($, view)) === 'repos') {
      const { here, repos: choices, load: status } = await read($, picker)
      const shown = (await read($, page)).repo
      const typed = await read($, query)
      const sections = byOwner(choices, here, typed)
      const isSessionShown = here !== null && matchesQuery(here, typed)
      const isEmpty = sections.length === 0 && !isSessionShown

      const row = (name: string, label: string) => (
        <Box key={`repo:${name}`} flexDirection="row" columnGap={2}>
          <Button
            key={pickKey(name)}
            label={name === shown ? `● ${label}` : label}
            plain
            onPress={() => void chooseRepo($, name)}
          />
          <Text dimColor wrap="truncate-end">
            {repoMeta(
              choices.find(one => one.name === name),
              now,
            )}
          </Text>
        </Box>
      )

      return paint(
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>Choose a repository</Text>
            {shown !== null && <Button key="back" label="Back" plain onPress={() => void backToIssues($)} />}
          </Box>
          {Input !== undefined && (
            <Box marginTop={1}>
              <Input
                key="repo-filter"
                placeholder="Filter, or type owner/name"
                value={typed}
                submitLabel="open"
                onInput={text => void setQuery($, text)}
                onSubmit={text => void submitQuery($, text)}
              />
            </Box>
          )}
          {status.kind !== 'ready' && (
            <Box marginTop={1}>
              {status.kind === 'error' ? (
                <Text dimColor wrap="wrap">
                  {status.message}
                </Text>
              ) : (
                busy(choices.length > 0 ? 'Refreshing…' : 'Loading repositories…')
              )}
            </Box>
          )}
          {isSessionShown && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                This session
              </Text>
              {row(here, here)}
            </Box>
          )}
          {sections.map(section => (
            <Box key={`owner:${section.owner}`} flexDirection="column" marginTop={1}>
              <Text dimColor bold>
                {section.owner}
              </Text>
              {section.repos.map(choice => row(choice.name, choice.name.slice(section.owner.length + 1)))}
            </Box>
          ))}
          {status.kind === 'ready' && isEmpty && (
            <Box marginTop={1}>
              <Text dimColor wrap="wrap">
                {isRepoName(typed.trim())
                  ? `Press Enter to open ${typed.trim()}.`
                  : typed === ''
                    ? 'No repositories found. Run /issues owner/name.'
                    : 'No match. Type owner/name and press Enter to open any repository.'}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const { repo: shown, scope, load: status, issues: list, total, labels, assigned } = await read($, page)
    // State kept from before 0.12.0 has no milestones.
    const milestones = (await read($, page)).milestones ?? []
    const opened = await read($, open)
    const working = await read($, active)
    const draft = await read($, searchDraft)
    const noun = FILTERS.find(one => one.id === scope.filter)?.noun ?? scope.filter
    const counted = `${total > list.length ? `${list.length} of ${total}` : list.length} ${noun}`
    const narrowing = [
      scope.search === '' ? '' : `matching "${scope.search}"`,
      scope.label === '' ? '' : `label ${scope.label}`,
      (scope.milestone ?? '') === '' ? '' : `milestone ${scope.milestone}`,
    ].filter(Boolean)
    const labelChoices = labelChips(labels, list, scope.label)
    const isEveryLabelShown = await read($, labelsAll)
    // Any and the first labels; the rest behind the +n button.
    const shownLabels = isEveryLabelShown ? labelChoices : labelChoices.slice(0, LABEL_CHIPS + 1)
    const hiddenLabels = labelChoices.length - shownLabels.length
    const areFiltersShown = await read($, filtersOpen)
    // What narrows the list beyond every open issue, said while the filters are folded away.
    const applied = [
      scope.filter === 'open' ? '' : (FILTERS.find(one => one.id === scope.filter)?.label ?? scope.filter),
      scope.run ?? '',
      ...narrowing,
    ].filter(Boolean)
    const isLoading = status.kind === 'loading' || status.kind === 'empty'
    // A card's inside: the pane's width less its border and padding.
    const rule = Math.max(1, e.props.bodyColumns - 4)
    const [owner, name] = shown === null ? [null, null] : (shown.split('/') as [string, string])
    // Labels are pills in one SVG where the surface draws SVG; on the terminal, dots and names.
    // A cell is about 7.5 CSS pixels wide on the surfaces that draw SVG.
    const pillsWidth = Math.max(160, Math.min(360, Math.floor(rule * 7.5)))
    const chipsOf = (shownLabels: readonly IssueLabel[]) => {
      if (Svg === undefined) {
        return shownLabels.map(one => (
          <Box flexDirection="row">
            <Text color={labelDot(one.color)}>●</Text>
            <Text>{` ${one.name}`}</Text>
          </Box>
        ))
      }
      const pills = labelPills(shownLabels, pillsWidth)

      return [
        <Svg
          source={pills.source}
          alt={`Labels: ${shownLabels.map(one => one.name).join(', ')}`}
          width={pills.width}
          height={pills.height}
        />,
      ]
    }

    const top = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" flexShrink={1} columnGap={1}>
            <Box flexDirection="row" flexShrink={1}>
              {owner === null ? (
                <Text bold>No repository</Text>
              ) : (
                <Text dimColor wrap="truncate-end">{`${owner} / `}</Text>
              )}
              {name !== null && (
                <Text bold wrap="truncate-end">
                  {name}
                </Text>
              )}
            </Box>
            {isLoading ? (
              busy(list.length > 0 ? `${counted} · refreshing…` : 'Loading issues…')
            ) : status.kind === 'error' ? null : (
              <Box flexDirection="row" columnGap={1} flexShrink={1}>
                <Text dimColor>·</Text>
                <Text dimColor wrap="truncate-end">
                  {list.length > 0 ? counted : `No issues ${noun}.`}
                </Text>
              </Box>
            )}
          </Box>
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            {version !== null && <Text dimColor>{`v${version}`}</Text>}
            {shown !== null && (
              <Button key="open-repo" label="↗" plain onPress={() => void openInBrowser($, `https://github.com/${shown}`)} />
            )}
            <Button key="switch" label="Repos" plain onPress={() => void showRepos($)} />
            <Button
              key="sort"
              label={SORTS.find(one => one.id === (scope.sort ?? 'number-desc'))?.label ?? '#↓'}
              plain
              onPress={() => void rescope($, { sort: nextSort(scope.sort ?? 'number-desc') })}
            />
            <Button key="refresh" label="↻" plain onPress={() => void rescope($, {})} />
            <Button key="collapse" label="⇥" plain onPress={() => void collapse($)} />
            <Button
              key="toggle-filters"
              label={areFiltersShown ? 'Filter ▾' : applied.length > 0 ? `Filter ▸ ${applied.length}` : 'Filter ▸'}
              plain
              onPress={() => void update($, filtersOpen, isShown => !isShown)}
            />
          </Box>
        </Box>
        {status.kind === 'error' && (
          <Text dimColor wrap="wrap">
            {status.message}
          </Text>
        )}
        {!areFiltersShown && applied.length > 0 && (
          <Box flexDirection="row" columnGap={2}>
            <Text dimColor wrap="truncate-end">
              {applied.join(' · ')}
            </Text>
            <Button key="clear-all" label="Clear" plain onPress={() => void clearAll($)} />
          </Box>
        )}
        {areFiltersShown && (
          <Box flexDirection="column">
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {FILTERS.map(one => (
                <Button
                  key={`filter:${one.id}`}
                  label={one.id === 'assigned' && assigned > 0 ? `${one.label} · ${assigned}` : one.label}
                  variant={one.id === scope.filter ? 'primary' : 'secondary'}
                  onPress={() => void rescope($, { filter: one.id as IssueFilter })}
                />
              ))}
            </Box>
            {groups.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {[{ name: '', label: 'All' }, ...groups.map(one => ({ name: one.name, label: one.name }))].map(one => (
                  <Button
                    key={`run-group:${one.name === '' ? '*' : one.name}`}
                    label={one.label}
                    variant={one.name === (scope.run ?? '') ? 'primary' : 'secondary'}
                    onPress={() => void rescope($, { run: one.name })}
                  />
                ))}
              </Box>
            )}
            {Input !== undefined && (
              <Input
                key="issue-search"
                placeholder="Search issues"
                value={draft}
                submitLabel="Search"
                onInput={text => void setSearchDraft($, text)}
                onSubmit={text => void submitSearch($, text)}
              />
            )}
            {/* Buttons, not a Select: a pick in the terminal's open Select was lost now and then. */}
            {labelChoices.length > 1 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>Label</Text>
                {shownLabels.map(one => (
                  <Button
                    key={one.key}
                    label={one.label}
                    variant={one.value === scope.label ? 'primary' : 'secondary'}
                    onPress={() => void rescope($, { label: one.value })}
                  />
                ))}
                {labelChoices.length > LABEL_CHIPS + 1 && (
                  <Button
                    key="labels-all"
                    label={isEveryLabelShown ? 'Fewer' : `+${hiddenLabels}`}
                    plain
                    onPress={() => void update($, labelsAll, isShown => !isShown)}
                  />
                )}
              </Box>
            )}
            {milestones.length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Text dimColor>Milestone</Text>
                {milestoneChips(milestones).map(one => (
                  <Button
                    key={one.key}
                    label={one.label}
                    variant={one.value === (scope.milestone ?? '') ? 'primary' : 'secondary'}
                    onPress={() => void rescope($, { milestone: one.value })}
                  />
                ))}
              </Box>
            )}
            {narrowing.length > 0 && (
              <Box flexDirection="row" columnGap={2}>
                <Text dimColor wrap="truncate-end">
                  {narrowing.join(', ')}
                </Text>
                <Button key="clear-filters" label="Clear" plain onPress={() => void clearSearch($)} />
              </Box>
            )}
          </Box>
        )}
      </Box>
    )

    // Told apart by what differs: labels on every listed issue and an age they all share drop out.
    const same = sameAcross(list, now)
    // The number column fits the widest number.
    const gutter = Math.max(3, ...list.map(issue => String(issue.number).length + 1))
    // Buttons stay dim until the pointer is over their issue, where the surface can tell.
    const quiet = { dimColor: true, hover: { dimColor: false } } as const

    const cards = list.map((issue, index) => {
      const isOpenHere = opened?.number === issue.number
      const handed = working?.number === issue.number ? working.state : null
      const isWorking = handed !== null
      // A run:<command> label shows as its button, not as a chip.
      const shownLabels = chips(issue.labels.filter(one => !one.name.startsWith(RUN_LABEL) && !same.labels.has(one.name)))
      const offered = commandsFor(issue, commands)
      const about = meta(issue, now, !same.age)
      const pr = issue.pr === null ? null : { ...issue.pr, ...prBadge(issue.pr) }
      const isClosed = issue.state.toUpperCase() === 'CLOSED'
      const tint = runColor(issue)
      const { series, rest } = splitSeries(issue.title)
      const isLast = index === list.length - 1

      return (
        <Box key={`issue:${issue.number}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Box width={gutter} flexShrink={0} justifyContent="flex-end">
              <Text
                bold
                {...(isWorking ? { color: 'claude' } : isClosed ? { dimColor: true } : tint === null ? {} : { color: tint })}
              >
                {`#${issue.number}`}
              </Text>
            </Box>
            <Box flexDirection="column" flexShrink={1} flexGrow={1}>
              <Text wrap="wrap" {...(isWorking ? { color: 'claude' } : {})}>
                {series !== '' && <Text color={tint ?? 'claude'}>{`${series} `}</Text>}
                {rest}
              </Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {isClosed && <Text color={CLOSED_COLOR}>✓ closed</Text>}
                {about !== '' && <Text dimColor>{about}</Text>}
                {pr !== null && (
                  <Box key={`pr:${issue.number}`} flexDirection="row" columnGap={1}>
                    <Link href={pr.url} label={`PR #${pr.number}`} />
                    <Text color={pr.color}>{pr.text}</Text>
                  </Box>
                )}
                {Svg === undefined && shownLabels.shown.length > 0 && (
                  <Box key={`labels:${issue.number}`} flexDirection="row" columnGap={1}>
                    {chipsOf(shownLabels.shown)}
                    {shownLabels.more > 0 && <Text dimColor>{`+${shownLabels.more}`}</Text>}
                  </Box>
                )}
                {(isClosed || about !== '' || pr !== null || (Svg === undefined && shownLabels.shown.length > 0)) && (
                  <Text dimColor>·</Text>
                )}
                {offered.length === 0 ? (
                  <Button
                    key={`work:${issue.number}`}
                    label={handed === 'queued' ? '◷ Queued' : handed === 'working' ? '● Working on it' : 'Work on it'}
                    plain
                    {...(isWorking ? {} : quiet)}
                    onPress={() => void workOn($, issue)}
                  />
                ) : (
                  offered.map(command => {
                    const mine = working?.command === command ? handed : null

                    return (
                      <Button
                        key={`run:${command}:${issue.number}`}
                        label={mine === 'queued' ? `◷ /${command}` : mine === 'working' ? `● /${command}` : `/${command}`}
                        plain
                        {...(mine === null ? quiet : {})}
                        onPress={() => void workOn($, issue, command)}
                      />
                    )
                  })
                )}
                <Button
                  key={`details:${issue.number}`}
                  label={isOpenHere ? '▾' : '▸'}
                  plain
                  {...quiet}
                  onPress={() => void toggleDetail($, issue.number)}
                />
                <Button key={`read:${issue.number}`} label="≡" plain {...quiet} onPress={() => void openReader($, issue.number)} />
                <Button key={`open:${issue.number}`} label="↗" plain {...quiet} onPress={() => void openInBrowser($, issue.url)} />
              </Box>
              {Svg !== undefined && shownLabels.shown.length > 0 && (
                <Box key={`labels:${issue.number}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
                  {chipsOf(shownLabels.shown)}
                  {shownLabels.more > 0 && <Text dimColor>{`+${shownLabels.more}`}</Text>}
                </Box>
              )}
              {isOpenHere && (
                <Box flexDirection="column" marginTop={1}>
                  {opened.detail !== null ? (
                    <Box flexDirection="column">
                      <Markdown key={`body:${issue.number}`} text={excerpt(opened.detail.body)} />
                      <Box flexDirection="row" columnGap={1} marginTop={1}>
                        <Text dimColor>
                          {opened.detail.comments === 1 ? '1 comment' : `${opened.detail.comments} comments`}
                        </Text>
                        <Text dimColor>·</Text>
                        <Link href={issue.url} label="View on GitHub" />
                      </Box>
                    </Box>
                  ) : (
                    busy('Loading…')
                  )}
                </Box>
              )}
            </Box>
          </Box>
          {!isLast && (
            <Text color={DIVIDER} wrap="truncate-end">
              {'─'.repeat(e.props.bodyColumns)}
            </Text>
          )}
        </Box>
      )
    })
    // The engine refuses a whole tree past its size bound, so cards stop short of it.
    const fitted = fitCards(top, cards)

    return paint(
      <Box flexDirection="column">
        {top}
        <Box flexDirection="column" marginTop={1}>
          {fitted.kept}
        </Box>
        {fitted.cut > 0 && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {`${fitted.cut} more didn't fit in the pane. Narrow the list with a search or a label.`}
            </Text>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: READER }, async ($, e) => {
    const { Box, Button, Link, Markdown, Text } = $.ui.resolve(e)
    const shown = await read($, reading)
    const working = await read($, active)
    const now = await $.clock.now()
    const paint = (tree: JSX.Element) =>
      background === null ? (
        tree
      ) : (
        <Box flexDirection="column" width={e.props.bodyColumns} minHeight={e.props.scroll.bodyRows} backgroundColor={background}>
          {tree}
        </Box>
      )

    if (shown === null) return paint(<Text dimColor>Press ≡ on an issue in the Issues pane to read it here.</Text>)
    const { repo, number, thread } = shown
    if (thread === null) {
      return paint(
        <Text dimColor wrap="wrap">
          {shown.load.kind === 'error' ? `Could not load #${number}: ${shown.load.message}` : `Loading #${number}…`}
        </Text>,
      )
    }

    const isClosed = thread.state.toUpperCase() === 'CLOSED'
    const issue = threadIssue(thread)
    const fitted = fitThread(thread)
    const labels = thread.labels.filter(one => !one.name.startsWith(RUN_LABEL)).map(one => one.name)
    const about = [repo, thread.author === '' ? '' : `@${thread.author}`, age(thread.createdAt, now), labels.join(', ')]
      .filter(Boolean)
      .join(' · ')

    return paint(
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text color={isClosed ? CLOSED_COLOR : OPEN_COLOR}>{isClosed ? '✓' : '○'}</Text>
          <Text bold wrap="wrap">
            {thread.title}
          </Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>
          <Link href={thread.url} label={`#${number}`} />
          <Text dimColor>{`· ${about} ·`}</Text>
          {commandsFor(thread, commands).map(command => {
            const mine = working?.number === number && working.command === command ? working.state : null

            return (
              <Button
                key={`reader-run:${command}`}
                label={mine === 'queued' ? `◷ /${command}` : mine === 'working' ? `● /${command}` : `/${command}`}
                plain
                onPress={() => void workOn($, issue, command, repo)}
              />
            )
          })}
          <Button key="reader-open" label="↗" plain onPress={() => void openInBrowser($, thread.url)} />
          <Button key="reader-reload" label="↻" plain onPress={() => void loadThread($, repo, number)} />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Markdown key="reader-body" text={fitted.body} />
        </Box>
        {fitted.comments.map((comment, index) => (
          <Box key={`comment:${index}`} flexDirection="column" marginTop={1}>
            <Text dimColor>{`── @${comment.author} · ${age(comment.createdAt, now)}`}</Text>
            <Markdown key={`comment-body:${index}`} text={comment.body} />
          </Box>
        ))}
        {fitted.cut > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{`${fitted.cut} more ${fitted.cut === 1 ? 'comment' : 'comments'} on GitHub.`}</Text>
          </Box>
        )}
      </Box>,
    )
  })

}
