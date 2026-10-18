/**
 * Day-1 PayPal proof. Run step by step:
 *
 *   npm run smoke:paypal -w @tracepay/api -- token
 *   npm run smoke:paypal -w @tracepay/api -- order            # prints an approval link
 *   npm run smoke:paypal -w @tracepay/api -- capture <ORDER_ID>  # after approving as the sandbox buyer
 *   npm run smoke:paypal -w @tracepay/api -- payout <SANDBOX_PERSONAL_EMAIL>
 *   npm run smoke:paypal -w @tracepay/api -- payout-status <PAYOUT_BATCH_ID>
 */
import { centsToDecimal, decimalToCents } from '@tracepay/shared';
import { newRequestId, PayPalApiError, PayPalClient } from '../integrations/paypal/client';

const [cmd, arg] = process.argv.slice(2);
const paypal = PayPalClient.fromEnv();

async function main() {
  switch (cmd) {
    case 'token': {
      const t = await paypal.accessToken();
      console.log('✓ OAuth token acquired (sandbox)');
      console.log(`  Payouts scope: ${(await paypal.hasPayoutsScope()) ? '✓ present' : '✗ MISSING — enable Payouts for this app in the Developer Dashboard'}`);
      console.log(`  ${t.scopes.length} scopes granted`);
      return;
    }
    case 'order': {
      const order = await paypal.createOrder(
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: 'smoke-test',
              custom_id: 'smoke-test',
              description: 'TracePay smoke test',
              amount: { currency_code: 'USD', value: centsToDecimal(100) },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: 'TracePay',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                return_url: 'https://example.com/return',
                cancel_url: 'https://example.com/cancel',
              },
            },
          },
        },
        newRequestId(),
      );
      const approve = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      console.log(`✓ Order ${order.id} created (${order.status})`);
      console.log(`  1. Open and log in as your SANDBOX PERSONAL (buyer) account:\n     ${approve?.href}`);
      console.log(`  2. Approve, then run:  npm run smoke:paypal -w @tracepay/api -- capture ${order.id}`);
      return;
    }
    case 'capture': {
      if (!arg) throw new Error('Usage: capture <ORDER_ID>');
      const result = await paypal.captureOrder(arg, `capture-${arg}`);
      const cap = result.purchase_units?.[0]?.payments?.captures?.[0];
      // Independently re-read the order: never trust a single response for money state.
      const verified = await paypal.getOrder(arg);
      console.log(`✓ Order ${result.id}: ${result.status} (re-read: ${verified.status})`);
      if (cap) {
        console.log(`  Capture ${cap.id}: ${cap.status} ${cap.amount.value} ${cap.amount.currency_code} = ${decimalToCents(cap.amount.value)}¢`);
        const fee = cap.seller_receivable_breakdown?.paypal_fee;
        if (fee) console.log(`  PayPal fee: ${fee.value} ${fee.currency_code}`);
      }
      return;
    }
    case 'payout': {
      if (!arg) throw new Error('Usage: payout <SANDBOX_PERSONAL_EMAIL>');
      const senderBatchId = `smoke-${Date.now()}`;
      const batch = await paypal.createPayoutBatch({
        senderBatchId,
        emailSubject: 'TracePay royalty (sandbox test)',
        emailMessage: 'Sandbox payout from the TracePay smoke test.',
        items: [
          { recipient_type: 'EMAIL', receiver: arg, amount: { value: '1.00', currency: 'USD' }, sender_item_id: `${senderBatchId}-1`, note: 'Smoke test' },
        ],
      });
      console.log(`✓ Payout batch ${batch.batch_header.payout_batch_id}: ${batch.batch_header.batch_status}`);
      console.log(`  sender_batch_id: ${senderBatchId}`);
      console.log(`  Check: npm run smoke:paypal -w @tracepay/api -- payout-status ${batch.batch_header.payout_batch_id}`);
      return;
    }
    case 'payout-status': {
      if (!arg) throw new Error('Usage: payout-status <PAYOUT_BATCH_ID>');
      const s = await paypal.getPayoutBatch(arg);
      console.log(`Batch ${s.batch_header.payout_batch_id}: ${s.batch_header.batch_status}`);
      for (const item of s.items ?? []) {
        console.log(`  ${item.payout_item.receiver}: ${item.transaction_status} ${item.payout_item.amount.value} ${item.payout_item.amount.currency}${item.errors ? ` — ${item.errors.name}` : ''}`);
      }
      return;
    }
    default:
      console.log('Commands: token | order | capture <id> | payout <email> | payout-status <batchId>');
  }
}

main().catch((err) => {
  if (err instanceof PayPalApiError) {
    console.error(`✗ ${err.message}`);
    console.error(JSON.stringify(err.body, null, 2));
  } else {
    console.error(`✗ ${(err as Error).message}`);
  }
  process.exit(1);
});
