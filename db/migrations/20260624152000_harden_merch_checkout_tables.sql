create index if not exists merch_customer_order_items_product_idx
  on public.merch_customer_order_items (product_id);

create index if not exists merch_payment_events_attempt_idx
  on public.merch_payment_events (payment_attempt_id);

create policy "No direct storefront access to customer orders"
  on public.merch_customer_orders
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "No direct storefront access to customer order items"
  on public.merch_customer_order_items
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "No direct storefront access to payment attempts"
  on public.merch_payment_attempts
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "No direct storefront access to payment events"
  on public.merch_payment_events
  for all
  to anon, authenticated
  using (false)
  with check (false);
