# E-commerce Checkout Load Test Report

**Date:** [date]  
**Commit:** [Git commit hash]  
**Environment:** [CPU, RAM, Docker, PostgreSQL, Redis]  
**Test:** Concurrent `POST /orders` requests using prepared user accounts and carts.

## 1. Objective

Find the first performance bottleneck in checkout before attempting a flash-sale workload. Inventory correctness must remain intact under concurrent requests.

## 2. Results

| Virtual users | Successful orders | Failed requests | p95 latency | Requests/sec |
| --- | --- | --- | --- | --- |
| 10 | [value] | [value] | [value] ms | [value] |
| 20 | [value] | [value] | [value] ms | [value] |
| 50 | [value] | [value] | [value] ms | [value] |
| 100 | [value] | [value] | [value] ms | [value] |

Record the queue waiting depth, database CPU, API CPU, and PostgreSQL lock waits for each run where available.

## 3. What I found

**First bottleneck:** [identify the component supported by the metrics]

**Evidence:** [p95 trend, error rate, queue depth, database wait events, or profiler output]

**Correctness:** [verify that no inventory became negative and order, movement, and idempotency records remained consistent]

## 4. What I changed

1. **Change:** [specific code or configuration change]
2. **Reason:** [evidence that justified the change]
3. **Result:** [rerun the same workload and compare p95, errors, throughput, and database behavior]

Do not change multiple unrelated variables between comparisons.

## 5. Remaining risks

- A single hot product can serialize inventory updates through row locks.
- More API instances may not improve throughput if PostgreSQL or inventory locks are already saturated.
- Queue backlogs can grow even when HTTP requests remain fast.
- A local test does not predict production flash-sale capacity by itself.

## Conclusion

The first measured bottleneck was **[component]**, supported by **[evidence]**. After changing **[specific item]**, p95 changed from **[before]** to **[after]**, while the inventory correctness tests **[passed/failed]**. The next test will focus on **[next bottleneck or higher load level]**.
