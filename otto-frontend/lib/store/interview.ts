"use client";

import { create } from "zustand";

export type InterviewTurn = {
  id: string;
  speaker: "agent" | "user";
  text: string;
  ts: number;
};

type InterviewState = {
  turns: InterviewTurn[];
  isMuted: boolean;
  isPaused: boolean;
  status: "idle" | "running" | "ended";
  pushTurn: (turn: InterviewTurn) => void;
  toggleMute: () => void;
  togglePause: () => void;
  end: () => void;
  reset: () => void;
};

export const useInterviewStore = create<InterviewState>((set) => ({
  turns: [],
  isMuted: false,
  isPaused: false,
  status: "idle",
  pushTurn: (turn) => set((s) => ({ turns: [...s.turns, turn], status: "running" })),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  togglePause: () => set((s) => ({ isPaused: !s.isPaused })),
  end: () => set({ status: "ended" }),
  reset: () => set({ turns: [], isMuted: false, isPaused: false, status: "idle" }),
}));
