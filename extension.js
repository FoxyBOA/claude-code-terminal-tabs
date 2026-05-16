// @ts-check
'use strict';

const vscode = require('vscode');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CFG_NS = 'claudeCodeTerminalTabs';

/** @type {WeakMap<vscode.Terminal, Promise<boolean>>} */
const claudeCache = new WeakMap();

/** @type {WeakMap<vscode.Terminal, string>} */
const waitingPromptLastName = new WeakMap();

const WAITING_PROMPT_POLL_MS = 1500;

const NOTIFY_FILE_NAME = 'cc-terminal-tabs-notify';
const NOTIFY_FILE_PATH = path.join(os.tmpdir(), NOTIFY_FILE_NAME);
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_COMMAND_MARKER = NOTIFY_FILE_NAME;

/** @returns {RegExp} */
function compileClaudePattern() {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    const pattern = cfg.get('claudePattern', 'claude|·|\\*');
    try {
        return new RegExp(pattern, 'i');
    } catch (e) {
        console.error('[claude-code-terminal-tabs] invalid claudePattern, falling back:', e);
        return /claude|·|\*/i;
    }
}

/**
 * @param {string} stdout
 * @param {boolean} isWin
 * @returns {Map<string, Array<[string, string]>>}
 */
function parseProcessList(stdout, isWin) {
    /** @type {Map<string, Array<[string, string]>>} */
    const children = new Map();
    const lines = stdout.split('\n');

    if (isWin) {
        for (const line of lines) {
            const cols = line.split(',');
            if (cols.length < 4) continue;
            const cmd = cols[1] || '';
            const ppid = (cols[2] || '').trim();
            const pid = (cols[3] || '').trim();
            if (!pid || !ppid || isNaN(Number(pid))) continue;
            if (!children.has(ppid)) children.set(ppid, []);
            const arr = children.get(ppid);
            if (arr) arr.push([pid, cmd]);
        }
    } else {
        for (let i = 1; i < lines.length; i++) {
            const m = lines[i].match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
            if (!m) continue;
            const pid = m[1], ppid = m[2], cmd = m[3];
            if (!children.has(ppid)) children.set(ppid, []);
            const arr = children.get(ppid);
            if (arr) arr.push([pid, cmd]);
        }
    }
    return children;
}

/**
 * BFS through the process tree rooted at rootPid; resolves true if any descendant
 * command line matches the pattern.
 * @param {number} rootPid
 * @param {RegExp} pattern
 * @returns {Promise<boolean>}
 */
function processTreeContains(rootPid, pattern) {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        const cmd = isWin
            ? 'wmic process get ProcessId,ParentProcessId,CommandLine /format:csv'
            : 'ps -A -o pid,ppid,command';

        exec(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(false);

            const children = parseProcessList(stdout, isWin);
            const queue = [String(rootPid)];
            const visited = new Set([String(rootPid)]);
            while (queue.length) {
                const p = queue.shift();
                if (p === undefined) break;
                for (const [c, cmdline] of (children.get(p) || [])) {
                    if (pattern.test(cmdline)) return resolve(true);
                    if (!visited.has(c)) {
                        visited.add(c);
                        queue.push(c);
                    }
                }
            }
            resolve(false);
        });
    });
}

/**
 * Decide whether a terminal is hosting Claude Code.
 * Fast path: regex on terminal name. Fallback: scan process tree for a `claude` descendant.
 * Cached per terminal in a WeakMap so the ps cost is paid at most once per terminal.
 * @param {vscode.Terminal} terminal
 * @returns {Promise<boolean>}
 */
async function isClaudeTerminal(terminal) {
    if (compileClaudePattern().test(terminal.name)) return true;

    let cached = claudeCache.get(terminal);
    if (cached) return cached;

    cached = (async () => {
        try {
            const pid = await terminal.processId;
            if (!pid) return false;
            return await processTreeContains(pid, /\bclaude\b/i);
        } catch (e) {
            console.error('[claude-code-terminal-tabs] process-tree check failed:', e);
            return false;
        }
    })();
    claudeCache.set(terminal, cached);
    return cached;
}

