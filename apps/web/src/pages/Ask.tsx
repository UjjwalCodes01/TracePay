import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BadgeCheck, CircleSlash, FileSignature, MessageSquareQuote, RotateCw, ShieldCheck, ShieldX, Sparkles, Wallet } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { DraftInput, parseDollars } from '../components/DraftInput';
import { Badge, Button, Card, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api, post } from '../lib/api';
import { formatDate, formatMoney, timeAgo } from '../lib/format';
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

type AnswerStatus = 'answering' | 'answered' | 'not_covered' | 'failed';

interface AnswerView {
  id: string;
  question: string;
  status: AnswerStatus;
  library: { id: string; name: string };
  text: string | null;
  model: string | null;
  fromFixture: boolean;
  citations: Array<{ handle: string; assetVersionId: string | null; title: string | null; paid: boolean; reason?: string | null }>;
  /** 'model': an independent AI check decided which citations were paid; 'rules': fixed rules did. */
  citationsCheckedBy?: string;
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

interface RedTeamScore {
  total: number;
  correct: number;
  misses: Array<{ text: string; technique: string; passage?: string; why: string }>;
}

interface Integrity {
  attacks: Array<{ id: string; attack: string; expected: string; caught: boolean }>;
  caught: number;
  total: number;
  overpaidCents: number;
  redTeam: {
    generatedAt: string;
    attackerModel: string;
    screenAttacks: RedTeamScore;
    screenControls: RedTeamScore;
    judgeAttacks: RedTeamScore;
    judgeControls: RedTeamScore;
    overpaidCents: number;
  } | null;
}

interface HistoryItem {
  id: string;
  question: string;
  status: AnswerStatus;
  chargedCents: number;
  createdAt: string;
  libraryName: string;
}

/** Same categorical order as the charts, so a source keeps its colour everywhere. */
const SOURCE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
/** Light slots need dark text to stay readable (WCAG contrast); the rest take white. */
const DARK_TEXT_ON = new Set(['#eb6834', '#1baf7a', '#eda100', '#e87ba4']);
const UNKNOWN_COLOR = '#94a3b8';

/** The server enforces its own fee as the floor; this mirrors it for the hint. */
const MIN_PRICE_CENTS = 2;
const MAX_PRICE_CENTS = 500;

const SUGGESTIONS = [
  'How fast is spending on AI coding assistants growing, and how many developers use one weekly?',
  'Why do engineering leaders expand AI assistant licences?',
  'What do developers value most about coding assistants?',
];

const ENTRY_LABEL: Record<string, string> = { top_up: 'PayPal top-up', answer: 'Answer', top_up_reversal: 'Top-up refunded', demo_credit: 'Demo credit' };

const STATUS_BADGE: Record<AnswerStatus, { text: string; tone: 'pass' | 'neutral' | 'block' | 'info' }> = {
  answered: { text: 'Answered', tone: 'pass' },
  not_covered: { text: 'Not covered — free', tone: 'neutral' },
  failed: { text: 'Not charged', tone: 'block' },
  answering: { text: 'Still answering', tone: 'info' },
};

const clampPrice = (cents: number) => Math.min(MAX_PRICE_CENTS, Math.max(MIN_PRICE_CENTS, cents));

export function AskPage() {
  const qc = useQueryClient();
  const libraries = useQuery({ queryKey: ['libraries'], queryFn: () => api<{ libraries: Library[] }>('/libraries') });
  const credits = useQuery({ queryKey: ['credits'], queryFn: () => api<Credits>('/credits') });
  const history = useQuery({ queryKey: ['answers'], queryFn: () => api<{ answers: HistoryItem[] }>('/answers') });
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [question, setQuestion] = useState(SUGGESTIONS[0]!);
  const [maxPriceCents, setMaxPriceCents] = useState(50);
  const [openId, setOpenId] = useState<string | null>(null);

  const library = libraryId ?? libraries.data?.libraries[0]?.id ?? null;
  const ask = useMutation({
    // Values are passed in, so a limit committed by pressing Enter is never read stale.
    mutationFn: (vars: { libraryId: string; question: string; maxPriceCents: number }) => post<{ answer: AnswerView }>('/answers', vars),
    onSuccess: (r) => {
      setOpenId(r.answer.id);
      qc.setQueryData(['answer', r.answer.id], { answer: r.answer });
      qc.invalidateQueries({ queryKey: ['answers'] });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['credits'] }),
  });
  const shown = openId ?? history.data?.answers[0]?.id ?? null;

