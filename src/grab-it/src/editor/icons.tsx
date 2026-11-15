import type { ReactNode } from "react";
import type { Tool } from "./model";

/** Inline icons on a 24px grid, drawn 18px in the current text colour. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const TOOL_ICONS: Record<Tool, ReactNode> = {
  select: <path d="M5 3l14 7.5-6 1.8L10.5 19z" />,
  pan: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </>
  ),
  arrow: <path d="M5 19L19 5M9 5h10v10" />,
  line: <path d="M5 19L19 5" />,
  rect: <rect x="4" y="5.5" width="16" height="13" rx="2" />,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  freehand: <path d="M3 17c3-7 5-9 7-6s2 6 4 4 3-7 7-8" />,
  text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  step: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.5 9.5L12.5 8v8" />
    </>
  ),
  highlighter: (
    <>
      <path d="M14.5 4.5l5 5L11 18H6v-5z" />
      <path d="M4 21h16" />
    </>
  ),
  blur: (
    <>
      <path d="M12 3.5c3.5 4 5.5 6.8 5.5 9.7a5.5 5.5 0 01-11 0c0-2.9 2-5.7 5.5-9.7z" />
      <path d="M12 16a2.8 2.8 0 002.8-2.8" />
    </>
  ),
  spotlight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="2.5 2.5" />
      <rect x="8" y="9" width="8" height="6" rx="1" />
    </>
  ),
  crop: <path d="M7 2.5V17h14.5M2.5 7H17v14.5" />,
};

export function ToolIcon({ tool }: { tool: Tool }) {
  return <Icon>{TOOL_ICONS[tool]}</Icon>;
}

export const UndoIcon = () => (
  <Icon>
    <path d="M8 5L4 9l4 4" />
    <path d="M4 9h10a5.5 5.5 0 010 11h-3" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="M16 5l4 4-4 4" />
    <path d="M20 9H10a5.5 5.5 0 000 11h3" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" />
  </Icon>
);

export const ZoomInIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.3-4.3M8.5 11h5M11 8.5v5" />
  </Icon>
);

export const ZoomOutIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.3-4.3M8.5 11h5" />
  </Icon>
);

export const FitIcon = () => (
  <Icon>
    <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
    <rect x="8.5" y="9" width="7" height="6" rx="1" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" />
    <path d="M15.5 5.5V5a1.5 1.5 0 00-1.5-1.5H5A1.5 1.5 0 003.5 5v9A1.5 1.5 0 005 15.5h.5" />
  </Icon>
);

export const CopyTextIcon = () => (
  <Icon>
    <path d="M5 6.5V5h11v1.5M10.5 5v11M8.5 16h4" />
    <path d="M14.5 13.5h5M14.5 17h5M14.5 20.5h3.5" />
  </Icon>
);

export const ExportIcon = () => (
  <Icon>
    <path d="M12 15V3.5M7.5 8L12 3.5 16.5 8" />
    <path d="M4 14v4.5a2 2 0 002 2h12a2 2 0 002-2V14" />
  </Icon>
);

export const PinIcon = () => (
  <Icon>
    <path d="M9 3.5h6l-1 6 3.5 3.5v1.5h-11V13L10 9.5z" />
    <path d="M12 14.5V21" />
  </Icon>
);

export const BackdropIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <rect x="7.5" y="8.5" width="9" height="7" rx="1.5" />
  </Icon>
);

export const FillIcon = () => (
  <Icon>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <rect x="7" y="8" width="10" height="8" rx="1" fill="currentColor" fillOpacity="0.45" stroke="none" />
  </Icon>
);

export const TextBackgroundIcon = () => (
  <Icon>
    <rect x="3" y="6" width="18" height="12" rx="6" />
    <path d="M9.5 10.5v-1h5v1M12 9.5v5.5" />
  </Icon>
);

export const CropResetIcon = () => (
  <Icon>
    <path d="M7 2.5V17h14.5M2.5 7H17v4" />
    <path d="M15 14l5 5M20 14l-5 5" />
  </Icon>
);

export const RotateLeftIcon = () => (
  <Icon>
    <path d="M4 4v5h5" />
    <path d="M4.5 9A8 8 0 1112 20" />
  </Icon>
);

export const RotateRightIcon = () => (
  <Icon>
    <path d="M20 4v5h-5" />
    <path d="M19.5 9A8 8 0 1012 20" />
  </Icon>
);

export const FlipHorizontalIcon = () => (
  <Icon>
    <path d="M12 3v18" strokeDasharray="2 2.5" />
    <path d="M9 6L3 18h6zM15 6l6 12h-6z" />
  </Icon>
);

export const FlipVerticalIcon = () => (
  <Icon>
    <path d="M3 12h18" strokeDasharray="2 2.5" />
    <path d="M6 9L18 3v6zM6 15l12 6v-6z" />
  </Icon>
);

export const ResizeIcon = () => (
  <Icon>
    <rect x="3" y="9" width="12" height="12" rx="2" />
    <path d="M13 3h8v8M21 3l-8 8" />
  </Icon>
);
