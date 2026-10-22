// The settlement engine lives in @tracepay/shared, so the web app's price simulator
// runs exactly the math a real sale is settled with.
export { calculateSettlement, ROUNDING_RULE, SettlementError, type FrozenTerm, type SettlementInput, type SettlementLine, type SettlementResult } from '@tracepay/shared';
