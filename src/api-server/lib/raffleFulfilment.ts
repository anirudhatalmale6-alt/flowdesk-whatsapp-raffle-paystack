import {
  db, raffleCampaignsTable, raffleOrdersTable, raffleTicketsTable,
} from "@workspace/db";
import { eq, and, sql, inArray, lt, gt } from "drizzle-orm";
import { logger } from "./logger";
import {
  getWhatsAppSettings, sendWhatsAppText, sendWhatsAppTemplate,
  isWithinSessionWindow, recordOutboundMessage,
} from "./whatsapp";
import type { VerifiedTransaction } from "./paystack";

// A private namespace for advisory locks so a campaign's ticket allocation is
// serialised without locking anything else in the database.
const TICKET_LOCK_NAMESPACE = 748291;

export type FulfilOutcome =
  | "completed"
  | "already_complete"
  | "unknown_reference"
  | "amount_mismatch"
  | "currency_mismatch"
  | "sold_out"
  | "refund_required"
  | "not_successful";

export interface FulfilResult {
  outcome: FulfilOutcome;
  orderId?: number;
  orderRef?: string;
  ticketNumbers?: string[];
  detail?: string;
}

export function formatTicketNumber(prefix: string, padding: number, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(Math.max(1, padding), "0")}`;
}

// Capacity counts allocated tickets AND the tickets held by orders that are
// still within their payment window. Without the second half, the last ten
// tickets can be checked out by a hundred people and every one of them pays.
type DbLike = typeof db;

async function countHeldAndAllocated(
  tx: DbLike,
  campaignId: number,
  now: Date,
): Promise<number> {
  const [heldRow] = await tx
    .select({ n: sql<number>`COALESCE(SUM(${raffleOrdersTable.quantity}), 0)` })
    .from(raffleOrdersTable)
    .where(and(
      eq(raffleOrdersTable.campaignId, campaignId),
      inArray(raffleOrdersTable.status, ["PENDING_PAYMENT", "PAYMENT_VERIFIED"]),
      gt(raffleOrdersTable.expiresAt, now),
    ));

  const [allocatedRow] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(raffleTicketsTable)
    .where(and(
      eq(raffleTicketsTable.campaignId, campaignId),
      eq(raffleTicketsTable.status, "active"),
    ));

  return Number(heldRow?.n ?? 0) + Number(allocatedRow?.n ?? 0);
}

export interface CreateOrderArgs {
  campaign: typeof raffleCampaignsTable.$inferSelect;
  waUserId: string;
  conversationId: number | null;
  customerName: string;
  customerEmail: string;
  quantity: number;
  orderRef: string;
  now?: Date;
}

export type CreateOrderResult =
  | { ok: true; order: typeof raffleOrdersTable.$inferSelect }
  | { ok: false; reason: "not_open" | "closed" | "sold_out" | "per_person_limit" | "per_order_limit"; detail: string };

export async function createPendingOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
  const now = args.now ?? new Date();
  const c = args.campaign;

  if (c.status !== "live") {
    return { ok: false, reason: "not_open", detail: "This raffle is not open yet." };
  }
  if (c.opensAt && now < c.opensAt) {
    return { ok: false, reason: "not_open", detail: "This raffle has not opened yet." };
  }
  // Checked before the order exists, not after the payment: Paystack will
  // happily take money for a raffle that closed an hour ago, and refunding it
  // is a conversation nobody wants to have with a donor.
  if (c.closesAt && now >= c.closesAt) {
    return { ok: false, reason: "closed", detail: "This raffle has closed." };
  }
  if (args.quantity < 1 || args.quantity > c.maxTicketsPerOrder) {
    return {
      ok: false,
      reason: "per_order_limit",
      detail: `You can buy between 1 and ${c.maxTicketsPerOrder} tickets in one order.`,
    };
  }

  const expiresAt = new Date(now.getTime() + c.orderTtlMinutes * 60 * 1000);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${TICKET_LOCK_NAMESPACE}, ${c.id})`);

      if (c.maxTickets != null) {
        const taken = await countHeldAndAllocated(tx as unknown as DbLike, c.id, now);
        if (taken + args.quantity > c.maxTickets) {
          const left = Math.max(0, c.maxTickets - taken);
          return {
            ok: false as const,
            reason: "sold_out" as const,
            detail: left === 0
              ? "All tickets have been taken."
              : `Only ${left} ticket${left === 1 ? "" : "s"} left.`,
          };
        }
      }

      if (c.maxTicketsPerPerson != null) {
        const [row] = await tx
          .select({
            n: sql<number>`COALESCE(SUM(${raffleOrdersTable.quantity}), 0)`,
          })
          .from(raffleOrdersTable)
          .where(and(
            eq(raffleOrdersTable.campaignId, c.id),
            eq(raffleOrdersTable.waUserId, args.waUserId),
            inArray(raffleOrdersTable.status, ["PENDING_PAYMENT", "PAYMENT_VERIFIED", "COMPLETE"]),
          ));
        const already = Number(row?.n ?? 0);
        if (already + args.quantity > c.maxTicketsPerPerson) {
          return {
            ok: false as const,
            reason: "per_person_limit" as const,
            detail: `There is a limit of ${c.maxTicketsPerPerson} tickets per person.`,
          };
        }
      }

      const [order] = await tx.insert(raffleOrdersTable).values({
        campaignId: c.id,
        orderRef: args.orderRef,
        waUserId: args.waUserId,
        conversationId: args.conversationId,
        customerName: args.customerName,
        customerEmail: args.customerEmail,
        quantity: args.quantity,
        amountMinor: c.ticketPriceMinor * args.quantity,
        currency: c.currency,
        status: "PENDING_PAYMENT",
        expiresAt,
      }).returning();

      return { ok: true as const, order };
    });
  } catch (err) {
    logger.error({ err, campaignId: c.id }, "Could not create raffle order");
    throw err;
  }
}

