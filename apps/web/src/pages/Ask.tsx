import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BadgeCheck, CircleSlash, FileSignature, MessageSquareQuote, ShieldCheck, ShieldX, Sparkles, Wallet } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { formatMoney, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

interface Library {
  id: string;
  name: string;
  sources: number;
}

interface Credits {
  balanceCents: number;
  reservedCents: number;
  availableCents: number;
  entries: Array<{ id: string; kind: string; amountCents: number; createdAt: string }>;
}

interface AnswerView {
  id: string;
  question: string;
  status: 'answering' | 'answered' | 'not_covered' | 'failed';
  library: { id: string; name: string };
  text: string | null;
  model: string | null;
  fromFixture: boolean;
  citations: Array<{ handle: string; assetVersionId: string | null; title: string | null; paid: boolean }>;
  paid: Array<{ assetVersionId: string; title: string; contributor: string; citations: number; centsPerCitation: number; amountCents: number }>;
  notPaid: { unsupported: number; repeated: number; overCap: number };
  excluded: Array<{ title: string; contributor: string; code: string; reason: string }>;
  feeCents: number;
  chargedCents: number;
  maxPriceCents: number;
  failureReason: string | null;
  createdAt: string;
  receipt: { document: Record<string, unknown>; signature: string; algorithm: 'Ed25519'; publicKeyPem: string } | null;
}

interface Integrity {
  attacks: Array<{ id: string; attack: string; expected: string; caught: boolean }>;
  caught: number;
  total: number;
  overpaidCents: number;
}

/** Same categorical order as the charts, so a source keeps its colour everywhere. */
const SOURCE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const SUGGESTIONS = [
  'How fast is spending on AI coding assistants growing, and how many developers use one weekly?',
  'Why do engineering leaders expand AI assistant licences?',
  'What do developers value most about coding assistants?',
];

const ENTRY_LABEL: Record<string, string> = { top_up: 'PayPal top-up', answer: 'Answer', top_up_reversal: 'Top-up refunded', demo_credit: 'Demo credit' };

export function AskPage() {
  const qc = useQueryClient();
  const libraries = useQuery({ queryKey: ['libraries'], queryFn: () => api<{ libraries: Library[] }>('/libraries') });
  const credits = useQuery({ queryKey: ['credits'], queryFn: () => api<Credits>('/credits') });
  const history = useQuery({ queryKey: ['answers'], queryFn: () => api<{ answers: Array<{ id: string; question: string; status: string; chargedCents: number; createdAt: string; libraryName: string }> }>('/answers') });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [question, setQuestion] = useState(SUGGESTIONS[0]!);
  const [maxPriceCents, setMaxPriceCents] = useState(50);
  const [openId, setOpenId] = useState<string | null>(null);

  const library = libraryId ?? libraries.data?.libraries[0]?.id ?? null;
  const ask = useMutation({
    mutationFn: () => post<{ answer: AnswerView }>('/answers', { libraryId: library, question, maxPriceCents }),
    onSuccess: (r) => {
      setOpenId(r.answer.id);
      qc.setQueryData(['answer', r.answer.id], { answer: r.answer });
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['answers'] });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['credits'] }),
  });
  const shown = openId ?? history.data?.answers[0]?.id ?? null;

  return (
    <>
      <PageHeader
        title="Ask the library"
        subtitle="Answers from licensed sources only. Every passage an answer relies on pays its author, automatically, through PayPal — and you never pay more than your limit."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Card title="Your question">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                ask.mutate();
              }}
            >
              {(libraries.data?.libraries.length ?? 0) > 1 && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Library</span>
                  <select className="h-10 w-full rounded-lg border border-line px-3" value={library ?? ''} onChange={(e) => setLibraryId(e.target.value)}>
                    {libraries.data!.libraries.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} — {l.sources} licensed sources
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {libraries.data && libraries.data.libraries.length === 0 && <p className="text-sm text-muted">No library has sources licensed for AI answers yet.</p>}
              <textarea
                aria-label="Your question"
                className="h-24 w-full rounded-lg border border-line p-3 text-sm"
                value={question}
                minLength={8}
                maxLength={500}
                required
                onChange={(e) => setQuestion(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => setQuestion(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-ink hover:text-ink">
                    {s.length > 60 ? `${s.slice(0, 58)}…` : s}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Most this answer may cost</span>
                  <DraftInput
                    inputMode="decimal"
                    className="h-10 w-32 rounded-lg border border-line px-3 tabular-nums"
                    value={formatMoney(maxPriceCents)}
                    onCommit={(text) => {
                      const cents = parseDollars(text);
                      if (cents !== null) setMaxPriceCents(Math.min(500, Math.max(1, cents)));
                    }}
                  />
                </label>
                <Button type="submit" loading={ask.isPending} disabled={!library}>
                  <Sparkles className="size-4" /> Ask
                </Button>
                <span className="pb-2 text-xs text-muted">Checked before the AI runs: the answer is planned to fit your limit.</span>
              </div>
              <ErrorNote error={ask.error} />
            </form>
          </Card>

          {ask.isPending ? (
            <Card>
              <Spinner label="Checking licenses, reading licensed sources and writing a cited answer…" />
            </Card>
          ) : shown ? (
            <AnswerCard key={shown} answerId={shown} />
          ) : (
            <Card>
              <div className="py-8 text-center text-sm text-muted">
                <MessageSquareQuote className="mx-auto mb-2 size-6" />
                Ask something. You’ll see exactly who your money pays, and why.
              </div>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <CreditCard credits={credits.data ?? null} loading={credits.isLoading} />
          <IntegrityCard />
          {history.data && history.data.answers.length > 0 && (
            <Card title="Your questions">
              <ul className="divide-y divide-line text-sm">
                {history.data.answers.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => setOpenId(a.id)} className={clsx('flex w-full items-start justify-between gap-3 py-2 text-left', a.id === shown && 'font-medium')}>
                      <span className="line-clamp-2 min-w-0">{a.question}</span>
                      <span className="shrink-0 text-right text-xs text-muted tabular-nums">
                        {formatMoney(a.chargedCents)}
                        <span className="block">{timeAgo(a.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function AnswerCard({ answerId }: { answerId: string }) {
  const q = useQuery({ queryKey: ['answer', answerId], queryFn: () => api<{ answer: AnswerView }>(`/answers/${answerId}`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const a = q.data!.answer;
  // A source keeps its colour across the text, the chips and the table.
  const order = [...new Set(a.citations.map((c) => c.assetVersionId).filter((x): x is string => !!x))];
  const color = (id: string | null) => (id ? SOURCE_COLORS[order.indexOf(id) % SOURCE_COLORS.length] : '#94a3b8');
  const handle = new Map(a.citations.map((c) => [c.handle, c]));
  const unpaid = a.notPaid.unsupported + a.notPaid.repeated + a.notPaid.overCap;

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {a.status === 'answered' ? <Badge tone="pass">Answered</Badge> : a.status === 'not_covered' ? <Badge>Not covered — free</Badge> : <Badge tone="block">Not charged</Badge>}
          <span className="text-sm font-normal text-muted">{a.library.name}</span>
          {a.model && a.model !== 'none' && <Badge tone={a.fromFixture ? 'warn' : 'ai'}>{a.fromFixture ? 'Written without AI (no model configured)' : `Gemini (${a.model})`}</Badge>}
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">“{a.question}”</p>
      {a.status === 'failed' ? (
        <p className="text-sm text-block">{a.failureReason}</p>
      ) : (
        <p className="text-[15px] leading-relaxed text-slate-800">
          {(a.text ?? '').split(/(\[C\d+\])/).map((part, i) => {
            const m = /^\[(C\d+)\]$/.exec(part);
            if (!m) return <Fragment key={i}>{part}</Fragment>;
            const c = handle.get(m[1]!);
            return (
              <span
                key={i}
                title={c?.title ? `${c.title}${c.paid ? '' : ' — not paid (didn’t support this sentence, or repeated)'}` : 'Unknown source'}
                className={clsx('mx-0.5 inline-flex h-5 items-center rounded px-1.5 align-[1px] text-[11px] font-semibold text-white', !c?.paid && 'opacity-40 line-through')}
                style={{ background: color(c?.assetVersionId ?? null) }}
              >
                {m[1]}
              </span>
            );
          })}
        </p>
      )}

      {a.status === 'answered' && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Wallet className="size-4" /> Where your {formatMoney(a.chargedCents)} went
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Author</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Source</th>
                  <th className="px-3 py-2 text-right font-medium">Passages used</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {a.paid.map((p) => (
                  <tr key={p.assetVersionId}>
                    <td className="px-3 py-2">
                      <span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: color(p.assetVersionId) }} />
                      {p.contributor}
                    </td>
                    <td className="hidden px-3 py-2 text-muted sm:table-cell">{p.title}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.citations} × {formatMoney(p.centsPerCitation)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(p.amountCents)}</td>
                  </tr>
                ))}
                <tr className="text-muted">
                  <td className="px-3 py-2" colSpan={3}>
                    Answer fee (TracePay)
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(a.feeCents)}</td>
                </tr>
                <tr className="bg-slate-50 font-semibold">
                  <td className="px-3 py-2" colSpan={3}>
                    Total (your limit was {formatMoney(a.maxPriceCents)})
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(a.chargedCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {unpaid > 0 && (
            <p className="mt-2 text-xs text-muted">
              {unpaid} citation{unpaid === 1 ? '' : 's'} earned nothing:{' '}
              {[
                a.notPaid.unsupported && `${a.notPaid.unsupported} didn’t support its sentence`,
                a.notPaid.repeated && `${a.notPaid.repeated} repeated a passage already paid`,
                a.notPaid.overCap && `${a.notPaid.overCap} over the per-source cap`,
              ]
                .filter(Boolean)
                .join(', ')}
              . You only pay for what the answer actually relies on.
            </p>
          )}
        </div>
      )}

      {a.excluded.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-sm font-medium">Not used</div>
          <ul className="space-y-1 text-sm">
            {a.excluded.map((e) => (
              <li key={e.title} className="flex items-start gap-2">
                {e.code === 'over_budget' ? <CircleSlash className="mt-0.5 size-4 shrink-0 text-muted" /> : <ShieldX className="mt-0.5 size-4 shrink-0 text-block" />}
                <span>
                  <span className="font-medium">{e.title}</span> <span className="text-muted">— {e.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {a.receipt && <ReceiptRow receipt={a.receipt} answerId={a.id} />}
    </Card>
  );
}

function ReceiptRow({ receipt, answerId }: { receipt: NonNullable<AnswerView['receipt']>; answerId: string }) {
  const verify = useMutation({ mutationFn: () => post<{ valid: boolean }>('/receipts/verify', { document: receipt.document, signature: receipt.signature, publicKeyPem: receipt.publicKeyPem }) });
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `tracepay-answer-${answerId}.json` });
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
      <FileSignature className="size-4" />
      <span className="font-medium">Signed receipt</span>
      <span className="text-muted">— who was paid, under which license terms, signed with Ed25519.</span>
      <span className="ml-auto flex items-center gap-2">
        {verify.data && (verify.data.valid ? <Badge tone="pass"><BadgeCheck className="size-3" /> Signature valid</Badge> : <Badge tone="block">Invalid</Badge>)}
        <Button size="sm" variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
          Verify
        </Button>
        <Button size="sm" variant="ghost" onClick={download}>
          Download
        </Button>
      </span>
    </div>
  );
}

function CreditCard({ credits, loading }: { credits: Credits | null; loading: boolean }) {
  const qc = useQueryClient();
  const { config } = useSession();
  const [amount, setAmount] = useState(500);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const topUpRef = useRef<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['credits'] });
  useEffect(() => setNotice(null), [amount]);

  return (
    <Card title="Answer credit">
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="text-3xl font-semibold tabular-nums">{formatMoney(Math.max(0, credits?.availableCents ?? 0))}</div>
          <p className="mt-1 text-xs text-muted">
            Available{credits && credits.reservedCents > 0 ? ` · ${formatMoney(credits.reservedCents)} held for an answer in progress` : ''}. A typical answer costs a few cents.
          </p>
          <div className="mt-4 flex gap-2">
            {[500, 1000, 2000].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setAmount(c)}
                className={clsx('h-9 flex-1 rounded-lg border text-sm font-medium', amount === c ? 'border-ink bg-ink text-white' : 'border-line hover:bg-slate-50')}
              >
                {formatMoney(c)}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {!config?.paypalClientId ? (
              <ErrorNote error={new Error('PayPal sandbox is not configured on the server.')} />
            ) : (
              <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons' }}>
                <PayPalButtons
                  forceReRender={[amount]}
                  style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 40 }}
                  createOrder={async () => {
                    setError(null);
                    const r = await post<{ topUpId: string; orderId: string }>('/credits/top-ups', { amountCents: amount });
                    topUpRef.current = r.topUpId;
                    return r.orderId;
                  }}
                  onApprove={async () => {
                    try {
                      const r = await post<{ status: string; amountCents: number }>(`/credits/top-ups/${topUpRef.current}/capture`);
                      setNotice(r.status === 'captured' ? `Added ${formatMoney(r.amountCents)} — verified with PayPal.` : 'PayPal is still processing this payment.');
                    } catch (e) {
                      setError(e);
                    } finally {
                      refresh();
                    }
                  }}
                  onCancel={() => setError(new Error('Top-up cancelled. Nothing was charged.'))}
                  onError={() => setError(new Error('PayPal reported a problem. Nothing was charged.'))}
                />
              </PayPalScriptProvider>
            )}
            {config?.sandboxBuyerHint && <p className="mt-2 text-xs text-muted">Test buyer: {config.sandboxBuyerHint}</p>}
          </div>
          {notice && <p className="mt-2 text-sm text-pass">{notice}</p>}
          <ErrorNote error={error} />
          {credits && credits.entries.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs">
              {credits.entries.slice(0, 6).map((e) => (
                <li key={e.id} className="flex justify-between gap-2">
                  <span className="text-muted">
                    {ENTRY_LABEL[e.kind] ?? e.kind} · {timeAgo(e.createdAt)}
                  </span>
                  <span className={clsx('tabular-nums', e.amountCents > 0 && 'text-pass')}>
                    {e.amountCents > 0 ? '+' : '−'}
                    {formatMoney(Math.abs(e.amountCents))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

/** The payment rules, attacked live — the same suite the tests run. */
function IntegrityCard() {
  const q = useQuery({ queryKey: ['answer-integrity'], queryFn: () => api<Integrity>('/answers/integrity'), staleTime: Infinity });
  if (!q.data) return null;
  const allCaught = q.data.caught === q.data.total;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {allCaught ? <ShieldCheck className="size-4 text-pass" /> : <ShieldX className="size-4 text-block" />} Can the AI overcharge you?
        </span>
      }
    >
      <p className="text-sm text-muted">
        These attacks run against the payment rules right now. <strong className="text-ink">{q.data.caught} of {q.data.total} caught</strong>; overpaid: {formatMoney(q.data.overpaidCents)}.
      </p>
      <ul className="mt-3 space-y-1.5 text-xs">
        {q.data.attacks.map((t) => (
          <li key={t.id} className="flex items-start gap-2">
            {t.caught ? <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-pass" /> : <ShieldX className="mt-0.5 size-3.5 shrink-0 text-block" />}
            <span>
              {t.attack} <span className="text-muted">→ {t.expected}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
