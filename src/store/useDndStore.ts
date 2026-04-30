import { create } from "zustand";

export type DraggingMeta = {
  id: string;
  kind: "dept" | "person";
  label: string;
  /** Source: "tree" if it was already placed, "tray" if from the inbox */
  source: "tree" | "tray";
};

type DndState = {
  dragging: DraggingMeta | null;
  hoverTargetLabel: string | null;
  hoverTargetState: "valid" | "invalid" | "none";
  startDrag: (meta: DraggingMeta) => void;
  setHover: (label: string | null, state?: "valid" | "invalid" | "none") => void;
  endDrag: () => void;
};

export const useDndStore = create<DndState>((set) => ({
  dragging: null,
  hoverTargetLabel: null,
  hoverTargetState: "none",

  startDrag: (meta) => set({ dragging: meta, hoverTargetLabel: null, hoverTargetState: "none" }),
  setHover: (label, state = "valid") =>
    set({ hoverTargetLabel: label, hoverTargetState: label ? state : "none" }),
  endDrag: () => set({ dragging: null, hoverTargetLabel: null, hoverTargetState: "none" }),
}));
