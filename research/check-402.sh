#!/bin/sh
# spec/09 hand check: does each URL answer 402 without paying? (no payment header is sent)
for u in https://api.exa.ai/search https://api.munition.io/v1/exa/search https://netintel.dev/exa/search https://netintel-production-440c.up.railway.app/exa/search https://stableenrich.dev/api/exa/search; do
  g=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$u")
  p=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST -H "content-type: application/json" --data '{"query":"solana"}' "$u")
  echo "GET $g  POST $p  $u"
done
