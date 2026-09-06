/**
 * The glyphs the Library screen draws, traced from `design/parts/Library.body.html`.
 *
 * They live here rather than in `components/icons.tsx` only to keep this
 * feature's files disjoint from the shell's while both are being written; they
 * are the same 24-box, 1.6-stroke, currentColor icons and belong in the shared
 * set the moment the branches meet.
 */
import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  /** Star and play read better filled once they are "on". */
  filled?: boolean;
}

function Svg({
  size = 16,
  className,
  filled,
  strokeWidth = 1.6,
  children,
}: IconProps & { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
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

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </Svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.5} {...props}>
      <path d="M12 4l2.4 5.2 5.6.7-4.1 3.9 1.1 5.6L12 16.7 6.9 19.4 8 13.8 3.9 9.9l5.6-.7z" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.5} {...props}>
      <path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg strokeWidth={1.8} {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
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
    <Svg strokeWidth={2} filled {...props}>
      <path d="M8 5l11 7-11 7z" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5H6a2 2 0 00-2 2v9" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7a2 2 0 012-2h3.2l1.6 2H18a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9h11a5 5 0 010 10h-6" />
      <path d="M8 5L4 9l4 4" />
    </Svg>
  );
}
