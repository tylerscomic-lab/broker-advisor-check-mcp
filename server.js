import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'http';

// ── FINRA BrokerCheck lookup + due-diligence summary ─────────────────────
// Reads FINRA's public BrokerCheck JSON (the same data behind
// brokercheck.finra.org) live on each call. Nothing is cached or stored.
// Flags are plain-English facts derived from the public record, not
// accusations: a disclosure is an item the person or firm must report, and
// many are closed, dismissed or settled with no finding.

const API = 'https://api.brokercheck.finra.org';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (compatible; broker-advisor-check-mcp/1.0)', accept: 'application/json' };

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!r.ok) throw new Error(`BrokerCheck returned HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s);
const parseDate = (s) => { const d = new Date(s); return isNaN(d) ? null : d; };
const yearsBetween = (a, b) => (b - a) / (365.25 * 24 * 3600 * 1000);

function mapIndividualHit(h) {
  const s = h._source;
  const cur = (s.ind_current_employments || [])[0];
  return {
    crd: s.ind_source_id,
    name: clean([s.ind_firstname, s.ind_middlename, s.ind_lastname].filter(Boolean).join(' ')),
    otherNames: (s.ind_other_names || []).map(clean).filter((n) => n).slice(0, 4),
    brokerStatus: s.ind_bc_scope,
    advisorStatus: s.ind_ia_scope,
    hasDisclosures: s.ind_bc_disclosure_fl === 'Y' || s.ind_ia_disclosure_fl === 'Y',
    currentFirm: cur ? clean(cur.firm_name) : null,
    location: cur ? [cur.branch_city, cur.branch_state].filter(Boolean).join(', ') : null,
    yearsInIndustrySince: s.ind_industry_cal_date || null,
  };
}

async function searchAdvisors(query, state, limit) {
  const qs = new URLSearchParams({ query, nrows: String(limit), start: '0', r: '25', sort: 'score+desc', wt: 'json', hl: 'false', includePrevious: 'true' });
  if (state) qs.set('filter', `active=true,prev=true,state=${state.toUpperCase()}`);
  else qs.set('filter', 'active=true,prev=true');
  const j = await getJson(`${API}/search/individual?${qs}`);
  return { totalMatches: j.hits?.total ?? 0, results: (j.hits?.hits || []).map(mapIndividualHit) };
}

async function fetchIndividual(crd) {
  const j = await getJson(`${API}/search/individual/${encodeURIComponent(crd)}?wt=json`);
  const hit = j.hits?.hits?.[0];
  if (!hit) return null;
  return JSON.parse(hit._source.content);
}

function summarizeDisclosures(list = []) {
  const byType = {};
  const items = list.map((d) => {
    byType[d.disclosureType] = (byType[d.disclosureType] || 0) + 1;
    const det = d.disclosureDetail || {};
    return {
      type: d.disclosureType,
      date: d.eventDate,
      resolution: d.disclosureResolution,
      initiatedBy: clean(det['Initiated By'] || det.Initiated_By || '') || null,
      allegations: clean(det.Allegations || '')?.slice(0, 400) || null,
      sanctions: (det.SanctionDetails || []).map((s) => s.Sanctions).filter(Boolean),
      sanctionDetails: clean(det['Sanction Details'] || '')?.slice(0, 300) || null,
      damagesOrAmount: det['Amount Requested'] || det['Damage Amount Requested'] || det['Settlement Amount'] || null,
    };
  });
  return { count: items.length, byType, items };
}

function buildProfile(c) {
  const b = c.basicInformation || {};
  const emp = (c.currentEmployments || []).concat(c.currentIAEmployments || []);
  const prev = (c.previousEmployments || []).concat(c.previousIAEmployments || []);
  const disc = summarizeDisclosures(c.disclosures);
  const now = new Date();
  const registrationDates = emp.map((e) => parseDate(e.registrationBeginDate)).filter(Boolean);
  const tenureCurrentYears = registrationDates.length ? +yearsBetween(new Date(Math.min(...registrationDates)), now).toFixed(1) : null;
  const industryYears = b.daysInIndustry ? +(b.daysInIndustry / 365.25).toFixed(1) : (b.daysInIndustryCalculatedDate ? +yearsBetween(parseDate(b.daysInIndustryCalculatedDate), now).toFixed(1) : null);
  const distinctFirms = new Set(prev.concat(emp).map((e) => e.firmId)).size;
  return {
    crd: b.individualId,
    name: clean([b.firstName, b.middleName, b.lastName].filter(Boolean).join(' ')),
    otherNames: (b.otherNames || []).map(clean).slice(0, 5),
    brokerStatus: b.bcScope,
    advisorStatus: b.iaScope,
    yearsInIndustry: industryYears,
    currentEmployers: emp.map((e) => ({
      firm: clean(e.firmName), firmId: e.firmId, registeredSince: e.registrationBeginDate,
      brokerDealer: e.firmBCScope, investmentAdviser: e.firmIAScope,
      offices: (e.branchOfficeLocations || []).map((o) => clean([o.street1, o.city, o.state, o.zipCode].filter(Boolean).join(', '))).slice(0, 3),
    })),
    yearsAtCurrentFirm: tenureCurrentYears,
    previousFirms: prev.slice(0, 15).map((e) => ({ firm: clean(e.firmName), city: e.city, state: e.state, from: e.registrationBeginDate, to: e.registrationEndDate })),
    distinctFirmsEver: distinctFirms,
    registeredStates: c.registeredStates || [],
    examCounts: { state: c.stateExamCategory?.length ?? c.examsCount?.stateExamCount ?? null, principal: c.principalExamCategory?.length ?? c.examsCount?.principalExamCount ?? null, product: c.productExamCategory?.length ?? c.examsCount?.productExamCount ?? null },
    disclosures: disc,
    sourceUrl: `https://brokercheck.finra.org/individual/summary/${b.individualId}`,
  };
}

