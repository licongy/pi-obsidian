const enabled = !!process.env.PI_OBSIDIAN_DEBUG;

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function debug(...args: unknown[]): void {
  if (!enabled) return;
  const line = args.map(fmt).join(" ");
  process.stderr.write("[pi-obsidian] " + line + "\n");
}
