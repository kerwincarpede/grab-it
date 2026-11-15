import { useId } from "react";

/** The Grab-it mark: a viewfinder around a gradient dot. */
function Logo({ size = 30 }: { size?: number }) {
  const gradient = `logo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4c8dff" />
          <stop offset=".55" stopColor="#8b6bff" />
          <stop offset="1" stopColor="#ff6bb3" />
        </linearGradient>
      </defs>
      <rect className="logo-tile" x="1" y="1" width="28" height="28" rx="8" />
      <path
        className="logo-frame"
        d="M8 12V9.5A1.5 1.5 0 0 1 9.5 8H12M18 8h2.5A1.5 1.5 0 0 1 22 9.5V12M22 18v2.5a1.5 1.5 0 0 1-1.5 1.5H18M12 22H9.5A1.5 1.5 0 0 1 8 20.5V18"
        fill="none"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="15" cy="15" r="3.4" fill={`url(#${gradient})`} />
    </svg>
  );
}

export default Logo;
