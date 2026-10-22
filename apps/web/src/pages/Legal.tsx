import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { useDocumentTitle } from '../components/ui';

const UPDATED = '23 October 2026';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="min-h-full bg-white">
      <div className="mx-auto max-w-3xl px-4 py-10 md:py-14">
        <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-semibold">
          <img src="/favicon.svg" alt="" className="size-6" /> TracePay
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted">Last updated {UPDATED}</p>
        <div className="mt-8 space-y-6 text-[15px] leading-relaxed text-slate-700 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc">{children}</div>
        <p className="mt-12 border-t border-line pt-4 text-xs text-muted">
          <Link to="/privacy" className="hover:underline">Privacy</Link> · <Link to="/terms" className="hover:underline">Terms</Link> · TracePay follows the license terms on record; it isn’t legal advice.
        </p>
      </div>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy">
      <p>
        TracePay licenses research sources, sells reports and AI answers built from them, and pays the people whose work they use. This page says what we keep about you,
        why, where it goes and how to get it back or deleted. The public demo runs on the PayPal <strong>sandbox</strong> with fictional data: no real money moves there.
      </p>
      <h2>What we keep, and why</h2>
      <ul>
        <li><strong>Your account:</strong> name, email, role and a scrypt hash of your password — to sign you in.</li>
        <li><strong>Your PayPal email</strong> (contributors) — to send you royalties with PayPal Payouts.</li>
        <li><strong>Payments:</strong> PayPal order, capture and payout ids, amounts and statuses, and the email PayPal reports for a payment — to prove what was paid and to reconcile it with PayPal.</li>
        <li><strong>Questions you ask</strong> and the answers you paid for — so you can see your history and verify your receipts.</li>
        <li><strong>Sign-in sessions</strong> (with your browser’s user agent) and <strong>API keys</strong> — stored hashed.</li>
        <li><strong>An audit log</strong> of every change, linked by ids rather than names or emails, so it proves what happened without exposing who you are.</li>
        <li><strong>Request logs</strong> with IP addresses, for security and abuse prevention.</li>
      </ul>
      <p>We don’t sell your data, run advertising or use tracking cookies. The only cookie is the one that keeps you signed in.</p>
      <h2>Who processes it for us</h2>
      <ul>
        <li><strong>PayPal</strong> — payments and payouts.</li>
        <li><strong>Google (Gemini API / Vertex AI)</strong> — writes answers and reports from licensed sources and drafts license terms. Your question and licensed passages are sent; your account details are not.</li>
        <li><strong>Render</strong> (API and rate-limit counters), <strong>Neon</strong> (database), <strong>Vercel</strong> (web app) — hosting.</li>
      </ul>
      <h2>How long we keep it</h2>
      <ul>
        <li>Expired sessions are deleted after a day; PayPal notification contents after 90 days.</li>
        <li>Payment, settlement and payout records are kept as long as accounting law requires.</li>
        <li>Everything else, until you delete your account.</li>
      </ul>
      <h2>Your rights</h2>
      <p>
        On your <Link to="/profile" className="text-brand hover:underline">Profile</Link> page you can <strong>download all your data</strong> and <strong>delete your account</strong>. Deleting removes
        your name, emails, PayPal address, password, sessions, keys and questions; payment records stay, without your details. For anything else — corrections, questions,
        objections — open an issue on our{' '}
        <a href="https://github.com/UjjwalCodes01/TracePay" className="text-brand hover:underline">GitHub repository</a>, or report a security problem privately as described in SECURITY.md.
      </p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms">
      <p>
        TracePay is open-source software (MIT license) and, at this address, a public demonstration on the PayPal sandbox with fictional data. By using it you agree to
        the following.
      </p>
      <h2>What TracePay does — and doesn’t</h2>
      <ul>
        <li>It enforces the license terms recorded and approved in it. It does not establish who owns a source, and it isn’t legal advice.</li>
        <li>Answers and reports are written by AI from licensed sources and can be wrong. Check anything important against the sources.</li>
        <li>The publisher receives a sale’s payment and pays contributors their share; TracePay is not an escrow service or a bank.</li>
      </ul>
      <h2>Answer credit and payments</h2>
      <ul>
        <li>Answer credit is bought with PayPal and spent on answers; an answer never costs more than the limit you set, and you’re not charged when no licensed source covers your question.</li>
        <li>Refunds and chargebacks made in PayPal reduce your credit; royalties that money funded and that haven’t been paid out are reversed.</li>
        <li>Contributors are paid through PayPal Payouts after a short clearing period, so refunds can land first.</li>
      </ul>
      <h2>Fair use of the service</h2>
      <ul>
        <li>Upload only work you have the right to license, and never other people’s personal data.</li>
        <li>Don’t try to break, overload or abuse the service, its rate limits or other people’s accounts. Report security problems privately (SECURITY.md).</li>
        <li>Demo personas are shared by every visitor: don’t put real information in them.</li>
      </ul>
      <h2>No warranty</h2>
      <p>The software is provided “as is”, without warranty of any kind, as stated in its MIT license.</p>
    </LegalPage>
  );
}
