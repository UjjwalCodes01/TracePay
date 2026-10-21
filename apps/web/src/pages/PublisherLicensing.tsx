import type { LicenseTerms } from '@tracepay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Search } from 'lucide-react';
import { useState } from 'react';
import { TermsSummary } from '../components/Terms';
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { timeAgo } from '../lib/format';

interface InboxItem {
  id: string;
  version: number;
  status: 'offered' | 'requested';
  terms: LicenseTerms | null;
  termsHash: string | null;
  requestMessage: string | null;
  sourceText: string | null;
  origin: 'manual' | 'ai_draft' | 'rules_draft';
  updatedAt: string;
  asset: { id: string; title: string; kind: string; owner: { name: string; canBePaid: boolean } };
  current: { version: number; terms: LicenseTerms } | null;
}

export function OffersPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['license-inbox'], queryFn: () => api<{ licenses: InboxItem[] }>('/licenses/inbox') });
  const decide = useMutation({
    mutationFn: ({ item, accept }: { item: InboxItem; accept: boolean }) =>
      accept ? post(`/licenses/${item.id}/accept`, { termsHash: item.termsHash }) : post(`/licenses/${item.id}/decline`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['license-inbox'] });
      qc.invalidateQueries({ queryKey: ['catalog'] });
      qc.invalidateQueries({ queryKey: ['marketplace'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const offers = q.data!.licenses.filter((l) => l.status === 'offered');
  const requests = q.data!.licenses.filter((l) => l.status === 'requested');

  return (
    <div className="space-y-4">
      <ErrorNote error={decide.error} />
      {offers.length === 0 ? (
        <Empty>No offers waiting. When a contributor offers you a license, it appears here for you to accept or decline.</Empty>
      ) : (
        offers.map((o) => (
          <Card
            key={o.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {o.asset.title}
                <span className="text-xs font-normal text-muted">from {o.asset.owner.name} · {timeAgo(o.updatedAt)}</span>
                {o.current && <Badge tone="warn">New terms for a source you already license</Badge>}
              </span>
            }
          >
            <div className={o.current ? 'grid gap-4 md:grid-cols-2' : ''}>
              {o.current && (
                <div className="rounded-lg border border-line p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">What you have today (v{o.current.version})</div>
                  <TermsSummary terms={o.current.terms} compact />
                </div>
              )}
              <div className={o.current ? 'rounded-lg border border-ink p-4' : ''}>
                {o.current && <div className="mb-2 text-xs font-semibold uppercase tracking-wide">Proposed (v{o.version})</div>}
                {o.terms && <TermsSummary terms={o.terms} />}
              </div>
            </div>
            {!o.asset.owner.canBePaid && (
              <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {o.asset.owner.name} hasn’t added a PayPal email yet. You can accept now, but reports using this source can’t be sold until they do.
              </p>
            )}
            {o.sourceText && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-muted">Read the original license text</summary>
                <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line pl-3 text-slate-700">{o.sourceText}</blockquote>
              </details>
            )}
            <p className="mt-4 text-xs text-muted">
              {o.current
                ? 'Your current license stays in force until you accept. Reports you already sold keep their original terms.'
                : 'Accepting makes these exact terms binding for reports you build from now on.'}
            </p>
            <div className="mt-3 flex gap-2">
              <Button loading={decide.isPending && decide.variables?.item.id === o.id && decide.variables.accept} disabled={decide.isPending} onClick={() => decide.mutate({ item: o, accept: true })}>
                Accept these terms
              </Button>
              <Button variant="secondary" loading={decide.isPending && decide.variables?.item.id === o.id && !decide.variables.accept} disabled={decide.isPending} onClick={() => decide.mutate({ item: o, accept: false })}>
                Decline
              </Button>
            </div>
          </Card>
        ))
      )}
      {requests.length > 0 && (
        <Card title="Your requests">
          <ul className="space-y-2 text-sm">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <Clock className="size-4 text-amber-600" /> Waiting for {r.asset.owner.name} to set terms for “{r.asset.title}”
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

interface Listing {
  assetId: string;
  title: string;
  kind: string;
  description: string;
  owner: { id: string; name: string };
  version: number;
  passages: number;
  /** The license in force if there is one, otherwise the newest. */
  myLicense: { id: string; status: string; version: number; terms: LicenseTerms | null } | null;
  /** A newer offer or request still open next to the license in force. */
  pendingLicense?: { id: string; status: string; version: number } | null;
}

const KIND_LABEL: Record<string, string> = { dataset: 'Dataset', research_notes: 'Research notes', expert_brief: 'Expert brief', api_feed: 'Data feed' };

export function FindSourcesPanel() {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const q = useQuery({ queryKey: ['marketplace'], queryFn: () => api<{ sources: Listing[] }>('/marketplace') });
  const request = useMutation({
    mutationFn: (assetId: string) => post(`/marketplace/${assetId}/request`, { message: null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace'] });
      qc.invalidateQueries({ queryKey: ['license-inbox'] });
    },
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const needle = query.trim().toLowerCase();
  const sources = q.data!.sources.filter((s) => !needle || `${s.title} ${s.description} ${s.owner.name}`.toLowerCase().includes(needle));

  const statusOf = (s: Listing) => {
    const st = s.myLicense?.status;
    const t = s.myLicense?.terms;
    if (st === 'approved' && t?.validUntil && t.validUntil < new Date().toISOString().slice(0, 10)) return <Badge tone="block">License expired</Badge>;
    if (st === 'approved' && t && !t.commercialUse) return <Badge tone="warn">Licensed for internal use only</Badge>;
    if (st === 'approved') return <Badge tone="pass"><CheckCircle2 className="size-3" /> Licensed for reports you sell</Badge>;
    if (st === 'offered') return <Badge tone="warn">Offer waiting for you</Badge>;
    if (st === 'requested') return <Badge tone="info">Requested</Badge>;
    if (st === 'revoked') return <Badge tone="block">Revoked</Badge>;
    return null;
  };

  return (
    <div className="space-y-4">
      <label className="flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-3">
        <Search className="size-4 text-muted" />
        <input aria-label="Search sources" className="w-full text-sm focus:outline-none" placeholder="Search sources by topic or contributor" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ErrorNote error={request.error} />
      {sources.length === 0 ? (
        <Empty>No sources match.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sources.map((s) => {
            const canRequest = !s.myLicense || ['declined', 'withdrawn', 'revoked', 'superseded'].includes(s.myLicense.status);
            return (
              <div key={s.assetId} className="flex flex-col rounded-xl border border-line bg-white p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold">{s.title}</div>
                  <div className="flex flex-col items-end gap-1">
                    {statusOf(s)}
                    {s.pendingLicense?.status === 'offered' && <Badge tone="warn">New terms offered</Badge>}
                    {s.pendingLicense?.status === 'requested' && <Badge tone="info">New terms requested</Badge>}
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {KIND_LABEL[s.kind] ?? s.kind} by {s.owner.name} · {s.passages} passages
                </div>
                <p className="mt-2 flex-1 text-sm text-slate-700">{s.description}</p>
                {canRequest && (
                  <Button size="sm" variant="secondary" className="mt-4 self-start" loading={request.isPending && request.variables === s.assetId} onClick={() => request.mutate(s.assetId)}>
                    Request a license
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
