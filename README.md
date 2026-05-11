# Claude Code Terminal Tabs

Browser-like hotkeys and reliable focus for terminals running [Claude Code](https://claude.com/claude-code) in VS Code.

## Why?

If you have multiple Claude Code sessions running in separate terminals, switching between them in VS Code is awkward:

- No default keyboard shortcut for jumping to terminal N
- Switching sometimes leaves focus on a stray quick-pick or palette, not the terminal input
- Spawning a fresh Claude session is "toggle panel → new terminal → type `claude`"

This extension fixes all three.

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

So you can immediately type into Claude without clicking around. Toggle with `claudeCodeTerminalTabs.enforceFocusOnSwitch` or run command **Claude Code Terminal Tabs: Toggle Enforce Focus On Switch**.

### One-click new session

Three ways to start a new Claude Code terminal:
- Hotkey `Cmd+Shift+0`
- Terminal profile **Claude Code** in the `+ ▾` dropdown next to the terminal tab list
- Command Palette → **Claude Code: New Terminal Session**

All three open a terminal in your workspace root and run `claude` immediately.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCodeTerminalTabs.enforceFocusOnSwitch` | `true` | Force focus into terminal when active terminal changes |
| `claudeCodeTerminalTabs.dismissQuickPick` | `true` | Close open Quick Open before forcing focus |
| `claudeCodeTerminalTabs.onlyClaudeTerminals` | `true` | Only act on terminals whose name matches `claudePattern` (set `false` to bulldoze every terminal) |
| `claudeCodeTerminalTabs.claudePattern` | `claude\|·\|\\*` | Regex for detecting Claude Code terminals (case-insensitive) |
| `claudeCodeTerminalTabs.launchCommand` | `claude` | Command run by the New Session action |

## Commands

- **Claude Code: New Terminal Session** — open new terminal and run Claude
- **Focus Active Terminal** — manual focus bulldozer
- **Toggle Enforce Focus On Switch** — flip the auto-focus setting

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
