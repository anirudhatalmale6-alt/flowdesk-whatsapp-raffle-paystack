import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import {
  db, raffleCampaignsTable, raffleOrdersTable, raffleTicketsTable,
  rafflePaymentEventsTable, integrationSettingsTable,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getPaystackConfig, initializeTransaction, verifyTransaction,
  isValidSignature, digestBody, PaystackError, PAYSTACK_INTEGRATION_TYPE,
} from "../lib/paystack";
import {
  createPendingOrder, fulfilPaidOrder, expireStalePendingOrders,
  voidTicketsForOrder, ticketsRemaining, sendConfirmation,
} from "../lib/raffleFulfilment";
import { findConversationId } from "../lib/whatsapp";

const router: IRouter = Router();

// Set by the rawBody capture in app.ts. Paystack signs the bytes it sent, so
// the parsed body is not evidence of anything.
type RawBodyRequest = Request & { rawBody?: Buffer };

function newOrderRef(): string {
  return `ORD_${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function newPaymentReference(orderRef: string): string {
  // A fresh reference per attempt: Paystack will not accept a second
  // transaction under a reference it has already seen, so reusing the order
  // reference would make a retry after a failed card impossible.
  return `${orderRef}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// ── Campaigns (admin) ───────────────────────────────────────────────────────

router.get("/raffle/campaigns", async (_req, res): Promise<void> => {
  const campaigns = await db
    .select()
    .from(raffleCampaignsTable)
    .orderBy(desc(raffleCampaignsTable.createdAt));
  const withCounts = await Promise.all(campaigns.map(async (c) => ({
    ...c,
    ticketsRemaining: await ticketsRemaining(c.id),
  })));
  res.json(withCounts);
});

router.post("/raffle/campaigns", async (req, res): Promise<void> => {
  const {
    name, ticketPriceMinor, currency, ticketPrefix, ticketNumberPadding,
    maxTickets, maxTicketsPerOrder, maxTicketsPerPerson,
    opensAt, closesAt, drawAt, orderTtlMinutes,
    confirmationTemplateName, confirmationTemplateLanguage, confirmationMessage,
  } = req.body ?? {};

  if (!name) { res.status(400).json({ error: "Name required" }); return; }

  const slug = String(name).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    + "-" + Date.now();

  const [campaign] = await db.insert(raffleCampaignsTable).values({
    name,
    slug,
    ticketPriceMinor: ticketPriceMinor ?? 8900,
    currency: currency ?? "ZAR",
    ticketPrefix: ticketPrefix ?? "TKT",
    ticketNumberPadding: ticketNumberPadding ?? 5,
    maxTickets: maxTickets ?? null,
    maxTicketsPerOrder: maxTicketsPerOrder ?? 1,
    maxTicketsPerPerson: maxTicketsPerPerson ?? null,
    opensAt: opensAt ? new Date(opensAt) : null,
    closesAt: closesAt ? new Date(closesAt) : null,
    drawAt: drawAt ? new Date(drawAt) : null,
    orderTtlMinutes: orderTtlMinutes ?? 60,
    confirmationTemplateName: confirmationTemplateName ?? null,
    confirmationTemplateLanguage: confirmationTemplateLanguage ?? "en",
    confirmationMessage: confirmationMessage ?? null,
  }).returning();

  res.status(201).json(campaign);
});

router.put("/raffle/campaigns/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const key of [
    "name", "ticketPriceMinor", "currency", "ticketPrefix", "ticketNumberPadding",
    "maxTickets", "maxTicketsPerOrder", "maxTicketsPerPerson", "status",
    "orderTtlMinutes", "confirmationTemplateName", "confirmationTemplateLanguage",
    "confirmationMessage",
  ]) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  for (const key of ["opensAt", "closesAt", "drawAt"]) {
    if (b[key] !== undefined) patch[key] = b[key] ? new Date(b[key]) : null;
  }

  const [updated] = await db.update(raffleCampaignsTable)
    .set(patch)
    .where(eq(raffleCampaignsTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.get("/raffle/campaigns/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [campaign] = await db.select().from(raffleCampaignsTable).where(eq(raffleCampaignsTable.id, id));
  if (!campaign) { res.status(404).json({ error: "Not found" }); return; }

  const orders = await db.select().from(raffleOrdersTable)
    .where(eq(raffleOrdersTable.campaignId, id))
    .orderBy(desc(raffleOrdersTable.createdAt))
    .limit(100);

  const [stats] = await db
    .select({
      sold: sql<number>`COUNT(*) FILTER (WHERE ${raffleTicketsTable.status} = 'active')`,
      voided: sql<number>`COUNT(*) FILTER (WHERE ${raffleTicketsTable.status} = 'void')`,
    })
    .from(raffleTicketsTable)
    .where(eq(raffleTicketsTable.campaignId, id));

  res.json({
    ...campaign,
    ticketsRemaining: await ticketsRemaining(id),
    stats: { sold: Number(stats?.sold ?? 0), voided: Number(stats?.voided ?? 0) },
    orders,
  });
});

// The draw list. Only active tickets, in sequence, so the result is
// reproducible by anyone holding the same export.
router.get("/raffle/campaigns/:id/tickets", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const includeVoid = req.query.includeVoid === "true";
  const rows = await db
    .select({
      ticketNumber: raffleTicketsTable.ticketNumber,
      sequence: raffleTicketsTable.sequence,
      status: raffleTicketsTable.status,
      orderRef: raffleOrdersTable.orderRef,
      customerName: raffleOrdersTable.customerName,
      customerEmail: raffleOrdersTable.customerEmail,
      waUserId: raffleOrdersTable.waUserId,
      paidAt: raffleOrdersTable.paidAt,
    })
    .from(raffleTicketsTable)
    .innerJoin(raffleOrdersTable, eq(raffleTicketsTable.orderId, raffleOrdersTable.id))
    .where(includeVoid
      ? eq(raffleTicketsTable.campaignId, id)
      : and(eq(raffleTicketsTable.campaignId, id), eq(raffleTicketsTable.status, "active")))
    .orderBy(raffleTicketsTable.sequence);
  res.json(rows);
});

