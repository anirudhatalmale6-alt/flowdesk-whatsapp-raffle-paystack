import {
  pgTable, serial, text, timestamp, integer, boolean, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// A raffle is not a booking and not a webform submission: money changes hands,
// and a ticket number is a claim on a prize. Everything below exists so that
// one payment can only ever produce one entry, and so that an entry can be
// traced back to the payment that bought it long after the draw.

export const raffleCampaignsTable = pgTable("raffle_campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Minor units throughout — Paystack is charged in cents and floats have no
  // business anywhere near a price.
  ticketPriceMinor: integer("ticket_price_minor").notNull().default(8900),
  currency: text("currency").notNull().default("ZAR"),
  ticketPrefix: text("ticket_prefix").notNull().default("TKT"),
  ticketNumberPadding: integer("ticket_number_padding").notNull().default(5),
  // NULL means no cap. A cap of 0 would mean "sold out before it opened".
  maxTickets: integer("max_tickets"),
  maxTicketsPerOrder: integer("max_tickets_per_order").notNull().default(1),
  maxTicketsPerPerson: integer("max_tickets_per_person"),
  opensAt: timestamp("opens_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  drawAt: timestamp("draw_at", { withTimezone: true }),
  // draft | live | closed
  status: text("status").notNull().default("draft"),
  // Denormalised counter for display only. raffle_tickets is the truth.
  ticketsAllocated: integer("tickets_allocated").notNull().default(0),
  // How long a customer has to pay before the order is swept away, so an
  // abandoned checkout cannot hold a place in a capped raffle forever.
  orderTtlMinutes: integer("order_ttl_minutes").notNull().default(60),
  // Used when the confirmation falls outside WhatsApp's 24-hour window, where
  // a free-form message is not deliverable and only an approved template is.
  confirmationTemplateName: text("confirmation_template_name"),
  confirmationTemplateLanguage: text("confirmation_template_language").notNull().default("en"),
  confirmationMessage: text("confirmation_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const raffleOrdersTable = pgTable("raffle_orders", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  // Customer-facing, and the value put into Paystack metadata.
  orderRef: text("order_ref").notNull().unique(),
  waUserId: text("wa_user_id").notNull(),
  conversationId: integer("conversation_id"),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  quantity: integer("quantity").notNull().default(1),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull().default("ZAR"),
  // PENDING_PAYMENT → PAYMENT_VERIFIED → COMPLETE
  // terminal: DECLINED | CANCELLED | EXPIRED | REFUNDED
  status: text("status").notNull().default("PENDING_PAYMENT"),
  paymentProvider: text("payment_provider").notNull().default("paystack"),
  // The unique index here is the actual defence against a duplicated webhook
  // creating a second order for one payment — not the code that checks it.
  paymentReference: text("payment_reference"),
  authorizationUrl: text("authorization_url"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  failureReason: text("failure_reason"),
  confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
  // session | template | pending | failed — how the customer was told, so an
  // undelivered confirmation is visible rather than merely absent.
  confirmationChannel: text("confirmation_channel"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("raffle_orders_payment_reference_key").on(table.paymentReference),
  index("raffle_orders_sweep_idx").on(table.status, table.expiresAt),
  index("raffle_orders_wa_user_idx").on(table.campaignId, table.waUserId),
]);

export const raffleTicketsTable = pgTable("raffle_tickets", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  orderId: integer("order_id").notNull(),
  // Gapless within a campaign, allocated under an advisory lock. The unique
  // index is what makes that guarantee real under concurrency.
  sequence: integer("sequence").notNull(),
  ticketNumber: text("ticket_number").notNull(),
  // active | void — a refunded ticket must not be able to win, and deleting it
  // would leave a hole in a sequence people can count.
  status: text("status").notNull().default("active"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("raffle_tickets_campaign_sequence_key").on(table.campaignId, table.sequence),
  uniqueIndex("raffle_tickets_campaign_number_key").on(table.campaignId, table.ticketNumber),
  index("raffle_tickets_order_idx").on(table.orderId),
]);

// Every webhook that arrives is written here before it is acted on, valid or
// not. When someone asks in six months why an order completed, this is the
// answer — and a rejected signature is evidence, so it is kept too.
export const rafflePaymentEventsTable = pgTable("raffle_payment_events", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("paystack"),
  eventType: text("event_type").notNull(),
  reference: text("reference"),
  // sha512 of the raw body: Paystack sends no event id, and a retry of the
  // same event is byte-identical.
  bodyDigest: text("body_digest").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  processed: boolean("processed").notNull().default(false),
  outcome: text("outcome"),
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("raffle_payment_events_digest_key").on(table.provider, table.bodyDigest),
  index("raffle_payment_events_reference_idx").on(table.reference),
]);

export type RaffleCampaign = typeof raffleCampaignsTable.$inferSelect;
export type RaffleOrder = typeof raffleOrdersTable.$inferSelect;
export type RaffleTicket = typeof raffleTicketsTable.$inferSelect;
export type RafflePaymentEvent = typeof rafflePaymentEventsTable.$inferSelect;