  return (
    <>
      <PageHeader
        title="Ask the library"
        subtitle="Answers from licensed sources only. Every passage an answer relies on pays the contributor who wrote it, automatically, through PayPal — and you never pay more than your limit."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <Card title="Your question">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!library) return;
                // A limit typed but not yet committed (Enter in the field) is read from the form.
                const field = (e.currentTarget.elements.namedItem('maxPrice') as HTMLInputElement | null)?.value;
                const typed = field ? parseDollars(field) : null;
                const limit = typed !== null ? clampPrice(typed) : maxPriceCents;
                setMaxPriceCents(limit);
                ask.mutate({ libraryId: library, question, maxPriceCents: limit });
              }}
            >
              {(libraries.data?.libraries.length ?? 0) > 1 && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Library</span>
                  <select className="h-10 w-full rounded-lg border border-line px-3" value={library ?? ''} onChange={(e) => setLibraryId(e.target.value)}>
                    {libraries.data!.libraries.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} — {l.sources} licensed {l.sources === 1 ? 'source' : 'sources'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {libraries.data && libraries.data.libraries.length === 0 && <p className="text-sm text-muted">No library has sources licensed for AI answers yet.</p>}
              <ErrorNote error={libraries.error} />
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
                {SUGGESTIONS.filter((s) => s !== question.trim()).map((s) => (
                  <button key={s} type="button" onClick={() => setQuestion(s)} className="rounded-full border border-line px-3 py-1 text-left text-xs text-muted hover:border-ink hover:text-ink">
                    {s.length > 60 ? `${s.slice(0, 58)}…` : s}
                  </button>
                ))}
              </div>
              <div>
                <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Most this answer may cost</span>
                  <DraftInput
                    name="maxPrice"
                    inputMode="decimal"
                    aria-describedby="max-price-hint"
                    className="h-10 w-32 rounded-lg border border-line px-3 tabular-nums"
                    value={formatMoney(maxPriceCents)}
                    onCommit={(text) => {
                      const cents = parseDollars(text);
                      if (cents !== null) setMaxPriceCents(clampPrice(cents));
                    }}
                  />
                </label>
                <Button type="submit" loading={ask.isPending} disabled={!library}>
                  <Sparkles className="size-4" aria-hidden /> Ask
                </Button>
                </div>
                <p id="max-price-hint" className="mt-1.5 text-xs text-muted">
                  {formatMoney(MIN_PRICE_CENTS)}–{formatMoney(MAX_PRICE_CENTS)}. Checked before the AI runs: the answer is planned to fit your limit.
                </p>
              </div>
              <ErrorNote error={ask.error} />
            </form>
          </Card>

          <div aria-live="polite">
            {ask.isPending ? (
              <Card>
                <Spinner label="Checking licenses, reading licensed sources and writing a cited answer…" />
              </Card>
            ) : shown ? (
              <AnswerCard key={shown} answerId={shown} />
            ) : (
              <Card>
                <div className="py-8 text-center text-sm text-muted">
                  <MessageSquareQuote className="mx-auto mb-2 size-6" aria-hidden />
                  Ask something. You’ll see exactly who your money pays, and why.
                </div>
              </Card>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          {/* A successful top-up clears a stale "top up to continue" error. */}
          <CreditCard credits={credits.data ?? null} loading={credits.isPending && !credits.error} loadError={credits.data ? null : credits.error} onToppedUp={() => ask.reset()} />
          <IntegrityCard />
          {history.data && history.data.answers.length > 0 && (
            <Card title="Your questions">
              <ul className="divide-y divide-line text-sm">
                {history.data.answers.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(a.id)}
                      aria-pressed={a.id === shown}
                      className={clsx('flex w-full items-start justify-between gap-3 py-2 text-left', a.id === shown && 'font-medium')}
                    >
                      <span className="min-w-0">
                        <span className="line-clamp-2">{a.question}</span>
                        <Badge tone={STATUS_BADGE[a.status]?.tone ?? 'neutral'} className="mt-1">
                          {STATUS_BADGE[a.status]?.text ?? a.status}
                        </Badge>
                      </span>
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
  const q = useQuery({
    queryKey: ['answer', answerId],
    queryFn: () => api<{ answer: AnswerView }>(`/answers/${answerId}`),
    // Opened from another tab while still answering: follow it to the end.
    refetchInterval: (query) => (query.state.data?.answer.status === 'answering' ? 2000 : false),
  });
  const [openChip, setOpenChip] = useState<number | null>(null);
  if (q.error && !q.data) return <ErrorNote error={q.error} />;
  if (!q.data) return <Spinner />;
  const a = q.data.answer;
  // A source keeps its colour across the text, the chips and the table.
  const order = [...new Set(a.citations.map((c) => c.assetVersionId).filter((x): x is string => !!x))];
  const color = (id: string | null) => (id ? SOURCE_COLORS[order.indexOf(id) % SOURCE_COLORS.length]! : UNKNOWN_COLOR);
  const handle = new Map(a.citations.map((c) => [c.handle, c]));
  const handlesOf = (assetVersionId: string) => [...new Set(a.citations.filter((c) => c.assetVersionId === assetVersionId && c.paid).map((c) => c.handle))];
  const unpaid = a.notPaid.unsupported + a.notPaid.repeated + a.notPaid.overCap;
  const parts = (a.text ?? '').split(/(\[C\d+\])/);
  // The k-th time a handle appears in the text is its k-th citation (each has its own verdict and reason).
  const citationAt = new Map<number, AnswerView['citations'][number]>();
  const seenCount = new Map<string, number>();
  parts.forEach((part, i) => {
    const h = /^\[(C\d+)\]$/.exec(part)?.[1];
    if (!h) return;
    const all = a.citations.filter((c) => c.handle === h);
    const k = seenCount.get(h) ?? 0;
    seenCount.set(h, k + 1);
    const c = all[k] ?? all.at(-1) ?? handle.get(h);
    if (c) citationAt.set(i, c);
  });
  const open = openChip !== null ? citationAt.get(openChip) : undefined;
  const badge = STATUS_BADGE[a.status];

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone}>{badge.text}</Badge>
          <span className="text-sm font-normal text-muted">{a.library.name}</span>
          {a.model && a.model !== 'none' && <Badge tone={a.fromFixture ? 'warn' : 'ai'}>{a.fromFixture ? 'Written without AI (no AI model configured)' : `Written with AI (${a.model})`}</Badge>}
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">“{a.question}”</p>
      {a.status === 'answering' ? (
        <Spinner label="Still answering…" />
      ) : a.status === 'failed' ? (
        <p className="text-sm text-block">{a.failureReason}</p>
      ) : (
        <>
          <p className="text-[15px] leading-relaxed text-slate-800">
            {parts.map((part, i) => {
              const m = /^\[(C\d+)\]$/.exec(part);
              if (!m) return <Fragment key={i}>{part}</Fragment>;
              const c = citationAt.get(i);
              const bg = color(c?.assetVersionId ?? null);
              const title = c?.title ?? 'a licensed source';
              const paid = !!c?.paid;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`Citation ${m[1]}: ${title}, ${paid ? 'paid' : 'not paid'}`}
                  aria-expanded={openChip === i}
                  title={`${title}${c?.reason ? ` — ${c.reason}` : paid ? '' : ' — not paid'}`}
                  onClick={() => setOpenChip(openChip === i ? null : i)}
                  className={clsx(
                    'mx-0.5 inline-flex h-5 items-center rounded px-1.5 align-[1px] text-[11px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink',
                    !paid && 'border border-dashed bg-white line-through',
                  )}
                  style={paid ? { background: bg, color: DARK_TEXT_ON.has(bg) ? '#0b0b0b' : '#ffffff' } : { borderColor: bg, color: '#334155' }}
                >
                  {m[1]}
                </button>
              );
            })}
          </p>
          {open && (
            <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700" role="note">
              <strong>{open.handle}</strong>: {open.title ?? 'a licensed source'} — {open.paid ? 'paid' : 'not paid'}.{' '}
              {open.reason ?? (open.paid ? 'The answer relies on this passage.' : 'It didn’t support its sentence, or repeated a passage already paid.')}
            </p>
          )}
          {a.status === 'answered' && a.citations.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              {a.citationsCheckedBy === 'model'
                ? 'Each citation was checked by a separate AI judge, which sees only the sentence and the passage: a citation is paid only if the sentence really draws on it. Click a citation to see why.'
                : 'Each citation was checked by fixed rules: a citation is paid only if its sentence shares the passage’s specific figures or terms. Click a citation to see why.'}
            </p>
          )}
        </>
      )}

      {a.status === 'answered' && (
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Wallet className="size-4" aria-hidden /> Where your {formatMoney(a.chargedCents)} went
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Contributor</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Source</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Passages used</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {a.paid.map((p) => {
                  const cited = handlesOf(p.assetVersionId);
                  return (
                    <tr key={p.assetVersionId}>
                      <td className="px-3 py-2">
                        <span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: color(p.assetVersionId) }} aria-hidden />
                        {p.contributor}
                        {cited.length > 0 && <span className="block text-xs text-muted">Cited as {cited.join(', ')}</span>}
                        <span className="block text-xs text-muted tabular-nums sm:hidden">
                          {p.citations} × {formatMoney(p.centsPerCitation)}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2 text-muted sm:table-cell">{p.title}</td>
                      <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                        {p.citations} × {formatMoney(p.centsPerCitation)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(p.amountCents)}</td>
                    </tr>
                  );
                })}
                <tr className="text-muted">
                  <td className="px-3 py-2">Library fee ({a.library.name})</td>
                  <td className="hidden sm:table-cell" colSpan={2} />
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(a.feeCents)}</td>
                </tr>
                <tr className="bg-slate-50 font-semibold">
                  <td className="px-3 py-2">Total (your limit was {formatMoney(a.maxPriceCents)})</td>
                  <td className="hidden sm:table-cell" colSpan={2} />
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
                a.notPaid.overCap && `${a.notPaid.overCap} over the limit of paid passages per source`,
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
                {e.code === 'over_budget' ? <CircleSlash className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <ShieldX className="mt-0.5 size-4 shrink-0 text-block" aria-hidden />}
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
    // Some browsers start the download asynchronously: release the URL afterwards.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="mt-6 border-t border-line pt-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FileSignature className="size-4" aria-hidden />
        <span className="font-medium">Signed receipt</span>
        <span className="ml-auto flex flex-wrap items-center gap-2" aria-live="polite">
          {verify.data &&
            (verify.data.valid ? (
              <Badge tone="pass">
                <BadgeCheck className="size-3" aria-hidden /> Signature valid
              </Badge>
            ) : (
              <Badge tone="block">Signature doesn’t match</Badge>
            ))}
          <Button size="sm" variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
            Verify
          </Button>
          <Button size="sm" variant="secondary" onClick={download}>
            Download
          </Button>
        </span>
      </div>
      <p className="mt-1 text-muted" title="Signed with Ed25519">
        Who was paid and under which license terms, digitally signed so anyone can check it wasn’t changed.
      </p>
      {verify.error ? (
        <div className="mt-2">
          <ErrorNote error={verify.error} />
        </div>
      ) : null}
    </div>
  );
}

