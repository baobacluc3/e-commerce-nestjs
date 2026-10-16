import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CAMPAIGN_ID = __ENV.CAMPAIGN_ID;
const VUS = Number(__ENV.K6_VUS || 500);
const ITEMS = JSON.parse(__ENV.K6_ITEMS || '[]');
const TOKENS = JSON.parse(__ENV.K6_TOKENS || '[]');
const RUN_ID = __ENV.K6_RUN_ID || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const reservationSuccess = new Counter('flash_sale_reservation_success');
const expectedRejection = new Counter('flash_sale_expected_rejection');
const unexpectedResponse = new Counter('flash_sale_unexpected_response');
const acceptedOrSoldOut = new Rate('flash_sale_expected_outcome_rate');
const checkoutLatency = new Trend('flash_sale_request_duration_ms', true);

export const options = {
  scenarios: {
    flash_sale_burst: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    'flash_sale_request_duration_ms': ['p(95)<300'],
    'flash_sale_expected_outcome_rate': ['rate>0.99'],
  },
};

export function setup() {
  if (!CAMPAIGN_ID) throw new Error('Set CAMPAIGN_ID');
  if (!Array.isArray(ITEMS) || ITEMS.length === 0) {
    throw new Error('K6_ITEMS must be a JSON array like [{"productId":"...","quantity":1}]');
  }
  if (!Array.isArray(TOKENS) || TOKENS.length < VUS) {
    throw new Error(`Provide at least ${VUS} JWTs in K6_TOKENS, one per test user`);
  }
  return { tokens: TOKENS, items: ITEMS };
}

export default function (data) {
  const token = data.tokens[__VU - 1];
  const response = http.post(
    `${BASE_URL}/flash-sale/campaigns/${CAMPAIGN_ID}/reservations`,
    JSON.stringify({ items: data.items }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `flash-load-${RUN_ID}-vu-${__VU}`,
      },
      tags: { name: 'POST /flash-sale/campaigns/:campaignId/reservations' },
      timeout: '30s',
    },
  );

  checkoutLatency.add(response.timings.duration);
  const success = response.status === 201 || response.status === 200;
  // 409 is an expected business rejection when the scarce stock sells out.
  const rejectedForBusiness = response.status === 409;
  const expected = success || rejectedForBusiness;

  if (success) reservationSuccess.add(1);
  else if (rejectedForBusiness) expectedRejection.add(1);
  else unexpectedResponse.add(1);
  acceptedOrSoldOut.add(expected);

  check(response, {
    'reservation succeeds or is rejected for business capacity': () => expected,
  });
}
