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
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </Icon>
);

export const CloseIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon size={14}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon size={14}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const AppIcon = () => (
  <Icon size={14}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M3.5 9h17" />
  </Icon>
);

export const TagIcon = () => (
  <Icon size={14}>
    <path d="M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.5 1.5 0 010 2.1l-6.2 6.2a1.5 1.5 0 01-2.1 0z" />
    <circle cx="8" cy="8" r="1.4" />
  </Icon>
);

export const CalendarIcon = () => (
  <Icon size={14}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 8.5V6a2.5 2.5 0 00-2.5-2.5H6A2.5 2.5 0 003.5 6v7A2.5 2.5 0 006 15.5h2.5" />
  </Icon>
);

/** A "T" in a frame: the text in an image. */
export const TextIcon = () => (
  <Icon>
    <path d="M4 7V5.5A1.5 1.5 0 015.5 4H7M17 4h1.5A1.5 1.5 0 0120 5.5V7M20 17v1.5a1.5 1.5 0 01-1.5 1.5H17M7 20H5.5A1.5 1.5 0 014 18.5V17" />
    <path d="M8.5 9h7M12 9v7" />
  </Icon>
);

export const PinIcon = () => (
  <Icon>
    <path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5z" />
    <path d="M12 13v7.5" />
  </Icon>
);

export const FolderIcon = () => (
  <Icon>
    <path d="M3.5 7a2 2 0 012-2h4l2 2.5h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a1.5 1.5 0 001.5 1.5h7a1.5 1.5 0 001.5-1.5L18 7M9 7V4.5h6V7" />
  </Icon>
);

export const ImageIcon = () => (
  <Icon size={14}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.7" />
    <path d="M20.5 16l-5-5-8 8.5" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon size={14}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const GridSmallIcon = () => (
  <Icon size={14}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Icon>
);

export const GridLargeIcon = () => (
  <Icon size={14}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
  </Icon>
);

export const SparkleIcon = () => (
  <Icon size={14}>
    <path d="M12 3.5l1.8 5 5 1.8-5 1.8-1.8 5-1.8-5-5-1.8 5-1.8z" />
    <path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Icon>
);

export const LayersIcon = () => (
  <Icon size={14}>
    <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
    <path d="M3.5 12.5l8.5 4.5 8.5-4.5" />
  </Icon>
);
