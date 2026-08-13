-- Raffle ticket sales over WhatsApp, paid through Paystack.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS raffle_campaigns (
  id                             serial PRIMARY KEY,
  name                           text NOT NULL,
  slug                           text NOT NULL UNIQUE,
  ticket_price_minor             integer NOT NULL DEFAULT 8900,
  currency                       text NOT NULL DEFAULT 'ZAR',
  ticket_prefix                  text NOT NULL DEFAULT 'TKT',
  ticket_number_padding          integer NOT NULL DEFAULT 5,
  max_tickets                    integer,
  max_tickets_per_order          integer NOT NULL DEFAULT 1,
  max_tickets_per_person         integer,
  opens_at                       timestamptz,
  closes_at                      timestamptz,
  draw_at                        timestamptz,
  status                         text NOT NULL DEFAULT 'draft',
  tickets_allocated              integer NOT NULL DEFAULT 0,
  order_ttl_minutes              integer NOT NULL DEFAULT 60,
  confirmation_template_name     text,
  confirmation_template_language text NOT NULL DEFAULT 'en',
  confirmation_message           text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raffle_orders (
  id                   serial PRIMARY KEY,
  campaign_id          integer NOT NULL,
  order_ref            text NOT NULL UNIQUE,
  wa_user_id           text NOT NULL,
  conversation_id      integer,
  customer_name        text NOT NULL,
  customer_email       text NOT NULL,
  quantity             integer NOT NULL DEFAULT 1,
  amount_minor         integer NOT NULL,
  currency             text NOT NULL DEFAULT 'ZAR',
  status               text NOT NULL DEFAULT 'PENDING_PAYMENT',
  payment_provider     text NOT NULL DEFAULT 'paystack',
  payment_reference    text,
  authorization_url    text,
  paid_at              timestamptz,
  expires_at           timestamptz NOT NULL,
  failure_reason       text,
  confirmation_sent_at timestamptz,
  confirmation_channel text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- One payment reference can belong to exactly one order. This, not any check
-- in the application, is what stops a duplicated webhook creating a second
-- order for the same money. NULLs are allowed and repeatable, which is what a
-- pending order that has not reached the gateway yet needs.
CREATE UNIQUE INDEX IF NOT EXISTS raffle_orders_payment_reference_key
  ON raffle_orders (payment_reference);
CREATE INDEX IF NOT EXISTS raffle_orders_sweep_idx
  ON raffle_orders (status, expires_at);
CREATE INDEX IF NOT EXISTS raffle_orders_wa_user_idx
  ON raffle_orders (campaign_id, wa_user_id);

CREATE TABLE IF NOT EXISTS raffle_tickets (
  id            serial PRIMARY KEY,
  campaign_id   integer NOT NULL,
  order_id      integer NOT NULL,
  sequence      integer NOT NULL,
  ticket_number text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  voided_at     timestamptz,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Gapless and unique per campaign. Allocation takes an advisory lock first;
-- these indexes are the backstop that makes the guarantee hold even if two
-- processes ever race past it.
CREATE UNIQUE INDEX IF NOT EXISTS raffle_tickets_campaign_sequence_key
  ON raffle_tickets (campaign_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS raffle_tickets_campaign_number_key
  ON raffle_tickets (campaign_id, ticket_number);
CREATE INDEX IF NOT EXISTS raffle_tickets_order_idx
  ON raffle_tickets (order_id);

CREATE TABLE IF NOT EXISTS raffle_payment_events (
  id              serial PRIMARY KEY,
  provider        text NOT NULL DEFAULT 'paystack',
  event_type      text NOT NULL,
  reference       text,
  body_digest     text NOT NULL,
  signature_valid boolean NOT NULL,
  processed       boolean NOT NULL DEFAULT false,
  outcome         text,
  payload         jsonb,
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- A Paystack retry is byte-identical to the original, and Paystack sends no
-- event id of its own, so the digest of the raw body is the event identity.
CREATE UNIQUE INDEX IF NOT EXISTS raffle_payment_events_digest_key
  ON raffle_payment_events (provider, body_digest);
CREATE INDEX IF NOT EXISTS raffle_payment_events_reference_idx
  ON raffle_payment_events (reference);
