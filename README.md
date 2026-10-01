# FINRA Broker & Advisor Check

Look up and vet US financial advisors, brokers and firms from live FINRA BrokerCheck records: registration status, disclosures, employment history and plain-English red flags, plus questions to ask before you hand over money.

## Check an advisor before you trust them with money
Pulls FINRA BrokerCheck public records live on every call, so the answer is today's record, not a stale copy. Search by name, then vet by CRD number.

## What you get
- **Registration status** for broker and investment-adviser roles.
- **Disclosures** with type, date, resolution, allegations and sanctions (regulatory, customer dispute, criminal, financial, termination).
- **Employment history**: current and previous firms, years in the industry, how often they move.
- **Ranked red flags** in plain English, plus questions to ask them directly.

## Tools
- `search_advisor`: find an advisor by name, optionally by state.
- `get_advisor_profile`: the full public record for a CRD number.
- `vet_advisor`: red flags ranked high/medium/low and questions to ask.
- `search_firm` and `get_firm_profile`: the same for firms.

## Good for
Individuals checking an advisor, family members protecting older relatives from investment fraud, compliance teams, journalists, and agents that need verified registration data instead of guessing.

A disclosure is a reportable event, not proof of wrongdoing, and many are dismissed or settled without a finding. Always confirm on brokercheck.finra.org. Not investment or legal advice.

## Use it

Hosted on [MCPize](https://mcpize.com/mcp/broker-advisor-check-mcp) with a free tier (10 calls a day). Remote MCP endpoint (streamable HTTP, API key from MCPize):

```
https://broker-advisor-check-mcp.mcpize.run/mcp
```

Or run it yourself:

```bash
npm install
node server.js   # listens on :8080, MCP at /mcp
```

MIT licensed.
