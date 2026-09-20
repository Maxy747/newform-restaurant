# Restaurant ordering and operations

The customer site and existing visual menu editor stay static on GitHub Pages. Supabase Postgres, Auth, Realtime and Edge Functions provide the backend. No Node server, Django service, or payment secret is needed on Pages.

## Features

- Guest or signed-in checkout for delivery, takeaway and dine-in; table/address validation.
- Server-priced portions and quantities, immutable purchase snapshots, 5% GST rounded as before, COD minimum ₹1,000.
- Retry-safe order creation; guest tracking keys stay on the customer's device. Logged-in customers also have server-backed order history.
- Saved contact/address summary with Change address. Profile updates cannot change roles.
- Restaurant dashboard, kitchen board, delivery view, date/status/payment/type filters, pagination, date-range analytics and top items.
- Sequential role-checked lifecycle: placed → confirmed → cooking → ready → out for delivery (delivery only) → completed. Payment and fulfilment remain independent.
- Order-specific support tickets, customer/staff replies, progress/resolution and reopening after a customer reply.
- Realtime notifications for authenticated users, with 15-second polling recovery while a relevant screen is open; guest tracking polls every 15 seconds.
- Razorpay Orders/Checkout, server HMAC verification, canonical captured-payment check and idempotent webhooks. An unverified browser callback cannot mark an order paid.

## Deploy / upgrade

1. Back up the database first. The local pre-upgrade backup is in `output/backups/newform-before-oms-20260920-161300/`; it must never be committed.
2. Existing projects: run `supabase/migrations/20260920114250_restaurant_order_management.sql` once. New projects: run `supabase_schema.sql` as the baseline FIRST. **Never rerun the baseline after the upgrade**: it contains legacy browser-write policies.
3. Deploy `oms-api` and `razorpay-webhook` using the pinned CLI. Both have `verify_jwt=false` because guests/provider webhooks do not carry a user JWT. `oms-api` explicitly verifies user tokens using Auth and checks each order's ownership or hashed guest key. The webhook explicitly verifies its raw-body Razorpay HMAC.
4. Default allowed browser origin is `https://maxy747.github.io`. For another host, set the Edge secret `SITE_ORIGIN` to that exact origin. Do not include a path or trailing slash.
5. Run `npm test` and `npm run build`, then deploy Pages. The existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` remain the only browser configuration.
6. Check Supabase security advisors and the read-only smoke checks. Do not create fake production orders for testing. `tests/oms.test.js` uses an isolated, in-memory PostgreSQL instance.

Useful commands (replace the project reference only for an intentionally different project):

```powershell
npx supabase db query --linked --project-ref crlivalipmeypovsubca --file supabase/migrations/20260920114250_restaurant_order_management.sql
npx supabase functions deploy oms-api razorpay-webhook --project-ref crlivalipmeypovsubca --use-api
npx supabase db advisors --linked --project-ref crlivalipmeypovsubca --type security
```

The SQL file is a one-time upgrade, not an idempotent seed. Check whether `public.restaurant_roles` already exists before applying it. Record application in migration history using the CLI's migration repair command when linking this previously SQL-editor-managed project; don't replay the baseline against production.

## Staff accounts

Existing `profiles.role='admin'` accounts retain restaurant access and menu editing. The old `profiles.role='staff'` value was used for CUSTOMERS, so it deliberately grants **no** restaurant permissions.

Grant a real employee a role explicitly from an authorized database session after creating their Auth account:

```sql
insert into public.restaurant_roles(user_id,role)
select id,'kitchen' from auth.users where email='employee@example.com'
on conflict(user_id) do update set role=excluded.role;
```

Supported employee roles: `staff`, `kitchen`, `delivery`, `admin`. Kitchen can confirm/start/ready orders and cannot read contact/address details. Delivery sees delivery orders ready/in transit/completed and can dispatch/complete them or record cash collected. Staff/admin handle support and analytics. Menu editing still uses the existing `profiles.role='admin'` permission.

## Razorpay activation (credentials still required)

Set these **Supabase Edge secrets**, never Vite variables or committed files:

```text
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET
```

Use Razorpay test keys first. The site labels test checkout, and keeps online payment disabled until all three are configured. No fake success mode exists. Enable automatic capture in Razorpay or arrange capture separately: authorized-but-uncaptured payments stay pending.

Register the webhook URL `https://crlivalipmeypovsubca.supabase.co/functions/v1/razorpay-webhook` for `payment.captured`, `payment.failed`, and `refund.processed`, using the same webhook secret. Test success, failure, retries, a closed browser, duplicate events, delayed events and refunds before switching to live keys. Actual money movement/refunds must be initiated through Razorpay by an authorized operator; cancellation does not automatically refund.

If creating the provider order times out, the backend retains a creation claim instead of risking duplicate provider orders. Reconcile using the restaurant UUID stored as the Razorpay receipt, set the correct `razorpay_order_id` in `payments`, or clear `creation_started_at` only after confirming no provider order was created. Never create a second restaurant order to retry payment.

Partial refunds retain `paid` with `refunded_paise` tracked; full refunds become `refunded`. Revenue currently reports the totals of fully paid orders, not net accounting revenue after partial refunds.

## Email sign-up

Enable Email, signups and email confirmation in Supabase Auth, with the Pages URL and redirect allow-list configured. For general public signup, configure a production SMTP provider: Supabase's default mail service restricts recipients and is not a public production mail service. The site includes resend-verification and clear delivery errors, but it cannot repair missing SMTP credentials. Keep email confirmation on.

## Safety and recovery

Private backend tables use RLS and no customer grants. Internal write RPCs use SECURITY INVOKER and are executable only by service_role. Guest access tokens are random 256-bit capabilities, stored as hashes server-side; don't share or log them. Anyone with access to a customer's browser storage can access that device's guest receipts.

Public guest ordering is rate-limited; monitor abuse and configure CAPTCHA/edge filtering if needed for production traffic. Supabase's gateway-provided forwarding address is used for the guest rate bucket. No payment card details are stored.

The migration preserves historical `orders.items` JSON and the current menu; new orders additionally populate normalized `order_items`. Existing guest orders have no recoverable tracking token and cannot be claimed simply by knowing an order ID.

Frontend rollback alone is **not** a backend rollback: legacy checkout wrote orders directly and those grants are intentionally revoked. Prefer a forward fix or temporarily disable ordering. Do not restore old permissive grants to work around an error.

Local UI fixture: `npm run dev`, then `/tests/cart-preview.html` exercises the real saved-address UI against an in-memory test adapter. This fixture is not included in the production build.
