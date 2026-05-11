// @ts-check
'use strict';

const vscode = require('vscode');
const { exec } = require('child_process');

const CFG_NS = 'claudeCodeTerminalTabs';

/** @type {WeakMap<vscode.Terminal, Promise<boolean>>} */
const claudeCache = new WeakMap();

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
    terminal.show(false);
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
