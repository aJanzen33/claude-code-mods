# github-issues

A side pane in Claude Code that lists a repository's GitHub issues as cards.

<p>
  <img src="docs/issues.png" alt="The Issues pane: tabs, search, a label picker, and issue cards with labels, linked pull requests and actions" width="380">
  <img src="docs/picker.png" alt="The repository picker: a filter box and repositories grouped by owner, with open issue counts" width="380">
</p>

<sub>Screenshots show made-up repositories, people and issues.</sub>

**[Watch the demo on X](https://x.com/marcocarne_/status/2107456270873796697)**

- **Tabs:** Open, Assigned (with your count), Created, Closed
- **Search and labels:** a search box (Enter runs a GitHub search) and a row of label buttons: **Any**, then the labels the listed issues use most. **+n** shows the rest, up to 64 in all, and **Fewer** hides them again. **Clear** drops the search; the label and milestone stay until you pick another or **Any**.
- **Cards:** title, `#number` (opens the issue on GitHub), assignees, last update, comment count, linked pull request (open, draft, merged or closed), and labels as small pills in GitHub's colors
- **Details:** shows the issue's description inside its card
- **Work on it:** sends Claude a prompt to read the issue and its comments, plan, and implement it. Its card gets an accent border.
- **Assignment alerts:** a toast when an issue is newly assigned to you, and your count on the Assigned tab

The pane shows the 40 most recently updated issues that match. A spinner shows while it loads. The list refreshes when you open the pane, after each of Claude's turns, every two minutes, and when you press **Refresh**. If a repository's issues are too large to fit in the pane at once, the pane shows as many as fit and says how many more there are. Use search or a label to narrow the list. If you leave the pane open, it opens again in your next session.

## Usage

| Command | |
| --- | --- |
| `/issues` | Started in a folder whose repository is on GitHub: that repository's issues. Anywhere else: pick a repository, the 30 you pushed to most recently (yours, collaborations and your organizations'), each with its open issue count. **Switch repo** opens the picker from the issues |
| `/issues owner/name` | Show that repository's issues |
| `/issues .` | Show the session's repository (from the `origin` remote) |

In the picker, repositories are grouped by owner. Type in the filter box to narrow the list. Enter opens the first match, or any `owner/name` you type. **Switch repo** in the pane goes back to the picker. If the session isn't in a GitHub repository, the pane opens on the picker.

A `/clear` leaves the pane as it was: the list, the opened card, the reader and the filters stay, and the list is brought up to date in the background.

## The header

One row: the repository and how many issues are loaded, then the mod's version (`v0.17.0`, so a reload shows which one runs), **↗** (the repository on GitHub), **Repos** (the picker), the sort, **↻** (refresh), **⇥** and **Filter ▸**. **⇥** closes the list and the reader so the conversation gets the whole width; while they are away, one row above the prompt says `⇤ Issues · <repository> · <count>`, and a press on it brings the list back (so does `/issues`). Each repository keeps its tab, run filter, label, milestone and order, in this session and the next; the search alone is not kept. The filters (tabs, run filters, search, label and milestone) fold away under **Filter ▸**; folded, a line names what narrows the list, with **Clear** while a search is in it, and the button counts it (`Filter ▸ 2`).

## The list

Each issue is its number, in a column of its own, beside the title, then one dim row of what tells it apart and its actions; faint rules sit between issues. The number takes the color of the issue's `run:` label (green implement, purple wayfinder, blue research), and a series prefix such as `[Diff check 1]` stands out in it. Labels every listed issue carries and an age they all share are left out. The actions stay dim, lit under the pointer where the surface tracks it.

## Issue commands

Each card offers the slash commands set in **Issue commands** (`github-issues.commands` in `/config`), `/implement` and `/wayfinder` by default. A press runs `/<command> #<number> <url>` in this session, once it is idle, and the button shows `◷` while queued and `●` once it runs. Any slash command or skill works, e.g. `implement, wayfinder, mattpocock-skills:tdd`. Leave the setting empty for the card's original **Work on it** button.

An issue labelled `run:<command>` (`run:implement`, `run:research`) offers that command alone, whatever the setting says; the label shows as its button, not as a chip. Only issues without such a label offer the commands of the setting.

## Reader

**≡** on a card opens the issue whole in a second pane, a tab beside the list: the title, the full description and every comment with its author and age, with the issue's commands, **↗** and **↻** (reload) at the top. Very long threads stop where the pane's size bound would, saying how many comments are left on GitHub.

## Open in a browser

**↗** on a card opens the issue on GitHub, and **↗** in the header the repository. In [cmux](https://cmux.dev) it opens a browser split beside the terminal (`cmux browser open`) and later issues load into that same split while it stays open; outside cmux, or with **Open issues in** (`github-issues.browser`) set to `system`, it opens the default browser on macOS, Linux or Windows.

## Sorting

The button beside **Refresh** steps through the list's order: `#↓` by number, newest first (the default), `#↑` by number, oldest first, and **Updated**, last updated first.

## Milestones

The **Milestone** row among the filters has a button for each of the repository's open milestones, in their order, with its open issues, and one press narrows the list to it; **Any** goes back to all. A button names its milestone by the part before ` · ` (`1 · Groundwork` is `1 (6)`) unless another open milestone shares that part; the line under the filters then gives the whole title.

## Run filters

A row of buttons under the tabs narrows the list to issues with certain `run:` labels: **All**, then each group of **Run filters** (`github-issues.runGroups` in `/config`), by default `Plan: wayfinder, research; Implement: implement`. **Plan** lists the issues labelled `run:wayfinder` or `run:research`, **Implement** those labelled `run:implement`. GitHub's search does the narrowing, so it reaches past the loaded page. Empty: no such row.

## Pane background

**Pane background** (`github-issues.background` in `/config`) paints the pane's body in a color of your own, as `#rrggbb`. Empty keeps Claude Code's own.

## Assignment alerts

While the pane is open, the mod checks every two minutes which open issues are assigned to you in the repository it's watching: the one you picked, or the session's own. With the pane closed it makes no requests. The first check of a repository is silent and only records the current issues. After that, each newly assigned issue raises a toast. The issue numbers already seen are kept in Claude Code's plugin store, so alerts carry over between sessions.

## Requirements

The [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`. The mod runs `gh api graphql` (issues, labels, assigned issues and repositories) and `gh issue view` on your machine. Nothing leaves your machine except those GitHub requests.

## Install

```
/plugin marketplace add aJanzen33/claude-code-mods
/plugin install github-issues@marco-mods-aja-fork
/reload-plugins
```
