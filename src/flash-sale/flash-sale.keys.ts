export function campaignReadyKey(campaignId: string): string {
  return `fs:{${campaignId}}:ready`;
}

export function campaignExpiryKey(campaignId: string): string {
  return `fs:{${campaignId}}:expiry`;
}

export function campaignProvisionalKey(campaignId: string): string {
  return `fs:{${campaignId}}:provisional`;
}

export function campaignConfigKey(campaignId: string): string {
  return `fs:{${campaignId}}:config`;
}

export function campaignQuotaKey(campaignId: string, userId: string): string {
  return `fs:{${campaignId}}:quota:${userId}`;
}

export function reservationKey(campaignId: string, reservationId: string): string {
  return `fs:{${campaignId}}:reservation:${reservationId}`;
}

export function stockKey(campaignId: string, productId: string): string {
  return `fs:{${campaignId}}:stock:${productId}`;
}

// All keys include the same {campaignId} Redis Cluster hash tag.
// This is required because a Lua script touches the entire campaign atomically.
