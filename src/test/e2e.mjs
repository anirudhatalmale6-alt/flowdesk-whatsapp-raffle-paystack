// End-to-end exercise of the raffle module against a stub gateway.
// Talks to a throwaway API instance on 127.0.0.1:3299 so the live service is
// never involved. Cleans up every row it creates.

import crypto from "node:crypto";

const API = process.env.API_BASE ?? "http://127.0.0.1:3299/api";
const STUB = process.env.STUB_BASE ?? "http://127.0.0.1:9911";
const SECRET = process.env.STUB_SECRET ?? "sk_test_stub0000000000000000000000000000";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function stubPay(reference, opts = {}) {
  const res = await fetch(`${STUB}/_pay/${encodeURIComponent(reference)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res.json();
}

// Exactly what Paystack sends: a JSON body, and an HMAC-SHA512 of those bytes.
function webhookBody(reference, extra = {}) {
  return JSON.stringify({
    event: "charge.success",
    data: { reference, status: "success", ...extra },
  });
}

async function postWebhook(rawBody, { signature } = {}) {
  const sig = signature ?? crypto.createHmac("sha512", SECRET).update(rawBody).digest("hex");
  const res = await fetch(`${API}/raffle/webhook/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: rawBody,
  });
  return res.status;
}

async function buy(campaignId, waUserId, quantity = 1) {
  return api("POST", "/raffle/orders", {
    campaignId,
    waUserId,
    customerName: "Test Buyer",
    customerEmail: "buyer@example.test",
    quantity,
  });
}

async function makeCampaign(overrides = {}) {
  const created = await api("POST", "/raffle/campaigns", {
    name: `E2E Raffle ${crypto.randomBytes(3).toString("hex")}`,
    ticketPriceMinor: 8900,
    currency: "ZAR",
    ticketPrefix: "E2E",
    ticketNumberPadding: 5,
    maxTicketsPerOrder: 5,
    ...overrides,
  });
  const id = created.body.id;
  await api("PUT", `/raffle/campaigns/${id}`, { status: "live", ...(overrides.patch ?? {}) });
  return id;
}

const createdCampaigns = [];

