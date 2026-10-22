import { useQuery } from '@tanstack/react-query';
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router';
import { describeFormula, type Economics } from '@tracepay/shared';
import { Card, ErrorNote, EVIDENCE, EvidenceBadge, PageHeader, Spinner, statusLabel } from '../components/ui';
import { api } from '../lib/api';
import { economicsLabel, formatMoney } from '../lib/format';
import { useSession } from '../lib/session';
import type { ProvEdge, ProvNode } from '../lib/types';

const COLUMNS: Array<{ kind: ProvNode['kind']; title: string; one: string }> = [
  { kind: 'source', title: 'Licensed sources', one: 'Source' },
  { kind: 'passage', title: 'Passages considered', one: 'Passage' },
  { kind: 'section', title: 'Report sections', one: 'Section' },
  { kind: 'artifact', title: 'The report', one: 'Report' },
  { kind: 'sale', title: 'PayPal sales', one: 'Sale' },
  { kind: 'settlement_line', title: 'Shares of each sale', one: 'Share of the sale' },
  { kind: 'payout', title: 'PayPal payouts', one: 'Payout' },
];
const KIND_NAME = Object.fromEntries(COLUMNS.map((c) => [c.kind, c.one])) as Record<ProvNode['kind'], string>;

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? formatMoney(v) : null);

/** The item's name as people should read it, from its data. */
function displayLabel(n: ProvNode): string {
  if (n.kind === 'settlement_line') {
    const amount = money(n.data.amountCents);
    const who = n.data.lineKind === 'publisher_residual' ? 'Publisher keeps' : 'Contributor’s share';
    return amount ? `${who} ${amount}` : who;
  }
  if (n.kind === 'payout') {
    const status = str(n.data.status);
    return status ? `Payout: ${statusLabel(status)}` : 'Payout';
  }
  return n.label;
}

/** The facts behind an item, in plain words. Everything exact stays under Technical details. */
function plainFacts(n: ProvNode, names: Record<string, string>): Array<[string, string]> {
  const d = n.data;
  const facts: Array<[string, string | null]> = [];
  const status = str(d.status);
  switch (n.kind) {
    case 'artifact':
      facts.push(['Written by', d.fromFixture ? 'Without AI (no AI model configured)' : str(d.model)]);
      facts.push(['Price', money(d.priceCents)]);
      break;
    case 'source':
      facts.push(['Contributor', str(d.owner)]);
      facts.push(['Version', typeof d.version === 'number' ? String(d.version) : null]);
      facts.push(['Contributor’s share', d.economics ? economicsLabel(d.economics as Economics) : null]);
      facts.push(['Paid when', d.payableOn === 'cited_in_output' ? 'The report cites it' : d.payableOn === 'included_in_build' ? 'It’s used in the report' : null]);
      facts.push(['Cited in the report', d.cited ? 'Yes' : 'No']);
      break;
    case 'passage':
      facts.push(['Citation marker', str(d.handle)]);
      break;
    case 'sale':
      facts.push(['Status', status ? statusLabel(status) : null]);
      facts.push(['PayPal confirmed', money(d.capturedCents)]);
      break;
    case 'settlement_line':
      facts.push(['Paid to', names[str(d.recipientId) ?? ''] ?? null]);
      facts.push(['Amount', money(d.amountCents)]);
      facts.push(['Why', str(d.formula) ? describeFormula(str(d.formula)!) : null]);
      facts.push(['Note', str(d.note)]);
      break;
    case 'payout':
      facts.push(['Status', status ? statusLabel(status) : null]);
      break;
  }
  return facts.filter((f): f is [string, string] => f[1] !== null);
}

const COL_X = [0, 290, 600, 880, 1120, 1360, 1620];
const ROW_H = { source: 96, passage: 64, section: 64, artifact: 96, sale: 96, settlement_line: 72, payout: 72 } as const;

type FlowData = { node: ProvNode; dimmed: boolean; selected: boolean };