/** @returns {RegExp | null} */
function compileWaitingPromptPattern() {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    const pattern = cfg.get('waitingPromptPattern', '^\\s*\\*');
    if (!pattern) return null;
    try {
        return new RegExp(pattern);
    } catch (e) {
        console.error('[claude-code-terminal-tabs] invalid waitingPromptPattern, ignoring:', e);
        return null;
    }
}

/**
 * Poll the active terminal's name. If it transitions from non-waiting to waiting
 * (i.e., Claude prepended its attention marker), bulldoze focus into that terminal.
 * Per-terminal previous name lives in waitingPromptLastName; gets cleared on terminal
 * switch so we don't react to stale transitions from when the terminal was inactive.
 */
function tickWaitingPromptWatcher() {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    if (!cfg.get('autoFocusOnWaitingPrompt', false)) return;

    const terminal = vscode.window.activeTerminal;
    if (!terminal) return;

    const pattern = compileWaitingPromptPattern();
    if (!pattern) return;

    const currentName = terminal.name;
    const previousName = waitingPromptLastName.get(terminal);

    if (previousName === undefined) {
        // First sighting since (re)activation — record baseline, don't fire
        waitingPromptLastName.set(terminal, currentName);
        return;
    }

    if (!pattern.test(previousName) && pattern.test(currentName)) {
        bulldozerFocus(terminal);
    }
    waitingPromptLastName.set(terminal, currentName);
}

/**
 * Sets up a file-system watcher on the temp-file written by Claude Code's
 * Notification hook (see installNotificationHook). When the file changes,
 * the hook fired — focus the active terminal if the notification's project
 * dir matches this VSCode window's workspace (so only the right window reacts).
 * @param {vscode.ExtensionContext} context
 */
function setupNotificationWatcher(context) {
    const dir = path.dirname(NOTIFY_FILE_PATH);
    const fileName = path.basename(NOTIFY_FILE_PATH);

    // VSCode bug #164925: FileSystemWatcher with a literal filename (no wildcards)
    // silently doesn't fire. Use a trailing '*' and filter by exact URI in the handler.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), fileName + '*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    console.log('[claude-code-terminal-tabs] watching', NOTIFY_FILE_PATH, 'via pattern', fileName + '*');

    let lastFireMs = 0;
    const handler = async (/** @type {vscode.Uri} */ uri) => {
        if (uri && uri.fsPath !== NOTIFY_FILE_PATH) return; // ignore sibling files

        const now = Date.now();
        if (now - lastFireMs < 200) return; // debounce duplicate fs events
        lastFireMs = now;

        const cfg = vscode.workspace.getConfiguration(CFG_NS);
        if (!cfg.get('autoFocusOnWaitingPrompt', false)) {
            console.log('[claude-code-terminal-tabs] notify fired but autoFocusOnWaitingPrompt=false');
            return;
        }

        let payload = '';
        try {
            payload = fs.readFileSync(NOTIFY_FILE_PATH, 'utf8').trim();
        } catch (_) { /* ignore */ }

        const wsFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const ws = wsFolder ? wsFolder.uri.fsPath : '';

        if (payload && ws) {
            const normalize = (/** @type {string} */ s) => s.replace(/[\\/]+$/, '');
            const a = normalize(payload);
            const b = normalize(ws);
            if (!a.startsWith(b) && !b.startsWith(a)) {
                console.log('[claude-code-terminal-tabs] notify for different workspace, ignoring. payload=', payload, 'ws=', ws);
                return;
            }
        }

        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
            console.log('[claude-code-terminal-tabs] notify fired but no active terminal');
            return;
        }
        console.log('[claude-code-terminal-tabs] notify fired — focusing terminal', terminal.name);
        await bulldozerFocus(terminal);
    };

    context.subscriptions.push(watcher.onDidChange(handler));
    context.subscriptions.push(watcher.onDidCreate(handler));
    context.subscriptions.push(watcher);
}

/**
 * Adds a Stop hook to ~/.claude/settings.json that writes the current
 * Claude project directory into the watched temp-file when Claude finishes
 * a response. Stop fires immediately (Notification has a known ~60s delay).
 * Backs up the existing settings.json before writing.
 */
