import { useMutation } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { verifyReceipt, type Verification } from '../lib/verify';

export interface SignedDocument {
  document: Record<string, unknown>;
  signature: string;
  publicKeyPem: string;
}

/**
 * Checking a receipt's signature in the browser, and the same check on a copy with one cent
 * changed — so anyone can see that a receipt can't be edited without it showing.
 */
export function useReceiptCheck(receipt: SignedDocument) {
  const verify = useMutation({ mutationFn: () => verifyReceipt(receipt) });
  const tamper = useMutation({
    mutationFn: () => {
      const charged = Number(receipt.document.chargedCents ?? 0);
      return verifyReceipt({ ...receipt, document: { ...receipt.document, chargedCents: charged + 1 } });
    },
  });
  return { verify, tamper };
}

export function VerificationNote({ result, tampered }: { result?: Verification; tampered?: Verification }) {
  if (!result && !tampered) return null;
  return (
    <div className="mt-3 space-y-2 text-sm" aria-live="polite">
      {result && (
        <p className={`flex items-start gap-2 rounded-lg px-3 py-2 ${result.valid ? 'bg-verified-soft text-verified' : 'bg-block-soft text-block'}`}>
          {result.valid ? <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span>
            {result.valid ? 'The signature checks out: nothing in this receipt has changed since TracePay signed it.' : 'The signature doesn’t match: this receipt was changed after TracePay signed it.'}{' '}
            <span className="text-ink/70">
              {result.where === 'browser' ? (
                <>
                  Checked here in your browser — TracePay’s servers weren’t asked. Key fingerprint (SHA-256): <span className="mono break-all">{result.fingerprint}</span>
                </>
              ) : (
                'Checked by TracePay’s server: this browser can’t check Ed25519 signatures itself.'
              )}
            </span>
          </span>
        </p>
      )}
      {tampered && (
        <p className={`flex items-start gap-2 rounded-lg px-3 py-2 ${tampered.valid ? 'bg-block-soft text-block' : 'bg-slate-100 text-ink'}`}>
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {tampered.valid
            ? 'Unexpected: the copy with one cent changed still verified. Please report this.'
            : 'With the charge changed by one cent, the same check fails — a receipt can’t be edited without it showing.'}
        </p>
      )}
    </div>
  );
}