// Everything that must be true at once — the order marked paid, the tickets
// allocated, the counter moved — happens inside one transaction. A crash
// between any two of them leaves the database as it was, and the webhook
// retry does the whole thing again cleanly.
export async function fulfilPaidOrder(
  verified: VerifiedTransaction,
  now = new Date(),
): Promise<FulfilResult> {
  if (verified.status !== "success") {
    return { outcome: "not_successful", detail: verified.gatewayResponse };
  }

  const result = await db.transaction(async (tx): Promise<FulfilResult> => {
    const [order] = await tx
      .select()
      .from(raffleOrdersTable)
      .where(eq(raffleOrdersTable.paymentReference, verified.reference))
      .for("update");

    if (!order) return { outcome: "unknown_reference" };

    // The idempotency guarantee: a duplicate webhook finds the order already
    // COMPLETE and stops here. Two simultaneous duplicates cannot both get
    // past the row lock above.
    if (order.status === "COMPLETE") {
      const existing = await tx
        .select({ ticketNumber: raffleTicketsTable.ticketNumber })
        .from(raffleTicketsTable)
        .where(eq(raffleTicketsTable.orderId, order.id));
      return {
        outcome: "already_complete",
        orderId: order.id,
        orderRef: order.orderRef,
        ticketNumbers: existing.map((t) => t.ticketNumber),
      };
    }

    if (verified.amountMinor !== order.amountMinor) {
      await tx.update(raffleOrdersTable)
        .set({ failureReason: `Amount mismatch: charged ${verified.amountMinor}, expected ${order.amountMinor}` })
        .where(eq(raffleOrdersTable.id, order.id));
      return { outcome: "amount_mismatch", orderId: order.id, orderRef: order.orderRef };
    }
    if (verified.currency !== order.currency) {
      await tx.update(raffleOrdersTable)
        .set({ failureReason: `Currency mismatch: charged ${verified.currency}, expected ${order.currency}` })
        .where(eq(raffleOrdersTable.id, order.id));
      return { outcome: "currency_mismatch", orderId: order.id, orderRef: order.orderRef };
    }

    const [campaign] = await tx
      .select()
      .from(raffleCampaignsTable)
      .where(eq(raffleCampaignsTable.id, order.campaignId));
    if (!campaign) return { outcome: "unknown_reference", orderId: order.id };

    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TICKET_LOCK_NAMESPACE}, ${campaign.id})`);

    // Somebody paid after their hold lapsed, or after the raffle closed. The
    // money is real and already taken, so this cannot simply be ignored: mark
    // it for a refund and tell a human, rather than silently issuing a ticket
    // in a draw that is over.
    const lapsed = order.status === "EXPIRED" || order.status === "CANCELLED";
    const closed = campaign.closesAt != null && now >= campaign.closesAt;
    if (closed || (lapsed && campaign.maxTickets != null)) {
      const [allocatedRow] = await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(raffleTicketsTable)
        .where(and(
          eq(raffleTicketsTable.campaignId, campaign.id),
          eq(raffleTicketsTable.status, "active"),
        ));
      const allocated = Number(allocatedRow?.n ?? 0);
      const noRoom = campaign.maxTickets != null && allocated + order.quantity > campaign.maxTickets;
      if (closed || noRoom) {
        await tx.update(raffleOrdersTable).set({
          status: "REFUND_REQUIRED",
          failureReason: closed
            ? "Payment arrived after the raffle closed"
            : "Payment arrived after the hold lapsed and the raffle is now full",
          paidAt: verified.paidAt ?? now,
        }).where(eq(raffleOrdersTable.id, order.id));
        return {
          outcome: "refund_required",
          orderId: order.id,
          orderRef: order.orderRef,
          detail: closed ? "raffle closed" : "sold out",
        };
      }
    }

    const [seqRow] = await tx
      .select({ next: sql<number>`COALESCE(MAX(${raffleTicketsTable.sequence}), 0) + 1` })
      .from(raffleTicketsTable)
      .where(eq(raffleTicketsTable.campaignId, campaign.id));
    let next = Number(seqRow?.next ?? 1);

    const rows = [];
    for (let i = 0; i < order.quantity; i += 1) {
      rows.push({
        campaignId: campaign.id,
        orderId: order.id,
        sequence: next,
        ticketNumber: formatTicketNumber(campaign.ticketPrefix, campaign.ticketNumberPadding, next),
      });
      next += 1;
    }
    const tickets = await tx.insert(raffleTicketsTable).values(rows).returning();

    await tx.update(raffleOrdersTable).set({
      status: "COMPLETE",
      paidAt: verified.paidAt ?? now,
      failureReason: null,
    }).where(eq(raffleOrdersTable.id, order.id));

    await tx.update(raffleCampaignsTable).set({
      ticketsAllocated: sql`${raffleCampaignsTable.ticketsAllocated} + ${order.quantity}`,
    }).where(eq(raffleCampaignsTable.id, campaign.id));

    return {
      outcome: "completed",
      orderId: order.id,
      orderRef: order.orderRef,
      ticketNumbers: tickets.map((t) => t.ticketNumber),
    };
  });

  // Sending happens after the transaction commits. A slow Graph API call has
  // no business holding a row lock, and a failed send must not roll back a
  // payment that has already been taken.
  if (result.outcome === "completed" && result.orderId) {
    await sendConfirmation(result.orderId).catch((err) => {
      logger.error({ err, orderId: result.orderId }, "Raffle confirmation failed after fulfilment");
    });
  }

  return result;
}

function renderConfirmation(
  template: string | null,
  vars: Record<string, string>,
): string {
  const base = template ??
    "Payment received — thank you!\n\nOrder: {{order}}\nAmount: {{amount}}\nTicket: {{tickets}}\n\nGood luck!";
  return base.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
}

export async function sendConfirmation(orderId: number): Promise<"session" | "template" | "pending" | "failed"> {
  const [order] = await db.select().from(raffleOrdersTable).where(eq(raffleOrdersTable.id, orderId));
  if (!order) return "failed";
  const [campaign] = await db
    .select()
    .from(raffleCampaignsTable)
    .where(eq(raffleCampaignsTable.id, order.campaignId));
  const tickets = await db
    .select({ ticketNumber: raffleTicketsTable.ticketNumber })
    .from(raffleTicketsTable)
    .where(eq(raffleTicketsTable.orderId, order.id));

  const settings = await getWhatsAppSettings();
  if (!settings) return "failed";

  const ticketList = tickets.map((t) => t.ticketNumber).join(", ");
  const amount = `${order.currency} ${(order.amountMinor / 100).toFixed(2)}`;
  const vars = {
    order: order.orderRef,
    amount,
    tickets: ticketList,
    name: order.customerName,
  };
  const text = renderConfirmation(campaign?.confirmationMessage ?? null, vars);

  let channel: "session" | "template" | "pending" | "failed";
  let messageId: string | null = null;
  let templateUsed: string | undefined;

  if (await isWithinSessionWindow(order.waUserId)) {
    messageId = await sendWhatsAppText(settings, order.waUserId, text);
    channel = messageId ? "session" : "failed";
  } else if (campaign?.confirmationTemplateName) {
    // Outside the 24-hour window a free-form message is simply refused, so the
    // confirmation has to go as an approved Utility template.
    templateUsed = campaign.confirmationTemplateName;
    messageId = await sendWhatsAppTemplate(
      settings,
      order.waUserId,
      campaign.confirmationTemplateName,
      campaign.confirmationTemplateLanguage,
      [order.customerName, order.orderRef, amount, ticketList],
    );
    channel = messageId ? "template" : "failed";
  } else {
    // No template configured and the window has shut. The customer has paid
    // and cannot be told — record it loudly rather than pretending it was sent.
    logger.error(
      { orderId: order.id, orderRef: order.orderRef, waUserId: order.waUserId },
      "Paid raffle order cannot be confirmed: outside the 24-hour window and no approved template is configured",
    );
    channel = "pending";
  }

  await db.update(raffleOrdersTable).set({
    confirmationSentAt: messageId ? new Date() : null,
    confirmationChannel: channel,
  }).where(eq(raffleOrdersTable.id, order.id));

  await recordOutboundMessage(order.conversationId, text, messageId, templateUsed);
  return channel;
}

// Paystack sends no webhook when a customer simply walks away from a checkout,
// so nothing else in the system will ever close these orders. Without this they
// sit PENDING forever and, in a capped raffle, hold tickets nobody bought.
export async function expireStalePendingOrders(now = new Date()): Promise<number> {
  const expired = await db
    .update(raffleOrdersTable)
    .set({ status: "EXPIRED", failureReason: "Payment not completed in time" })
    .where(and(
      eq(raffleOrdersTable.status, "PENDING_PAYMENT"),
      lt(raffleOrdersTable.expiresAt, now),
    ))
    .returning({ id: raffleOrdersTable.id });
  if (expired.length) {
    logger.info({ count: expired.length }, "Expired abandoned raffle orders");
  }
  return expired.length;
}

// A refunded entry must not be able to win. The row stays so the sequence keeps
// its shape and the history stays auditable.
export async function voidTicketsForOrder(orderId: number, reason: string): Promise<number> {
  return await db.transaction(async (tx) => {
    const voided = await tx
      .update(raffleTicketsTable)
      .set({ status: "void", voidedAt: new Date(), voidReason: reason })
      .where(and(
        eq(raffleTicketsTable.orderId, orderId),
        eq(raffleTicketsTable.status, "active"),
      ))
      .returning({ id: raffleTicketsTable.id, campaignId: raffleTicketsTable.campaignId });

    if (voided.length) {
      await tx.update(raffleCampaignsTable).set({
        ticketsAllocated: sql`GREATEST(0, ${raffleCampaignsTable.ticketsAllocated} - ${voided.length})`,
      }).where(eq(raffleCampaignsTable.id, voided[0].campaignId));
    }
    return voided.length;
  });
}

export async function ticketsRemaining(campaignId: number, now = new Date()): Promise<number | null> {
  const [campaign] = await db
    .select()
    .from(raffleCampaignsTable)
    .where(eq(raffleCampaignsTable.id, campaignId));
  if (!campaign || campaign.maxTickets == null) return null;
  const taken = await countHeldAndAllocated(db, campaignId, now);
  return Math.max(0, campaign.maxTickets - taken);
}

export async function isCampaignOpen(
  campaign: typeof raffleCampaignsTable.$inferSelect,
  now = new Date(),
): Promise<boolean> {
  if (campaign.status !== "live") return false;
  if (campaign.opensAt && now < campaign.opensAt) return false;
  if (campaign.closesAt && now >= campaign.closesAt) return false;
  const left = await ticketsRemaining(campaign.id, now);
  return left == null || left > 0;
}
