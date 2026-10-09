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

Delivery drivers don't need SQL. Apply `supabase/migrations/20261008090000_delivery_drivers.sql`, deploy `oms-api` **after** the migration (its order queries embed the assigned driver), then use **Admin → Drivers**. The driver first signs up on the website. An admin then adds them by email, which grants the `delivery` role. Admins can edit, disable or re-enable drivers. Disabling removes access immediately and is refused while the driver still has open deliveries. Admin, staff or the driver can switch a shift on or off. Only active, on-shift drivers can be assigned. Admin and staff can assign or reassign any open delivery order. Drivers see unassigned ready orders and their own deliveries only. They can take an unassigned ready order, hand one back before leaving, and update or collect cash only on orders assigned to them. The Drivers page shows each driver's active orders, deliveries completed today and cash recorded today.

Supported employee roles: `staff`, `kitchen`, `delivery`, `admin`. Kitchen can confirm/start/ready orders and cannot read contact/address details. Delivery sees delivery orders ready/in transit/completed and can dispatch/complete them or record cash collected. Staff/admin handle support and analytics. Menu editing still uses the existing `profiles.role='admin'` permission.

## Menu categories

Apply `supabase/migrations/20260923061317_menu_categories.sql` after the baseline/OMS migration. Admins see **Edit categories** below the category bar. They can add, rename, remove (archive), and restore tabs. Category IDs stay stable when renamed, so dish assignments are preserved. Removing a tab never deletes its dishes: they remain visible in All and can be reassigned through the existing dish editor. All is a built-in filter, not a deletable category. Category writes are enforced by database RLS using the existing admin profile role. Public users have read-only access. Category changes appear on subsequent page loads.

`tests/categories-preview.html` is a local-only in-memory UI fixture (not a production build entry); database authorization is covered in `tests/oms.test.js`.

## Billing and invoices

Apply `supabase/migrations/20261009090000_billing_invoices.sql` **after** the delivery-drivers migration (credit notes use its `oms_actor_role`), then deploy `oms-api`. The migration can be re-run safely. Until it's applied, the updated `oms-api` still serves orders, and the admin hides Billing.

- Invoicing is **off** after the migration. An admin fills in **Settings → Invoices** (business name, address, GSTIN, FSSAI, prefix, SAC) and turns it on. Nothing is backfilled. An order that finished earlier can be invoiced from its order drawer (**Issue invoice**).
- A database trigger issues the invoice when an order is both `completed` and `paid`, whichever happens last. Numbers are `PREFIX/YY-YY/00001`, consecutive per financial year (April–March, India time), with no gaps. The counter is updated inside the same transaction, so a rollback also rolls back the number. Credit notes use `PREFIXC/YY-YY/00001`.
- Each invoice stores a snapshot of the seller, buyer, lines and totals. Invoices and credit notes can't be updated or deleted, by any role. To make a correction, an admin issues a credit note (Order drawer → Credit note) up to the uncredited amount. Credit notes don't move money: refund separately. Billing flags fully refunded orders whose invoices haven't been fully credited yet.
- Tax: the order's existing 5% is shown as CGST 2.5% + SGST 2.5% of the food subtotal, computed to the paisa. The difference from the whole-rupee `orders.tax` is shown as **Round off**, so invoice totals always equal `orders.total`. The delivery fee is printed as a separate, untaxed line, which is how orders are priced today.
- Staff and admins can view, print and export invoices (**Billing**, CSV by date range). Only admins change settings or issue credit notes. Customers get **View invoice** on their order tracking card. Guests use the tracking key already on their device. Nothing sensitive goes in the URL.
- `invoice.html?order=<id>` prints on A4 or as an 80 mm thermal receipt. Use the browser's Save as PDF for a file.

**Check with the restaurant's accountant before turning it on:** confirm a regular GST registration and the GSTIN (a composition-scheme restaurant must not charge GST and issues a "bill of supply"). Also confirm whether the delivery fee should carry GST, and whether the invoice format meets their requirements. Without a GSTIN, documents print as "Bill" rather than "Tax invoice".

## Counter billing

Apply `supabase/migrations/20261009150000_counter_billing.sql` after the billing migration, then deploy `oms-api`. It can be re-run safely.

- **Admin → Counter** (admins and staff) rings up walk-in **takeaway** or **dine-in** sales. Tap dishes (Qtr/Half/Full where priced), choose cash or UPI, optionally enter cash received to see the change, and confirm the payment.
- The server prices the sale with the same rules as online checkout (5% GST rounded to the rupee). It saves the order as `source='counter'`, confirmed for the kitchen and paid, all in one transaction. A retried request returns the same sale. Name and phone are optional; walk-ins show as "Walk-in customer".
- Counter sales are invoiced **as soon as they're paid**. Online orders still wait until they're completed. **Print bill** opens the 80 mm receipt and the print dialog. With invoicing off, the sale is still saved, but no bill is issued.
- Cancelling an invoiced order (counter or online) automatically issues a full credit note ("Order cancelled"). Return the money at the counter separately.
- UPI is recorded as its own payment method (`upi`) so cash and UPI totals can be reconciled in Reports.

## End-of-day cash count

Apply `supabase/migrations/20261009180000_cash_counts.sql` after the counter migration, then deploy `oms-api`. It can be re-run safely.

- **Admin → Counter → Close day** (admins and staff). Pick today or one of the last 7 days, enter the opening float (it defaults to the last float used), and type how many of each note and coin (₹500…₹1) are in the drawer.
- Expected cash is the opening float plus cash recorded as **received** that India day: counter cash sales, pay-at-counter orders staff marked paid, and cash drivers collected. Cash for paid orders cancelled that day is taken off, because it was handed back. UPI and Razorpay never count towards the drawer. UPI counter takings are shown separately so you can check them against the UPI app.
- Saving stores a permanent snapshot: the server recomputes the expected cash and the counted total from the note and coin counts, and records who counted. A count can't be edited or deleted. To recount, save another one; every count for the day is listed with its over/short amount.

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