function ProvNodeView({ data }: NodeProps<Node<FlowData>>) {
  const { node, dimmed, selected } = data;
  const color = EVIDENCE[node.evidence].color;
  return (
    <div
      className={clsx('w-[240px] rounded-lg border bg-white px-3 py-2 text-xs shadow-sm transition', dimmed && 'opacity-25', selected && 'ring-2 ring-ink')}
      style={{ borderColor: color, borderLeftWidth: 4 }}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-slate-300" />
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color }}>
        {KIND_NAME[node.kind]}
      </div>
      <div className="line-clamp-2 font-medium text-ink">{displayLabel(node)}</div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-slate-300" />
    </div>
  );
}

const nodeTypes = { prov: ProvNodeView };

/** On load, frame the start of the story (sources → report) at a size people can read; pan or zoom out for the rest. */
const FIRST_VIEW: ReadonlyArray<ProvNode['kind']> = ['source', 'passage', 'section', 'artifact'];

function useWide(minPx: number) {
  const query = `(min-width: ${minPx}px)`;
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return wide;
}

export function ProvenancePage() {
  const { id } = useParams();
  const { users } = useSession();
  const names = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const q = useQuery({ queryKey: ['provenance', id], queryFn: () => api<{ nodes: ProvNode[]; edges: ProvEdge[] }>(`/artifacts/${id}/provenance`) });
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useWide(640);
  // On a phone the details sit below the list: bring them into view when an item is chosen.
  useEffect(() => {
    if (!wide && selected) document.getElementById('prov-details')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [wide, selected]);
  const toggle = (nodeId: string) => setSelected((s) => (s === nodeId ? null : nodeId));
  // Keyboard: React Flow makes each item focusable; Enter or Space opens its details, like a click.
  const onGraphKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nodeId = (e.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
    if (!nodeId) return;
    e.preventDefault();
    toggle(nodeId);
  };

  const { nodes, edges, connected } = useMemo(() => {
    const g = q.data;
    if (!g) return { nodes: [], edges: [], connected: new Set<string>() };

    // Everything upstream and downstream of the selected node.
    const connected = new Set<string>();
    if (selected) {
      const walk = (start: string, dir: 'up' | 'down') => {
        const stack = [start];
        while (stack.length) {
          const cur = stack.pop()!;
          for (const e of g.edges) {
            const next = dir === 'down' ? (e.source === cur ? e.target : null) : e.target === cur ? e.source : null;
            if (next && !connected.has(`${next}|${dir}`)) {
              connected.add(`${next}|${dir}`);
              connected.add(next);
              stack.push(next);
            }
          }
        }
      };
      connected.add(selected);
      walk(selected, 'up');
      walk(selected, 'down');
    }

    const counters = new Map<string, number>();
    const nodes: Node<FlowData>[] = g.nodes.map((n) => {
      const col = COLUMNS.findIndex((c) => c.kind === n.kind);
      const row = counters.get(n.kind) ?? 0;
      counters.set(n.kind, row + 1);
      return {
        id: n.id,
        type: 'prov',
        position: { x: COL_X[col] ?? 0, y: 40 + row * ROW_H[n.kind] },
        data: { node: n, dimmed: Boolean(selected) && !connected.has(n.id), selected: n.id === selected },
      };
    });
    const edges: Edge[] = g.edges.map((e) => {
      const on = !selected || (connected.has(e.source) && connected.has(e.target));
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.evidence === 'verified' && on,
        style: { stroke: EVIDENCE[e.evidence].color, strokeWidth: on ? 1.6 : 1, opacity: on ? 0.9 : 0.12 },
      };
    });
    return { nodes, edges, connected };
  }, [q.data, selected]);

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const graph = q.data;
  const sel = graph.nodes.find((n) => n.id === selected);
  const firstView = graph.nodes.filter((n) => FIRST_VIEW.includes(n.kind)).map((n) => ({ id: n.id }));

  return (
    <>
      <PageHeader
        title="Where this report came from"
        subtitle="From the licensed sources, through the passages the report used, to the money each one earned. Every item shows what backs it up: an AI’s claim is never shown as a confirmed fact."
        action={
          <Link to={`/reports/${id}`} className="text-sm font-medium text-brand hover:underline">
            ← Back to report
          </Link>
        }
      />
      <div className="mb-3 flex flex-wrap gap-4 text-xs">
        {Object.entries(EVIDENCE).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5" title={v.description}>
            <span className="inline-block h-2 w-5 rounded" style={{ background: v.color }} />
            {v.label}
          </span>
        ))}
        <span className="basis-full text-muted sm:basis-auto">{wide ? 'Click any item to follow it from start to finish; drag to see the rest.' : 'Tap any item to see what backs it up.'}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {wide ? (
          <div className="h-[640px] overflow-hidden rounded-xl border border-line bg-white" onKeyDown={onGraphKey}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ nodes: firstView.length ? firstView : undefined, minZoom: 0.65, maxZoom: 1, padding: 0.08 }}
              minZoom={0.2}
              nodesDraggable={false}
              onNodeClick={(_, n) => toggle(n.id)}
              onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} color="#eef2f7" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        ) : (
          <StepList nodes={graph.nodes} selected={selected} connected={connected} onSelect={toggle} />
        )}
        <div id="prov-details" className="min-w-0 scroll-mt-4">
        <Card title={sel ? displayLabel(sel) : 'Details'}>
          {!sel ? (
            <div className="space-y-3 text-sm text-muted">
              <p>Choose an item to see what backs it up.</p>
              <ul className="space-y-2">
                {COLUMNS.filter((c) => c.kind !== 'artifact').map((c) => (
                  <li key={c.kind}>
                    <span className="font-medium text-ink">{c.title}:</span> {graph.nodes.filter((n) => n.kind === c.kind).length}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <EvidenceBadge evidence={sel.evidence} />
              <p className="text-xs text-muted">{EVIDENCE[sel.evidence].description}</p>
              {typeof sel.data.text === 'string' && <blockquote className="border-l-2 border-line pl-3 text-slate-700">{sel.data.text}</blockquote>}
              {typeof sel.data.body === 'string' && <p className="text-slate-700">{sel.data.body}</p>}
              <p className="text-xs font-medium text-muted">{KIND_NAME[sel.kind]}</p>
              <dl className="space-y-1.5">
                {plainFacts(sel, names).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                    <dt className="text-muted">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <details className="rounded-lg border border-line bg-slate-50">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-ink">Technical details</summary>
                <dl className="space-y-1.5 border-t border-line px-3 py-3 text-xs">
                  {Object.entries(sel.data)
                    .filter(([k, v]) => !['text', 'body'].includes(k) && v !== null && v !== undefined)
                    .map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[7rem_1fr] gap-2">
                        <dt className="text-muted">{k}</dt>
                        <dd className="mono break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                      </div>
                    ))}
                </dl>
              </details>
              <p className="text-xs text-muted">{connected.size > 1 ? 'Highlighted: everything this item came from and everything that followed from it.' : ''}</p>
            </div>
          )}
        </Card>
        </div>
      </div>
    </>
  );
}

/** Phones: the same trail as a list of steps, from the sources down to the payouts. */
function StepList({ nodes, selected, connected, onSelect }: { nodes: ProvNode[]; selected: string | null; connected: Set<string>; onSelect: (id: string) => void }) {
  return (
    <ol className="space-y-3">
      {COLUMNS.map((c) => {
        const items = nodes.filter((n) => n.kind === c.kind);
        if (!items.length) return null;
        return (
          <li key={c.kind} className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-sm font-semibold">
              {c.title} <span className="font-normal text-muted">({items.length})</span>
            </h2>
            <ul className="mt-2 space-y-1.5">
              {items.map((n) => {
                const color = EVIDENCE[n.evidence].color;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(n.id)}
                      aria-pressed={n.id === selected}
                      className={clsx(
                        'w-full rounded-lg border bg-white px-3 py-2 text-left text-sm transition',
                        n.id === selected && 'ring-2 ring-ink',
                        selected && !connected.has(n.id) && 'opacity-40',
                      )}
                      style={{ borderColor: color, borderLeftWidth: 4 }}
                    >
                      <span className="line-clamp-2">{displayLabel(n)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}
