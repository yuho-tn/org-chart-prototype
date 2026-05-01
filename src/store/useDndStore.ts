import { create } from "zustand";

export type DraggingMeta = {
  id: string;
  kind: "dept" | "person";
  label: string;
  /** Source: "tree" if it was already placed, "tray" if from the inbox */
  source: "tree" | "tray";
};

export type PreviewMove = {
  /** id of the node being moved */
  sourceId: string;
  /** target parent id (or null for top-level) */
  targetParentId: string | null;
  /** position among same-kind siblings of targetParentId after the move */
  atIndex: number;
};

type DndState = {
  dragging: DraggingMeta | null;
  hoverTargetLabel: string | null;
  hoverTargetState: "valid" | "invalid" | "none";
  /** When set, Canvas re-renders nodes after applying this move so the user sees a live preview. */
  preview: PreviewMove | null;
  /** True while Alt/Option is held — drop will create a copy instead of moving. */
  copyMode: boolean;
  startDrag: (meta: DraggingMeta) => void;
  setHover: (label: string | null, state?: "valid" | "invalid" | "none") => void;
  setPreview: (preview: PreviewMove | null) => void;
  setCopyMode: (on: boolean) => void;
  endDrag: () => void;
};

export const useDndStore = create<DndState>((set) => ({
  dragging: null,
  hoverTargetLabel: null,
  hoverTargetState: "none",
  preview: null,
  copyMode: false,

  startDrag: (meta) =>
    set({
      dragging: meta,
      hoverTargetLabel: null,
      hoverTargetState: "none",
      preview: null,
    }),
  setHover: (label, state = "valid") =>
    set({ hoverTargetLabel: label, hoverTargetState: label ? state : "none" }),
  setPreview: (preview) => set({ preview }),
  setCopyMode: (on) => set({ copyMode: on }),
  endDrag: () =>
    set({
      dragging: null,
      hoverTargetLabel: null,
      hoverTargetState: "none",
      preview: null,
      copyMode: false,
    }),
}));
