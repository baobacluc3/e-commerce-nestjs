import { OrderStatus } from '../generated/prisma/client';

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.EXPIRED],
  [OrderStatus.PAID]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED, OrderStatus.REFUND_PENDING],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPING, OrderStatus.CANCELLED, OrderStatus.REFUND_PENDING],
  [OrderStatus.SHIPPING]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [OrderStatus.REFUND_PENDING],
  [OrderStatus.EXPIRED]: [OrderStatus.REFUND_PENDING],
  [OrderStatus.REFUND_PENDING]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
};

export class OrderStateMachine {
  canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return TRANSITIONS[from]?.includes(to) ?? false;
  }
}
