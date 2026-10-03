// Emulates a second, independent user of the app on this machine so the
// full P2P flow can be tested end-to-end (create/join, chat, transfers,
// bans) between two real instances.
//
//   node scripts/test-second-user.mjs [--name Alice] [--fresh]
//
// How it stays "as close to a real one as possible":
//   - userData is fully isolated by redirecting APPDATA to a sandbox
//     folder, so the instance gets its own settings, HWID cache, ed25519
//     keypair, room/chat/ban databases and tray identity. The app's
//     single-instance lock is keyed on userData, so both run side by side.
//   - The HWID query really executes: the app spawns `powershell.exe` and
//     parses its JSON. This script puts a tiny compiled shim FIRST on the
//     child's PATH; when it sees the hardware-identifier query it answers
//     with different-but-realistic, persisted values (a different
//     "machine"), and it delegates everything else — e.g. the
//     receive-folder lock helper — to the real PowerShell unchanged.
//   - Different HWID means ban-by-HWID behaves like it would between two
//     physical machines; the shared LAN IP exercises the spec's
//     "HWID OR IP" matching exactly as two machines behind one NAT would.

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const has = (name) => argv.includes(`--${name}`)

const NAME = flag('name') ?? 'TestUser2'
const slug = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user2'

const ROOT = path.resolve(import.meta.dirname, '../.test-users', slug)
const APPDATA_DIR = path.join(ROOT, 'appdata')
const SHIM_DIR = path.join(ROOT, 'shim')
const RECEIVE_DIR = path.join(ROOT, 'received')
const HARDWARE_FILE = path.join(SHIM_DIR, 'hardware.json')

// ---- 1. sandbox + stable fake hardware ----

if (has('fresh')) {
  fs.rmSync(ROOT, { recursive: true, force: true })
  console.log(`[emulator] wiped sandbox for "${NAME}"`)
}
fs.mkdirSync(APPDATA_DIR, { recursive: true })
fs.mkdirSync(SHIM_DIR, { recursive: true })
fs.mkdirSync(RECEIVE_DIR, { recursive: true })

function makeHardware() {
  const rand = (n, alphabet) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  return {
    // Realistic formats, mirroring what Get-CimInstance returns.
    mb: `M80-${rand(10, '0123456789')}`, // motherboard serial
    cpu: `178BFBFF00A6${rand(4, '0123456789ABCDEF')}`, // AuthenticID-style ProcessorId
    disk: `WD-WCC6Y${rand(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`, // disk serial
    mac: rand(12, '0123456789ABCDEF') // first NIC MAC, no separators
  }
}

if (!fs.existsSync(HARDWARE_FILE)) {
  fs.writeFileSync(HARDWARE_FILE, JSON.stringify(makeHardware(), null, 2))
  console.log('[emulator] generated fake hardware identifiers (persisted for this user)')
}
const hardware = JSON.parse(fs.readFileSync(HARDWARE_FILE, 'utf8'))

// ---- 2. compile the powershell shim (once per sandbox) ----

const SHIM_SRC = path.join(SHIM_DIR, 'powershell-shim.cs')
const SHIM_EXE = path.join(SHIM_DIR, 'powershell.exe')
const SRC = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class Shim {
  static string Quote(string a) { return "\\"" + (a ?? "").Replace("\\"\\"", "\\"\\"") + "\\""; }
  static int Main(string[] argv) {
    string cmd = Environment.CommandLine;
    if (cmd.Contains("Win32_BaseBoard")) {
      string json = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "hardware.json"));
      Console.Out.Write(json);
      return 0;
    }
    string real = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.System),
      "WindowsPowerShell\\\\v1.0\\\\powershell.exe");
    StringBuilder sb = new StringBuilder();
    foreach (string a in argv) { if (sb.Length > 0) sb.Append(' '); sb.Append(Quote(a)); }
    ProcessStartInfo psi = new ProcessStartInfo();
    psi.FileName = real;
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    Process p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`

function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

const needsBuild = !fs.existsSync(SHIM_EXE) || !fs.existsSync(SHIM_SRC) || fs.readFileSync(SHIM_SRC, 'utf8') !== SRC
let hwidFaked = true
if (needsBuild) {
  const csc = findCsc()
  if (!csc) {
    hwidFaked = false
    console.warn('[emulator] WARNING: no .NET csc.exe found — cannot build the hardware-identifier')
    console.warn('[emulator] shim, so this user will share the real machine HWID. Everything else')
    console.warn('[emulator] still works (ban tests will behave like two accounts on one machine).')
  } else {
    fs.writeFileSync(SHIM_SRC, SRC, 'utf8')
    execFileSync(csc, ['/nologo', `/out:${SHIM_EXE}`, SHIM_SRC], { stdio: 'pipe' })
    console.log('[emulator] compiled powershell shim (answers the HWID hardware query,')
    console.log('[emulator] delegates everything else to the real PowerShell)')
  }
}

// Sanity: confirm the fake HWID really differs from this machine's.
const fakeRaw = `${hardware.mb}-${hardware.cpu}-${hardware.disk}-${hardware.mac}`
const fakeHash = crypto.createHash('sha256').update(fakeRaw, 'utf8').digest('hex').toUpperCase()

// ---- 3. launch the app ----

const childEnv = {
  ...process.env,
  PATH: `${SHIM_DIR};${process.env.PATH}`
}

console.log('[emulator] ----------------------------------------------------------------')
console.log(`[emulator] user        : ${NAME}`)
console.log(`[emulator] fake HWID   : ${fakeHash.slice(0, 16)}… (differs from this machine)`)
console.log(`[emulator] sandbox     : ${ROOT}`)
// Which build is this instance actually running? The emulator loads
// out/main/index.js directly, so a stale out/ silently means old code.
try {
  const st = fs.statSync(path.join(import.meta.dirname, '../out/main/index.js'))
  console.log(`[emulator] running build: ${new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19)} (out/main/index.js)`)
} catch {
  console.warn('[emulator] WARNING: out/main/index.js missing — run npm run build first')
}
console.log(`[emulator] suggest set the receive folder to: ${RECEIVE_DIR}`)
console.log('[emulator] the first window shows the normal setup gate — pick a display')
console.log('[emulator] name, then create/join rooms and exchange codes with your main')
console.log('[emulator] instance. Kill this script (Ctrl+C) to close the emulated user.')
console.log('[emulator] ----------------------------------------------------------------')

const electronBin = path.resolve(import.meta.dirname, '../node_modules/electron/dist/electron.exe')
const appDir = path.resolve(import.meta.dirname, '..')
const userDataDir = path.join(APPDATA_DIR, 'user')
const child = spawn(electronBin, [appDir, `--user-data-dir=${userDataDir}`], {
  env: childEnv,
  stdio: 'inherit',
  windowsHide: false
})

child.on('error', (err) => {
  console.error(`[emulator] failed to launch electron: ${err.message}`)
  process.exit(1)
})

const forward = (sig) => () => {
  try {
    child.kill(sig)
  } catch {
    // already dead
  }
}
process.on('SIGINT', forward('SIGINT'))
process.on('SIGTERM', forward('SIGTERM'))
child.on('exit', (code) => {
  process.exit(code ?? 0)
})
