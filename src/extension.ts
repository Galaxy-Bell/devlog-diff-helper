import * as vscode from 'vscode';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
  let lastErrorTime = 0;
  function showOncePerSecond(type: 'error' | 'info' | 'warn', message: string) {
    const now = Date.now();
    if (now - lastErrorTime < 1000) {
      return; // suppress repeated messages
    }
    lastErrorTime = now;

    if (type === 'error') {
      vscode.window.showErrorMessage(message);
    } else if (type === 'warn') {
      vscode.window.showWarningMessage(message);
    } else {
      vscode.window.showInformationMessage(message);
    }
  }

  const disposable = vscode.commands.registerCommand(
    'devlog-diff-helper.copyTodayDiff',
    async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        showOncePerSecond('error', '没有打开任何工作区，无法生成 diff');
        return;
      }

      const workspaceRoot = folders[0].uri.fsPath;
      const fs = require('fs');
      const path = require('path');

      // ---------- Step 1: Check if Git exists ----------
      const gitAvailable = await new Promise<boolean>((resolve) => {
        exec('git --version', (err) => {
          if (err) {
            showOncePerSecond('error', '未检测到 Git，请先安装 Git');
            return resolve(false);
          }
          resolve(true);
        });
      });
      if (!gitAvailable) {
        return;
      }

      // ---------- Step 2: Check if inside a Git repository ----------
      const isRepo = await new Promise<boolean>((resolve) => {
        exec('git rev-parse --is-inside-work-tree', { cwd: workspaceRoot }, (err) => {
          if (err) {
            resolve(false);
          } else {
            resolve(true);
          }
        });
      });

      if (!isRepo) {
        showOncePerSecond('error', '当前目录不是 Git 仓库，无法生成 diff');
        return;
      }

      // ---------- Step 3: Calculate today 00:00 ----------
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const changedFiles = await new Promise<string[]>((resolve) => {
        exec('git diff --name-only', { cwd: workspaceRoot }, (err, stdout) => {
          if (err) {
            resolve([]);
            return;
          }
          resolve(stdout.split('\n').filter(Boolean).map((f) => path.join(workspaceRoot, f)));
        });
      });

      // ---------- Step 4: Filter files modified today ----------
      const todayFiles = changedFiles.filter((f: string) => {
        let stat;
        try {
          stat = fs.statSync(f);
        } catch {
          return false;
        }
        return stat.mtime >= todayStart;
      });

      if (todayFiles.length === 0) {
        showOncePerSecond('info', '今日没有文件被修改');
        return;
      }

      // ---------- Step 5: Run git diff for each ----------
      let finalDiff = '';
      // ---------- Build summary header for Codex ----------
      let summaryHeader = `# 今日修改文件（${todayFiles.length} 个）\n`;
      for (const file of todayFiles) {
        summaryHeader += `- ${path.relative(workspaceRoot, file)}\n`;
      }
      summaryHeader += `\n# 以下为按文件分组的详细 diff：\n\n`;

      finalDiff += summaryHeader;

      let hasRealDiff = false;

      const runGitDiff = (filePath: string) =>
        new Promise<string>((resolve) => {
          exec(`git diff "${filePath}"`, { cwd: workspaceRoot }, (err, stdout) => {
            if (err) {
              resolve('');
            } else {
              resolve(stdout || '');
            }
          });
        });

      for (const file of todayFiles) {
        const diff = await runGitDiff(file);

        if (diff.trim().length > 0) {
          hasRealDiff = true;
          // Add a Codex-optimized header for each file
          finalDiff +=
            `\n==================== FILE: ${path.relative(workspaceRoot, file)} ====================\n` +
            diff +
            `\n================ END OF FILE: ${path.relative(workspaceRoot, file)} ================\n`;
        }
      }

      // If diff still empty
      if (!hasRealDiff) {
        showOncePerSecond('info', '今天有修改文件，但没有未提交的变更');
        return;
      }

      // ---------- Step 6: Truncate if too large (500KB) ----------
      const maxSize = 500 * 1024; // 500KB
      let output = finalDiff;

      if (Buffer.byteLength(finalDiff, 'utf8') > maxSize) {
        output = finalDiff.slice(0, maxSize);
        showOncePerSecond('warn', 'diff 内容过大，已自动截断以避免 Codex 拒绝处理');
      }

      // ---------- Step 7: Write to clipboard ----------
      try {
        await vscode.env.clipboard.writeText(output.trim());
        {
          vscode.window.showInformationMessage('今日真实 diff 已复制到剪贴板 👍');
        }
      } catch (err) {
        showOncePerSecond('error', '复制到剪贴板失败：' + String(err));
      }
    }
  );

  context.subscriptions.push(disposable);
  // Create a status bar button for copying today's diff
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'devlog-diff-helper.copyTodayDiff';
  statusBarItem.text = '$(git-commit) Copy Diff';
  statusBarItem.tooltip = '复制今日 diff 到剪贴板';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {}
