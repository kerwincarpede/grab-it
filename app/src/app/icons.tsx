import type { ReactNode } from "react";

/** Inline icons on a 24px grid, drawn in the current text colour. */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const RegionIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
  </Icon>
);

export const WindowIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18" />
  </Icon>
);

export const ScreenIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const RecordIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="9" />
    <circle className="record-dot" cx="12" cy="12" r="3.5" stroke="none" />
  </Icon>
);

export const TextIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 7V5h16v2M9 19h6M12 5v14" />
  </Icon>
);

export const ColourIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m14 4 6 6-9 9H5v-6z" />
    <path d="m12 6 6 6" />
  </Icon>
);

export const GridIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Icon>
);

export const GearIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
  </Icon>
);

export const KeyboardIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
  </Icon>
);

export const ChevronDownIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronLeftIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);



export const PenIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
);

export const SparkleIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
  </Icon>
);

export const FolderIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);
