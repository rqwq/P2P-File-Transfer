import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Receive-folder protection (spec 8.7). While the app is running, a marker
// file inside the folder is held open with FILE_SHARE_READ|FILE_SHARE_WRITE
// and *no* FILE_SHARE_DELETE, so Explorer reports "in use by another
// program" when the user tries to delete/rename the folder. Plain Node fs
// cannot control share modes, so a hidden PowerShell child process does a
// CreateFileW via P/Invoke and parks on the handle for the app's lifetime
// (best-effort per the spec; the transfer-time existence checks remain the
// safety net).

const PS_BODY = `
param([string]$Marker)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Marker)) { exit 2 }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class P2pFolderLock {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
}
"@
$GENERIC_READ = [uint32]2147483648
$SHARE_READ_WRITE = [uint32]3
$h = [P2pFolderLock]::CreateFileW($Marker, $GENERIC_READ, $SHARE_READ_WRITE, [IntPtr]::Zero, 3, 128, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { exit 3 }
while ($true) { Start-Sleep -Seconds 3600 }
`

export class FolderLock {
  private proc: ChildProcess | null = null
  private scriptFile = ''

  ensureStarted(folder: string): void {
    const marker = path.join(folder, '.p2pft-lock')
    try {
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, 'P2P File Transfer folder lock')
      if (!this.scriptFile) {
        this.scriptFile = path.join(app.getPath('userData'), 'folder-lock.ps1')
        fs.writeFileSync(this.scriptFile, PS_BODY.trim(), 'utf8')
      }
      if (this.proc && !this.proc.killed && this.proc.exitCode === null) return
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptFile, '-Marker', marker],
        { windowsHide: true, stdio: 'ignore' }
      )
      this.proc.on('error', () => {
        this.proc = null
      })
    } catch {
      // Best-effort lock (spec 8.7): failing to lock is not fatal; the
      // existence checks at transfer time are the safety net.
    }
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        // already dead
      }
      this.proc = null
    }
  }
}

export const folderLock = new FolderLock()
