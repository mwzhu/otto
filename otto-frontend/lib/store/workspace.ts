"use client";

import { create } from "zustand";

export type WorkspaceTab = "summary" | "steps" | "impact" | "insights" | "risk";

type WorkspaceState = {
  activeTab: WorkspaceTab;
  setActiveTab: (t: WorkspaceTab) => void;
  evidenceOpen: boolean;
  evidenceClaimId: string | null;
  openEvidence: (claimId: string) => void;
  closeEvidence: () => void;
  refineOpen: boolean;
  toggleRefine: (next?: boolean) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  layoutMode: "authored" | "vertical" | "swimlane-role" | "swimlane-system" | "exception";
  setLayoutMode: (m: WorkspaceState["layoutMode"]) => void;
  collapsedToL3: boolean;
  toggleL3: () => void;
  correctedNodeIds: string[];
  addCorrection: (nodeId: string) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeTab: "summary",
  setActiveTab: (t) => set({ activeTab: t }),
  evidenceOpen: false,
  evidenceClaimId: null,
  openEvidence: (claimId) => set({ evidenceOpen: true, evidenceClaimId: claimId }),
  closeEvidence: () => set({ evidenceOpen: false, evidenceClaimId: null }),
  refineOpen: false,
  toggleRefine: (next) =>
    set((s) => ({ refineOpen: next ?? !s.refineOpen })),
  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  layoutMode: "authored",
  setLayoutMode: (m) => set({ layoutMode: m }),
  collapsedToL3: false,
  toggleL3: () => set((s) => ({ collapsedToL3: !s.collapsedToL3 })),
  correctedNodeIds: [],
  addCorrection: (nodeId) =>
    set((s) => ({
      correctedNodeIds: s.correctedNodeIds.includes(nodeId)
        ? s.correctedNodeIds
        : [...s.correctedNodeIds, nodeId],
    })),
}));
