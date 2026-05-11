// @ts-check
'use strict';

const vscode = require('vscode');

const CFG_NS = 'claudeCodeTerminalTabs';

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
 * @param {vscode.Terminal} terminal
 */
function shouldHandle(terminal) {
    const cfg = vscode.workspace.getConfiguration(CFG_NS);
    if (!cfg.get('onlyClaudeTerminals', true)) return true;
    return compileClaudePattern().test(terminal.name);
}

/**
 * Dismiss any open quick-pick / command palette, then drive focus into the terminal.
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
            if (!shouldHandle(terminal)) return;
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
                    // PowerShell: run claude, drop back to PS prompt if it exits
                    return new vscode.TerminalProfile({
                        shellPath: 'powershell.exe',
                        shellArgs: ['-NoExit', '-Command', launchCommand]
                    });
                }

                const shell = process.env.SHELL || '/bin/zsh';
                // Run claude, then exec interactive shell so terminal stays alive
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
