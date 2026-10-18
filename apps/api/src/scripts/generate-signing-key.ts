/** Prints a fresh Ed25519 key pair for signing audit receipts. Put the private key in .env only. */
import { generateSigningKeys } from '../modules/audit/signing';

const { privateKeyB64, publicKeyPem } = generateSigningKeys();
console.log('# Add to apps/api/.env (keep secret):');
console.log(`AUDIT_SIGNING_PRIVATE_KEY=${privateKeyB64}\n`);
console.log('# Public key (safe to publish; also served at GET /api/audit/public-key):');
console.log(publicKeyPem);
