import { create } from "zustand";

export type OrgView = "tree" | "list";

type UiState = {
  view: OrgView;
  /** True when the page is opened via a `?v=` share URL — editing is disabled. */
  viewOnly: boolean;
  /** Label shown in the viewer header for the loaded shared version. */
  sharedVersionLabel: string | null;
  /** Operation-history drawer open state. Defaults closed; shown via TopBar button. */
  showLog: boolean;
  /** User management modal open state. */
  showUsers: boolean;
  setView: (v: OrgView) => void;
  setViewOnly: (b: boolean) => void;
  setSharedVersionLabel: (label: string | null) => void;
  setShowLog: (b: boolean) => void;
  setShowUsers: (b: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  view: "tree",
  viewOnly: false,
  sharedVersionLabel: null,
  showLog: false,
  showUsers: false,
  setView: (view) => set({ view }),
  setViewOnly: (viewOnly) => set({ viewOnly }),
  setSharedVersionLabel: (sharedVersionLabel) => set({ sharedVersionLabel }),
  setShowLog: (showLog) => set({ showLog }),
  setShowUsers: (showUsers) => set({ showUsers }),
}));
