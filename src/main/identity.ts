import { MAX_DISPLAY_NAME, RESERVED_HASH_B64, RESERVED_NAME_B64 } from '../shared/constants'

// Reserved identity protection (spec 4.4). The owner's display name is
// globally reserved, compared case-insensitively, and may only be claimed
// by a machine whose locally computed HWID hash equals the embedded
// reserved hash. Both values are stored base64-obfuscated so they do not
// appear via a plaintext strings/grep pass; the production bundle's
// string-array obfuscator hides them a second time.

export function reservedName(): string {
  return Buffer.from(RESERVED_NAME_B64, 'base64').toString('utf8')
}

function reservedHash(): string {
  return Buffer.from(RESERVED_HASH_B64, 'base64').toString('utf8').toUpperCase()
}

export function validateDisplayName(name: string, myHwidHash: string): { ok: boolean; error: string | null } {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, error: 'Enter a display name.' }
  if (trimmed.length > MAX_DISPLAY_NAME) {
    return { ok: false, error: `Display name is limited to ${MAX_DISPLAY_NAME} characters.` }
  }
  if (
    trimmed.toLowerCase() === reservedName().toLowerCase() &&
    myHwidHash.toUpperCase() !== reservedHash()
  ) {
    return { ok: false, error: 'This name is reserved.' }
  }
  return { ok: true, error: null }
}

// The final product license: source-available, All Rights Reserved
// (spec Section 14). Identical text lives in the repository root as
// LICENSE; the About / License panel renders this constant.
export const LICENSE_TEXT = `P2P File Transfer — serverless peer-to-peer file transfer
Copyright (c) 2026 rqwq

ALL RIGHTS RESERVED.

This source code is made publicly viewable for transparency and review
purposes only. It is not open-source software, and its publication does
not grant any license to use, copy, modify, or distribute it.

Without prior written permission from the copyright holder, you may
not:

  * copy, publish, or redistribute this software or its source code,
    in whole or in part;
  * modify it, or create derivative works from it;
  * compile, build, or distribute it, or any derivative work of it;
  * present any copy or modified build of it as your own.

This restriction applies to any modified, obfuscated, re-compiled,
renamed, or partial version of the source code, regardless of the
changes made, and regardless of how those changes were produced.

Forking this repository through GitHub's built-in functionality does
not grant any rights beyond viewing it on GitHub. Cloning, building,
modifying, or redistributing a fork — or any part of it —
outside of GitHub's viewing functionality is not authorized.

The only authorized distribution of P2P File Transfer is the official
Releases page of this repository. Unauthorized copies, modified builds,
and reuploads infringe the copyright and will be removed via DMCA
takedown and may be pursued by any other available legal remedies.

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS SOFTWARE.

This license is governed by the laws of the Russian Federation, without
regard to conflict of law principles.

For permissions or questions, contact phenomenal_lqc on Discord.
`
