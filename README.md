# Terminal Tabs — Hotkeys, Focus & Claude Code

Browser-like hotkeys and reliable focus for VS Code terminals — with built-in [Claude Code](https://claude.com/claude-code) integration.

## Why?

If you keep multiple terminals open in VS Code, switching between them is awkward:

- No default keyboard shortcut for jumping to terminal N
- Clicks sometimes leave focus on a stray Quick Open / palette instead of the terminal input
- Spawning a fresh Claude Code session is "toggle panel → new terminal → type `claude`"

This extension fixes all three.

The first two features work for **any** terminal (`tail -f`, dev servers, REPLs, shells). The Claude Code integration (one-click new session, terminal profile, name-aware filtering) is the cherry on top.

## Features

### Browser-like terminal hotkeys

| Hotkey (Mac) | Linux/Win | Action |
|---|---|---|
| `Cmd+1` … `Cmd+9` | `Ctrl+1..9` | Jump to terminal #1..9 |
| `Cmd+Shift+0` | `Ctrl+Shift+0` | Start a new Claude Code session |

Like browser tabs. `Cmd+1..9` overrides VS Code's default "focus editor group N" — re-bind in your `keybindings.json` if you miss it.

### Focus bulldozer

When the active terminal changes, the extension:
1. Closes any open Quick Open / command palette
2. Forces focus into the terminal input

So you can immediately type into Claude without clicking around. Toggle with `claudeCodeTerminalTabs.enforceFocusOnSwitch` or run command **Toggle Enforce Focus On Switch**.

### One-click new session

Three ways to start a new Claude Code terminal:
- Hotkey `Cmd+Shift+0`
- Terminal profile **Claude Code** in the `+ ▾` dropdown next to the terminal tab list
- Command Palette → **New Terminal Session**

All three open a terminal in your workspace root and run `claude` immediately.

### Auto-focus when Claude finishes a response

When Claude finishes a turn, focus snaps to the active terminal so you can keep typing without clicking back. This is wired through a `Stop` hook in `~/.claude/settings.json`.

**Setup** — one-time:
1. Set `claudeCodeTerminalTabs.autoFocusOnWaitingPrompt` to `true`.
2. Run command **Install Auto-Focus Hook** (from the Command Palette, or click the link that appears under the setting in Settings UI). It writes the hook into `~/.claude/settings.json` with a confirmation dialog and an automatic `settings.json.bak` backup.
3. **New** Claude sessions pick up the hook automatically. For sessions that were already running, **restart `claude`** — `/hooks` is read-only and Claude's file-watcher doesn't always notice the change (tracked as [anthropics/claude-code#5513](https://github.com/anthropics/claude-code/issues/5513)).

To revert: run **Uninstall Auto-Focus Hook**. It removes our entry while leaving every other hook you may have configured intact.

**Limitation**: Claude's `Notification` event has a built-in delay (~60s) and does not fire for inline "Do you want to proceed?" permission prompts. Auto-focus works for the common "Claude finished, waiting for next prompt" case via `Stop`; mid-task permission prompts still require a manual click. Tracked upstream as [anthropics/claude-code#13922](https://github.com/anthropics/claude-code/issues/13922).

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCodeTerminalTabs.enforceFocusOnSwitch` | `true` | Force focus into terminal when active terminal changes |
| `claudeCodeTerminalTabs.dismissQuickPick` | `true` | Close open Quick Open before forcing focus |
| `claudeCodeTerminalTabs.onlyClaudeTerminals` | `true` | Only act on terminals running Claude Code. Detection: regex on terminal name first; if no match, the terminal's process tree is scanned for a `claude` descendant (cached per terminal). Set `false` to bulldoze every terminal. |
| `claudeCodeTerminalTabs.claudePattern` | `claude\|·\|\\*` | Fast-path regex for detecting Claude terminals by name (case-insensitive). When a terminal name doesn't match, the process tree is scanned as fallback. |
| `claudeCodeTerminalTabs.launchCommand` | `claude` | Command run by the New Session action |
| `claudeCodeTerminalTabs.autoFocusOnWaitingPrompt` | `false` | Auto-focus the active terminal when Claude finishes a response (requires **Install Auto-Focus Hook** to wire the hook into `~/.claude/settings.json`) |
| `claudeCodeTerminalTabs.waitingPromptPattern` | `^\s*\*` | Fallback regex for detecting a "waiting for input" state by terminal name change (used when the Claude hook is not installed) |

## Commands

- **New Terminal Session** — open new terminal and run Claude
- **Focus Active Terminal** — manual focus bulldozer
- **Toggle Enforce Focus On Switch** — flip the auto-focus setting
- **Install Auto-Focus Hook** — wire the Claude `Stop` hook into `~/.claude/settings.json`
- **Uninstall Auto-Focus Hook** — remove our hook from `~/.claude/settings.json` (preserves all other hooks)

## Installation

### Build from source

```bash
npm install
npx vsce package
code --install-extension claude-code-terminal-tabs-*.vsix
```

## Caveats

- The terminal profile uses an `exec`-trick (`claude; exec $SHELL -i`) so the terminal stays alive after Claude exits. Works on `bash` / `zsh`. On other shells (fish, nu) behavior may differ.
- `Cmd+1..9` will shadow VS Code's editor-group focus shortcuts. To restore them, add negated overrides in your user `keybindings.json`:
  ```json
  { "key": "cmd+1", "command": "-workbench.action.terminal.focusAtIndex1" }
  ```
- Inline icon in the terminal toolbar (next to `+ ▾`) is not added — VS Code's public extension API doesn't expose that surface.

## License

MIT
