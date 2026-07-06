# Database Schema Summary

## User
```sql
id UUID PRIMARY KEY
clerk_user_id STRING UNIQUE (foreign ref to Clerk)
email STRING
name STRING?
role ENUM (cliente | admin)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

## Product
```sql
id UUID PRIMARY KEY
slug STRING UNIQUE
sku STRING UNIQUE
name STRING
category STRING
price_cents INT (never float!)
discount_pct INT (default 0)
stock INT (default 0)
reserved INT (default 0) -- CHECK: 0 <= reserved <= stock
is_active BOOLEAN (default true)
image_url STRING
description STRING
rating DECIMAL(2,1)
review_count INT
badge STRING?
created_at TIMESTAMPTZ
```

## Order
```sql
id INT AUTOINCREMENT (sequential ID: "#12345")
clerk_user_id STRING (foreign ref to Clerk)
customer_name STRING
customer_email STRING
customer_phone STRING
address_cep STRING
address_street STRING
address_city STRING
address_state STRING
subtotal_cents INT
discount_cents INT (product discount)
shipping_cents INT
total_cents INT (= subtotal - discount + shipping)
shipping_service STRING?
shipping_days STRING?
payment_status ENUM (pending | paid | cancelled)
payment_method STRING
shipping_status ENUM (pending | sent | delivered | cancelled)
internal_note STRING?
asaas_payment_id STRING UNIQUE (anti-replay)
asaas_customer_id STRING?
checkout_key STRING UNIQUE (idempotency)
coupon_code STRING?
coupon_discount_cents INT (coupon discount)
stock_reserved BOOLEAN (checkout flag)
stock_committed BOOLEAN (payment flag)
due_date TIMESTAMPTZ? (PIX expiration)
created_at TIMESTAMPTZ
```

## OrderItem
```sql
id UUID PRIMARY KEY
order_id INT (foreign key)
product_id UUID (foreign key)
product_name STRING (snapshot at purchase)
unit_price_cents INT (snapshot at purchase)
quantity INT
```

## AuditLog (IMMUTABLE)
```sql
id UUID PRIMARY KEY
action ENUM (product.create, product.update, product.inactivate, 
             order.payment_status_update, coupon.create, etc.)
entity_type ENUM (product | order | coupon | user)
entity_id STRING (accommodates UUID, INT, or any ID type)
before JSONB? (snapshot before)
after JSONB? (snapshot after)
actor_clerk_user_id STRING?
actor_email STRING?
actor_role ENUM (admin | cliente)?
request_id STRING?
ip STRING?
created_at TIMESTAMPTZ (@index for historical queries)
```

## Coupon
```sql
id UUID PRIMARY KEY
code STRING (@unique case-insensitive via LOWER index)
type ENUM (percent | fixed)
percent_off INT? (CHECK: required if type='percent')
value_cents INT? (CHECK: required if type='fixed')
min_subtotal_cents INT (default 0)
max_redemptions INT?
per_user_limit INT?
is_active BOOLEAN (default true)
starts_at TIMESTAMPTZ?
expires_at TIMESTAMPTZ?
redeemed_count INT (atomic increment)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

## CouponRedemption
```sql
id UUID PRIMARY KEY
coupon_id UUID (foreign key)
order_id INT UNIQUE (idempotency: one redemption per order)
clerk_user_id STRING
discount_cents INT (effective discount)
created_at TIMESTAMPTZ
```

## WebhookEvent (IDEMPOTENCY LEDGER)
```sql
id UUID PRIMARY KEY
provider STRING (Asaas, Clerk, etc.)
event_id STRING (provider's event ID)
type STRING
payload JSONB?
received_at TIMESTAMPTZ
processed_at TIMESTAMPTZ? (NULL = pending)
UNIQUE(provider, event_id)  -- Prevents duplicate processing
```

## Key Invariants
- `0 <= reserved <= stock` (CHECK constraint)
- `stockReserved = true` when order reserved items
- `stockCommitted = true` only after payment confirmed
- AuditLog can only INSERT (immutable)
- Coupon code is case-insensitive (LOWER index)
- CouponRedemption is idempotent per order (order_id @unique)
