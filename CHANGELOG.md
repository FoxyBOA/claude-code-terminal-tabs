# Changelog

## [0.1.6]

### Added
- **Auto-focus when Claude finishes a response** via a `Stop` hook in `~/.claude/settings.json`. When Claude completes its turn, focus snaps to the active terminal so you can keep typing without clicking around.
- Command **Install Auto-Focus Hook** — wires the hook into `~/.claude/settings.json` with a confirmation dialog and an automatic backup (`settings.json.bak`). Works alongside any existing hooks you have configured.
- Command **Uninstall Auto-Focus Hook** — removes the auto-focus hook from any event type while preserving every other hook in the file.
- Setting `claudeCodeTerminalTabs.autoFocusOnWaitingPrompt` (default `false`) to toggle the behavior.
- Setting `claudeCodeTerminalTabs.waitingPromptPattern` (default `^\s*\*`) — fallback regex for detecting a "waiting for input" state by terminal name change, used when no Claude hook is installed.
- Clickable **Install / Uninstall Auto-Focus Hook** links under the `autoFocusOnWaitingPrompt` setting in the Settings UI, in addition to the Command Palette entries.

### Changed
- Display name → "Terminal Tabs — Hotkeys, Focus & Claude Code" — leads with the universal value (hotkeys, focus) so the extension is findable by terminal-tab seekers too.
- Settings UI section header and Command Palette category renamed from "Claude Code Terminal Tabs" to the display name for consistency. Setting keys (`claudeCodeTerminalTabs.*`) and command IDs are unchanged so existing configurations and keybindings keep working.

## [0.1.5]

### Added
- **Process-tree fallback** for Claude terminal detection. When a terminal name doesn't match the fast-path regex, the terminal's process tree is scanned for a `claude` descendant (via `ps -A` on Unix, `wmic` on Windows). The result is cached per terminal — the cost is paid at most once per terminal. Fixes `onlyClaudeTerminals` missing Claude sessions whose tab title is still in the "version-only" state (e.g. `2.1.143 Merkuri`).

## [0.1.4] — initial release

### Added
- Browser-like terminal hotkeys: `Cmd+1..9` / `Ctrl+1..9` to jump between terminals.
- `Cmd+Shift+0` / `Ctrl+Shift+0` — start a new Claude Code session in the workspace root.
- **Focus bulldozer**: when the active terminal changes, close any open Quick Open / palette and force focus into the terminal input. Controlled by `enforceFocusOnSwitch` and `dismissQuickPick`.
- Setting `onlyClaudeTerminals` (default `true`) to scope the bulldozer to Claude terminals.
- Setting `claudePattern` (default `claude|·|\*`) to identify Claude terminals by tab name.
- Setting `launchCommand` (default `claude`) for the new-session action.
- Commands **Focus Active Terminal** and **Toggle Enforce Focus On Switch**.
- Terminal profile **Claude Code** in the `+ ▾` dropdown.
- Overflow-menu entry **New Terminal Session** on the terminal panel toolbar.
- Extension icon (terminal with three tabs, Claude-orange accent on the active tab).
