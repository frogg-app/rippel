/**
 * The glyphs the Create screen needs on top of the shell's set, traced from the
 * Main artboard so stroke weight and caps match. Same one-prop API as
 * `src/components/icons.tsx`; kept here rather than added there because that
 * file belongs to the shell workstream.
 */
import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({
  size = 16,
  className,
  strokeWidth = 1.6,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Randomise the seed. Four pips, as the artboard draws it. */
export function DiceIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 1.5}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 1.7}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 018 0v3" />
    </Svg>
  );
}

/** The unlocked state: the same body, shackle swung open. */
export function UnlockIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 1.7}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 017.5-2" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v11M7 11l5 5 5-5M4 20h16" />
    </Svg>
  );
}

export function RemixIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4" />
      <path d="M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 2}>
      <path d="M8 5l11 7-11 7z" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 2.2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={props.strokeWidth ?? 1.8}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4.2M12 17.2v.1" />
    </Svg>
  );
}
