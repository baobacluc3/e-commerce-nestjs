export const ORDER_EXPIRATION_QUEUE = 'order-expiration';
export const ORDER_NOTIFICATION_QUEUE = 'order-notifications';
export const DEAD_LETTER_QUEUE = 'dead-letter';

export const PAYMENT_TIMEOUT_MS = 30 * 60 * 1000;

export const RETRY_OPTIONS = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
    jitter: 0.2,
  },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: false,
};
