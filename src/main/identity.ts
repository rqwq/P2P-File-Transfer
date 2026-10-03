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

// The final product license (spec Section 14): a proprietary, All Rights
// Reserved EULA — the source is public for transparency and review only.
// The same text lives in the repository root as LICENSE and in the
// renderer's About / License panel.
export const LICENSE_TEXT = `P2P FILE TRANSFER — END USER LICENSE AGREEMENT
Last updated: 2026-10-03

1. THE SOFTWARE
This agreement covers the Windows desktop application "P2P File
Transfer" (the "App"), including any updates delivered through the
App's built-in updater. "We", "us" and "the publisher" mean the author
of the App; "you" means the person using it.

P2P File Transfer is serverless: rooms, chat and file transfers connect
your machine directly to other users' machines over HyperDHT or a VPN
adapter. There is no central server and we never receive, relay or store
your files, chats or room data.

2. LICENSE GRANT
We grant you a personal, non-exclusive, non-transferable, revocable
license to install and run the App on hardware you own or control. The
App is licensed, not sold. We reserve all rights not explicitly granted
here.

3. OWNERSHIP AND SOURCE
The App and its source code are protected by copyright and other laws.
The source code is published for transparency and review only. It is
NOT open source: viewing or forking the repository grants no right to
use, copy, modify, compile or redistribute the App or its source beyond
plain viewing on the repository host.

4. RESTRICTIONS
You must not:
  - redistribute the App or any build of it, in whole or in part, or
    charge money for it; the only authorized distribution channel is the
    project's own Releases page;
  - modify the App, build a modified client, or remove or bypass its
    identity, integrity, or ban enforcement (HWID verification, the
    runtime integrity gate, room and app bans);
  - use a modified or mismatched build against other users — such builds
    are automatically detected, flagged Untrusted and banned;
  - use the App to distribute malware or illegal content, or for any
    unlawful purpose.

5. PEER-TO-PEER NATURE
Transfers and chat happen directly between users. Anything another user
sends you comes from that user, not from us. Peers you interact with can
see your network address, and you can see theirs. Because there is no
central server, there is no central copy of your traffic to moderate or
retrieve. Your machine's hardware identity hash is computed locally,
stored locally, and is used for identity and ban enforcement.

6. MODERATION AND BANS
Rooms are moderated by their creators and staff. The publisher may
remotely ban an installation from the entire App (an "app ban") for
abuse, tampering, or distributing harmful content. A banned installation
is refused by the App itself, cannot go online, leaves its rooms, and
receives no further updates. Bans cannot be appealed.

7. UPDATES
The App updates itself automatically. Banned installations do not. You
are not obliged to install anything, but using an outdated build may
disconnect you from peers running a newer protocol.

8. NO WARRANTY
THE APP IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. WITHOUT
LIMITING THE FOREGOING, WE DISCLAIM ANY WARRANTY THAT THE APP WILL BE
UNINTERRUPTED, ERROR-FREE, SECURE, OR THAT FILES TRANSFERRED WILL BE
SAFE OR LAWFUL. YOU RUN FILES YOU RECEIVE AT YOUR OWN RISK.

9. LIMITATION OF LIABILITY
TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE ARE NOT LIABLE FOR ANY
DAMAGES ARISING FROM YOUR USE OF THE APP, THE CONTENT OTHER USERS SEND
YOU, LOST DATA, LOST PROFITS, OR THE ACTIONS OF OTHER USERS. OUR TOTAL
LIABILITY FOR ANY CLAIM IS LIMITED TO THE AMOUNT YOU PAID FOR THE APP,
WHICH IS ZERO.

10. TERMINATION
This license ends automatically if you breach it. Room bans and app bans
end your right to use the corresponding parts of the App and the network.

11. CHANGES
We may update this agreement with new App versions. If you keep using the
App after an update, you accept the updated agreement.

12. CONTACT
Licensing questions and abuse reports: Discord ".extremism".

Copyright (c) 2026 P2P File Transfer. All rights reserved.
`
