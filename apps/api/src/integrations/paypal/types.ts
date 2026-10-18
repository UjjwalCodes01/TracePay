/** The subset of PayPal REST shapes TracePay relies on. */

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export interface CreateOrderRequest {
  intent: 'CAPTURE';
  purchase_units: Array<{
    reference_id: string;
    custom_id: string;
    description: string;
    amount: Money;
  }>;
  payment_source?: {
    paypal: {
      experience_context: {
        brand_name?: string;
        shipping_preference?: 'NO_SHIPPING' | 'GET_FROM_FILE' | 'SET_PROVIDED_ADDRESS';
        user_action?: 'PAY_NOW' | 'CONTINUE';
        return_url?: string;
        cancel_url?: string;
      };
    };
  };
}

export type OrderStatus = 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';

export interface Capture {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  amount: Money;
  custom_id?: string;
  seller_receivable_breakdown?: {
    gross_amount: Money;
    paypal_fee?: Money;
    net_amount?: Money;
  };
  create_time?: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  links: Link[];
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: Money;
    payments?: { captures?: Capture[] };
  }>;
  payer?: { email_address?: string; payer_id?: string };
}

export type CaptureResponse = Order;

export interface PayoutItemRequest {
  recipient_type: 'EMAIL';
  receiver: string;
  amount: { value: string; currency: string };
  note?: string;
  sender_item_id: string;
}

export type PayoutBatchState = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'DENIED' | 'CANCELED';
export type PayoutItemState =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'UNCLAIMED'
  | 'RETURNED'
  | 'ONHOLD'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED';

export interface PayoutBatchResponse {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayoutBatchState;
    sender_batch_header: { sender_batch_id: string };
  };
}

export interface PayoutBatchStatus {
  batch_header: PayoutBatchResponse['batch_header'] & {
    time_created?: string;
    time_completed?: string;
    amount?: { value: string; currency: string };
    fees?: { value: string; currency: string };
  };
  items?: Array<{
    payout_item_id: string;
    transaction_id?: string;
    transaction_status: PayoutItemState;
    payout_item_fee?: { value: string; currency: string };
    payout_item: PayoutItemRequest;
    errors?: { name: string; message: string };
  }>;
}

export interface WebhookVerificationHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface WebhookEvent<T = unknown> {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: T;
  create_time: string;
}
