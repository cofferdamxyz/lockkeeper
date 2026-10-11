"use client";

import type { ReactNode } from "react";

/** Inline markdown an agent writes: **bold** and `code`. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={k++} className="font-semibold text-foreground">{tok.slice(2, -2)}</strong>);
    else out.push(<code key={k++} className="mono text-[0.92em] rounded bg-muted/60 px-1 py-px">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Enough markdown for an agent's summary: paragraphs, bullet lists, headings, bold, code. */
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  let k = 0;
  const flush = () => {
    if (para.length) {
      blocks.push(<p key={k++}>{inline(para.join(" "))}</p>);
      para = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={k++} className="list-disc pl-5 space-y-0.5">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (bullet) {
      if (para.length) flush();
      list.push(bullet[1]);
    } else if (heading) {
      flush();
      blocks.push(<p key={k++} className="font-semibold text-foreground">{inline(heading[1])}</p>);
    } else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <div className={`space-y-2 leading-relaxed ${className}`}>{blocks}</div>;
}
