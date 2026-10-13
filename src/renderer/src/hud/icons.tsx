// Inline SVG icon set (24px grid, 1.7 stroke). Written by hand so the HUD needs no icon font or dependency.
import type { CSSProperties, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconX = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Base>
)

export const IconSearch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.2 4.2" />
  </Base>
)

export const IconCommand = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 9h6v6H9z" />
    <path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm6 0V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 6v2.5a2.5 2.5 0 1 0 2.5-2.5H15zM9 15H6.5A2.5 2.5 0 1 0 9 17.5V15z" />
  </Base>
)

export const IconPlus = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Base>
)

export const IconFolder = (p: IconProps) => (
  <Base {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Base>
)

export const IconMinus = (p: IconProps) => (
  <Base {...p}>
    <path d="M5.5 12h13" />
  </Base>
)

export const IconSquare = (p: IconProps) => (
  <Base {...p}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="3" />
  </Base>
)

export const IconRestore = (p: IconProps) => (
  <Base {...p}>
    <rect x="5.5" y="8.5" width="10" height="10" rx="2.5" />
    <path d="M9 8.5V7a2 2 0 0 1 2-2h6.5a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H15" />
  </Base>
)

export const IconChevronLeft = (p: IconProps) => (
  <Base {...p}>
    <path d="M14.5 6.5L9 12l5.5 5.5" />
  </Base>
)

export const IconChevronRight = (p: IconProps) => (
  <Base {...p}>
    <path d="M9.5 6.5L15 12l-5.5 5.5" />
  </Base>
)

export const IconChevronDown = (p: IconProps) => (
  <Base {...p}>
    <path d="M6.5 9.5L12 15l5.5-5.5" />
  </Base>
)

export const IconPlay = (p: IconProps) => (
  <Base fill="currentColor" stroke="none" {...p}>
    <path d="M8.5 6.2v11.6c0 .6.66.97 1.17.65l9.2-5.8a.77.77 0 0 0 0-1.3l-9.2-5.8c-.5-.32-1.17.05-1.17.65z" />
  </Base>
)

export const IconPause = (p: IconProps) => (
  <Base fill="currentColor" stroke="none" {...p}>
    <rect x="6.5" y="5.5" width="3.8" height="13" rx="1.4" />
    <rect x="13.7" y="5.5" width="3.8" height="13" rx="1.4" />
  </Base>
)

export const IconStepBack = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 6v12" />
    <path d="M18 6.5l-8 5.5 8 5.5z" fill="currentColor" />
  </Base>
)

export const IconStepForward = (p: IconProps) => (
  <Base {...p}>
    <path d="M17 6v12" />
    <path d="M6 6.5l8 5.5-8 5.5z" fill="currentColor" />
  </Base>
)

export const IconReplay = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
    <path d="M4.5 4.5v4h4" />
  </Base>
)

export const IconClock = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="7.8" />
    <path d="M12 8v4.2l2.7 1.8" />
  </Base>
)

export const IconEye = (p: IconProps) => (
  <Base {...p}>
    <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </Base>
)

export const IconPencil = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 19.5l1-4.2L15.6 5.2a2.1 2.1 0 0 1 3 3L8.5 18.3z" />
    <path d="M13.8 7l3 3" />
  </Base>
)

export const IconFilePlus = (p: IconProps) => (
  <Base {...p}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5M12 11.5v5.5M9.2 14.2h5.6" />
  </Base>
)

export const IconTrash = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Base>
)

export const IconTerminal = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="M7.5 9.8l2.8 2.3-2.8 2.3M12.8 15h3.7" />
  </Base>
)

export const IconMessage = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 6.8A2.8 2.8 0 0 1 7.8 4h8.4A2.8 2.8 0 0 1 19 6.8v6.4a2.8 2.8 0 0 1-2.8 2.8H11l-4.4 3.3v-3.3h-.8A2.8 2.8 0 0 1 5 13.2z" />
  </Base>
)

export const IconDots = (p: IconProps) => (
  <Base {...p}>
    <circle cx="6.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Base>
)

export const IconSparkle = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.8l1.7 4.5 4.5 1.7-4.5 1.7L12 16.2l-1.7-4.5-4.5-1.7 4.5-1.7z" />
    <path d="M18.5 15.5v4M16.5 17.5h4" />
  </Base>
)

export const IconBranch = (p: IconProps) => (
  <Base {...p}>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="7.5" r="2" />
    <path d="M6.5 7.5v9M17.5 9.5c0 4.5-11 2.5-11 7" />
  </Base>
)

