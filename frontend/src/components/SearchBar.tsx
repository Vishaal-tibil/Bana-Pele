import { useState } from "react";

export default function SearchBar({
  queryPlaceholder,
  regionPlaceholder,
  disabled,
  onSearch,
}: {
  queryPlaceholder: string;
  regionPlaceholder: string;
  disabled: boolean;
  onSearch: (query: string, region: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query.trim(), region.trim());
      }}
      className="flex flex-wrap items-stretch gap-2 rounded-xl border border-border bg-panel p-2 shadow-sm"
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`What are you looking for? e.g. "${queryPlaceholder}"`}
        disabled={disabled}
        className="min-w-[220px] flex-1 rounded-md border border-border-soft bg-bg px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-cyan-border focus:outline-none disabled:opacity-50"
      />
      <input
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        placeholder={`Where? e.g. "${regionPlaceholder}"`}
        disabled={disabled}
        className="w-48 rounded-md border border-border-soft bg-bg px-3 py-2 text-sm text-text placeholder:text-text-faint focus:border-cyan-border focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md border border-amber-border bg-amber px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
      >
        {disabled ? "Searching…" : "Search"}
      </button>
    </form>
  );
}