function CreditCard({ credits, loading, loadError, onToppedUp }: { credits: Credits | null; loading: boolean; loadError: unknown; onToppedUp: () => void }) {
  const qc = useQueryClient();
  const { config } = useSession();
  const [params, setParams] = useSearchParams();
  const [amount, setAmount] = useState(500);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  // Which top-up each PayPal order belongs to: onApprove looks it up by the order it approved.
  const topUps = useRef(new Map<string, string>());
  // Our own errors (raised in createOrder) are shown as-is; PayPal's generic onError mustn't replace them.
  const shownRef = useRef(false);
  const [retryTopUp, setRetryTopUp] = useState<string | null>(null);

  const capture = useMutation({
    mutationFn: (topUpId: string) => post<{ status: string; amountCents: number }>(`/credits/top-ups/${topUpId}/capture`),
    onMutate: () => {
      setError(null);
      setNotice(null);
    },
    onSuccess: (r) => {
      setRetryTopUp(null);
      if (r.status === 'captured') {
        setNotice(`Added ${formatMoney(r.amountCents)} — verified with PayPal.`);
        onToppedUp();
      } else if (r.status === 'pending_payment') setNotice('PayPal is still processing this payment. Your credit appears as soon as PayPal confirms it.');
      else setError(new Error('PayPal didn’t complete this payment, so nothing was charged.'));
    },
    onError: (e, topUpId) => {
      setError(e);
      setRetryTopUp(topUpId);
    },
    onSettled: () => {
      setPaying(false);
      qc.invalidateQueries({ queryKey: ['credits'] });
    },
  });

  // Back from a full-page PayPal redirect (?topup=…): finish the top-up, then tidy the URL.
  const returned = params.get('topup');
  useEffect(() => {
    if (!returned) return;
    setPaying(true);
    capture.mutate(returned);
    setParams(
      (p) => {
        p.delete('topup');
        return p;
      },
      { replace: true },
    );
    // Runs once per returned id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned]);

  return (
    <Card title="Answer credit">
      {loading ? (
        <Spinner />
      ) : loadError ? (
        <ErrorNote error={loadError} />
      ) : (
        <>
          <div className="text-3xl font-semibold tabular-nums">{formatMoney(Math.max(0, credits?.availableCents ?? 0))}</div>
          <p className="mt-1 text-xs text-muted">
            Available
            {credits && credits.reservedCents > 0 ? ` · ${formatMoney(credits.reservedCents)} held for an answer in progress` : ''}
            {credits && credits.balanceCents < 0 ? ` · ${formatMoney(-credits.balanceCents)} owed after a refunded top-up` : ''}. A typical answer costs a few cents.
          </p>
          <fieldset className="mt-4" disabled={paying}>
            <legend className="mb-1.5 text-xs font-medium text-muted">Choose how much to add, then pay with PayPal</legend>
            <div className="flex gap-2">
              {[500, 1000, 2000].map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={amount === c}
                  onClick={() => {
                    setAmount(c);
                    setNotice(null);
                  }}
                  className={clsx(
                    'h-9 flex-1 rounded-lg border text-sm font-medium disabled:opacity-50',
                    amount === c ? 'border-ink bg-slate-50 text-ink ring-1 ring-ink' : 'border-line text-muted hover:bg-slate-50 hover:text-ink',
                  )}
                >
                  Add {formatMoney(c).replace(/\.00$/, '')}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="mt-3">
            {!config?.paypalClientId ? (
              <ErrorNote error={new Error('PayPal sandbox is not configured on the server.')} />
            ) : (
              <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture', components: 'buttons' }}>
                <PayPalButtons
                  style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 40 }}
                  disabled={capture.isPending}
                  createOrder={async () => {
                    setError(null);
                    setNotice(null);
                    setRetryTopUp(null);
                    shownRef.current = false;
                    setPaying(true);
                    try {
                      const r = await post<{ topUpId: string; orderId: string }>('/credits/top-ups', { amountCents: amount });
                      topUps.current.set(r.orderId, r.topUpId);
                      return r.orderId;
                    } catch (e) {
                      shownRef.current = true;
                      setError(e);
                      setPaying(false);
                      throw e;
                    }
                  }}
                  onApprove={async (data) => {
                    const topUpId = topUps.current.get(data.orderID);
                    if (!topUpId) {
                      setPaying(false);
                      setError(new Error('We couldn’t match this PayPal payment to your top-up. Reload the page: if PayPal took the money, your credit appears shortly.'));
                      return;
                    }
                    await capture.mutateAsync(topUpId).catch(() => undefined);
                  }}
                  onCancel={() => {
                    setPaying(false);
                    setError(new Error('Top-up cancelled. Nothing was charged.'));
                  }}
                  onError={() => {
                    setPaying(false);
                    if (!shownRef.current) setError(new Error('PayPal reported a problem. Nothing was charged.'));
                  }}
                />
              </PayPalScriptProvider>
            )}
            {config?.sandboxBuyerHint && <p className="mt-2 text-xs text-muted">Test buyer: {config.sandboxBuyerHint}</p>}
          </div>
          <div aria-live="polite">
            {capture.isPending && <Spinner label="Confirming the payment with PayPal…" />}
            {notice && <p className="mt-2 text-sm text-pass">{notice}</p>}
          </div>
          <ErrorNote error={error} />
          {retryTopUp && (
            <Button size="sm" variant="secondary" className="mt-2" loading={capture.isPending} onClick={() => capture.mutate(retryTopUp)}>
              <RotateCw className="size-3.5" aria-hidden /> Try again
            </Button>
          )}
          {credits && credits.entries.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-line pt-3 text-xs">
              {credits.entries.slice(0, 6).map((e) => (
                <li key={e.id} className="flex justify-between gap-2">
                  <span className="text-muted">
                    {ENTRY_LABEL[e.kind] ?? e.kind.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase())} · {timeAgo(e.createdAt)}
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

/** How the AI defences held up against attacks Gemini wrote, and the payment rules enforced in code. */
function IntegrityCard() {
  const q = useQuery({ queryKey: ['answer-integrity'], queryFn: () => api<Integrity>('/answers/integrity'), staleTime: Infinity });
  const title = (icon: ReactNode) => (
    <span className="flex items-center gap-2">
      {icon} Can the AI be gamed?
    </span>
  );
  if (q.isPending && !q.error) {
    return (
      <Card title={title(<ShieldCheck className="size-4" aria-hidden />)}>
        <Spinner label="Loading the checks…" />
      </Card>
    );
  }
  if (q.error || !q.data) {
    return (
      <Card title={title(<ShieldX className="size-4" aria-hidden />)}>
        <ErrorNote error={q.error ?? new Error('The integrity check didn’t load.')} />
      </Card>
    );
  }
  const rt = q.data.redTeam;
  // The honest answer is the control case, not an attack: shown apart, not counted.
  const control = q.data.attacks.find((t) => t.id === 'honest');
  const rules = q.data.attacks.filter((t) => t.id !== 'honest');
  const rulesHold = rules.filter((t) => t.caught).length;
  const rows = rt
    ? [
        { label: 'Instructions planted in a source, withheld', s: rt.screenAttacks, attack: true },
        { label: 'Citations that shouldn’t be paid, refused', s: rt.judgeAttacks, attack: true },
        { label: 'Ordinary passages about AI, left alone', s: rt.screenControls, attack: false },
        { label: 'Honest paraphrases, paid', s: rt.judgeControls, attack: false },
      ]
    : [];
  const misses = rows.flatMap((r) => r.s.misses.map((m) => ({ ...m, kind: r.attack ? 'Got through' : 'Wrongly blocked' })));
  return (
    <Card title={title(<ShieldCheck className="size-4 text-pass" aria-hidden />)}>
      {rt ? (
        <>
          <p className="text-sm text-muted">
            Red team: Gemini wrote {rt.screenAttacks.total + rt.judgeAttacks.total} fresh attacks on the AI checks, plus honest controls ({formatDate(rt.generatedAt)}). Real results, misses included.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm">
            {rows.map((r) => (
              <li key={r.label} className="flex items-start justify-between gap-3">
                <span>{r.label}</span>
                <span className={clsx('shrink-0 font-medium tabular-nums', r.s.correct === r.s.total ? 'text-pass' : 'text-ink')}>
                  {r.s.correct}/{r.s.total}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            What missed citation attacks would have been paid: {formatMoney(rt.overpaidCents)}. Regenerated with <code className="rounded bg-slate-100 px-1 text-slate-800">npm run red-team</code>.
          </p>
          {misses.length > 0 && (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer select-none font-medium text-muted hover:text-ink">See the {misses.length} misses</summary>
              <ul className="mt-2 space-y-2">
                {misses.map((m, i) => (
                  <li key={i} className="rounded-lg bg-slate-50 p-2">
                    <div className="font-medium">
                      {m.kind} · {m.technique}
                    </div>
                    <div className="mt-0.5 text-slate-700">“{m.text}”</div>
                    {m.passage && <div className="mt-0.5 text-muted">Passage: “{m.passage}”</div>}
                    <div className="mt-0.5 text-muted">Checker said: {m.why}</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">The AI red team hasn’t been run on this server yet.</p>
      )}
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-sm">
          Rules enforced in code, checked on every request:{' '}
          <strong>
            {rulesHold} of {rules.length} hold
          </strong>
          {control && <span className="text-muted">; an honest answer is {control.caught ? 'paid correctly' : 'not paid correctly'}</span>}.
        </p>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted hover:text-ink">See the {rules.length} rules</summary>
          <ul className="mt-2 space-y-1.5">
            {rules.map((t) => (
              <li key={t.id} className="flex items-start gap-2">
                {t.caught ? <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-pass" aria-label="Holds" /> : <ShieldX className="mt-0.5 size-3.5 shrink-0 text-block" aria-label="Broken" />}
                <span>
                  {t.attack} <span className="text-muted">→ {t.expected}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Card>
  );
}
