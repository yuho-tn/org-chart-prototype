export type ColorSlot = {
  /** Header background (the dark colored bar at top of a card) */
  header: string;
  /** Header text color */
  headerText: string;
  /** Leader strip background (lighter than header) */
  leaderStrip: string;
  /** Leader strip text */
  leaderText: string;
  /** Card body background (member chip area) */
  body: string;
  /** Card border */
  border: string;
};

export const PALETTE: ColorSlot[] = [
  // 0: blue
  { header: "#1e40af", headerText: "#fff", leaderStrip: "#dbeafe", leaderText: "#1e3a8a", body: "#eff6ff", border: "#3b82f6" },
  // 1: pink
  { header: "#be185d", headerText: "#fff", leaderStrip: "#fbcfe8", leaderText: "#9d174d", body: "#fdf2f8", border: "#ec4899" },
  // 2: orange
  { header: "#c2410c", headerText: "#fff", leaderStrip: "#fed7aa", leaderText: "#7c2d12", body: "#fff7ed", border: "#f97316" },
  // 3: green
  { header: "#15803d", headerText: "#fff", leaderStrip: "#bbf7d0", leaderText: "#14532d", body: "#f0fdf4", border: "#22c55e" },
  // 4: purple
  { header: "#7e22ce", headerText: "#fff", leaderStrip: "#e9d5ff", leaderText: "#581c87", body: "#faf5ff", border: "#a855f7" },
  // 5: teal
  { header: "#0f766e", headerText: "#fff", leaderStrip: "#99f6e4", leaderText: "#134e4a", body: "#f0fdfa", border: "#14b8a6" },
  // 6: rose
  { header: "#be123c", headerText: "#fff", leaderStrip: "#fecdd3", leaderText: "#881337", body: "#fff1f2", border: "#f43f5e" },
  // 7: indigo
  { header: "#4338ca", headerText: "#fff", leaderStrip: "#c7d2fe", leaderText: "#312e81", body: "#eef2ff", border: "#6366f1" },
  // 8: cyan
  { header: "#0e7490", headerText: "#fff", leaderStrip: "#cffafe", leaderText: "#155e75", body: "#ecfeff", border: "#06b6d4" },
  // 9: lime
  { header: "#4d7c0f", headerText: "#fff", leaderStrip: "#ecfccb", leaderText: "#365314", body: "#f7fee7", border: "#84cc16" },
  // 10: amber
  { header: "#b45309", headerText: "#fff", leaderStrip: "#fef3c7", leaderText: "#78350f", body: "#fffbeb", border: "#f59e0b" },
  // 11: emerald
  { header: "#047857", headerText: "#fff", leaderStrip: "#d1fae5", leaderText: "#064e3b", body: "#ecfdf5", border: "#10b981" },
  // 12: violet
  { header: "#6d28d9", headerText: "#fff", leaderStrip: "#ddd6fe", leaderText: "#4c1d95", body: "#f5f3ff", border: "#8b5cf6" },
  // 13: fuchsia
  { header: "#a21caf", headerText: "#fff", leaderStrip: "#fae8ff", leaderText: "#701a75", body: "#fdf4ff", border: "#d946ef" },
  // 14: sky
  { header: "#0369a1", headerText: "#fff", leaderStrip: "#e0f2fe", leaderText: "#0c4a6e", body: "#f0f9ff", border: "#0ea5e9" },
  // 15: slate
  { header: "#334155", headerText: "#fff", leaderStrip: "#e2e8f0", leaderText: "#1e293b", body: "#f8fafc", border: "#64748b" },
];

export const ROOT_COLOR: ColorSlot = {
  header: "#0b1220",
  headerText: "#fff",
  leaderStrip: "#1f2937",
  leaderText: "#f9fafb",
  body: "#111827",
  border: "#0b1220",
};

/** Distinct gold/amber theme for the Exe (executive) department, between ROOT and DIV. */
export const EXE_COLOR: ColorSlot = {
  header: "#a16207",
  headerText: "#fffbeb",
  leaderStrip: "#fef3c7",
  leaderText: "#713f12",
  body: "#fffbeb",
  border: "#eab308",
};

/** Resolve a color slot from the palette index, defaulting to slot 0. */
export function colorAt(idx: number | undefined | null): ColorSlot {
  if (idx === undefined || idx === null) return PALETTE[0];
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}
