# dsh-memory-vault

English | [中文](README.zh.md)

## Summary

A knowledge and memory vault for DSH: conversations settle into **memory groups**, every memory is assigned freely between **conversation memory** and the **knowledge base**, the conversation-creation screen offers a **knowledge application** choice that pulls memories in from elsewhere, and useless memories can be **hidden** at any time. The model gets six tools and a standing memory index; a person gets a tile board in the sidebar, built from the shell's own components and design tokens.

## Core concepts

| Concept | Meaning |
|---|---|
| **Memory group** | The first-level container. A group can be a topic ("project conventions", "troubleshooting log") or one session's dedicated container. |
| **Memory entry** | One memory: title, body, kind, tags, visibility. |
| **Assignment** | Every entry and group is assigned to `conversation` (belongs to the session that produced it) or `knowledge` (reusable across sessions). |
| **Knowledge application** | Which memory groups one session has "plugged in". An applied group's memories enter that session's prompt directly — this is the channel for cross-conversation memory sync. |
| **Hiding** | Reversible retirement. The entry, its tags, and its group survive; it leaves search, the prompt, and the board by default. |

Assignment is always changeable: the model uses `memory_assign`, a person drags a tile onto a scope facet. **An entry's assignment may differ from its group's** — promoting a memory from the knowledge base to conversation memory leaves it filed in its original group and marks it `manual`, after which it no longer follows the group.

## Install

The package declares `dsh.bundle`, so both install paths work.

```powershell
# Path one: CLI (run from the dsh source checkout root)
pnpm dsh plugin --profile web add "<absolute path to this plugin directory>"

# Path two: the Web sidebar's Plugins page -> install -> the same absolute directory
```

The install appends `dsh-memory-vault` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`. Restart `dsh web` to take effect: Host code is an in-process module, and replacing an installed package does not hot-reload (the browser half is the exception — see Development).

Remove it with:

```powershell
pnpm dsh plugin --profile web remove dsh-memory-vault
```

## Model surface

### Tools

| Tool | Purpose |
|---|---|
| `memory_group` | List, create, update, or delete memory groups, switch a whole group's assignment, or `bind` / `unbind` where this conversation's summaries are filed. |
| `memory_write` | Write one or more memories, optionally assigning them in the same call. Bodies accept Markdown and LaTeX. |
| `memory_recall` | Keyword search, read one entry by id, or list by group, assignment, or tag; `includeHidden` reaches hidden memories too. |
| `memory_assign` | Reassign, move between groups, set a **priority** (0–100), mark a **base prompt** memory, or hide and restore memories. |
| `memory_apply` | Apply knowledge to the current conversation (cross-conversation sync): list / set / reset; `groups` applies whole groups, `entries` applies single memories. |
| `memory_curate` | **AI curation**: one model call decides whether each memory is reusable knowledge or a one-off note and suggests a group; `review` only reports, `apply` files. |
| `memory_summarize` | Settle this conversation into one memory. With `content`, your text is stored as written; without it, the plugin calls a model over the **unsummarized increment**. |

### Standing memory index

The plugin registers one system-prompt section naming the groups, their assignments, their entry counts, their priorities, their auto-summary switch, **each group's highest-priority memory titles** (see "Knowledge priority and the knowledge index"), the group this session is bound to, and **the knowledge this session has applied**. The index is priority-sorted and size-capped — priority is set deliberately, so the order only moves when somebody moves it and writing a memory does not reshuffle the prompt prefix.

## Automatic summarization

- **Trigger**: the unsummarized increment is checked at `turn/end`. It trips when the message count reaches `autoSummaryTurns` (default 6) or the character count reaches `autoSummaryChars` (default 4000), and only for a bound group with auto-summary switched on.
- **Incremental**: each session records a watermark in `sessions.summarized_seq`. A summary covers only what follows the watermark and then advances it.
- **Execution**: one `ctx.llm.stream()` call, using the session's routed `session.requestHeader().config` provider/model (config can override). It **does not enter a session log, does not wake an idle agent, and does not pass through the agent loop**.
- **Failure**: a failure logs one warning and gives up for that round without blocking the conversation. A truncated record (`max-tokens`) counts as a failure and is never filed as memory.
- **Manual**: `memory_summarize` runs the same path on demand; `full=true` covers the whole visible session history.

> Automatic summarization spends real model quota. Set `autoSummary` to `false` to keep only manual summarization, or `summarizer` to `off`.

## Knowledge: choose it when the conversation starts, keep tuning it after

The memory choice appears in **two places**, covering the whole life of a conversation:

**On the new-conversation screen, above the composer.** The shell renders `conversation.input.dock` for a blank session too, while conversation views are not rendered at all until a session has content — so this case gets its own row: one pill per memory group, lit when applied, with `Use defaults` to clear the choice. It reads the session snapshot it receives and **hides itself the moment the conversation starts**, handing over to the tab below.

**Once the conversation has started: the 知识 tab** beside **Chat** and **Trajectory**, a `conversation.view` entry at `order: 20` (after chat at 0 and the trajectory at 10):

- **Two drop areas**: `Applied` and `Available`. Memory groups appear as tiles, and **dragging a tile across the two areas applies or removes it**. Clicking a tile toggles it as well, so touch and keyboard readers are not locked out of the interaction.
- A **group tile** shows its name, its assignment, and how many memories it holds; drop it into `Applied` to plug the whole group into this conversation.
- Header actions: `Use defaults`, `Apply nothing` (an explicit empty set), and refresh.
- Below, the panel lists **the memories it actually injects**, rendered with the shell's own Markdown/KaTeX — literally what the model can see — and says so when the injection cap is reached.

Both surfaces read and write **the same per-session state**, so a group chosen on the creation screen is exactly what the tab shows once the conversation begins.

Three outcomes stay distinct: **apply a set**, **apply nothing on purpose**, and **fall back to the default**. By default (`applyByDefault: true`) a new conversation applies `applyDefaultGroups` (default `["知识库"]`); an empty knowledge base injects nothing, so the default costs nothing. Injection is capped (`applyMaxEntries` / `applyMaxChars`).

That is the cross-conversation sync: a conclusion settled into the knowledge base from conversation A is available in conversation B immediately. The model does the same thing through `memory_apply`.

## Knowledge priority and the knowledge index

The injection budget is finite (12 memories / 2400 characters by default), so *which* memory gets in has to be decided by importance rather than by when it happened to be written.

**Priority is 0–100, one scale for groups and memories alike:**

- In the **prompt index**, groups sort by priority and so do the memories inside them.
- In the **injection plan**, the highest priority takes the budget first, so an important older conclusion is not starved by newer noise.
- A memory a conversation **applied by hand always comes first**, ahead of anything inferred.
- Set it with `memory_assign priority=` (one memory) or `memory_group action=update priority=` (a whole group); in the panel, pick a level on the priority row of a memory, or step a group by 10 with −/+ in Manage groups.

**The knowledge index** is what that section of the prompt now lists:

```
知识库（2 组）：
- DSH 插件开发 [DSH, 插件开发] · P40 · 组内 16 条 — 为 DSH 开发插件的可复用知识
  · [P90] 界面必须用外壳自己的基元与设计令牌
  · [P70] Host 半要重启、浏览器半会热更
  · …
