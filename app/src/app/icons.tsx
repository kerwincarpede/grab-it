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

export const SlidersIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const OpenIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const RepeatIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M4 11a7 7 0 0 1 12.5-4.3L19 9M19 4v5h-5M20 13a7 7 0 0 1-12.5 4.3L5 15M5 20v-5h5" />
  </Icon>
);

export const TimerIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9.5V13l2 2M10 2.5h4" />
  </Icon>
);

export const CardIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M13 15h5" />
  </Icon>
);

export const PinIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M12 16v5M8.5 3.5h7l-1 5.5 3 3.5h-11l3-3.5z" />
  </Icon>
);

export const SearchIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const CloseIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const CheckIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const TagIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-9 9z" />
    <circle cx="8" cy="8" r="1.3" />
  </Icon>
);

export const ChevronUpIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m6 15 6-6 6 6" />
  </Icon>
);

export const ChevronRightIcon = ({ size }: IconProps) => (
  <Icon size={size}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);
