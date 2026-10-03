import React from 'react'

// Inline stroke icon set (lucide-style geometry, 24x24 grid) — no icon
// package dependency, works offline, colors inherit from `currentColor`.

export type IconName =
  | 'x'
  | 'minus'
  | 'maximize'
  | 'plus'
  | 'check'
  | 'copy'
  | 'users'
  | 'message'
  | 'send'
  | 'paperclip'
  | 'file'
  | 'fileText'
  | 'folder'
  | 'download'
  | 'upload'
  | 'settings'
  | 'logOut'
  | 'alertTriangle'
  | 'shield'
  | 'ban'
  | 'clock'
  | 'pause'
  | 'play'
  | 'xCircle'
  | 'globe'
  | 'zap'
  | 'hash'
  | 'externalLink'
  | 'info'
  | 'image'
  | 'film'
  | 'music'
  | 'inbox'
  | 'trash'
  | 'crown'
  | 'spear'
  | 'checkCircle'
  | 'hammer'
  | 'anarchy'
  | 'hammerShield'
  | 'wrench'
  | 'alertCircle'
  | 'thumbsDown'
  | 'star'
  | 'arrowRight'
  | 'arrowLeft'
  | 'refresh'
  | 'mail'
  | 'share2'
  | 'chevronRight'

const P: Record<IconName, React.ReactNode> = {
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  // Administrator: a spear held to the right of the bearer.
  spear: (
    <>
      <path d="M3 21 13 11" />
      <path d="M13 4.5 19.5 11 22 2 12.5 2Z" />
      <path d="M11 13 8 10" />
    </>
  ),
  // Official / verified.
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8.5 12.5 2.5 2.5 5-5.5" />
    </>
  ),
  // App moderator hammer.
  hammer: (
    <>
      <path d="m14.5 12.5-8.4 8.4a1.4 1.4 0 0 1-2-2l8.4-8.4" />
      <path d="m17 9 4.2-4.2-1.4-3.5-2.1 2.1-2.8-.7-.7 2.8-2.1 2.1Z" />
      <path d="M14.5 12.5 17 10" />
    </>
  ),
  // Anarchy circle-A: the legs of the A extend past the circle outline,
  // classic symbol proportions.
  anarchy: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M5.2 21.2 12 2 18.8 21.2" />
      <path d="M7.75 14h8.5" />
    </>
  ),
  // Room administrator: a hammer contained in a shield (shield outline
  // reused from `shield`; the hammer is scaled 0.5 with a doubled stroke
  // so it keeps the set's visual weight inside).
  hammerShield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <g transform="translate(5.675 5.95) scale(0.5)" strokeWidth={4}>
        <path d="m14.5 12.5-8.4 8.4a1.4 1.4 0 0 1-2-2l8.4-8.4" />
        <path d="m17 9 4.2-4.2-1.4-3.5-2.1 2.1-2.8-.7-.7 2.8-2.1 2.1Z" />
        <path d="M14.5 12.5 17 10" />
      </g>
    </>
  ),
  // Wrench (tool) — the Developer badge renders its own gradient variant.
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  // Exclamation in a circle — the Suspected badge (red = active,
  // orange = marked/past).
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  // Untrusted: outlined thumbs-down.
  thumbsDown: (
    <path d="M17 14V4.5a1.5 1.5 0 0 0-1.5-1.5H11a1 1 0 0 0-.8.4L7.6 7A1 1 0 0 0 6 8v3.2a1.8 1.8 0 0 0 1.8 1.8H10l-1.2 5a1.5 1.5 0 0 0 2.7 1.2l4-5.4a1.5 1.5 0 0 0 1.5-.8ZM3 9v4" />
  ),
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2 1.2-6.8-5-4.9 6.9-1Z" />,
  minus: <path d="M5 12h14" />,
  maximize: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  message: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  paperclip: (
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  fileText: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </>
  ),
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
  settings: (
    <>
      <path d="M21 4h-7" />
      <path d="M10 4H3" />
      <path d="M21 12h-9" />
      <path d="M8 12H3" />
      <path d="M21 20h-5" />
      <path d="M12 20H3" />
      <path d="M14 2v4" />
      <path d="M8 10v4" />
      <path d="M16 18v4" />
    </>
  ),
  logOut: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  shield: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  pause: (
    <>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </>
  ),
  play: <path d="m6 3 14 9-14 9z" />,
  xCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  zap: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
  hash: (
    <>
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3 8 21" />
      <path d="M16 3l-2 18" />
    </>
  ),
  externalLink: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </>
  ),
  film: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="2.18" />
      <path d="M7 2v20" />
      <path d="M17 2v20" />
      <path d="M2 12h20" />
      <path d="M2 7h5" />
      <path d="M2 17h5" />
      <path d="M17 7h5" />
      <path d="M17 17h5" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  crown: (
    <>
      <path d="M2 6l5 5 5-8 5 8 5-5-2 12H4L2 6Z" />
      <path d="M5 21h14" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1.06 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 8.97a2.5 2.5 0 0 1-3.06 0L2 7" />
    </>
  ),
  share2: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.59 13.51 6.83 3.98" />
      <path d="m15.41 6.51-6.82 3.98" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />
}

export function Icon(props: { name: IconName; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Base `icon` class: badge styles key off it (.badge-appMod .icon …)
      // and it is mergeable with any caller-provided class.
      className={props.className ? `${props.className} icon` : 'icon'}
      aria-hidden="true"
    >
      {P[props.name]}
    </svg>
  )
}