async function installAutoFocusHook() {
    let settings = {};
    let existingText = '';
    try {
        existingText = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
        settings = JSON.parse(existingText);
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            if (e instanceof SyntaxError) {
                vscode.window.showErrorMessage(
                    `Claude Code Terminal Tabs: ${CLAUDE_SETTINGS_PATH} contains invalid JSON — aborting install.`
                );
            } else {
                vscode.window.showErrorMessage(`Cannot read ${CLAUDE_SETTINGS_PATH}: ${e.message}`);
            }
            return;
        }
        // ENOENT — fine, we'll create it
    }

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {};
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

    const alreadyInstalled = settings.hooks.Stop.some((/** @type {any} */ entry) =>
        entry && Array.isArray(entry.hooks) && entry.hooks.some((/** @type {any} */ h) =>
            h && typeof h.command === 'string' && h.command.includes(HOOK_COMMAND_MARKER)
        )
    );

    if (alreadyInstalled) {
        vscode.window.showInformationMessage(
            'Claude Code Terminal Tabs: auto-focus hook is already installed.'
        );
        return;
    }

    const isWin = process.platform === 'win32';
    const hookCmd = isWin
        ? `cmd /c "echo %CLAUDE_PROJECT_DIR%> %TEMP%\\${NOTIFY_FILE_NAME}"`
        : `sh -c 'printf "%s" "$CLAUDE_PROJECT_DIR" > "${NOTIFY_FILE_PATH}"'`;

    settings.hooks.Stop.push({
        hooks: [{ type: 'command', command: hookCmd }]
    });

    const answer = await vscode.window.showInformationMessage(
        `Install Claude Code auto-focus hook?`,
        {
            modal: true,
            detail:
                `This adds a Stop hook to ${CLAUDE_SETTINGS_PATH} so the extension can ` +
                `auto-focus your terminal when Claude finishes a response.\n\n` +
                `The hook writes only the current Claude project directory into a temp file ` +
                `(${NOTIFY_FILE_PATH}) that the extension watches. No data leaves your machine.\n\n` +
                `A backup of your existing settings.json will be saved next to it as settings.json.bak.`
        },
        'Install'
    );

    if (answer !== 'Install') return;

    try {
        fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
        if (existingText) {
            fs.writeFileSync(CLAUDE_SETTINGS_PATH + '.bak', existingText);
        }
        fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        vscode.window.showInformationMessage(
            'Claude Code Terminal Tabs: auto-focus hook installed. ' +
            'New Claude Code sessions pick it up automatically. ' +
            'For already-running sessions, restart claude — `/hooks` is read-only and the file-watcher reload is not always reliable.'
        );
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to write ${CLAUDE_SETTINGS_PATH}: ${e.message}`);
    }
}

/**
 * Removes any hook entry containing our marker, regardless of which event
 * type (Stop, Notification, PreToolUse, …) it lives under. This handles
 * cleanup of older installs that placed the hook under Notification before
 * we migrated to Stop. Preserves all unrelated hooks.
 */
async function uninstallAutoFocusHook() {
    let settings;
    let existingText;
    try {
        existingText = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
        settings = JSON.parse(existingText);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            vscode.window.showInformationMessage(
                'Claude Code Terminal Tabs: no Claude settings.json found — nothing to remove.'
            );
        } else {
            vscode.window.showErrorMessage(`Cannot read ${CLAUDE_SETTINGS_PATH}: ${e.message}`);
        }
        return;
    }

    if (!settings || !settings.hooks || typeof settings.hooks !== 'object') {
        vscode.window.showInformationMessage(
            'Claude Code Terminal Tabs: no hooks section to clean.'
        );
        return;
    }

    let removedCount = 0;
    for (const eventName of Object.keys(settings.hooks)) {
        const arr = settings.hooks[eventName];
        if (!Array.isArray(arr)) continue;

        settings.hooks[eventName] = arr
            .map((/** @type {any} */ entry) => {
                if (!entry || !Array.isArray(entry.hooks)) return entry;
                const kept = entry.hooks.filter((/** @type {any} */ h) => {
                    const matches = h && typeof h.command === 'string' && h.command.includes(HOOK_COMMAND_MARKER);
                    if (matches) removedCount++;
                    return !matches;
                });
                return { ...entry, hooks: kept };
            })
            .filter((/** @type {any} */ entry) => entry && Array.isArray(entry.hooks) && entry.hooks.length > 0);

        if (settings.hooks[eventName].length === 0) delete settings.hooks[eventName];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

    if (removedCount === 0) {
        vscode.window.showInformationMessage(
            'Claude Code Terminal Tabs: no matching hook found to remove.'
        );
        return;
    }

    try {
        fs.writeFileSync(CLAUDE_SETTINGS_PATH + '.bak', existingText);
        fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        vscode.window.showInformationMessage(
            `Claude Code Terminal Tabs: removed ${removedCount} hook entry(ies).`
        );
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to write ${CLAUDE_SETTINGS_PATH}: ${e.message}`);
    }
}

