import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.K6_VUS || 10);
const RUN_ID =
  __ENV.K6_RUN_ID || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const options = {
  scenarios: {
    concurrent_checkout: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const tokens = JSON.parse(__ENV.K6_TOKENS || '[]');
  if (!Array.isArray(tokens) || tokens.length < VUS) {
    throw new Error(`Provide at least ${VUS} access tokens in K6_TOKENS`);
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[__VU - 1];
  const response = http.post(`${BASE_URL}/orders`, JSON.stringify({}), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `load-${RUN_ID}-vu-${__VU}`,
    },
    tags: { name: 'POST /orders' },
    timeout: '30s',
  });

  check(response, {
    'checkout returned 201': (r) => r.status === 201,
    'checkout returned an order ID': (r) => {
      try {
        return Boolean(JSON.parse(r.body).id);
      } catch {
        return false;
      }
    },
  });
}
