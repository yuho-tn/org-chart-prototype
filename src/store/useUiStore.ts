import { create } from "zustand";

export type OrgView = "tree" | "list";

type UiState = {
  view: OrgView;
  /** True when the page is opened via a `?v=` share URL — editing is disabled. */
  viewOnly: boolean;
  /** Label shown in the viewer header for the loaded shared version. */
  sharedVersionLabel: string | null;
  setView: (v: OrgView) => void;
  setViewOnly: (b: boolean) => void;
  setSharedVersionLabel: (label: string | null) => void;
};

export const useUiStore = create<UiState>((set) => ({
  view: "tree",
  viewOnly: false,
  sharedVersionLabel: null,
  setView: (view) => set({ view }),
  setViewOnly: (viewOnly) => set({ viewOnly }),
  setSharedVersionLabel: (sharedVersionLabel) => set({ sharedVersionLabel }),
}));