/**
 * @param {vscode.Terminal} terminal
 */
async function bulldozerFocus(terminal) {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    if (cfg.get('dismissQuickPick', true)) {
        try {
            await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        } catch (_) { /* no quick-open open — fine */ }
    }

    // VSCode #131340 + #204810: terminal.show() and chained focus commands sometimes fail
    // to pull focus out of a sidebar view (Source Control / Git Graph / Explorer). Workaround:
    //   1) pull focus into the bottom panel container first (workbench.action.focusPanel)
    //   2) let the focus change settle one event-loop tick
    //   3) show the terminal and explicitly focus it
    try {
        await vscode.commands.executeCommand('workbench.action.focusPanel');
    } catch (_) { /* ignore */ }
    await new Promise(resolve => setTimeout(resolve, 50));
    terminal.show(false);
    try {
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
    } catch (_) { /* ignore */ }
}

async function newSession() {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    const launchCommand = cfg.get('launchCommand', 'claude');
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const cwd = folder ? folder.uri.fsPath : undefined;

    const terminal = vscode.window.createTerminal({ cwd });
    terminal.show(false);
    terminal.sendText(launchCommand, true);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('[claude-code-terminal-tabs] activated');

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(async (terminal) => {
            if (!terminal) return;
            // Reset waiting-prompt tracking for the newly active terminal so we don't react
            // to name changes that happened while it was inactive
            waitingPromptLastName.delete(terminal);

            const cfg = vscode.workspace.getConfiguration(CFG_NS);
            if (!cfg.get('enforceFocusOnSwitch', true)) return;

            if (cfg.get('onlyClaudeTerminals', true)) {
                const isClaude = await isClaudeTerminal(terminal);
                if (!isClaude) return;
                // Async check may have taken a moment — bail if user already moved on
                if (vscode.window.activeTerminal !== terminal) return;
            }

            await bulldozerFocus(terminal);
        })
    );

    const waitingPromptInterval = setInterval(tickWaitingPromptWatcher, WAITING_PROMPT_POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(waitingPromptInterval) });

    setupNotificationWatcher(context);

    context.subscriptions.push(
        vscode.commands.registerCommand(`${CFG_NS}.installAutoFocusHook`, installAutoFocusHook),
        vscode.commands.registerCommand(`${CFG_NS}.uninstallAutoFocusHook`, uninstallAutoFocusHook)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(`${CFG_NS}.newSession`, newSession),

        vscode.commands.registerCommand(`${CFG_NS}.focusActive`, async () => {
            const t = vscode.window.activeTerminal;
            if (!t) {
                vscode.window.showInformationMessage('Claude Code Terminal Tabs: no active terminal');
                return;
            }
            await bulldozerFocus(t);
        }),

        vscode.commands.registerCommand(`${CFG_NS}.toggleEnforce`, async () => {
            const cfg = vscode.workspace.getConfiguration(CFG_NS);
            const next = !cfg.get('enforceFocusOnSwitch', true);
            await cfg.update('enforceFocusOnSwitch', next, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Claude Code Terminal Tabs: enforce focus ${next ? 'enabled' : 'disabled'}`
            );
        })
    );

    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(`${CFG_NS}.profile`, {
            provideTerminalProfile() {
                const cfg = vscode.workspace.getConfiguration(CFG_NS);
                const launchCommand = cfg.get('launchCommand', 'claude');
                const isWin = process.platform === 'win32';

                if (isWin) {
                    return new vscode.TerminalProfile({
                        shellPath: 'powershell.exe',
                        shellArgs: ['-NoExit', '-Command', launchCommand]
                    });
                }

                const shell = process.env.SHELL || '/bin/zsh';
                return new vscode.TerminalProfile({
                    shellPath: shell,
                    shellArgs: ['-i', '-c', `${launchCommand}; exec "${shell}" -i`]
                });
            }
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
