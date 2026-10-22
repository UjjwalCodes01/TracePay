import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bot, Check, ChevronDown, ChevronRight, Copy, KeyRound, Plus, RotateCw, Send, Webhook } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSession } from '../lib/session';
import { Link } from 'react-router';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, del, patch, post } from '../lib/api';
import { timeAgo } from '../lib/format';

/**
 * Developers: connect TracePay to your own software. Everything here goes
 * through the same public API (/api/v1) that integrations use.
 */

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  access: 'read_only' | 'read_write';
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  enabled_events: string[];
  status: 'enabled' | 'disabled';
  disabled_reason: string | null;
  consecutive_failures: number;
  previous_secret_expires_at: string | null;
  created: string;
}

interface Delivery {
  id: string;
  event_id: string;
  event_type: string;
  status: 'pending' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created: string;
}

type List<T> = { data: T[] };

export function DevelopersPage() {
  const { user } = useSession();
  if (user?.role === 'buyer') {
    return (
      <>
        <PageHeader
          title="Connect an AI agent"
          subtitle="Let your own AI assistant (for example Claude Desktop) find and buy licensed reports for you. It can search and prepare a purchase; you approve every payment in PayPal."
          action={
            <Link to="/developers/api" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-medium hover:bg-slate-50">
              <BookOpen className="size-4" /> API reference
            </Link>
          }
        />
        <div className="space-y-6">
          <McpCard />
          <div id="api-keys" className="scroll-mt-4">
            <ApiKeysCard />
          </div>
        </div>
      </>
    );
  }
  if (user && user.role !== 'publisher' && user.role !== 'admin') {
    return (
      <>
        <PageHeader title="Developers" />
        <Empty>API keys and webhooks are for publisher accounts, which build and sell reports. Your account doesn’t need them.</Empty>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Developers"
        subtitle="Connect TracePay to your own software. An API key lets your systems do what you do here; webhooks let TracePay tell your systems the moment something happens — a sale, a payout, a license change."
        action={
          <Link to="/developers/api" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 text-sm font-medium hover:bg-slate-50">
            <BookOpen className="size-4" /> API reference
          </Link>
        }
      />
      <div className="space-y-6">
        <ApiKeysCard />
        <WebhooksCard />
      </div>
    </>
  );
}

// ---- AI agents (MCP) ---------------------------------------------------------------------

const REPO_URL = 'https://github.com/UjjwalCodes01/TracePay';

const mcpConfig = (libraryId: string | null) => `{
  "mcpServers": {
    "tracepay": {
      "command": "node",
      "args": ["<folder you cloned into>/TracePay/packages/mcp/src/server.ts"],
      "env": {
        "TRACEPAY_API_KEY": "tp_… (your key)",
        "TRACEPAY_MAX_PRICE_CENTS": "5000",
        "TRACEPAY_MAX_ANSWER_CENTS": "50",
        "TRACEPAY_MAX_SESSION_CENTS": "200"${libraryId ? `,
        "TRACEPAY_LIBRARY_ID": "${libraryId}"` : ''}
      }
    }
  }
}`;

function McpCard() {
  const [copied, setCopied] = useState(false);
  // Which library answers your agent's questions: shown by name, set by its id.
  const libraries = useQuery({ queryKey: ['libraries'], queryFn: () => api<{ libraries: Array<{ id: string; name: string }> }>('/libraries') });
  const list = libraries.data?.libraries ?? [];
  const config = mcpConfig(list[0]?.id ?? null);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Bot className="size-4" /> Use TracePay from your AI assistant</span>}>
      <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
        <li>
          <a href="#api-keys" className="font-medium text-brand hover:underline">Create an API key</a> (further down this page) and keep it somewhere safe: it’s shown once.
        </li>
        <li>
          Download TracePay from{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">GitHub</a>{' '}
          (<code className="break-all rounded bg-slate-100 px-1">git clone {REPO_URL}</code>, needs Node 24) and run <code className="rounded bg-slate-100 px-1">npm install</code> in that folder.
        </li>
        <li>Add this to your assistant’s MCP settings (in Claude Desktop: Settings → Developer → Edit config). Put in your key, and the folder you cloned TracePay into:</li>
      </ol>
      <div className="relative">
        <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">{config}</pre>
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-2 top-2"
          onClick={() => void navigator.clipboard?.writeText(config).then(() => setCopied(true), () => undefined)}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {list.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          <code className="break-all rounded bg-slate-100 px-1">TRACEPAY_LIBRARY_ID</code> picks the library that answers questions:{' '}
          {list.length === 1 ? (
            <>
              <strong className="text-ink">{list[0]!.name}</strong> (its id is filled in above).
            </>
          ) : (
            <>
              {list.map((l, i) => (
                <span key={l.id}>
                  {i > 0 && (i === list.length - 1 ? ' or ' : ', ')}
                  <strong className="text-ink">{l.name}</strong> (<code className="mono break-all">{l.id}</code>)
                </span>
              ))}
              .
            </>
          )}
        </p>
      )}
      <p className="mt-4 text-sm text-muted">
        Then ask it something like “Ask the TracePay library how fast AI coding assistant spend is growing” — each answer pays the contributors it relies on from your credit — or “Find me a report on developer tools under $25.” It can search, check that every source is licensed, and prepare the checkout — then it gives
        you a PayPal link to approve. It can never pay on its own, and it won’t start a purchase over the price cap you set (in cents).
      </p>
    </Card>
  );
}

