import { db, settingsTable, conversationsTable, messagesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "./logger";

// A thin wrapper over the Graph API, plus the one rule that is easy to forget
// and impossible to see in testing: WhatsApp only accepts a free-form message
// within 24 hours of the customer's last inbound message. Outside that window
// the send is rejected, and a customer who paid hears nothing back at all.

const GRAPH_VERSION = "v19.0";
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type WhatsAppSettings = typeof settingsTable.$inferSelect;

export async function getWhatsAppSettings(): Promise<WhatsAppSettings | null> {
  const [s] = await db.select().from(settingsTable);
  return s ?? null;
}

async function graphSend(settings: WhatsAppSettings, payload: unknown): Promise<string | null> {
  if (!settings.phoneNumberId || !settings.accessToken) return null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${settings.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = (await res.json()) as any;
    if (!res.ok) {
      logger.warn({ status: res.status, error: data?.error }, "WhatsApp send rejected");
      return null;
    }
    return data?.messages?.[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "WhatsApp send failed");
    return null;
  }
}

export async function sendWhatsAppText(
  settings: WhatsAppSettings,
  to: string,
  body: string,
): Promise<string | null> {
  return graphSend(settings, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

export async function sendWhatsAppTemplate(
  settings: WhatsAppSettings,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[],
): Promise<string | null> {
  return graphSend(settings, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
        : [],
    },
  });
}

// The window opens on the customer's last INBOUND message, not on the last
// message in the thread — our own outbound replies do not extend it.
export async function isWithinSessionWindow(waUserId: string, now = new Date()): Promise<boolean> {
  const [conversation] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, waUserId))
    .orderBy(desc(conversationsTable.updatedAt))
    .limit(1);
  if (!conversation) return false;

  const [lastInbound] = await db
    .select({ createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(and(
      eq(messagesTable.conversationId, conversation.id),
      eq(messagesTable.direction, "inbound"),
    ))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);
  if (!lastInbound) return false;

  return now.getTime() - lastInbound.createdAt.getTime() < SESSION_WINDOW_MS;
}

export async function findConversationId(waUserId: string): Promise<number | null> {
  const [conversation] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, waUserId))
    .orderBy(desc(conversationsTable.updatedAt))
    .limit(1);
  return conversation?.id ?? null;
}

// Mirror an outbound message into the inbox so the raffle confirmation shows up
// in the same thread the operator sees, rather than being invisible to them.
export async function recordOutboundMessage(
  conversationId: number | null,
  body: string,
  waMessageId: string | null,
  templateName?: string,
): Promise<void> {
  if (!conversationId) return;
  try {
    await db.insert(messagesTable).values({
      conversationId,
      direction: "outbound",
      body,
      messageType: templateName ? "template" : "text",
      status: waMessageId ? "sent" : "failed",
      waMessageId,
      templateName: templateName ?? null,
    });
    await db
      .update(conversationsTable)
      .set({ lastMessage: body, lastMessageAt: new Date() })
      .where(eq(conversationsTable.id, conversationId));
  } catch (err) {
    // Logging the confirmation is a convenience; failing to log it must never
    // undo a payment that has already been fulfilled.
    logger.warn({ err, conversationId }, "Could not mirror raffle message into inbox");
  }
}
