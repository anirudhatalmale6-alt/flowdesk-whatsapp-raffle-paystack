// A stand-in for Paystack, bound to loopback, used to drive the raffle module
// end to end without touching the real gateway. It implements only what the
// module calls: initialise, and verify.
import http from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 9911);
const transactions = new Map();

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;

  const send = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (req.method === "POST" && req.url === "/transaction/initialize") {
    const p = JSON.parse(body || "{}");
    transactions.set(p.reference, {
      reference: p.reference,
      amount: p.amount,
      currency: p.currency,
      status: "abandoned",
      metadata: p.metadata ?? {},
    });
    return send(200, {
      status: true,
      data: {
        authorization_url: `http://127.0.0.1:${PORT}/checkout/${p.reference}`,
        access_code: "stub_access_code",
        reference: p.reference,
      },
    });
  }

  if (req.method === "GET" && req.url.startsWith("/transaction/verify/")) {
    const ref = decodeURIComponent(req.url.split("/transaction/verify/")[1]);
    const t = transactions.get(ref);
    if (!t) return send(404, { status: false, message: "Transaction reference not found" });
    return send(200, {
      status: true,
      data: {
        reference: t.reference,
        status: t.status,
        amount: t.amount,
        currency: t.currency,
        paid_at: t.status === "success" ? new Date().toISOString() : null,
        gateway_response: t.status === "success" ? "Successful" : "Abandoned",
        metadata: t.metadata,
      },
    });
  }

  // Test-harness control surface: "the customer paid", including the ability to
  // pay a different amount than was asked for.
  if (req.method === "POST" && req.url.startsWith("/_pay/")) {
    const ref = decodeURIComponent(req.url.split("/_pay/")[1]);
    const t = transactions.get(ref);
    if (!t) return send(404, { ok: false });
    const p = body ? JSON.parse(body) : {};
    t.status = p.status ?? "success";
    if (p.amount != null) t.amount = p.amount;
    if (p.currency != null) t.currency = p.currency;
    return send(200, { ok: true, transaction: t });
  }

  if (req.method === "GET" && req.url === "/_health") return send(200, { ok: true });

  send(404, { status: false, message: "not implemented in stub" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`paystack stub listening on 127.0.0.1:${PORT}`);
});
