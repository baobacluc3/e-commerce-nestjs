export interface IdempotencyContext {
  recordId: string;
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
}
