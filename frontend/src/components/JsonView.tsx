type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function Indent({ depth }: { depth: number }) {
  return <span style={{ paddingLeft: depth * 14 }} />;
}

function Value({ value, depth }: { value: Json; depth: number }) {
  if (value === null) {
    return <span className="text-text-faint">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-cyan">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-amber">{value}</span>;
  }
  if (typeof value === "string") {
    return <span className="text-green">"{value}"</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-dim">[]</span>;
    return (
      <span>
        {"["}
        {value.map((item, i) => (
          <div key={i}>
            <Indent depth={depth + 1} />
            <Value value={item} depth={depth + 1} />
            {i < value.length - 1 ? "," : ""}
          </div>
        ))}
        <Indent depth={depth} />
        {"]"}
      </span>
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-text-dim">{"{}"}</span>;
  return (
    <span>
      {"{"}
      {entries.map(([k, v], i) => (
        <div key={k}>
          <Indent depth={depth + 1} />
          <span className="text-cyan/90">"{k}"</span>
          <span className="text-text-dim">: </span>
          <Value value={v} depth={depth + 1} />
          {i < entries.length - 1 ? "," : ""}
        </div>
      ))}
      <Indent depth={depth} />
      {"}"}
    </span>
  );
}

export default function JsonView({ data }: { data: unknown }) {
  if (data === undefined) {
    return <span className="text-text-faint italic">nothing yet</span>;
  }
  return (
    <pre className="font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words">
      <Value value={data as Json} depth={0} />
    </pre>
  );
}
