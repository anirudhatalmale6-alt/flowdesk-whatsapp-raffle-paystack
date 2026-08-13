import os

os.chdir("/opt/flowdesk")

# 1. schema index
p = "lib/db/src/schema/index.ts"
s = open(p).read()
if "./raffle" not in s:
    s = s.rstrip("\n") + '\nexport * from "./raffle";\n'
    open(p, "w").write(s)
    print("schema/index.ts: added raffle export")
else:
    print("schema/index.ts: already done")

# 2. routes index
p = "artifacts/api-server/src/routes/index.ts"
s = open(p).read()
if "raffleRouter" not in s:
    assert 'import telegramRouter from "./telegram";' in s
    s = s.replace(
        'import telegramRouter from "./telegram";',
        'import telegramRouter from "./telegram";\nimport raffleRouter from "./raffle";',
    )
    assert "router.use(telegramRouter);" in s
    s = s.replace(
        "router.use(telegramRouter);",
        "router.use(telegramRouter);\nrouter.use(raffleRouter);",
    )
    open(p, "w").write(s)
    print("routes/index.ts: registered raffle router")
else:
    print("routes/index.ts: already done")

# 3. app.ts - capture raw bytes for the Paystack webhook only
p = "artifacts/api-server/src/app.ts"
s = open(p).read()
if "rawBody" not in s:
    old = "app.use(express.json());"
    new = """// Paystack signs the exact bytes it sends, so the webhook route needs them
// before express.json() throws them away. Captured for that one path only —
// buffering every request body would cost memory for no reason.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (req.url?.includes("/raffle/webhook/")) {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      }
    },
  }),
);"""
    assert old in s, "app.ts: express.json() line not found"
    s = s.replace(old, new, 1)
    open(p, "w").write(s)
    print("app.ts: rawBody capture added")
else:
    print("app.ts: already done")

# 4. index.ts - periodic sweep of abandoned checkouts
p = "artifacts/api-server/src/index.ts"
s = open(p).read()
if "expireStalePendingOrders" not in s:
    assert 'import { logger } from "./lib/logger";' in s
    s = s.replace(
        'import { logger } from "./lib/logger";',
        'import { logger } from "./lib/logger";\n'
        'import { expireStalePendingOrders } from "./lib/raffleFulfilment";',
    )
    s = s.rstrip("\n") + """

// Paystack sends nothing at all when a customer abandons a checkout, so
// abandoned raffle orders would otherwise stay PENDING forever and keep
// holding tickets in a capped raffle. Nothing else in the system closes them.
const RAFFLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const raffleSweep = setInterval(() => {
  expireStalePendingOrders().catch((err) => {
    logger.error({ err }, "Raffle order sweep failed");
  });
}, RAFFLE_SWEEP_INTERVAL_MS);
raffleSweep.unref();
"""
    open(p, "w").write(s)
    print("index.ts: sweep interval added")
else:
    print("index.ts: already done")