```

Beside each group's name and count, the index lists that group's **highest-priority memory titles** (`indexEntryTitles`, 5 by default, 0 to switch the catalogue off). That is what lets the model judge whether a group is worth reading — or worth applying to this conversation — without spending a search on it first: the index stops being a table of contents and becomes a menu, which is the point of having one.

The section ends by naming the step it can take next: `memory_recall` for the bodies, `memory_apply groups=[...]` to plug in a whole group, `memory_apply entries=[...]` to carry a single memory across, and `memory_assign priority=` to raise one.

On the panel side a tile shows a `P90` badge when its priority is raised, and the 知识 tab marks every injected memory as **picked here** or **via group**, so why a memory is in the prompt is never a mystery.

## Base prompt, a tunable quota, and AI curation

### The base prompt is a floor, not a preference

Some memories are standing conventions — "every coding task leaves a git trail". They should not depend on which groups a conversation applied, and they should not eat the room it reserved for what it chose. Mark them as **base prompt**:

- On write: `memory_write` with `base: true`; in the panel, the Base prompt row on a memory's detail screen.
- Afterwards: `memory_assign` with `base: true/false`, in bulk if needed.
- They are injected into **every** conversation regardless of what it applied, in a section of their own.
- They are **not counted** against the knowledge quota: the layer has its own caps (`baseMaxEntries`, default 4, and `baseMaxChars`, default 1200).

### The knowledge quota is editable

The quota decides how many *applied* memories a conversation injects (12 by default). It now lives in the vault rather than only in a profile file:

- `− / +` in the panel's 知识 tab, effective immediately, **no restart**.
- `applyMaxEntries` / `applyMaxChars` in the config remain the deployment defaults; the panel writes an override, and setting it back to the default restores it.
- The base layer is not part of that number — the two budgets are separate.

### AI curation

A vault collects two kinds of thing that look identical as text: conclusions worth keeping for months, and details that mattered once. The vault cannot tell them apart by itself, so one model call does:

```
memory_curate action=review     # verdicts only, nothing written
memory_curate action=apply      # file them
```

- **Reusable** means a conclusion, fact, convention, preference or step that still holds in another session; **one-off** means progress, a temporary decision, a one-time investigation, a superseded state. Doubt resolves to one-off.
- Each item gets a verdict, a one-line reason, and a suggested group name (identical meanings get identical names so they merge cleanly).
- On `apply`, reusable memories move to the knowledge base under that group (created if needed) and one-off memories go back to conversation memory; `applyPriority: true` also lifts the reusable ones to priority 60.
- The whole batch commits in **one transaction**, so the vault is never left half-sorted.
- The panel's 知识 tab has the same two actions as buttons, and the **知识记忆库 board carries an 「AI 整理」 button of its own**: it curates the whole vault and expands the verdicts into a card (how many reusable, how many one-off, each with its reason and suggested group), writing nothing until 「按建议归类」 is pressed.
- **A panel call needs no provider configured**: the panel is not inside a session, so the Host answers on the provider/model of the last turn it observed. Only a vault that has never seen a session reports that no route is available.

> It is a real model call and spends quota; 50 memories at most, 20 by default.

## Web panel

A **Memory Vault** entry appears in the sidebar. The knowledge base and conversation memory are **one tile board**; assignment survives only as a filter.

The panel renders with the shell's own primitives and design tokens (`--dsw-*`): buttons, pills, tags, switches, checkboxes, inputs, and icons come from `@deepseek-ai/dsh-client-ui-primitives`, so typography, spacing, corner radii, and light/dark theming follow the application automatically.

### Level one: the tile board

- A top row with the search box, `＋ New memory`, and refresh.
- A facet row: the scope pills `All / Knowledge base / Conversation memory`, every tag in use with its count, a `Show hidden` switch, and the grouping mode (by memory group, by tag, or none).
- Each tile shows a title (two lines), a plain-text summary of the body (three lines), its tags, its group, and when it last changed. **Search terms are highlighted.** A hidden tile is dimmed, carries a `Hidden` tag, and offers `Restore` in place.
- The board groups by the selected mode into collapsible sections; **Manage groups** sits in a collapsed section of its own.
- **Dragging is the operation**: drop a tile on `Knowledge base / Conversation memory` to reassign it, or on any tag facet to label it. A group card can be dragged onto a scope facet.

### Level two: the detail screen (click any tile; `Esc` or Back leaves it)

- A `Preview / Source` toggle: preview typesets the body with the shell's Markdown renderer (below), source shows the raw text.
- Tag editing: `AI自动总结` / `人工输入` follow provenance and cannot be removed; other tags can be added (Enter adds one) and removed.
- A property table: assignment, group, kind, source, visibility, created and updated timestamps, and the id.
- Actions: `Edit` (title, kind, body), `Save`, move to the other assignment, move to another memory group, `Hide / Restore`, and `Delete`.

`＋ New memory` reuses the same detail screen: pick a group and assignment, write the body in Markdown, add tags, and saving files it as `人工输入`.

The panel and the model call one Host-side operation table, so both surfaces always see one dataset.

## Markdown and LaTeX

A memory body is rendered by **the shell's own `MarkdownText`** (`@deepseek-ai/dsh-client-ui-primitives`): GFM parsing, tables, task lists, footnotes, reference links, code highlighting, and TeX math typeset by **KaTeX**. It is the same renderer and the same styles the assistant's own messages use, so typography, sizing, and light/dark behavior match exactly.

- Inline math uses `$...$`; display math uses `$$...$$`.
- The plugin needs no Markdown or math dependency of its own: the renderer ships with the shell and the plugin simply calls it.
- Tile previews use the shell's `extractMarkdownPlainText` (typesetting every formula on every tile would be slow); the full render belongs to the detail screen.

## Tags

- **Two system tags** follow provenance and are neither requested nor removable by hand: `AI自动总结` marks threshold-summarized and `memory_summarize` memories, and `人工输入` marks memories the model wrote through `memory_write` or that you created in the panel. They search and filter like any other tag.
- **Ordinary tags** are free-form. Clicking a tag in the panel filters the board (several at once means all must match); the `tag` parameter of `memory_recall` does the same for the model.

## Hiding useless memories

- Entry points: the `Hide` button on the detail screen, or the `hidden` parameter of `memory_assign`.
- Effect: the memory leaves search, the prompt index, and applied-knowledge injection entirely, and stops counting toward the tag bar and group counts.
- Restore: turn on `Show hidden` in the facet row and press `Restore` on the dimmed tile, or press `Restore` on the detail screen.
- Hiding versus deleting: hiding keeps every byte and is reversible; deletion is not.

## Configuration

Override the shipped layer from `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: memory-vault
  name: 'dsh-memory-vault'
  config:
    databasePath: null              # defaults to $DSH_HOME/memory-vault/vault.sqlite
    conversationGroupName: '对话记忆'
    knowledgeGroupName: '知识库'
    autoSummary: true               # threshold summarization on or off
    autoSummaryTurns: 6             # unsummarized message threshold
    autoSummaryChars: 4000          # unsummarized character threshold
    summarizer: 'llm'               # 'llm' calls a model; 'off' keeps manual only
    summarizerProvider: null        # provider override (defaults to the session route)
    summarizerModel: null           # model override
    summarizerMaxTokens: 1600
    summarizerTimeoutMs: 120000
    injectIndex: true               # inject the memory index section
    injectMaxGroups: 24             # groups listed at most
    indexEntryTitles: 5             # memory titles listed per group; 0 turns the catalogue off
    baseMaxEntries: 4               # base-prompt memories injected (not part of the quota)
    baseMaxChars: 1200              # character budget for the base layer
    transcriptRetention: 400        # summarized transcript rows kept per session
    searchLimit: 20                 # default `memory_recall` result cap
    maxEntryChars: 20000            # longest entry body
    applyByDefault: true            # whether a new session applies the default groups
    applyDefaultGroups: ['知识库']  # which groups those are
    applyMaxEntries: 12             # memories pushed into one session's prompt
    applyMaxChars: 2400             # character budget for those memories
