import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api } from '../lib/api';
import type { ArtifactFull, ProvNode } from '../lib/types';
import { Badge } from './ui';

/** Renders report sections with [Cn] markers as clickable citation chips. */
export function ReportBody({ artifact }: { artifact: ArtifactFull }) {
  const graph = useQuery({
    queryKey: ['provenance', artifact.id],
    queryFn: () => api<{ nodes: ProvNode[] }>(`/artifacts/${artifact.id}/provenance`),
  });
  const [open, setOpen] = useState<{ sectionKey: string; handle: string } | null>(null);

  const passageByChunk = new Map(
    (graph.data?.nodes ?? []).filter((n) => n.kind === 'passage').map((n) => [String(n.data.chunkId), String(n.data.text)]),
  );
  const sourceTitle = new Map(artifact.content.sources.map((s) => [s.assetVersionId, s.assetTitle]));
  const citation = (sectionKey: string, handle: string) => artifact.citationReport.citations.find((c) => c.sectionKey === sectionKey && c.handle === handle);

  return (
    <article className="space-y-6">
      {artifact.content.sections.map((s) => (
        <section key={s.key}>
          <h3 className="mb-1.5 font-semibold">{s.heading}</h3>
          <p className="leading-relaxed text-slate-700">
            {s.body.split(/(\[C\d+\])/g).map((part, i) => {
              const m = /^\[(C\d+)\]$/.exec(part);
              if (!m) return <Fragment key={i}>{part}</Fragment>;
              const handle = m[1]!;
              const active = open?.sectionKey === s.key && open.handle === handle;
              return (
                <button
                  key={i}
                  onClick={() => setOpen(active ? null : { sectionKey: s.key, handle })}
                  className={`mx-0.5 rounded px-1 align-baseline text-xs font-medium ${active ? 'bg-ai text-white' : 'bg-ai-soft text-ai hover:bg-violet-200'}`}
                  title="Show the passage this cites"
                  aria-label={`Citation ${handle}: show the passage`}
                  aria-expanded={active}
                >
                  {handle}
                </button>
              );
            })}
          </p>
          {open?.sectionKey === s.key &&
            (() => {
              const c = citation(s.key, open.handle);
              if (!c) return null;
              return (
                <blockquote className="mt-2 rounded-lg border border-ai/30 bg-ai-soft/50 px-4 py-3 text-sm">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ai">
                    <Badge tone="ai">{open.handle}</Badge>
                    <span className="font-medium">{sourceTitle.get(c.assetVersionId)}</span>
                  </div>
                  {passageByChunk.get(c.chunkId) ?? 'Loading passage…'}
                </blockquote>
              );
            })()}
        </section>
      ))}

      {artifact.content.credits.length > 0 && (
        <section className="border-t border-line pt-4 text-sm">
          <h3 className="mb-1 font-semibold">Credits</h3>
          <ul className="list-disc pl-5 text-slate-700">
            {artifact.content.credits.map((c) => (
              <li key={c.assetVersionId}>{c.text}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-t border-line pt-4 text-sm">
        <h3 className="mb-2 font-semibold">Licensed sources</h3>
        <ul className="space-y-1">
          {artifact.content.sources.map((s) => (
            <li key={s.assetVersionId} className="flex flex-wrap items-center gap-2">
              <span>{s.assetTitle}</span>
              <span className="text-xs text-muted">version {s.version}</span>
              {s.cited ? <Badge tone="pass">Cited</Badge> : <Badge>Read, but not cited</Badge>}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
