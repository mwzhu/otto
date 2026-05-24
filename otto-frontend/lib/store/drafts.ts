"use client";

import { create } from "zustand";

type DraftsState = {
  approvedVersions: Record<string, number>;
  draftVersions: Record<string, number>;
  approve: (processId: string) => void;
  isApproved: (processId: string) => boolean;
};

export const useDraftsStore = create<DraftsState>((set, get) => ({
  approvedVersions: {},
  draftVersions: {},
  approve: (processId) =>
    set((s) => ({
      approvedVersions: {
        ...s.approvedVersions,
        [processId]: (s.draftVersions[processId] ?? 1),
      },
    })),
  isApproved: (processId) => Boolean(get().approvedVersions[processId]),
}));