// ---- secrets shown once ------------------------------------------------------------------

function ShownOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked: the value is selectable below.
    }
  };
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="text-sm font-semibold text-amber-900">{label}</div>
      <p className="mt-1 text-sm text-amber-900">Copy it now and keep it somewhere safe. For your security it won’t be shown again.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="mono break-all rounded bg-white px-2 py-1 text-sm">{value}</code>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          I’ve saved it
        </Button>
      </div>
    </div>
  );
}

// ---- API keys --------------------------------------------------------------------------------

const EXPIRY = [
  { label: 'Never', days: null },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
] as const;

function ApiKeysCard() {
  const qc = useQueryClient();
  const { authMethod } = useSession();
  const isDemo = authMethod === 'demo';
  const q = useQuery({ queryKey: ['api-keys'], queryFn: () => api<{ keys: ApiKeyRow[] }>('/auth/api-keys') });
  const [form, setForm] = useState<{ name: string; access: 'read_write' | 'read_only'; expires: number | null } | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (f: NonNullable<typeof form>) => post<{ key: string }>('/auth/api-keys', { name: f.name, access: f.access, expiresInDays: f.expires }),
    onSuccess: (r) => {
      setCreated(r.key);
      setForm(null);
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/auth/api-keys/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form) create.mutate(form);
  };

  const active = (q.data?.keys ?? []).filter((k) => !k.revokedAt);
  const expired = (k: ApiKeyRow) => k.expiresAt !== null && new Date(k.expiresAt) <= new Date();

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4" /> API keys</span>}
      action={!form && <Button size="sm" onClick={() => setForm({ name: '', access: 'read_write', expires: 90 })}><Plus className="size-4" /> New key</Button>}
    >
      <p className="mb-4 text-sm text-muted">
        A key is like a password for your software. Give each system its own key, so you can switch one off without affecting the others.
      </p>
      {isDemo && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You’re exploring the shared demo account, so keys you create here stop working after 24 hours (and when the demo is reset). Sign up for your own account to keep them.
        </p>
      )}
      {created && <div className="mb-4"><ShownOnce label="Your new API key" value={created} onDone={() => setCreated(null)} /></div>}
      {form && (
        <form onSubmit={submit} className="mb-4 space-y-3 rounded-lg border border-line p-4">
          <label className="block text-sm">
            <span className="font-medium">Name</span>
            <input
              autoFocus
              required
              maxLength={80}
              placeholder="e.g. Reporting dashboard"
              className="mt-1 block h-10 w-full rounded-lg border border-line px-3"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <fieldset className="text-sm">
            <legend className="font-medium">What may it do?</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {(
                [
                  ['read_write', 'Everything (read and make changes)'],
                  ['read_only', 'Look only (read, never change)'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="inline-flex items-center gap-2">
                  <input type="radio" name="access" checked={form.access === value} onChange={() => setForm({ ...form, access: value })} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="font-medium">Stops working after</span>
            <select
              className="mt-1 block h-10 rounded-lg border border-line px-3"
              value={form.expires ?? ''}
              onChange={(e) => setForm({ ...form, expires: e.target.value ? Number(e.target.value) : null })}
            >
              {EXPIRY.map((o) => (
                <option key={o.label} value={o.days ?? ''}>{o.label}</option>
              ))}
            </select>
          </label>
          <ErrorNote error={create.error} />
          <div className="flex gap-2">
            <Button type="submit" loading={create.isPending}>Create key</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </form>
      )}
      <ErrorNote error={q.error ?? revoke.error} />
      {q.isLoading ? (
        <Spinner />
      ) : active.length === 0 ? (
        <Empty>No API keys yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {active.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="min-w-48 flex-1">
                <div className="font-medium">{k.name}</div>
                <div className="mono text-xs text-muted">{k.prefix}…</div>
              </div>
              <Badge tone={k.access === 'read_only' ? 'info' : 'neutral'}>{k.access === 'read_only' ? 'Look only' : 'Read & change'}</Badge>
              {expired(k) ? (
                <Badge tone="block">Expired</Badge>
              ) : (
                <span className="text-xs text-muted">{k.expiresAt ? `Expires ${new Date(k.expiresAt).toLocaleDateString()}` : 'Never expires'}</span>
              )}
              <span className="text-xs text-muted">{k.lastUsedAt ? `Used ${timeAgo(k.lastUsedAt)}` : 'Never used'}</span>
              <Button
                size="sm"
                variant="danger"
                loading={revoke.isPending && revoke.variables === k.id}
                onClick={() => confirm(`Switch off “${k.name}”? Software using it will stop working immediately.`) && revoke.mutate(k.id)}
              >
                Switch off
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- webhooks --------------------------------------------------------------------------------

const GROUPS: { label: string; prefix: string }[] = [
  { label: 'Sales', prefix: 'sale.' },
  { label: 'Settlements', prefix: 'settlement.' },
  { label: 'Payouts', prefix: 'payout_batch.' },
  { label: 'Reports', prefix: 'report.' },
  { label: 'Builds', prefix: 'build.' },
  { label: 'Licenses', prefix: 'license.' },
  { label: 'Research assistant', prefix: 'agent_run.' },
  { label: 'Checks with PayPal', prefix: 'reconciliation.' },
  { label: 'Answers (pay-per-citation)', prefix: 'answer.' },
  { label: 'Answer royalties', prefix: 'royalty_payout.' },
];

const DELIVERY_TONE = { succeeded: 'pass', failed: 'block', pending: 'warn', skipped: 'neutral' } as const;
const DELIVERY_LABEL = { succeeded: 'Delivered', failed: 'Gave up', pending: 'Retrying', skipped: 'Not sent' } as const;

function WebhooksCard() {
  const qc = useQueryClient();
  const endpoints = useQuery({ queryKey: ['webhook-endpoints'], queryFn: () => api<List<Endpoint>>('/v1/webhook_endpoints') });
  const types = useQuery({ queryKey: ['event-types'], queryFn: () => api<List<{ type: string; description: string }>>('/v1/event_types'), staleTime: Infinity });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhook-endpoints'] });

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Webhook className="size-4" /> Webhooks</span>}
      action={!adding && <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add endpoint</Button>}
    >
      <p className="mb-4 text-sm text-muted">
        TracePay sends a signed message to your URL whenever something you choose happens. If your system is down, it keeps retrying for about a day.
      </p>
      {secret && <div className="mb-4"><ShownOnce label={secret.label} value={secret.value} onDone={() => setSecret(null)} /></div>}
      {adding && (
        <AddEndpoint
          types={types.data?.data ?? []}
          onCancel={() => setAdding(false)}
          onCreated={(s) => {
            setAdding(false);
            setSecret({ label: 'Signing secret for your new endpoint', value: s });
            refresh();
          }}
        />
      )}
      <ErrorNote error={endpoints.error} />
      {endpoints.isLoading ? (
        <Spinner />
      ) : (endpoints.data?.data.length ?? 0) === 0 ? (
        !adding && <Empty>No endpoints yet. Add one to start receiving events.</Empty>
      ) : (
        <ul className="space-y-3">
          {(endpoints.data?.data ?? []).map((e) => (
            <EndpointRow key={e.id} endpoint={e} onSecret={(value) => setSecret({ label: 'New signing secret', value })} onChange={refresh} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddEndpoint({ types, onCreated, onCancel }: { types: { type: string; description: string }[]; onCreated: (secret: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('https://');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set(['sale.completed', 'settlement.created', 'payout_batch.updated']));
  const create = useMutation({
    mutationFn: () => post<{ secret: string }>('/v1/webhook_endpoints', { url: url.trim(), enabled_events: all ? ['*'] : [...picked] }),
    onSuccess: (r) => onCreated(r.secret),
  });
  const toggle = (t: string) => {
    const next = new Set(picked);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setPicked(next);
  };

  return (
    <form
      className="mb-4 space-y-3 rounded-lg border border-line p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <label className="block text-sm">
        <span className="font-medium">Your URL</span>
        <input autoFocus required type="url" className="mt-1 block h-10 w-full rounded-lg border border-line px-3" value={url} onChange={(e) => setUrl(e.target.value)} />
        <span className="mt-1 block text-xs text-muted">Must start with https:// and be reachable from the internet.</span>
      </label>
      <fieldset className="text-sm">
        <legend className="font-medium">Which events?</legend>
        <div className="mt-1 flex gap-4">
          <label className="inline-flex items-center gap-2"><input type="radio" checked={all} onChange={() => setAll(true)} /> Everything</label>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={!all} onChange={() => setAll(false)} /> Let me choose</label>
        </div>
        {!all && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {/* Groups with no event types (yet) aren't shown. */}
            {GROUPS.filter((g) => types.some((t) => t.type.startsWith(g.prefix))).map((g) => (
              <div key={g.prefix}>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</div>
                {types.filter((t) => t.type.startsWith(g.prefix)).map((t) => (
                  <label key={t.type} className="mt-1 flex items-start gap-2" title={t.description}>
                    <input type="checkbox" className="mt-1" checked={picked.has(t.type)} onChange={() => toggle(t.type)} />
                    <span>
                      <span className="mono text-xs">{t.type}</span>
                      <span className="block text-xs text-muted">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </fieldset>
      <ErrorNote error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" loading={create.isPending} disabled={!all && picked.size === 0}>Add endpoint</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function EndpointRow({ endpoint: e, onSecret, onChange }: { endpoint: Endpoint; onSecret: (s: string) => void; onChange: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lastTest, setLastTest] = useState<Delivery | null>(null);
  const deliveries = useQuery({
    queryKey: ['webhook-deliveries', e.id],
    queryFn: () => api<List<Delivery>>(`/v1/webhook_endpoints/${e.id}/deliveries?limit=15`),
    enabled: open,
  });
  const after = () => {
    onChange();
    qc.invalidateQueries({ queryKey: ['webhook-deliveries', e.id] });
  };
  const test = useMutation({ mutationFn: () => post<Delivery>(`/v1/webhook_endpoints/${e.id}/test`), onSuccess: (d) => (setLastTest(d), after()) });
  const toggle = useMutation({ mutationFn: () => patch(`/v1/webhook_endpoints/${e.id}`, { status: e.status === 'enabled' ? 'disabled' : 'enabled' }), onSuccess: after });
  const rotate = useMutation({ mutationFn: () => post<{ secret: string }>(`/v1/webhook_endpoints/${e.id}/rotate_secret`, { previous_secret_valid_hours: 24 }), onSuccess: (r) => (onSecret(r.secret), after()) });
  // Refresh either way: if another tab already deleted it, the list must catch up.
  const remove = useMutation({ mutationFn: () => del(`/v1/webhook_endpoints/${e.id}`), onSettled: onChange });
  const retry = useMutation({ mutationFn: (id: string) => post(`/v1/webhook_deliveries/${id}/retry`), onSuccess: after });

  return (
    <li className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button type="button" className="text-muted" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide deliveries' : 'Show deliveries'}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="mono truncate text-sm font-medium">{e.url}</div>
          <div className="text-xs text-muted">
            {e.enabled_events[0] === '*' ? 'All events' : `${e.enabled_events.length} event type${e.enabled_events.length === 1 ? '' : 's'}`}
            {e.consecutive_failures > 0 && e.status === 'enabled' && ` · last ${e.consecutive_failures} deliveries failed`}
          </div>
        </div>
        <Badge tone={e.status === 'enabled' ? 'pass' : 'block'}>{e.status === 'enabled' ? 'On' : 'Paused'}</Badge>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={test.isPending} disabled={e.status !== 'enabled'} onClick={() => test.mutate()}>
            <Send className="size-4" /> Send test
          </Button>
          <Button size="sm" variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate()}>
            {e.status === 'enabled' ? 'Pause' : 'Turn on'}
          </Button>
          <Button size="sm" variant="ghost" loading={rotate.isPending} onClick={() => confirm('Create a new signing secret? The old one keeps working for 24 hours.') && rotate.mutate()}>
            <RotateCw className="size-4" /> New secret
          </Button>
          <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this endpoint? It will stop receiving events.') && remove.mutate()}>
            Delete
          </Button>
        </div>
      </div>
      {e.status === 'disabled' && e.disabled_reason && <p className="mx-4 mb-3 rounded bg-red-50 px-3 py-2 text-sm text-block">{e.disabled_reason}</p>}
      {lastTest && (
        <p className={`mx-4 mb-3 rounded px-3 py-2 text-sm ${lastTest.status === 'succeeded' ? 'bg-verified-soft text-verified' : 'bg-amber-50 text-amber-900'}`}>
          {lastTest.status === 'succeeded'
            ? `Test delivered: your endpoint answered ${lastTest.last_status_code}.`
            : `Test not accepted: ${lastTest.last_error ?? 'no answer'}. Fix your endpoint and send another test.`}
        </p>
      )}
      <ErrorNote error={test.error ?? toggle.error ?? rotate.error ?? remove.error ?? retry.error} />
      {open && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent deliveries</div>
          {deliveries.isLoading ? (
            <Spinner />
          ) : (deliveries.data?.data.length ?? 0) === 0 ? (
            <p className="text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {(deliveries.data?.data ?? []).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Badge tone={DELIVERY_TONE[d.status]}>{DELIVERY_LABEL[d.status]}</Badge>
                  <span className="mono text-xs">{d.event_type}</span>
                  <span className="text-xs text-muted">{timeAgo(d.created)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted" title={d.last_error ?? undefined}>
                    {d.last_status_code ? `Answered ${d.last_status_code}` : d.last_error ?? ''}
                    {d.attempts > 1 && ` · ${d.attempts} tries`}
                    {d.status === 'pending' && d.next_attempt_at && ` · next try ${new Date(d.next_attempt_at).toLocaleTimeString()}`}
                  </span>
                  {(d.status === 'failed' || d.status === 'skipped') && (
                    <Button size="sm" variant="ghost" disabled={e.status !== 'enabled'} loading={retry.isPending && retry.variables === d.id} onClick={() => retry.mutate(d.id)}>
                      Send again
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
