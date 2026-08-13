import crypto from "node:crypto";
import { db, integrationSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Paystack keys live in integration_settings alongside every other provider,
// not in the environment, so the client can rotate them from the UI and so a
// test key can never be left behind in a deploy script.

const PAYSTACK_LIVE_BASE = "https://api.paystack.co";
export const PAYSTACK_INTEGRATION_TYPE = "paystack";

// End-to-end tests need somewhere to point that is not the real gateway. The
// override is deliberately only honoured for a loopback address: it can send
// traffic to a stub on this machine and nowhere else, so it cannot be turned
// into a way of quietly redirecting live payments to someone else's server.
function paystackBase(): string {
  const override = process.env.PAYSTACK_BASE_URL;
  if (!override) return PAYSTACK_LIVE_BASE;
  try {
    const url = new URL(override);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
      return override.replace(/\/$/, "");
    }
  } catch {
    // Fall through to the real gateway on anything unparseable.
  }
  return PAYSTACK_LIVE_BASE;
}

export interface PaystackConfig {
  secretKey: string;
  publicKey?: string;
  // "test" | "live" — recorded so the UI can say out loud which one is in use.
  mode: string;
  callbackUrl?: string;
}

export async function getPaystackConfig(): Promise<PaystackConfig | null> {
  const [row] = await db
    .select()
    .from(integrationSettingsTable)
    .where(eq(integrationSettingsTable.type, PAYSTACK_INTEGRATION_TYPE));
  if (!row) return null;
  const cfg = (row.config ?? {}) as Partial<PaystackConfig>;
  if (!cfg.secretKey) return null;
  return {
    secretKey: cfg.secretKey,
    publicKey: cfg.publicKey,
    mode: cfg.mode ?? (cfg.secretKey.startsWith("sk_live_") ? "live" : "test"),
    callbackUrl: cfg.callbackUrl,
  };
}

export class PaystackError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PaystackError";
  }
}

async function paystackFetch(
  path: string,
  secretKey: string,
  init?: RequestInit,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${paystackBase()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secretKey}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new PaystackError(
      `Could not reach Paystack: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new PaystackError(`Paystack returned a non-JSON response (HTTP ${res.status})`, res.status);
  }

  if (!res.ok || body?.status === false) {
    throw new PaystackError(body?.message ?? `Paystack returned HTTP ${res.status}`, res.status);
  }
  return body?.data ?? {};
}

export interface InitializeArgs {
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export async function initializeTransaction(
  cfg: PaystackConfig,
  args: InitializeArgs,
): Promise<InitializeResult> {
  const data = await paystackFetch("/transaction/initialize", cfg.secretKey, {
    method: "POST",
    body: JSON.stringify({
      email: args.email,
      // Minor units. 8900 is ZAR 89.00, and sending 89 here would charge 89
      // cents — the kind of mistake that only shows up in a bank statement.
      amount: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      callback_url: args.callbackUrl ?? cfg.callbackUrl,
      metadata: args.metadata ?? {},
    }),
  });
  if (!data?.authorization_url) {
    throw new PaystackError("Paystack did not return a checkout URL");
  }
  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference ?? args.reference,
  };
}

export interface VerifiedTransaction {
  reference: string;
  status: string;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  metadata: Record<string, unknown>;
  gatewayResponse?: string;
}

export async function verifyTransaction(
  cfg: PaystackConfig,
  reference: string,
): Promise<VerifiedTransaction> {
  const data = await paystackFetch(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    cfg.secretKey,
  );
  return {
    reference: data.reference,
    status: data.status,
    amountMinor: Number(data.amount),
    currency: data.currency,
    paidAt: data.paid_at ? new Date(data.paid_at) : null,
    metadata: (data.metadata ?? {}) as Record<string, unknown>,
    gatewayResponse: data.gateway_response,
  };
}

// Paystack signs the exact bytes it sent. Re-serialising the parsed body
// produces a different string often enough (key order, unicode escapes,
// whitespace) that a signature check written against req.body will pass in
// testing and fail in production, or worse, the reverse.
export function isValidSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
  const given = Buffer.from(signature, "utf8");
  const mine = Buffer.from(expected, "utf8");
  if (given.length !== mine.length) return false;
  return crypto.timingSafeEqual(given, mine);
}

export function digestBody(rawBody: Buffer): string {
  return crypto.createHash("sha512").update(rawBody).digest("hex");
}