export const IconGitBranch = IconBranch

export const IconCheck = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12.6l4.4 4.4L19 7.4" />
  </Base>
)

export const IconCoins = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="7" rx="7.5" ry="3" />
    <path d="M4.5 7v5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V7M4.5 12v5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-5" />
  </Base>
)

export const IconMoon = (p: IconProps) => (
  <Base {...p}>
    <path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z" />
  </Base>
)

export const IconDownload = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4.5v10.5M7.5 11l4.5 4.5 4.5-4.5M5 19.5h14" />
  </Base>
)

export const IconSidebar = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3.2" />
    <path d="M9.5 4.5v15" />
  </Base>
)

export const IconRefresh = (p: IconProps) => (
  <Base {...p}>
    <path d="M19.5 11.5a7.6 7.6 0 0 0-13.3-4.6L4.5 8.5" />
    <path d="M4.5 4.5v4h4M4.5 12.5a7.6 7.6 0 0 0 13.3 4.6l1.7-1.6M19.5 19.5v-4h-4" />
  </Base>
)

export const IconAlert = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 7.8v5" />
    <circle cx="12" cy="16.2" r=".6" fill="currentColor" />
  </Base>
)

export const IconInfo = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.3" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r=".6" fill="currentColor" />
  </Base>
)

export const IconWave = (p: IconProps) => (
  <Base {...p}>
    <path d="M3 12h3.2l2.6-6 4 12 2.6-6H21" />
  </Base>
)

export const IconArrowRight = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h14M13.5 6.5L19 12l-5.5 5.5" />
  </Base>
)

export const IconLink = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </Base>
)

export const IconDoc = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 3.5h7l4.5 4.5v11.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19.5v-14A1.5 1.5 0 0 1 7.5 3.5z" />
    <path d="M14 3.5V8h4.5M9 12.5h6M9 16h6" />
  </Base>
)

export const IconSend = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 11.8L19.8 4.5l-5.6 15.3-2.9-6.1z" />
    <path d="M11.3 13.7l3.1-3.1" />
  </Base>
)

export const IconDrone = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="2.6" />
    <path d="M9.6 10.4L6.2 7.4M14.4 10.4l3.4-3M9.6 13.6l-3.4 3M14.4 13.6l3.4 3" />
    <circle cx="5" cy="6.5" r="2" />
    <circle cx="19" cy="6.5" r="2" />
    <circle cx="5" cy="17.5" r="2" />
    <circle cx="19" cy="17.5" r="2" />
  </Base>
)

export const IconSettings = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6" />
  </Base>
)

export const IconTokens = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.8v16.4M3.8 12h16.4" />
    <circle cx="12" cy="12" r="8.2" />
  </Base>
)

export const IconSplit = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 4v5M12 9l-5 4.5M12 9l5 4.5M7 13.5V20M17 13.5V20" />
  </Base>
)

/** The Skyline glyph: four building bars on a rounded tile. Bars breathe when `animated`. */
export function SkylineGlyph({ size = 22, animated = false }: { size?: number; animated?: boolean }) {
  const bars: Array<[number, number, number, number]> = [
    [4.2, 12.4, 3.2, 7.4],
    [8.6, 6.8, 3.2, 13],
    [13, 9.4, 3.2, 10.4],
    [17.4, 5, 3.2, 14.8]
  ]
  return (
    <svg className="skyline-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="sky-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5eb3ff" />
          <stop offset="1" stopColor="#0a5fd6" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="24" height="24" rx="7" fill="url(#sky-tile)" />
      <rect x="0" y="0" width="24" height="24" rx="7" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth=".6" />
      {bars.map(([x, y, w, h], i) => (
        <rect
          key={i}
          className={animated ? 'bar' : undefined}
          x={x}
          y={y}
          width={w}
          height={h}
          rx={1}
          fill="#fff"
          opacity={0.92}
          style={animated ? ({ '--d': `${i * 0.18}s` } as CSSProperties) : undefined}
        />
      ))}
    </svg>
  )
}

export const IconCamera = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.3-2h4l1.3 2h1.2A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </Base>
)

export const IconVideo = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="6.5" width="13" height="11" rx="2.5" />
    <path d="M16 10.5l5-3v9l-5-3" />
  </Base>
)

export const IconImage = (p: IconProps) => (
  <Base {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 17l4.5-4.2 3.2 2.8 2.6-2.2 4.7 4.1" />
  </Base>
)