```

Configuration is validated when the plugin loads: a bad value fails that row and names the offending field instead of degrading silently.

## Data and storage

- SQLite through `node:sqlite` — the same engine the harness's own SQLite storage backend uses, with no native build step and no third-party runtime dependency.
- Tables: `groups`, `entries` (with `hidden`), `applications` (session × group), `sessions` (binding, summarization watermark, whether the application set was chosen explicitly), `summaries`, `meta`. An older database gains the added columns and system tags on open.
- Data lives outside the workspace (by default under `$DSH_HOME/memory-vault/`).
- Search is case-insensitive weighted substring matching (title 6, tags 3, body 2) rather than FTS5: entries are short mixed Chinese/English text, where SQLite's stock tokenizers split neither language usefully.

## Removing it

```powershell
pnpm dsh plugin --profile web remove dsh-memory-vault
Remove-Item -Recurse "$env:USERPROFILE\.dsh\memory-vault"   # the memories, optionally
```

## Known limitations

- **Host code changes need a `dsh web` restart**: the plugin lives outside the profile directory, so HMR does not watch it. The browser file `client.js` is the exception. While only `client.js` has been hot-reloaded, the panel derives the system tags from `source` and builds its own tag inventory; persisted system tags, hiding, and server-side tag filtering wait for the restart.
- **Applications lengthen the prompt**: the more groups a session applies, the larger its context; injection is capped (`applyMaxEntries` / `applyMaxChars`) and the model must search for the rest.
- **No vector retrieval**: search is keyword substring matching, so a memory that means the same thing in different words is not recalled.
- **Summarization triggers per session**: sessions trigger independently with no global budget, and a long session's cost grows with its turn count.
- **No conflict resolution or forgetting policy**: a new memory never overwrites or merges an old one, and hiding and deleting are both explicit.
- **Only conversations after load are observed**: history from before the install is not in `transcript`, and `full=true` still sees only the session's currently visible history.
- **The panel's look depends on the shell's design tokens**: where a host theme lacks one, that declaration falls back to its default rather than failing.

## Development

```powershell
# Standalone smoke test: drives tools, priority, the knowledge index, the base-prompt layer, a tunable quota, AI curation, per-memory application, hiding, watermark summarization, the panel route and the request boundary on a mock ctx, then renders the knowledge view, the board and the new-conversation strip for real (151 checks)
cd <this plugin directory>
node tests/smoke.mjs
```

```
dsh-memory-vault/
├── index.js          Host half: wires storage, tools, prompt section, panel routes, session observation
├── client.js         Browser half: sidebar entry, tile board and detail screen, knowledge-application control
├── cordis.patch.yml  Bundle layer: inserts the plugin row and its default configuration
├── src/
│   ├── config.js     Config defaults and Standard Schema validation
│   ├── store.js      SQLite schema, migrations, and every read/write operation
│   ├── tools.js      The six model tools and their result rendering
│   ├── prompt.js     The memory index and the applied-knowledge block
│   ├── summarize.js  One-shot model call and summarization prompt
│   └── http.js       Same-origin HTTP routes the panel and the control use
└── tests/smoke.mjs   Smoke test
```

The plugin depends on nothing but `ctx` (the Cordis context) and imports no `@deepseek-ai/*` runtime module; the browser half takes only `react` and `@deepseek-ai/dsh-client-ui-primitives` from the module table's baseline.
