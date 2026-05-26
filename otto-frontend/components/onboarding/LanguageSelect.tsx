"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

const LANGS = [
  { code: "en", flag: "🇬🇧", label: "English" },
  { code: "es", flag: "🇪🇸", label: "Español" },
  { code: "de", flag: "🇩🇪", label: "Deutsch" },
  { code: "fr", flag: "🇫🇷", label: "Français" },
  { code: "pt", flag: "🇵🇹", label: "Português" },
  { code: "zh", flag: "🇨🇳", label: "中文" },
  { code: "ja", flag: "🇯🇵", label: "日本語" },
];

export function LanguageSelect({
  value = "en",
  onChange,
}: {
  value?: string;
  onChange?: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(value);
  const current = LANGS.find((l) => l.code === selected) ?? LANGS[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex w-56 items-center justify-between gap-2 rounded-md border border-subtle bg-surface px-3 py-2 text-[13px] text-ink shadow-card transition hover:border-ink-muted"
      >
        <span className="inline-flex items-center gap-2">
          <span>{current.flag}</span>
          <span>{current.label}</span>
        </span>
        <span className="text-ink-muted">▾</span>
      </button>
      {open && (
        <ul className="absolute z-10 mt-1 w-56 overflow-hidden rounded-md border border-subtle bg-surface shadow-pop">
          {LANGS.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                onClick={() => {
                  setSelected(l.code);
                  onChange?.(l.code);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition hover:bg-muted",
                  l.code === selected && "bg-muted",
                )}
              >
                <span>{l.flag}</span>
                <span className="text-ink">{l.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