async function main() {
  console.log("\nConfiguring the stub gateway credentials");
  const cfg = await api("PUT", "/raffle/paystack", {
    secretKey: SECRET,
    callbackUrl: "http://127.0.0.1:9911/done",
  });
  check("paystack credentials accepted", cfg.status === 200 && cfg.body.mode === "test", JSON.stringify(cfg.body));

  const masked = await api("GET", "/raffle/paystack");
  check(
    "secret key is never echoed back in full",
    masked.body.secretKey !== SECRET && String(masked.body.secretKey).includes("…"),
    String(masked.body.secretKey),
  );

  // ── 1. The happy path ─────────────────────────────────────────────────────
  console.log("\n1. A customer buys one ticket and pays");
  const c1 = await makeCampaign();
  createdCampaigns.push(c1);

  const order = await buy(c1, "27000000001");
  check("order created with a checkout link", order.status === 201 && Boolean(order.body.payUrl), JSON.stringify(order.body));
  check("charged in minor units (8900 = ZAR 89.00)", order.body.amountMinor === 8900, String(order.body.amountMinor));

  const detail = await api("GET", `/raffle/orders/${order.body.orderRef}`);
  const reference = detail.body.paymentReference;
  check("order is PENDING_PAYMENT before payment", detail.body.status === "PENDING_PAYMENT", detail.body.status);
  check("no ticket is allocated before payment", detail.body.tickets.length === 0, JSON.stringify(detail.body.tickets));

  await stubPay(reference);
  const raw1 = webhookBody(reference);
  const st1 = await postWebhook(raw1);
  check("valid webhook accepted", st1 === 200, String(st1));

  const afterPay = await api("GET", `/raffle/orders/${order.body.orderRef}`);
  check("order is COMPLETE after a verified webhook", afterPay.body.status === "COMPLETE", afterPay.body.status);
  check("exactly one ticket allocated", afterPay.body.tickets.length === 1, JSON.stringify(afterPay.body.tickets));
  check(
    "ticket number is formatted and starts at 1",
    afterPay.body.tickets[0]?.ticketNumber === "E2E-00001",
    afterPay.body.tickets[0]?.ticketNumber,
  );
  check("paidAt recorded", Boolean(afterPay.body.paidAt), String(afterPay.body.paidAt));

  // ── 2. Duplicate webhooks ─────────────────────────────────────────────────
  console.log("\n2. Paystack sends the same webhook again");
  const st2 = await postWebhook(raw1);
  check("duplicate webhook accepted with 200", st2 === 200, String(st2));
  const afterDup = await api("GET", `/raffle/orders/${order.body.orderRef}`);
  check("still exactly one ticket", afterDup.body.tickets.length === 1, JSON.stringify(afterDup.body.tickets));

  console.log("\n2b. Two duplicate webhooks arriving at the same moment");
  const c2b = await makeCampaign();
  createdCampaigns.push(c2b);
  const o2b = await buy(c2b, "27000000002");
  const d2b = await api("GET", `/raffle/orders/${o2b.body.orderRef}`);
  await stubPay(d2b.body.paymentReference);
  const raw2b = webhookBody(d2b.body.paymentReference);
  // Distinct bodies so the digest guard cannot be what saves us — this has to
  // be stopped by the row lock and the status check inside the transaction.
  const raw2bAlt = JSON.stringify({
    event: "charge.success",
    data: { reference: d2b.body.paymentReference, status: "success" },
    sent_at: "2026-01-01T00:00:00Z",
  });
  const [r1, r2] = await Promise.all([postWebhook(raw2b), postWebhook(raw2bAlt)]);
  check("both concurrent webhooks answered 200", r1 === 200 && r2 === 200, `${r1}/${r2}`);
  const after2b = await api("GET", `/raffle/orders/${o2b.body.orderRef}`);
  check("concurrency did not double-allocate", after2b.body.tickets.length === 1, JSON.stringify(after2b.body.tickets));

  // ── 3. A forged webhook ───────────────────────────────────────────────────
  console.log("\n3. Someone posts a webhook with a bad signature");
  const c3 = await makeCampaign();
  createdCampaigns.push(c3);
  const o3 = await buy(c3, "27000000003");
  const d3 = await api("GET", `/raffle/orders/${o3.body.orderRef}`);
  await stubPay(d3.body.paymentReference);
  const forged = await postWebhook(webhookBody(d3.body.paymentReference), { signature: "deadbeef" });
  check("forged signature rejected with 401", forged === 401, String(forged));
  const after3 = await api("GET", `/raffle/orders/${o3.body.orderRef}`);
  check("forged webhook allocated nothing", after3.body.tickets.length === 0 && after3.body.status === "PENDING_PAYMENT", after3.body.status);

  const noSig = await fetch(`${API}/raffle/webhook/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: webhookBody(d3.body.paymentReference),
  });
  check("webhook with no signature at all rejected", noSig.status === 401, String(noSig.status));

  // ── 4. Paying the wrong amount ────────────────────────────────────────────
  console.log("\n4. The gateway reports a different amount than the order");
  const c4 = await makeCampaign();
  createdCampaigns.push(c4);
  const o4 = await buy(c4, "27000000004");
  const d4 = await api("GET", `/raffle/orders/${o4.body.orderRef}`);
  await stubPay(d4.body.paymentReference, { amount: 100 });
  await postWebhook(webhookBody(d4.body.paymentReference));
  const after4 = await api("GET", `/raffle/orders/${o4.body.orderRef}`);
  check("underpaid order is not completed", after4.body.status !== "COMPLETE", after4.body.status);
  check("no ticket for an underpayment", after4.body.tickets.length === 0, JSON.stringify(after4.body.tickets));
  check("the mismatch is recorded", /Amount mismatch/i.test(String(after4.body.failureReason)), String(after4.body.failureReason));

  console.log("\n4b. The gateway reports a different currency");
  const o4b = await buy(c4, "27000000005");
  const d4b = await api("GET", `/raffle/orders/${o4b.body.orderRef}`);
  await stubPay(d4b.body.paymentReference, { currency: "NGN" });
  await postWebhook(webhookBody(d4b.body.paymentReference));
  const after4b = await api("GET", `/raffle/orders/${o4b.body.orderRef}`);
  check("wrong-currency payment is not completed", after4b.body.status !== "COMPLETE", after4b.body.status);
  check("the currency mismatch is recorded", /Currency mismatch/i.test(String(after4b.body.failureReason)), String(after4b.body.failureReason));

  // ── 5. An unsuccessful charge ─────────────────────────────────────────────
  console.log("\n5. The card is declined");
  const c5 = await makeCampaign();
  createdCampaigns.push(c5);
  const o5 = await buy(c5, "27000000006");
  const d5 = await api("GET", `/raffle/orders/${o5.body.orderRef}`);
  await stubPay(d5.body.paymentReference, { status: "failed" });
  await postWebhook(webhookBody(d5.body.paymentReference));
  const after5 = await api("GET", `/raffle/orders/${o5.body.orderRef}`);
  check("a declined charge allocates nothing", after5.body.tickets.length === 0 && after5.body.status !== "COMPLETE", after5.body.status);

  // ── 6. A capped raffle ────────────────────────────────────────────────────
  console.log("\n6. A raffle with only 3 tickets");
  const c6 = await makeCampaign({ maxTickets: 3 });
  createdCampaigns.push(c6);
  const b1 = await buy(c6, "27000000007");
  const b2 = await buy(c6, "27000000008");
  const b3 = await buy(c6, "27000000009");
  check("first three orders accepted", [b1, b2, b3].every((b) => b.status === 201), [b1, b2, b3].map((b) => b.status).join(","));
  const b4 = await buy(c6, "27000000010");
  check("fourth is refused as sold out", b4.status === 409 && b4.body.reason === "sold_out", JSON.stringify(b4.body));
  check(
    "unpaid holds count against the cap",
    /All tickets have been taken|Only \d+ ticket/.test(String(b4.body.error)),
    String(b4.body.error),
  );

  const remaining = await api("GET", `/raffle/campaigns/${c6}`);
  check("remaining count reaches zero", remaining.body.ticketsRemaining === 0, String(remaining.body.ticketsRemaining));

  // ── 7. Abandoned checkouts ────────────────────────────────────────────────
  console.log("\n7. Nobody pays and the hold lapses");
  const c7 = await makeCampaign({ maxTickets: 1, orderTtlMinutes: 0 });
  createdCampaigns.push(c7);
  const o7 = await buy(c7, "27000000011");
  check("order created", o7.status === 201, JSON.stringify(o7.body));
  const swept = await api("POST", "/raffle/maintenance/sweep");
  check("the sweep expires it", swept.body.expired >= 1, JSON.stringify(swept.body));
  const after7 = await api("GET", `/raffle/orders/${o7.body.orderRef}`);
  check("order is EXPIRED, not left PENDING forever", after7.body.status === "EXPIRED", after7.body.status);

  const o7b = await buy(c7, "27000000012");
  check("the released ticket can be bought by someone else", o7b.status === 201, JSON.stringify(o7b.body));

  // ── 8. Paying after the raffle has closed ─────────────────────────────────
  console.log("\n8. The money arrives after the raffle closes");
  const c8 = await makeCampaign();
  createdCampaigns.push(c8);
  const o8 = await buy(c8, "27000000013");
  const d8 = await api("GET", `/raffle/orders/${o8.body.orderRef}`);
  await stubPay(d8.body.paymentReference);
  await api("PUT", `/raffle/campaigns/${c8}`, { closesAt: new Date(Date.now() - 60_000).toISOString() });
  await postWebhook(webhookBody(d8.body.paymentReference));
  const after8 = await api("GET", `/raffle/orders/${o8.body.orderRef}`);
  check("a payment after closing is flagged for refund", after8.body.status === "REFUND_REQUIRED", after8.body.status);
  check("no ticket is issued for a closed raffle", after8.body.tickets.length === 0, JSON.stringify(after8.body.tickets));

  const buyClosed = await buy(c8, "27000000014");
  check("a closed raffle refuses new orders up front", buyClosed.status === 409 && buyClosed.body.reason === "closed", JSON.stringify(buyClosed.body));

  // ── 9. Sequence integrity and refunds ─────────────────────────────────────
  console.log("\n9. Ticket numbers, and voiding a refunded entry");
  const c9 = await makeCampaign({ maxTicketsPerOrder: 3 });
  createdCampaigns.push(c9);
  const o9a = await buy(c9, "27000000015", 2);
  const d9a = await api("GET", `/raffle/orders/${o9a.body.orderRef}`);
  await stubPay(d9a.body.paymentReference);
  check("two tickets are charged as one payment", d9a.body.amountMinor === 17800, String(d9a.body.amountMinor));
  await postWebhook(webhookBody(d9a.body.paymentReference));

  const o9b = await buy(c9, "27000000016", 1);
  const d9b = await api("GET", `/raffle/orders/${o9b.body.orderRef}`);
  await stubPay(d9b.body.paymentReference);
  await postWebhook(webhookBody(d9b.body.paymentReference));

  const tickets9 = await api("GET", `/raffle/campaigns/${c9}/tickets`);
  const numbers = tickets9.body.map((t) => t.ticketNumber);
  check("numbers are gapless and in order", JSON.stringify(numbers) === JSON.stringify(["E2E-00001", "E2E-00002", "E2E-00003"]), JSON.stringify(numbers));
  check("every ticket traces back to a buyer", tickets9.body.every((t) => t.orderRef && t.paidAt), JSON.stringify(tickets9.body[0]));

  const orderId9a = (await api("GET", `/raffle/orders/${o9a.body.orderRef}`)).body.id;
  const voided = await api("POST", `/raffle/orders/${orderId9a}/void-tickets`, { reason: "refunded in test" });
  check("refund voids both tickets on the order", voided.body.voided === 2, JSON.stringify(voided.body));

  const drawList = await api("GET", `/raffle/campaigns/${c9}/tickets`);
  check("a refunded entry drops out of the draw list", drawList.body.length === 1 && drawList.body[0].ticketNumber === "E2E-00003", JSON.stringify(drawList.body.map((t) => t.ticketNumber)));

  const withVoid = await api("GET", `/raffle/campaigns/${c9}/tickets?includeVoid=true`);
  check("but the voided rows are still on record", withVoid.body.length === 3, String(withVoid.body.length));

  const c9detail = await api("GET", `/raffle/campaigns/${c9}`);
  check("the campaign counters follow the void", c9detail.body.stats.sold === 1 && c9detail.body.stats.voided === 2, JSON.stringify(c9detail.body.stats));

  // ── 10. Per-person limit ──────────────────────────────────────────────────
  console.log("\n10. A limit of 2 tickets per person");
  const c10 = await makeCampaign({ maxTicketsPerPerson: 2, maxTicketsPerOrder: 2 });
  createdCampaigns.push(c10);
  const p1 = await buy(c10, "27000000017", 2);
  check("first order of 2 accepted", p1.status === 201, JSON.stringify(p1.body));
  const p2 = await buy(c10, "27000000017", 1);
  check("the same person is refused a third", p2.status === 409 && p2.body.reason === "per_person_limit", JSON.stringify(p2.body));
  const p3 = await buy(c10, "27000000018", 1);
  check("someone else is unaffected", p3.status === 201, JSON.stringify(p3.body));
  const p4 = await buy(c10, "27000000019", 3);
  check("an order above the per-order limit is refused", p4.status === 409 && p4.body.reason === "per_order_limit", JSON.stringify(p4.body));

  // ── 11. Confirmation outside the 24-hour window ───────────────────────────
  console.log("\n11. The confirmation when the WhatsApp window has shut");
  const c11detail = await api("GET", `/raffle/orders/${o9b.body.orderRef}`);
  check(
    "an unconfirmable payment is recorded as pending, not silently dropped",
    c11detail.body.confirmationChannel === "pending",
    String(c11detail.body.confirmationChannel),
  );
  check("and it is not marked as sent", c11detail.body.confirmationSentAt === null, String(c11detail.body.confirmationSentAt));

  // ── 12. Unknown reference ─────────────────────────────────────────────────
  console.log("\n12. A webhook for a payment that belongs to something else");
  // A real, verifiable transaction at the gateway that no order of ours points
  // at — a shared Paystack account used for more than the raffle would do this.
  await fetch(`${STUB}/transaction/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference: "not-ours-001", amount: 8900, currency: "ZAR" }),
  });
  await stubPay("not-ours-001");
  const ghost = await postWebhook(webhookBody("not-ours-001"));
  check("a payment we do not own is answered, not crashed on", ghost === 200, String(ghost));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`CAMPAIGN_IDS=${createdCampaigns.join(",")}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness error:", err);
  console.log(`CAMPAIGN_IDS=${createdCampaigns.join(",")}`);
  process.exit(2);
});
