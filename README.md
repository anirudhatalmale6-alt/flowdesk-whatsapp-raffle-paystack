# FlowDesk — WhatsApp raffle ticket sales (Paystack)

Sells a raffle ticket over WhatsApp, takes the money through Paystack, and
issues a unique entry number only once the payment has been verified.

Built against the Reach for a Dream developer handoff, plus the four failure
modes that handoff did not cover.

## What is here

| File | Purpose |
| --- | --- |
| `src/lib-db/schema/raffle.ts` | Campaigns, orders, tickets, payment events |
| `src/migrations/001_raffle.sql` | The same tables as plain SQL, re-runnable |
| `src/api-server/lib/paystack.ts` | Initialise, verify, signature checking |
| `src/api-server/lib/whatsapp.ts` | Graph API sends + the 24-hour window check |
| `src/api-server/lib/raffleFulfilment.ts` | Orders, capacity, allocation, confirmation, sweeper |
| `src/api-server/routes/raffle.ts` | HTTP surface |
| `src/patch_integration.py` | Wires the module into the existing app |
| `src/test/` | Stub gateway + 49-check end-to-end run |

## The order lifecycle

```
PENDING_PAYMENT ──(verified webhook)──► COMPLETE          (ticket issued)
       │
       ├──(TTL lapses, sweeper)────────► EXPIRED          (hold released)
       ├──(gateway would not start)────► CANCELLED
       ├──(paid after close/sold out)──► REFUND_REQUIRED  (money in, no ticket)
       └──(operator voids)─────────────► REFUNDED         (tickets voided)
```

## The four things the handoff did not cover

**The 24-hour window.** WhatsApp refuses a free-form message more than 24 hours
after the customer last wrote. In a demo everything happens inside two minutes,
so it always works; in production somebody pays the next morning and hears
nothing. `sendConfirmation` checks the last *inbound* message, uses an approved
Utility template when the window has shut, and when there is no template it
records `confirmationChannel = "pending"` and logs an error rather than
pretending the message was sent.

This is not theoretical. The live FlowDesk instance logged 30 send failures with
Meta error `131047` — *"more than 24 hours have passed since the customer last
replied"* — in the three days before this module was written.

**Abandoned checkouts.** Paystack sends no webhook when a customer simply walks
away, so nothing would ever close those orders. `expireStalePendingOrders` runs
every five minutes and releases the hold.

**Ticket allocation.** Allocation happens inside the same transaction that marks
the order paid, under a per-campaign advisory lock, with
`UNIQUE (campaign_id, sequence)` as the backstop. Numbers are gapless and
traceable to the payment that bought them.

**Duplicate webhooks.** Idempotency is enforced by the database, not by a check
in the code: `UNIQUE (provider, body_digest)` on the event log, `UNIQUE` on
`payment_reference`, and a `SELECT … FOR UPDATE` on the order inside the
fulfilment transaction. Two identical webhooks arriving simultaneously cannot
both allocate.

## Verification

`src/test/e2e.mjs` drives the whole module against a stub gateway bound to
loopback. 49 checks, all passing:

* one payment produces exactly one order and exactly one entry
* a duplicate webhook, and two simultaneous distinct webhooks, allocate nothing extra
* a forged signature and a missing signature are both rejected, and allocate nothing
* an underpayment, a wrong currency and a declined card each allocate nothing and record why
* unpaid holds count against a capped raffle; the fourth buyer of three tickets is refused
* an abandoned checkout expires and releases its ticket to the next buyer
* money arriving after the raffle closes is flagged `REFUND_REQUIRED`, not quietly given a ticket
* numbers are gapless; a refunded entry leaves the draw list but stays on record
* per-person and per-order limits hold
* a payment that belongs to something else is answered, not crashed on

`PAYSTACK_BASE_URL` exists so the tests have somewhere to point. It is honoured
**only** for `127.0.0.1`, `localhost` or `::1`, so it cannot be used to redirect
live payments to another host.

## Still to do (needs the client's answers)

* The WhatsApp Flow itself, and the campaign trigger — tied to the WABA
* The Utility template for out-of-window confirmations — needs Meta review time
* Real Paystack test keys, then a live end-to-end run before switching to live mode
* Ticket prefix, cap, closing date and per-person limit are configurable and
  currently unset
