export interface FlashSaleItemRequest {
  productId: string;
  quantity: number;
}

export interface FlashSaleIdempotencyContext {
  recordId: string;
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
}

export interface RedisLuaResult {
  code: number;
  value?: number;
}

export interface FlashSaleReservationResponse {
  orderId: string;
  reservationId: string;
  status: 'PENDING_PAYMENT';
  expiresAt: string;
  currency: 'VND';
  totalAmount: string;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: string;
  }>;
}