// ── Buying a ticket ─────────────────────────────────────────────────────────

router.post("/raffle/orders", async (req, res): Promise<void> => {
  const { campaignId, campaignSlug, waUserId, customerName, customerEmail, quantity } = req.body ?? {};

  if (!waUserId || !customerName || !customerEmail) {
    res.status(400).json({ error: "waUserId, customerName and customerEmail are required" });
    return;
  }

  const [campaign] = campaignId
    ? await db.select().from(raffleCampaignsTable).where(eq(raffleCampaignsTable.id, Number(campaignId)))
    : await db.select().from(raffleCampaignsTable).where(eq(raffleCampaignsTable.slug, String(campaignSlug ?? "")));
  if (!campaign) { res.status(404).json({ error: "Raffle not found" }); return; }

  const cfg = await getPaystackConfig();
  if (!cfg) {
    res.status(503).json({ error: "Payments are not configured yet" });
    return;
  }

  const created = await createPendingOrder({
    campaign,
    waUserId: String(waUserId),
    conversationId: await findConversationId(String(waUserId)),
    customerName: String(customerName),
    customerEmail: String(customerEmail),
    quantity: Number(quantity ?? 1),
    orderRef: newOrderRef(),
  });

  if (!created.ok) {
    res.status(409).json({ error: created.detail, reason: created.reason });
    return;
  }

  const order = created.order;
  const reference = newPaymentReference(order.orderRef);

  try {
    const init = await initializeTransaction(cfg, {
      email: order.customerEmail,
      amountMinor: order.amountMinor,
      currency: order.currency,
      reference,
      metadata: {
        order_ref: order.orderRef,
        order_id: order.id,
        campaign_id: campaign.id,
        wa_user_id: order.waUserId,
        custom_fields: [
          { display_name: "Order", variable_name: "order_ref", value: order.orderRef },
        ],
      },
    });

    const [updated] = await db.update(raffleOrdersTable).set({
      paymentReference: init.reference,
      authorizationUrl: init.authorizationUrl,
    }).where(eq(raffleOrdersTable.id, order.id)).returning();

    res.status(201).json({
      orderRef: updated.orderRef,
      amountMinor: updated.amountMinor,
      currency: updated.currency,
      quantity: updated.quantity,
      status: updated.status,
      payUrl: updated.authorizationUrl,
      expiresAt: updated.expiresAt,
    });
  } catch (err) {
    // The order exists but has no checkout link, so nothing can be paid
    // against it. Close it now rather than leaving a hold on a ticket.
    await db.update(raffleOrdersTable).set({
      status: "CANCELLED",
      failureReason: err instanceof PaystackError ? err.message : "Could not start payment",
    }).where(eq(raffleOrdersTable.id, order.id));

    logger.error({ err, orderRef: order.orderRef }, "Paystack initialise failed");
    res.status(502).json({ error: "Could not start the payment. Please try again." });
  }
});

