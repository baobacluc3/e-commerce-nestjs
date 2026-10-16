import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const CAMPAIGN_ID = __ENV.CAMPAIGN_ID;
const TARGET_RPS = Number(__ENV.K6_RPS || 1500);
const DURATION = __ENV.K6_DURATION || '60s';
const TOKENS = JSON.parse(__ENV.K6_TOKENS || '[]');
const ITEMS = JSON.parse(__ENV.K6_ITEMS || '[]');
const RUN_ID = __ENV.K6_RUN_ID || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const successCount = new Counter('flash_sale_throughput_success');
const expectedRejections = new Counter('flash_sale_throughput_business_rejections');
const unexpectedResponses = new Counter('flash_sale_throughput_unexpected_responses');
const expectedOutcomeRate = new Rate('flash_sale_throughput_expected_outcome_rate');
const latency = new Trend('flash_sale_throughput_request_duration_ms', true);

export const options = {
  scenarios: {
    sustained_flash_sale: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Number(__ENV.K6_PREALLOCATED_VUS || 500),
      maxVUs: Number(__ENV.K6_MAX_VUS || 2500),
    },
  },
  thresholds: {
    flash_sale_throughput_request_duration_ms: ['p(95)<300'],
    flash_sale_throughput_expected_outcome_rate: ['rate>0.99'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  if (!CAMPAIGN_ID) throw new Error('Set CAMPAIGN_ID');
  if (!Array.isArray(TOKENS) || TOKENS.length === 0) {
    throw new Error('K6_TOKENS must be a JSON array of access tokens');
  }
  if (!Array.isArray(ITEMS) || ITEMS.length === 0) {
    throw new Error('K6_ITEMS must be a JSON array of unique campaign products');
  }
  return { tokens: TOKENS, items: ITEMS };
}

export default function (data) {
  // For a true high-rate run, configure staging rate limits to match the test
  // and use a sufficiently large pool of seeded users/tokens. Repeated user
  // quotas are deliberately visible as business rejections, not hidden errors.
  const tokenIndex = (__VU - 1 + __ITER) % data.tokens.length;
  const token = data.tokens[tokenIndex];
  const response = http.post(
    `${BASE_URL}/flash-sale/campaigns/${CAMPAIGN_ID}/reservations`,
    JSON.stringify({ items: data.items }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `flash-throughput-${RUN_ID}-vu-${__VU}-iter-${__ITER}`,
        'X-Correlation-ID': `k6-${RUN_ID}-${__VU}-${__ITER}`,
      },
      tags: { name: 'POST /flash-sale/campaigns/:campaignId/reservations' },
      timeout: '10s',
    },
  );

  latency.add(response.timings.duration);
  const success = response.status === 201 || response.status === 200;
  const expectedBusinessRejection = response.status === 409;
  const expected = success || expectedBusinessRejection;

  if (success) successCount.add(1);
  else if (expectedBusinessRejection) expectedRejections.add(1);
  else unexpectedResponses.add(1);
  expectedOutcomeRate.add(expected);

  check(response, {
    'request succeeded or hit expected capacity/quota conflict': () => expected,
  });
}
