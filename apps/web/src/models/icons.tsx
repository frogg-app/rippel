/**
 * The handful of glyphs this screen needs, traced from the Models artboard.
 *
 * Inline rather than a sprite or a dependency for the same reason the Library
 * icons are: there are six of them, they are decorative, and every one carries
 * `aria-hidden` because the control around it is what is labelled.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.6-3.6" />
  </Icon>
);

export const InstallIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M12 4v11M7 11l5 5 5-5M4 20h16" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={2.6}>
    <path d="M5 13l4 4 10-10" />
  </Icon>
);

export const CubeIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.5}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </Icon>
);

export const WarningIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4l9 15.5H3z" />
    <path d="M12 10v4.5M12 17.2v.2" />
  </Icon>
);

/** A download *count* — a tray, not the install arrow, which means something else here. */
export const DownloadCountIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <path d="M4 15v3.5A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5V15" />
    <path d="M12 4v9M8 9.5l4 4 4-4" />
  </Icon>
);

/** Leaves the app: on the "Model page" link, so the arrow is the warning. */
export const LinkIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.9}>
    <path d="M14 5h5v5M19 5l-8 8M17 14v4.5A1.5 1.5 0 0115.5 20h-10A1.5 1.5 0 014 18.5v-10A1.5 1.5 0 015.5 7H10" />
  </Icon>
);

export const ChevronIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