router.get("/raffle/orders/:orderRef", async (req, res): Promise<void> => {
  const [order] = await db.select().from(raffleOrdersTable)
    .where(eq(raffleOrdersTable.orderRef, req.params.orderRef));
  if (!order) { res.status(404).json({ error: "Not found" }); return; }
  const tickets = await db.select({ ticketNumber: raffleTicketsTable.ticketNumber, status: raffleTicketsTable.status })
    .from(raffleTicketsTable)
    .where(eq(raffleTicketsTable.orderId, order.id));
  res.json({ ...order, tickets });
});

// ── Paystack webhook ────────────────────────────────────────────────────────

router.post("/raffle/webhook/paystack", async (req, res): Promise<void> => {
  const raw = (req as RawBodyRequest).rawBody;
  const signature = req.header("x-paystack-signature");

  const cfg = await getPaystackConfig();
  if (!cfg) {
    logger.error("Paystack webhook arrived but no Paystack credentials are configured");
    res.status(503).send();
    return;
  }

  if (!raw) {
    // Without the raw bytes there is nothing to check the signature against,
    // and an unverified webhook must never be allowed to move money.
    logger.error("Paystack webhook arrived without a raw body — rawBody capture is not wired up");
    res.status(500).send();
    return;
  }

  const valid = isValidSignature(raw, signature, cfg.secretKey);
  const digest = digestBody(raw);
  const body = (req.body ?? {}) as any;
  const eventType = String(body?.event ?? "unknown");
  const reference = body?.data?.reference ? String(body.data.reference) : null;

  // Recorded before it is acted on — including the ones that fail the
  // signature check, because those are the interesting ones.
  const [inserted] = await db.insert(rafflePaymentEventsTable).values({
    provider: "paystack",
    eventType,
    reference,
    bodyDigest: digest,
    signatureValid: valid,
    payload: body,
  }).onConflictDoNothing().returning();

  if (!valid) {
    logger.warn({ eventType, reference }, "Rejected a Paystack webhook with an invalid signature");
    res.status(401).send();
    return;
  }

  let event = inserted;
  if (!event) {
    // Byte-identical to one already seen. If it was processed, this is a
    // duplicate and the answer is simply 200. If it was not, an earlier
    // attempt failed and this retry is the second chance.
    const [existing] = await db.select().from(rafflePaymentEventsTable)
      .where(and(
        eq(rafflePaymentEventsTable.provider, "paystack"),
        eq(rafflePaymentEventsTable.bodyDigest, digest),
      ));
    if (!existing || existing.processed) {
      res.status(200).send();
      return;
    }
    event = existing;
  }

  if (eventType !== "charge.success") {
    await db.update(rafflePaymentEventsTable)
      .set({ processed: true, outcome: "ignored" })
      .where(eq(rafflePaymentEventsTable.id, event.id));
    res.status(200).send();
    return;
  }

  if (!reference) {
    await db.update(rafflePaymentEventsTable)
      .set({ processed: true, outcome: "no_reference" })
      .where(eq(rafflePaymentEventsTable.id, event.id));
    res.status(200).send();
    return;
  }

  try {
    // The signature proves Paystack sent it. This asks Paystack what it
    // actually holds, which is the only thing worth fulfilling against.
    const verified = await verifyTransaction(cfg, reference);
    const result = await fulfilPaidOrder(verified);

    await db.update(rafflePaymentEventsTable)
      .set({ processed: true, outcome: result.outcome })
      .where(eq(rafflePaymentEventsTable.id, event.id));

    if (result.outcome === "refund_required") {
      logger.error(
        { orderRef: result.orderRef, reference, detail: result.detail },
        "Payment taken for a raffle that can no longer issue a ticket — refund needed",
      );
    }
    if (result.outcome === "amount_mismatch" || result.outcome === "currency_mismatch") {
      logger.error({ reference, outcome: result.outcome }, "Paystack payment did not match the order");
    }

    res.status(200).send();
  } catch (err) {
    // Left unprocessed on purpose: Paystack retries on a non-2xx, and the
    // duplicate guard above lets an unprocessed event through to try again.
    await db.update(rafflePaymentEventsTable)
      .set({ outcome: "error", processed: false })
      .where(eq(rafflePaymentEventsTable.id, event.id));
    logger.error({ err, reference }, "Failed to process a Paystack webhook");
    res.status(500).send();
  }
});

