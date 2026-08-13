#!/bin/bash
# Remove everything the end-to-end run created: the throwaway API instance,
# the stub gateway, the test rows and the stub credentials.
# Expects PGPASSWORD (or a .pgpass entry) to be set by the caller — no database
# password belongs in a file that gets committed.
: "${PGPASSWORD:?set PGPASSWORD before running}"

pkill -f 'paystack-stub.mjs'
for p in $(ss -lptnH 'sport = :3355' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
  kill "$p" 2>/dev/null
done
sleep 2

psql -U flowdesk -h localhost -d flowdesk -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DELETE FROM raffle_payment_events;
DELETE FROM raffle_tickets;
DELETE FROM raffle_orders;
DELETE FROM raffle_campaigns;
DELETE FROM integration_settings WHERE type = 'paystack';
COMMIT;
SQL

echo "--- after cleanup ---"
echo "port 3355: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:3355/api/raffle/campaigns)"
echo "port 9911: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9911/_health)"
psql -U flowdesk -h localhost -d flowdesk -tAc \
  "SELECT 'campaigns=' || (SELECT count(*) FROM raffle_campaigns)
        || ' orders='   || (SELECT count(*) FROM raffle_orders)
        || ' tickets='  || (SELECT count(*) FROM raffle_tickets)
        || ' events='   || (SELECT count(*) FROM raffle_payment_events)
        || ' paystack_cfg=' || (SELECT count(*) FROM integration_settings WHERE type = 'paystack')"

rm -rf /opt/flowdesk/raffle-test /tmp/raffle-stub.log /tmp/raffle-testapi.log /tmp/raffle-build.log
echo "temp files removed"
