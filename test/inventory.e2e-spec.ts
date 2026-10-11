it('never oversells under 50 concurrent reservations for 10 units', async () => {
  await admin.post('/inventory/products')
    .send({ sku: 'RACE-1', name: 'Race', initialStock: 10 }).expect(201);

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      users[i % users.length].post('/inventory/reservations')
        .set('Idempotency-Key', `key-${i}-xxxxxxxx`)
        .send({ items: [{ sku: 'RACE-1', quantity: 1 }] }),
    ),
  );

  expect(results.filter((r) => r.status === 201)).toHaveLength(10);
  expect(results.filter((r) => r.status === 409)).toHaveLength(40);

  const stock = await admin.get('/inventory/products/RACE-1').expect(200);
  expect(stock.body).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
});

it('replaying an Idempotency-Key returns the same reservation without double-holding', async () => {
  const body = { items: [{ sku: 'IDEM-1', quantity: 2 }] };
  const [a, b] = await Promise.all([1, 2].map(() =>
    user.post('/inventory/reservations').set('Idempotency-Key', 'same-key-123').send(body)));
  expect(a.body.id).toBe(b.body.id);
  expect((await admin.get('/inventory/products/IDEM-1')).body.reserved).toBe(2);
});