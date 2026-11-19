export const Icon = {
  plus: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  trash: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
    </svg>
  ),
  gear: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </svg>
  ),
  book: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
      <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z" />
    </svg>
  ),
  table: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10M15 10v10" />
    </svg>
  ),
  comment: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M20.5 11.5a7.5 7.5 0 0 1-7.5 7.5H9L4 21v-4.2A7.5 7.5 0 1 1 20.5 11.5Z" />
    </svg>
  ),
  send: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m4 12 16-8-5 16-3-6-8-2Z" />
    </svg>
  ),
  stop: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  close: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  ),
  doc: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </svg>
  ),
  search: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  ),
  quote: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M9 7H5v5h4c0 3-1 5-4 6M19 7h-4v5h4c0 3-1 5-4 6" />
    </svg>
  ),
  chevronUp: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m6 15 6-6 6 6" />
    </svg>
  ),
  chevronDown: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  chevronLeft: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  ),
  chevronRight: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  copy: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </svg>
  ),
  download: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
    </svg>
  ),
  note: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M5 4h14v12l-5 5H5V4Z" />
      <path d="M14 21v-5h5M8 9h8M8 13h5" />
    </svg>
  ),
  highlighter: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m14 5 5 5-8 8H6v-5l8-8Z" />
      <path d="M4 21h8" />
    </svg>
  ),
  menu: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  panel: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  ),
  keyboard: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  ),
  check: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="m5 12 5 5 9-10" />
    </svg>
  ),
  external: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  pencil: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17l-1 3Z" />
      <path d="m14.5 7.5 3 3" />
    </svg>
  ),
  undo: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  ),
  more: (p) => (
    <svg viewBox="0 0 24 24" {...p}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.4" />
    </svg>
  ),
}