function flagsFor(p) {
  const flags = [];
  const active = p.brokerStatus === 'Active' || p.advisorStatus === 'Active';
  if (!active) flags.push({ level: 'high', flag: 'Not currently registered', detail: `Broker status: ${p.brokerStatus || 'n/a'}, advisor status: ${p.advisorStatus || 'n/a'}. Anyone offering securities or advice for pay should be currently registered.` });
  if (p.disclosures.count > 0) {
    const t = p.disclosures.byType;
    const serious = (t['Criminal'] || 0) + (t['Regulatory'] || 0) + (t['Civil'] || 0) + (t['Financial'] || 0);
    flags.push({ level: serious ? 'high' : 'medium', flag: `${p.disclosures.count} reported disclosure(s)`, detail: `By type: ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')}. Read each one: many are dismissed, withdrawn or settled without a finding, but regulatory, criminal and customer-dispute items deserve a direct question.` });
    if (p.disclosures.items.some((d) => (d.sanctions || []).some((s) => /revocation|expulsion|denial|bar|suspension/i.test(s)))) flags.push({ level: 'high', flag: 'Revocation, bar, suspension or denial on record', detail: 'At least one disclosure lists a license-level sanction.' });
  }
  if (p.yearsAtCurrentFirm !== null && p.yearsAtCurrentFirm < 1) flags.push({ level: 'low', flag: 'Less than a year at current firm', detail: 'Not a problem alone. Combined with disclosures or frequent moves, ask why they moved.' });
  if (p.yearsInIndustry && p.distinctFirmsEver / Math.max(p.yearsInIndustry, 1) > 0.5 && p.distinctFirmsEver >= 5) flags.push({ level: 'medium', flag: 'Frequent firm changes', detail: `${p.distinctFirmsEver} firms in ${p.yearsInIndustry} years.` });
  if (p.yearsInIndustry !== null && p.yearsInIndustry < 2) flags.push({ level: 'low', flag: 'Under two years of industry experience', detail: 'A short record is not a red flag by itself, but there is little history to judge.' });
  const rank = { high: 3, medium: 2, low: 1 };
  flags.sort((a, b) => rank[b.level] - rank[a.level]);
  return flags;
}

function mapFirmHit(h) {
  const s = h._source;
  return {
    firmId: s.firm_source_id, name: clean(s.firm_name), otherNames: (s.firm_other_names || []).slice(0, 4),
    brokerDealerStatus: s.firm_scope, advisorStatus: s.firm_ia_scope,
    hasDisclosures: s.firm_disclosure_fl === 'Y' || s.firm_ia_disclosure_fl === 'Y',
    secNumbers: { brokerDealer: s.firm_bd_full_sec_number || null, adviser: s.firm_ia_full_sec_number || null },
    branches: s.firm_branches_count ?? null,
  };
}

const reply = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `BrokerCheck lookup failed: ${e.message}. The public FINRA service may be temporarily unavailable; try again shortly.` }] });
const NOTE = 'Source: FINRA BrokerCheck public records, fetched live. Disclosures are reportable events, not proof of wrongdoing. Verify on brokercheck.finra.org and adviserinfo.sec.gov before making decisions. Not investment or legal advice.';