// ── Operations ──────────────────────────────────────────────────────────────

router.post("/raffle/maintenance/sweep", async (_req, res): Promise<void> => {
  const expired = await expireStalePendingOrders();
  res.json({ expired });
});

router.post("/raffle/orders/:id/void-tickets", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const reason = String(req.body?.reason ?? "refunded");
  const voided = await voidTicketsForOrder(id, reason);
  await db.update(raffleOrdersTable)
    .set({ status: "REFUNDED", failureReason: reason })
    .where(eq(raffleOrdersTable.id, id));
  res.json({ voided });
});

router.post("/raffle/orders/:id/resend-confirmation", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const channel = await sendConfirmation(id);
  res.json({ channel });
});

// ── Paystack credentials ────────────────────────────────────────────────────

function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length <= 12 ? "•".repeat(key.length) : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

router.get("/raffle/paystack", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(integrationSettingsTable)
    .where(eq(integrationSettingsTable.type, PAYSTACK_INTEGRATION_TYPE));
  const cfg = (row?.config ?? {}) as Record<string, string>;
  // Never echo the secret key back, not even to an authenticated caller — it
  // ends up in browser history, screenshots and support tickets.
  res.json({
    connected: Boolean(cfg.secretKey),
    mode: cfg.mode ?? (cfg.secretKey?.startsWith("sk_live_") ? "live" : "test"),
    secretKey: maskKey(cfg.secretKey),
    publicKey: cfg.publicKey ?? null,
    callbackUrl: cfg.callbackUrl ?? null,
  });
});

router.put("/raffle/paystack", async (req, res): Promise<void> => {
  const { secretKey, publicKey, callbackUrl } = req.body ?? {};
  if (!secretKey || typeof secretKey !== "string") {
    res.status(400).json({ error: "secretKey is required" });
    return;
  }
  if (!/^sk_(test|live)_/.test(secretKey)) {
    res.status(400).json({ error: "That does not look like a Paystack secret key (expected sk_test_… or sk_live_…)" });
    return;
  }
  const mode = secretKey.startsWith("sk_live_") ? "live" : "test";
  const config = { secretKey, publicKey: publicKey ?? null, callbackUrl: callbackUrl ?? null, mode };

  await db.insert(integrationSettingsTable)
    .values({ type: PAYSTACK_INTEGRATION_TYPE, config, isConnected: true })
    .onConflictDoUpdate({
      target: integrationSettingsTable.type,
      set: { config, isConnected: true },
    });

  logger.info({ mode }, "Paystack credentials updated");
  res.json({ connected: true, mode, secretKey: maskKey(secretKey) });
});

export default router;
