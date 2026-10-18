import { useQuery } from '@tanstack/react-query';
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Card, ErrorNote, EVIDENCE, EvidenceBadge, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import type { ProvEdge, ProvNode } from '../lib/types';

const COLUMNS: Array<{ kind: ProvNode['kind']; title: string }> = [
  { kind: 'source', title: 'Licensed source versions' },
  { kind: 'passage', title: 'Retrieved passages' },
  { kind: 'section', title: 'Report sections' },
  { kind: 'artifact', title: 'Artifact' },
  { kind: 'sale', title: 'PayPal sale' },
  { kind: 'settlement_line', title: 'Settlement lines' },
  { kind: 'payout', title: 'PayPal payouts' },
];
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
        {node.kind.replace('_', ' ')}
      </div>
      <div className="line-clamp-2 font-medium text-ink">{node.label}</div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-slate-300" />
    </div>
  );
}

const nodeTypes = { prov: ProvNodeView };

export function ProvenancePage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['provenance', id], queryFn: () => api<{ nodes: ProvNode[]; edges: ProvEdge[] }>(`/artifacts/${id}/provenance`) });
  const [selected, setSelected] = useState<string | null>(null);

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

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const sel = q.data!.nodes.find((n) => n.id === selected);

  return (
    <>
      <PageHeader
        title="Provenance Explorer"
        subtitle="From licensed source versions to the money they earned. Every element is labeled with what kind of evidence backs it — a model's claim is never shown as a verified fact."
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
        <span className="text-muted">· Click a node to trace it end to end</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="h-[640px] overflow-hidden rounded-xl border border-line bg-white">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            nodesDraggable={false}
            onNodeClick={(_, n) => setSelected((s) => (s === n.id ? null : n.id))}
            onPaneClick={() => setSelected(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#eef2f7" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <Card title={sel ? sel.label : 'Details'}>
          {!sel ? (
            <div className="space-y-3 text-sm text-muted">
              <p>Select a node to see the evidence behind it.</p>
              <ul className="space-y-2">
                {COLUMNS.map((c) => (
                  <li key={c.kind}>
                    <span className="font-medium text-ink">{c.title}</span> — {q.data!.nodes.filter((n) => n.kind === c.kind).length}
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
              <dl className="space-y-1.5">
                {Object.entries(sel.data)
                  .filter(([k, v]) => !['text', 'body'].includes(k) && v !== null && typeof v !== 'object')
                  .map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                      <dt className="text-muted">{k}</dt>
                      <dd className="mono break-all">{String(v)}</dd>
                    </div>
                  ))}
                {Object.entries(sel.data)
                  .filter(([, v]) => v !== null && typeof v === 'object')
                  .map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                      <dt className="text-muted">{k}</dt>
                      <dd className="mono break-all">{JSON.stringify(v)}</dd>
                    </div>
                  ))}
              </dl>
              <p className="text-xs text-muted">{connected.size > 1 ? 'Highlighted: everything this node depends on and everything that depends on it.' : ''}</p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