function buildServer() {
  const server = new McpServer({ name: 'broker-advisor-check-mcp', version: '1.0.0' });

  server.tool('search_advisor',
    'Search FINRA BrokerCheck for a US financial advisor or broker by name (optionally narrowed by two-letter state). Returns CRD number, registration status, current firm, location and whether any disclosures exist. Use the CRD with get_advisor_profile or vet_advisor.',
    { name: z.string().min(2).describe('Full or partial name, e.g. "Jane Q Smith"'), state: z.string().length(2).optional().describe('Two-letter US state code to filter by'), limit: z.number().int().min(1).max(25).default(10).describe('Max results') },
    async ({ name, state, limit }) => { try { return reply({ ...(await searchAdvisors(name, state, limit)), note: NOTE }); } catch (e) { return fail(e); } });

  server.tool('get_advisor_profile',
    'Full public profile for an advisor or broker by CRD number: registration status, current and previous firms, registered states, exam counts, years in industry and every reported disclosure with type, date, resolution, allegations and sanctions.',
    { crd: z.string().regex(/^\d{3,9}$/).describe('The CRD number from search_advisor') },
    async ({ crd }) => { try { const c = await fetchIndividual(crd); if (!c) return reply({ error: `No record found for CRD ${crd}` }); return reply({ ...buildProfile(c), note: NOTE }); } catch (e) { return fail(e); } });

  server.tool('vet_advisor',
    'Due-diligence summary for an advisor or broker by CRD number: a plain-English list of red flags ranked high/medium/low (not currently registered, disclosures by type, license-level sanctions, frequent firm changes, very short tenure) plus questions to ask them directly. Facts from the public record, not accusations.',
    { crd: z.string().regex(/^\d{3,9}$/).describe('The CRD number from search_advisor') },
    async ({ crd }) => {
      try {
        const c = await fetchIndividual(crd);
        if (!c) return reply({ error: `No record found for CRD ${crd}` });
        const p = buildProfile(c);
        const flags = flagsFor(p);
        const high = flags.filter((f) => f.level === 'high').length;
        return reply({
          name: p.name, crd: p.crd, brokerStatus: p.brokerStatus, advisorStatus: p.advisorStatus,
          overall: high ? 'REVIEW CAREFULLY: high-level items on the public record' : flags.some((f) => f.level === 'medium') ? 'SOME ITEMS WORTH ASKING ABOUT' : 'NO MAJOR ITEMS ON THE PUBLIC RECORD',
          flags,
          questionsToAsk: [
            'Are you acting as a fiduciary on all of my accounts?',
            'How are you paid: fee-only, commission, or both?',
            ...(p.disclosures.count ? ['Can you walk me through each disclosure on your BrokerCheck record?'] : []),
            ...(p.yearsAtCurrentFirm !== null && p.yearsAtCurrentFirm < 2 ? ['What prompted your move to your current firm?'] : []),
          ],
          currentEmployers: p.currentEmployers.map((e) => e.firm),
          yearsInIndustry: p.yearsInIndustry,
          disclosureSummary: p.disclosures.byType,
          sourceUrl: p.sourceUrl, note: NOTE,
        });
      } catch (e) { return fail(e); }
    });

  server.tool('search_firm',
    'Search FINRA BrokerCheck for a US broker-dealer or investment adviser firm by name. Returns firm ID, registration status, SEC numbers, branch count and whether disclosures exist.',
    { name: z.string().min(2).describe('Firm name, e.g. "Edward Jones"'), limit: z.number().int().min(1).max(25).default(10) },
    async ({ name, limit }) => {
      try {
        const qs = new URLSearchParams({ query: name, nrows: String(limit), start: '0', wt: 'json', hl: 'false' });
        const j = await getJson(`${API}/search/firm?${qs}`);
        return reply({ totalMatches: j.hits?.total ?? 0, results: (j.hits?.hits || []).map(mapFirmHit), note: NOTE });
      } catch (e) { return fail(e); }
    });

  server.tool('get_firm_profile',
    'Public profile for a firm by firm ID: registration status for broker-dealer and investment adviser, address, regulatory disclosure flags, and registered states.',
    { firm_id: z.string().regex(/^\d{1,9}$/).describe('Firm ID from search_firm') },
    async ({ firm_id }) => {
      try {
        const j = await getJson(`${API}/search/firm/${firm_id}?wt=json`);
        const hit = j.hits?.hits?.[0];
        if (!hit) return reply({ error: `No firm found for ID ${firm_id}` });
        const c = JSON.parse(hit._source.content);
        const b = c.basicInformation || {};
        return reply({
          firmId: b.firmId, name: clean(b.firmName), otherNames: (b.otherNames || []).slice(0, 5),
          brokerDealerStatus: b.bcScope, advisorStatus: b.iaScope, firmType: b.firmType || null,
          secNumbers: { brokerDealer: b.bdSECNumber || null, adviser: b.iaSECNumber || null },
          disclosureFlags: { brokerDealer: c.disclosureFlag ?? null, adviser: c.iaDisclosureFlag ?? null },
          address: c.firmAddressDetails || c.addressDetails || null,
          sourceUrl: `https://brokercheck.finra.org/firm/summary/${b.firmId}`, note: NOTE,
        });
      } catch (e) { return fail(e); }
    });

  return server;
}

const PORT = process.env.PORT || 8080;
const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url !== '/' && !req.url?.startsWith('/mcp')) { res.writeHead(404); res.end(); return; }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
httpServer.listen(PORT, () => console.log(`broker-advisor-check-mcp listening on :${PORT}`));
