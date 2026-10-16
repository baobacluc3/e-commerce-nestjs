# Rate limiting

Redis-backed limits use atomic Lua scripts for both fixed windows and token buckets. Public product and category reads use fixed-window IP limits and fail open if Redis is unavailable. Login and registration, checkout and order changes, payment endpoints, and the payment webhook use token buckets and fail closed with `503` when Redis cannot be reached. Requests over a configured limit return `429` with `Retry-After`.

The app uses Express's default client-IP handling. If deploying behind a reverse proxy, configure `trust proxy` only for proxy addresses you operate; do not enable unrestricted proxy trust.

The Redis concurrency integration tests use `RATE_LIMIT_TEST_REDIS_URL` and are skipped when it is unset. Point it at a dedicated test Redis instance, then run `npx jest src/rate-limit/rate-limit.integration.spec.ts --runInBand`. Each algorithm test sends 10 concurrent requests with a limit of 5 and expects 5 allowed and 5 rejected; the test also checks that rejected decisions include a positive retry delay.
