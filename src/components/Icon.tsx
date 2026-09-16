const PATHS = {
  home: 'M3 7.2 8 3.5l5 3.7V13H9.8V9.6H6.2V13H3z',
  target: 'M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.7h11M6.4 6.7v5.8',
  chart: 'M2.5 13.5V2.5M2.5 13.5h11M5 10.5l2.6-3.4 2.2 2 3-4.2',
  cube: 'M8 1.9 14 5v6L8 14.1 2 11V5zM2 5l6 3 6-3M8 8v6.1',
  arrow: 'M3 8h9.5M8.8 4.4 12.5 8l-3.7 3.6',
  chevronRight: 'M6 3.8 10.2 8 6 12.2',
  chevronDown: 'M3.8 6 8 10.2 12.2 6',
  check: 'M3 8.4 6.2 11.6 13 4.8',
  close: 'M4 4l8 8M12 4l-8 8',
  warn: 'M8 2.6 14.2 13.2H1.8zM8 6.4v3.2M8 11.3v.5',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 7.2v4M8 4.8v.4',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  reset: 'M3.2 8a4.8 4.8 0 1 0 1.6-3.6M3 2.6V5h2.4',
  search: 'M7.2 2.4a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zM10.8 10.8 14 14',
  flask: 'M6 2h4M6.6 2v3.6L3.4 12a1.2 1.2 0 0 0 1 1.9h7.2a1.2 1.2 0 0 0 1-1.9L9.4 5.6V2M4.8 9.4h6.4',
  columns: 'M2.5 3.5h4.2v9H2.5zM9.3 3.5h4.2v9H9.3z',
  sun: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.4v1.6M8 13v1.6M1.4 8H3M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1',
  moon: 'M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8z',
  monitor: 'M2.5 3.5h11v7h-11zM6 13h4M8 10.5V13',
  layers: 'M8 2 14 5.2 8 8.4 2 5.2zM2 8.4 8 11.6l6-3.2M2 11.2 8 14.4l6-3.2',
  spinner: 'M8 2.4V5M8 11v2.6M2.4 8H5M11 8h2.6',
  component: 'M8 3.2c3 0 5.4 1.1 5.4 2.4S11 8 8 8 2.6 6.9 2.6 5.6 5 3.2 8 3.2zM2.6 5.6v4.8C2.6 11.7 5 12.8 8 12.8s5.4-1.1 5.4-2.4V5.6M6.1 8.4v4.1M9.9 8.4v4.1',
  sparkle: 'M8 2.2l1.3 3.3L12.6 6.8 9.3 8.1 8 11.4 6.7 8.1 3.4 6.8l3.3-1.3zM12.4 10.4l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z',
  // A compass rose, not a sparkle or a speech bubble. This thing is an
  // instrument that points at things in the data; the mark should say so.
  copilot: 'M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9zM10.9 5.1 9.3 9.3 5.1 10.9 6.7 6.7z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.45}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
