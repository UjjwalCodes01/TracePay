import type { LicenseTerms } from '@tracepay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bell, FileUp, Plus, Sparkles, Upload, Wand2 } from 'lucide-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DEFAULT_TERMS, TermsEditor, TermsSummary, type Extraction } from '../components/Terms';
import { Badge, Button, buttonClass, Card, Empty, ErrorNote, Hash, PageHeader, Spinner, statusLabel } from '../components/ui';
import { api, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

interface Grant {
  id: string;
  version: number;
  status: 'requested' | 'offered' | 'approved' | 'declined' | 'withdrawn' | 'revoked' | 'superseded' | 'draft';
  terms: LicenseTerms | null;
  termsHash: string | null;
  requestMessage: string | null;
  closedReason: string | null;
  updatedAt: string;
  licensee: { id: string; name: string; email: string };
}

interface MyAsset {
  id: string;
  title: string;
  kind: string;
  description: string;
  archivedAt: string | null;
  createdAt: string;
  versions: Array<{ id: string; version: number; sha256: string; createdAt: string; _count: { chunks: number } }>;
  licenses: Grant[];
}

const KINDS = [
  { value: 'dataset', label: 'Dataset' },
  { value: 'research_notes', label: 'Research notes' },
  { value: 'expert_brief', label: 'Expert brief' },
  { value: 'api_feed', label: 'Data feed' },
];

const STATUS_TEXT: Record<Grant['status'], { text: (g: Grant) => string; tone: 'pass' | 'warn' | 'block' | 'neutral' | 'info' }> = {
  requested: { text: (g) => `${g.licensee.name} asked for a license`, tone: 'info' },
  offered: { text: (g) => `Waiting for ${g.licensee.name} to accept`, tone: 'warn' },
  approved: { text: () => 'Active', tone: 'pass' },
  declined: { text: (g) => `Declined${g.closedReason ? `: ${g.closedReason}` : ''}`, tone: 'neutral' },
  withdrawn: { text: () => 'You withdrew this offer', tone: 'neutral' },
  revoked: { text: () => 'Revoked by you', tone: 'block' },
  superseded: { text: () => 'Replaced by newer terms', tone: 'neutral' },
  draft: { text: () => 'Draft', tone: 'neutral' },
};

/** Latest grant per publisher. */
function latestPerPublisher(grants: Grant[]): Grant[] {
  const seen = new Map<string, Grant>();
  for (const g of grants) if (!seen.has(g.licensee.id)) seen.set(g.licensee.id, g);
  return [...seen.values()];
}

/**
 * Each publisher relationship as it stands: the license in force (a newer offer that
 * was declined or withdrawn doesn't end it), plus a newer offer next to it, if any.
 * Open requests are shown separately, at the top of the page.
 */
function relationships(grants: Grant[]): Array<{ current: Grant; newer: Grant | null }> {
  const byPublisher = new Map<string, Grant[]>();
  for (const g of grants) byPublisher.set(g.licensee.id, [...(byPublisher.get(g.licensee.id) ?? []), g]);
  const out: Array<{ current: Grant; newer: Grant | null }> = [];
  for (const list of byPublisher.values()) {
    const latest = list[0]!; // newest version first (API order)
    const active = list.find((g) => g.status === 'approved');
    if (active) out.push({ current: active, newer: latest !== active && ['offered', 'declined', 'withdrawn'].includes(latest.status) ? latest : null });
    else if (latest.status !== 'requested') out.push({ current: latest, newer: null });
  }
  return out;
}

export function MySourcesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-assets'], queryFn: () => api<{ assets: MyAsset[] }>('/contributor/assets') });
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api<{ user: { paypalEmail: string | null } }>('/me/profile') });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => post(`/contributor/assets/${id}/archive`, { archived }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-assets'] }),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'withdraw' | 'revoke' | 'decline-request' }) => post(`/licenses/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-assets'] }),
  });

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const assets = q.data.assets;
  // One action at a time on a given license or source: no double clicks.
  const busy = (id: string) => act.isPending && act.variables?.id === id;
  const requests = assets.flatMap((a) => latestPerPublisher(a.licenses).filter((g) => g.status === 'requested').map((g) => ({ asset: a, grant: g })));

  return (
    <>
      <PageHeader
        title="My sources"
        subtitle="The data and research you license to report publishers. You decide the terms; you’re paid automatically every time a report that uses your work sells."
        action={
          <Link to="/sources/new" className={buttonClass()}>
            <Plus className="size-4" /> Add a source
          </Link>
        }
      />

      {profile.data && !profile.data.user.paypalEmail && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <span>
            <strong>Add your PayPal email to get paid.</strong> Until you do, publishers can’t sell reports that use your sources.
          </span>
          <Link to="/profile" className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg bg-amber-900 px-3 font-medium text-white">
            Add PayPal email
          </Link>
        </div>
      )}
      {requests.length > 0 && (
        <div className="mb-6 space-y-2">
          {requests.map(({ asset, grant }) => (
            <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-recorded/30 bg-recorded-soft px-5 py-4">
              <div className="flex items-start gap-3">
                <Bell className="mt-0.5 size-5 text-recorded" />
                <div>
                  <div className="font-medium">
                    {grant.licensee.name} wants to license “{asset.title}”
                  </div>
                  {grant.requestMessage && <p className="text-sm text-slate-700">“{grant.requestMessage}”</p>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to={`/sources/${asset.id}/offer?to=${encodeURIComponent(grant.licensee.email)}`} className={buttonClass({ size: 'sm' })}>
                  Set your terms
                </Link>
                <Button size="sm" variant="secondary" loading={busy(grant.id)} disabled={act.isPending} onClick={() => act.mutate({ id: grant.id, action: 'decline-request' })}>
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ErrorNote error={act.error ?? archive.error} />

      {assets.length === 0 ? (
        <Empty>
          You haven’t added any sources yet. <Link to="/sources/new" className="font-medium text-ink underline">Add your first one</Link> — a dataset, research notes or an expert brief.
        </Empty>
      ) : (
        <div className="space-y-4">
          {assets.map((a) => {
            const v = a.versions[0];
            const rels = relationships(a.licenses);
            return (
              <Card
                key={a.id}
                title={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">{a.title}</span>
                    <Badge>{KINDS.find((k) => k.value === a.kind)?.label ?? statusLabel(a.kind)}</Badge>
                    {a.archivedAt && <Badge tone="neutral">Hidden from marketplace</Badge>}
                    <span className="text-xs font-normal text-muted">
                      {v ? `version ${v.version} · ${v._count.chunks} ${v._count.chunks === 1 ? 'passage' : 'passages'}` : 'no content yet'}
                    </span>
                  </span>
                }
                action={
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={archive.isPending && archive.variables?.id === a.id}
                      disabled={archive.isPending}
                      onClick={() => archive.mutate({ id: a.id, archived: !a.archivedAt })}
                    >
                      {a.archivedAt ? 'Show in marketplace' : 'Hide from marketplace'}
                    </Button>
                    <Link to={`/sources/${a.id}/version`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                      <Upload className="size-3.5" /> New version
                    </Link>
                    <Link to={`/sources/${a.id}/offer`} className={buttonClass({ size: 'sm' })}>
                      Offer a license
                    </Link>
                  </div>
                }
              >
                <p className="text-sm text-muted">{a.description}</p>
                {rels.length === 0 ? (
                  <p className="mt-4 text-sm text-muted">Not licensed to anyone yet.</p>
                ) : (
                  <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
                    {rels.map(({ current: g, newer }) => {
                      const s = STATUS_TEXT[g.status] ?? { text: () => statusLabel(g.status), tone: 'neutral' as const };
                      return (
                        <li key={g.id} className="grid min-w-0 grid-cols-1 gap-3 p-4 md:grid-cols-[1fr_1.4fr_auto] md:items-start">
                          <div className="min-w-0">
                            <div className="font-medium">{g.licensee.name}</div>
                            <Badge tone={s.tone}>{s.text(g)}</Badge>
                            <div className="mt-1 text-xs text-muted">Terms version {g.version} · {timeAgo(g.updatedAt)}</div>
                            {newer && (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                                <span className="text-muted">Newer terms (version {newer.version}):</span>
                                <Badge tone={STATUS_TEXT[newer.status]?.tone ?? 'neutral'}>{STATUS_TEXT[newer.status]?.text(newer) ?? statusLabel(newer.status)}</Badge>
                                {newer.status === 'offered' && (
                                  <Button size="sm" variant="ghost" loading={busy(newer.id)} disabled={act.isPending} onClick={() => act.mutate({ id: newer.id, action: 'withdraw' })}>
                                    Withdraw
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0">{g.terms && <TermsSummary terms={g.terms} compact />}</div>
                          <div className="flex flex-wrap gap-2 md:flex-col">
                            {g.status === 'offered' && (
                              <Button size="sm" variant="secondary" loading={busy(g.id)} disabled={act.isPending} onClick={() => act.mutate({ id: g.id, action: 'withdraw' })}>
                                Withdraw offer
                              </Button>
                            )}
                            {g.status === 'approved' && (
                              <>
                                <Link to={`/sources/${a.id}/offer?to=${encodeURIComponent(g.licensee.email)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                                  Propose new terms
                                </Link>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  loading={busy(g.id)}
                                  disabled={act.isPending}
                                  onClick={() =>
                                    confirm(`Revoke ${g.licensee.name}'s license? They won't be able to use this source in new reports. Reports already sold still pay you under the old terms.`) &&
                                    act.mutate({ id: g.id, action: 'revoke' })
                                  }
                                >
                                  Revoke
                                </Button>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {v && (
                  <details className="mt-3 text-xs text-muted">
                    <summary className="cursor-pointer select-none hover:text-ink">Technical details</summary>
                    <p className="mt-2">
                      Fingerprint of version {v.version} <Hash value={v.sha256} n={16} /> — every report records exactly which version of this source it used.
                    </p>
                  </details>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

const input = 'w-full min-w-0 rounded-lg border border-line px-3 text-sm focus:border-ink focus:outline-none disabled:bg-slate-50 disabled:text-muted';

function readTextFile(e: ChangeEvent<HTMLInputElement>, onText: (t: string) => void, onError: (m: string) => void) {
  const file = e.target.files?.[0];
  // Cleared at once, so choosing the same file again (say, after fixing it) still fires a change.
  e.target.value = '';
  if (!file) return;
  if (!/\.(txt|md|markdown|csv)$/i.test(file.name)) return onError('Upload a .txt, .md or .csv file.');
  if (file.size > 400_000) return onError('That file is too large (max 400 KB of text).');
  const reader = new FileReader();
  reader.onload = () => onText(String(reader.result ?? ''));
  reader.onerror = () => onError('Could not read that file.');
  reader.readAsText(file);
}

export function NewSourcePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: '', kind: 'dataset', description: '', content: '' });
  const [fileError, setFileError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => post<{ assetId: string }>('/contributor/assets', form),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['my-assets'] });
      navigate(`/sources/${r.assetId}/offer`);
    },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/sources" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> My sources
      </Link>
      <PageHeader title="Add a source" subtitle="Publishers see the name and description. The content itself stays private and is only used in reports by publishers you license." />
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Name</span>
            <input className={`${input} h-10`} required minLength={3} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Cloud Spend Tracker, Autumn 2026" />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">What kind of source is it?</span>
            <select className={`${input} h-10`} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Short description</span>
            <textarea className={`${input} min-h-20 py-2`} required minLength={10} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What it covers, in one or two sentences." />
          </label>
          <div className="space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">Content</span>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-brand hover:underline">
                <FileUp className="size-4" /> Upload a text file
                <input type="file" accept=".txt,.md,.markdown,.csv,text/plain,text/markdown" className="hidden" onChange={(e) => readTextFile(e, (t) => { setFileError(null); setForm((f) => ({ ...f, content: t })); }, setFileError)} />
              </label>
            </div>
            <textarea className={`${input} min-h-64 py-2 font-mono text-xs`} required value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Paste your data, notes or findings. Separate sections with a blank line." />
            <div className="flex justify-between text-xs text-muted">
              <span>{fileError ?? 'Each paragraph becomes a passage that reports can cite.'}</span>
              <span>{form.content.length.toLocaleString()} / 200,000</span>
            </div>
          </div>
          <ErrorNote error={m.error} />
          <Button className="w-full" loading={m.isPending}>
            Add source and set license terms
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function NewVersionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [content, setContent] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => post(`/contributor/assets/${id}/versions`, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-assets'] });
      navigate('/sources');
    },
  });
  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/sources" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> My sources
      </Link>
      <PageHeader title="Upload a new version" subtitle="The previous version is kept unchanged, so reports already built still point at exactly what they used." />
      <Card>
        <label className="mb-2 inline-flex cursor-pointer items-center gap-1.5 text-sm text-brand hover:underline">
          <FileUp className="size-4" /> Upload a text file
          <input type="file" accept=".txt,.md,.markdown,.csv,text/plain" className="hidden" onChange={(e) => readTextFile(e, (t) => { setFileError(null); setContent(t); }, setFileError)} />
        </label>
        <textarea className={`${input} min-h-64 py-2 font-mono text-xs`} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste the updated content." />
        {fileError && <p className="mt-1 text-xs text-block">{fileError}</p>}
        <ErrorNote error={m.error} />
        <Button className="mt-4 w-full" loading={m.isPending} disabled={!content.trim()} onClick={() => m.mutate()}>
          Save new version
        </Button>
      </Card>
    </div>
  );
}

export function OfferLicensePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { config } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const assets = useQuery({ queryKey: ['my-assets'], queryFn: () => api<{ assets: MyAsset[] }>('/contributor/assets') });
  const asset = assets.data?.assets.find((a) => a.id === id);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState(params.get('to') ?? '');
  const [text, setText] = useState('');
  const [terms, setTerms] = useState<LicenseTerms>(DEFAULT_TERMS(today));
  const [draft, setDraft] = useState<Extraction | null>(null);
  const [seededFrom, setSeededFrom] = useState<string | null>(null);

  // Proposing new terms to an existing licensee starts from what they have today — once per license,
  // so a background refresh never overwrites terms you've started editing.
  useEffect(() => {
    const current = asset?.licenses.find((g) => g.licensee.email === email && g.status === 'approved');
    if (current?.terms && !draft && seededFrom !== current.id) {
      setTerms(current.terms);
      setSeededFrom(current.id);
    }
  }, [asset, email, draft, seededFrom]);

  const extract = useMutation({
    mutationFn: () => post<Extraction>('/licenses/extract', { text }),
    onSuccess: (r) => {
      setDraft(r);
      setTerms(r.terms);
      setStep(3);
    },
  });
  const send = useMutation({
    mutationFn: () =>
      post(`/contributor/assets/${id}/offers`, {
        licenseeEmail: email,
        terms,
        origin: draft ? (draft.source === 'vertex' ? 'ai_draft' : 'rules_draft') : 'manual',
        sourceText: text || null,
        extraction: draft ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-assets'] });
      navigate('/sources');
    },
  });

  if (assets.error) return <ErrorNote error={assets.error} />;
  if (!assets.data) return <Spinner />;
  if (!asset) return <ErrorNote error={new Error('Source not found. It may have been removed; go back to My sources.')} />;

  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/sources" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> My sources
      </Link>
      <PageHeader title={`License “${asset.title}”`} subtitle="Nothing is binding until the publisher accepts these exact terms." />

      <ol className="mb-6 grid grid-cols-3 gap-2 text-xs">
        {['Who is it for?', 'Your license document', 'Review the terms'].map((label, i) => (
          <li key={label} className={`rounded-lg border px-3 py-2 ${step === i + 1 ? 'border-ink font-medium' : step > i + 1 ? 'border-green-200 bg-green-50 text-verified' : 'border-line text-muted'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Publisher’s account email</span>
            <input className={`${input} h-10`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="studio@example.com" />
            {config?.demoMode && <span className="text-xs text-muted">Demo publisher: studio@atlas-research.example</span>}
          </label>
          <Button className="mt-4" disabled={!/^\S+@\S+\.\S+$/.test(email)} onClick={() => setStep(2)}>
            Continue
          </Button>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <p className="mb-3 text-sm text-muted">Paste your license or contract. We’ll read it and fill in the terms for you — you review every one before anything is sent.</p>
          <textarea className={`${input} min-h-48 py-2`} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. The publisher may use the dataset in reports sold worldwide until 31 Dec 2027. The original data may not be shared. The contributor receives 20% of each sale." />
          <ErrorNote error={extract.error} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button loading={extract.isPending} disabled={text.trim().length < 20} onClick={() => extract.mutate()}>
              {config?.vertexReady ? <Sparkles className="size-4" /> : <Wand2 className="size-4" />}
              Read it and fill in the terms
            </Button>
            <Button variant="secondary" onClick={() => setStep(3)}>
              Skip — fill in manually
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-4">
          {draft && (
            <div className="rounded-xl border border-line bg-white p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2 font-medium">
                {draft.source === 'vertex' ? <Badge tone="ai">Drafted by Gemini</Badge> : <Badge tone="warn">Drafted automatically (rule-based)</Badge>}
                Every field below is yours to change.
              </div>
              {draft.warnings.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-contract">
                  {draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <TermsEditor terms={terms} onChange={setTerms} evidence={draft?.evidence} />
          <Card title="What the publisher will see">
            <TermsSummary terms={terms} />
          </Card>
          <ErrorNote error={send.error} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button loading={send.isPending} onClick={() => send.mutate()}>
              Send offer to {email}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the PayPal email is for, depending on who you are. */
const PAYPAL_HELP: Record<string, string> = {
  contributor: 'Your share of every sale and AI answer is sent here with PayPal. Without it, publishers can’t include your sources in reports they sell.',
  publisher: 'Only contributors are paid at this address. Your sales are paid into the PayPal business account TracePay is connected to, so you can leave this empty.',
  buyer: 'You don’t need this to buy: you pay with your own PayPal account at checkout. This email is only used to send money to contributors.',
};

export function ProfilePage() {
  const qc = useQueryClient();
  const { authMethod } = useSession();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api<{ user: { name: string; email: string; role: string; paypalEmail: string | null } }>('/me/profile') });
  const [form, setForm] = useState<{ name: string; paypalEmail: string; currentPassword: string } | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm({ name: q.data.user.name, paypalEmail: q.data.user.paypalEmail ?? '', currentPassword: '' });
  }, [q.data, form]);
  const isDemo = authMethod === 'demo';
  // Changing where money goes needs the password: a stolen session alone can't redirect payouts.
  const payeeChanges = !!form && !!q.data && (form.paypalEmail.trim().toLowerCase() || null) !== (q.data.user.paypalEmail ?? null);
  const m = useMutation({
    mutationFn: () =>
      api('/me', {
        method: 'PATCH',
        body: { name: form!.name, paypalEmail: form!.paypalEmail.trim() || null, ...(payeeChanges ? { currentPassword: form!.currentPassword } : {}) },
      }),
    onSuccess: () => {
      setForm((f) => (f ? { ...f, currentPassword: '' } : f));
      qc.invalidateQueries();
    },
  });
  if (q.isLoading || !form) return q.error ? <ErrorNote error={q.error} /> : <Spinner />;
  return (
    <div className="max-w-xl">
      <PageHeader title="Profile" subtitle={q.data!.user.email} />
      <Card>
        {isDemo && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">This is a shared demo profile, so it can’t be changed. Sign up for your own account to edit yours.</p>}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <fieldset disabled={isDemo} className="space-y-4">
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <input className={`${input} h-10`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            {/* Only contributors are paid at this address; others see it only if they set one before. */}
            {(q.data!.user.role === 'contributor' || q.data!.user.paypalEmail) && (
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">PayPal email for receiving payments</span>
                <input className={`${input} h-10`} type="email" value={form.paypalEmail} onChange={(e) => setForm({ ...form, paypalEmail: e.target.value })} placeholder="you@example.com" />
                <span className="text-xs text-muted">{PAYPAL_HELP[q.data!.user.role] ?? PAYPAL_HELP.contributor}</span>
              </label>
            )}
            {q.data!.user.role !== 'contributor' && !q.data!.user.paypalEmail && (
              <p className="text-sm text-muted">{PAYPAL_HELP[q.data!.user.role] ?? ''}</p>
            )}
            {payeeChanges && (
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Your password, to change where payments go</span>
                <input className={`${input} h-10`} type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
              </label>
            )}
          </fieldset>
          <ErrorNote error={m.error} />
          {m.isSuccess && <p className="text-sm text-pass" role="status">Saved.</p>}
          {!isDemo && <Button loading={m.isPending}>Save</Button>}
        </form>
      </Card>
      {authMethod === 'session' && <ChangePassword />}
      <YourData canDelete={authMethod === 'session'} />
    </div>
  );
}

/** Download everything TracePay holds about you, or delete the account. */
function YourData({ canDelete }: { canDelete: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const download = useMutation({
    mutationFn: () => api<unknown>('/me/export'),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: 'tracepay-my-data.json' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
  const remove = useMutation({
    mutationFn: () => post('/me/delete', { currentPassword: password, confirm: typed }),
    onSuccess: () => window.location.assign('/login'),
  });
  return (
    <Card title="Your data" className="mt-6">
      <p className="mb-3 text-sm text-muted">Download a copy of everything TracePay holds about you: profile, sources, licenses, purchases, earnings, questions and credit history.</p>
      <Button variant="secondary" loading={download.isPending} onClick={() => download.mutate()}>
        Download my data
      </Button>
      <ErrorNote error={download.error} />
      {canDelete && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="text-sm text-muted">
            Deleting removes your name, emails, PayPal address, password, sessions, API keys and the questions you asked. Sales and payouts you were part of stay on record,
            without your details, because accounting requires them. It can’t be undone, and isn’t possible while you still have credit or are owed royalties.
          </p>
          {!confirming ? (
            <Button variant="ghost" className="mt-3 text-block" onClick={() => setConfirming(true)}>
              Delete my account…
            </Button>
          ) : (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                remove.mutate();
              }}
            >
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Your password</span>
                <input className={`${input} h-10`} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Type DELETE to confirm</span>
                <input className={`${input} h-10`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </label>
              <ErrorNote error={remove.error} />
              <div className="flex gap-2">
                <Button className="bg-block hover:bg-block/90" disabled={typed !== 'DELETE' || !password} loading={remove.isPending}>
                  Delete my account
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}

function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const m = useMutation({
    mutationFn: () => post('/auth/password', form),
    onSuccess: () => setForm({ currentPassword: '', newPassword: '' }),
  });
  return (
    <Card title="Change password" className="mt-6">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Current password</span>
          <input className={`${input} h-10`} type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
        </label>
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">New password</span>
          <input className={`${input} h-10`} type="password" autoComplete="new-password" required minLength={10} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
          <span className="text-xs text-muted">At least 10 characters. You’ll stay signed in here; other devices are signed out.</span>
        </label>
        <ErrorNote error={m.error} />
        {m.isSuccess && <p className="text-sm text-pass">Password changed.</p>}
        <Button loading={m.isPending}>Change password</Button>
      </form>
    </Card>
  );
}
