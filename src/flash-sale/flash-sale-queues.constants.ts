export const FLASH_SALE_EXPIRATION_QUEUE = 'flash-sale-expiration';
export const FLASH_SALE_REFUND_QUEUE = 'flash-sale-refunds';

export const FLASH_SALE_JOB_RETRY = {
  attempts: 8,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
    jitter: 0.2,
  },
  removeOnComplete: { age: 24 * 60 * 60, count: 2000 },
  removeOnFail: false,
};
