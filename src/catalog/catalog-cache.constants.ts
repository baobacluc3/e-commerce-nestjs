export const PRODUCT_CACHE_LOCK_TTL_MS = 5_000;
export const PRODUCT_CACHE_MAX_WAIT_ATTEMPTS = 10;
export const PRODUCT_CACHE_WAIT_MS = 50;
export const PRODUCT_DETAIL_TTL_SECONDS = 300;
export const PRODUCT_LIST_TTL_SECONDS = 60;
export const PRODUCT_LIST_VERSION_KEY = 'catalog:products:list:version';

export function productDetailVersionKey(slug: string): string {
  return `catalog:products:detail:${encodeURIComponent(slug)}:version`;
}
