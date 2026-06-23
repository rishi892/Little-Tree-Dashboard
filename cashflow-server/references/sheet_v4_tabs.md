# Moysh LLC dba Little Tree — Cashflow Recovery Model
## Per-Tab Structural Reference (v4 export)

**Source file:** `mcp-claude_ai_Google_Drive-read_file_content-1778518976450.txt` (Google Drive export)
**Snapshot date:** As of May 05, 2026
**Workbook:** 34 tabs total. Tabs 1–10 have full data in this export. **Tabs 11–24 are referenced in the README index but contain NO rendered cell data in this export** (they exist as scaffolding only — empty/template sheets, or sheets whose content was not exported).

### Workbook color conventions (from README)
- **Bright orange tab (FFC000)** = new sheet
- **Yellow fill + blue font** = editable user input (updated in Monday call)
- **Green font** = cross-sheet formula link
- **Light teal background** = formula linking to another sheet
- **Black text** = formula result or static label
- Existing v2 sheets remain authoritative for actuals; new sheets reference them, never overwrite.

---

## Tab 1. 00. README - New Sheets
- **Purpose:** Index of all new tabs, conventions, color legend, and workbook structure map.
- **Columns/headers:** `| Tab | What it does |`
- **Row labels / line items:** Index rows for `00. README - New Sheets`, `18. Outflow Budget`, `19. Variance Tracker`, `20. Production & Batch Plan`, `21. Decision Alerts`, `22. Scenario Modeling`, `23. Meeting Cadence`, `24. Implementation Roadmap`. Plus Conventions block (`Tab color`, `Editable cells`, `Formula links`, `Source of truth`, `Update cadence`).
- **Sub-table `WORKBOOK STRUCTURE`:** lists `Sheet 1: Cover` through `Sheet 8: Cash Health Roadmap` with a short caption for each.
- **Sub-table `COLOR LEGEND`:** Blue text, Black text, Green text, Yellow background, Light teal background.
- **Key numbers:** None — text-only navigational tab.
- **Notes:** Single source for conventions. Tab 23 (Meeting Cadence) is named as the system-of-record for "who updates what and when."

---

## Tab 2. 1a. Cover
- **Purpose:** Title page / orientation card for the model (mostly captured indirectly via README).
- **Columns/headers:** Not rendered as a separate section in this export — content folded into the WORKBOOK STRUCTURE block on the README. README states `Sheet 1: Cover     This page`.
- **Row labels / line items:** None in export.
- **Key numbers:** None.
- **Notes:** Effectively a template / static cover page. No live data wiring needed.

---

## Tab 3. 1b. Current Position
- **Purpose:** Point-in-time balance-sheet snapshot of cash, debt, intercompany, AR, and net liquidity, dated to the workbook's "As of" date.
- **Anchor date:** `As of: May 05, 2026`.
- **Section 1 – CASH ON HAND.** Columns: `Account | Balance | (blank) | Notes`. Rows: `Checking 7561` $7,755.34 (Primary operating account), `BMM Account` $55.37 (Secondary), `TOTAL CASH ON HAND` **$7,810.71**.
- **Section 2 – CREDIT CARD DEBT.** Columns: `Card | Balance | Min Payment | Notes`. Rows: `MC Consumer` $23,762.97 / $706, `Amex Blue Business` $31,931.70 / $7,993.31, `Delta Business` $3,265.29 / $0, `Amex Everyday` $15,463.97 / $414.81, `FNBO` $17,825.37 / $2,225.37, `Chase 4158` $24,810.17 / $776, `Chase 0715` $3,268.62 / $102. `Subtotal: Business Credit Cards` **$120,328.09 / $12,217.49 min**. Personal informational row: `Delta (Personal)` $9,763.80 / $227.25 (PERSONAL, EXCLUDED).
- **Section 3 – INTERCOMPANY (PureX).** Rows: `PureX intercompany clearing balance` **$(358,545.62)** (working capital cushion; PureX paid more on our behalf than collected), `Expected PureX remittance (Week 1 lump sum)` **$260,000** (confirmed Week 1; 2025 avg $135K/mo recurring).
- **Section 4 – ACCOUNTS RECEIVABLE.** Rows: `Gelato AR (Jan invoice)` $249,091.65 (Net 90, due ~Apr 2026), `Gelato AR (Feb invoice)` $136,583.13 (~May 2026), `Gelato AR (Mar invoice)` $168,614.00 (~Jun 2026), `LT Other Customers AR (Apr onward)` $0, `LT Other Customers AR (Pre-April)` $0, `TOTAL AR (Gross)` **$554,288.78**, `Less: 0% non-collection buffer` $0, `NET COLLECTIBLE AR` **$554,288.78**.
- **Section 5 – NET LIQUIDITY POSITION.** Rows: `Total Cash` $7,810.71, `Less: Business Credit Card Debt` $(120,328.09), `Add: PureX clearing balance (cushion)` $(358,545.62), `Add: Net Collectible AR` $554,288.78. (Sum line truncated in export.)
- **Notes:** This is the primary balance-sheet input. Anchors Sheet 5 (13-Week Cash Flow) Week 1 opening cash and Sheet 6 (CC Payoff). Editable yellow cells live here.

---

## Tab 4. 2. 13-Week Cash Flow  *(this exported file labels this content as "Sheet 5" in the WORKBOOK STRUCTURE — primary lender deliverable)*
- **Purpose:** The PRIMARY OUTPUT of the workbook — weekly opening cash, inflows, outflows, net change, closing cash, and status flag across 13 weeks. Share-with-lenders artifact.
- **Column headers (13 weeks):** `Wk 1 05/04 | Wk 2 05/11 | Wk 3 05/18 | Wk 4 05/25 | Wk 5 06/01 | Wk 6 06/08 | Wk 7 06/15 | Wk 8 06/22 | Wk 9 06/29 | Wk 10 07/06 | Wk 11 07/13 | Wk 12 07/20 | Wk 13 07/27` (Mondays).
- **Row labels / line items (top section):**
  - `OPENING CASH`: 7,811 / 31,701 / 16,509 / 6,699 / (0) / 120,904 / 69,000 / 15,255 / 0 / 0 / 48,287 / 17,773 / 0
  - `CASH INFLOWS`
    - `Customer AR Collections (from Sheet 4)`: 260,000 / 104,867 / 104,867 / 104,867 / 241,450 / 64,530 / 64,530 / 64,530 / 64,530 / 251,740 / 88,627 / 88,627 / 88,627
  - `TOTAL INFLOWS`: 260,000 / 104,867 / 104,867 / 109,417 / 241,450 / 64,530 / 64,530 / 99,280 / 151,009 / 251,740 / 88,627 / 96,787 / 124,231
- **Row labels / line items (outflows block):**
  - `Inventory & Raw Materials` — "Currently under Other Expenses on average basis" (placeholder text — not broken out)
  - `Payroll Expenses`: flat **$49,964** every week (Wk1–Wk13)
  - `Software & Subscriptions`: 2,015 / 6,292 / 911 / 2,349 / 2,229 / 2,667 / 4,509 / 768 / 2,492 / 3,208 / 5,374 / 794 / 2,305
  - `Other Expenses`: flat **$63,803** every week
  - `Credit Card Full Payoff (Week 1 — $120,328)`: 120,328 / 0 / 0 / 0 / 4,550 / 0 / 0 / 0 / 34,750 / 86,479 / 0 / 0 / 8,160 (residual entries appear to be smaller credit-card cleanups)
  - `TOTAL OUTFLOWS`: 236,110 / 120,059 / 114,678 / 116,116 / 120,546 / 116,434 / 118,276 / 114,535 / 151,009 / 203,454 / 119,141 / 114,561 / 124,231
- **Net / closing block:**
  - `NET CASH CHANGE`: 23,890 / (15,192) / (9,811) / (6,699) / 120,904 / (51,904) / (53,746) / (15,255) / 0 / 48,287 / (30,513) / (17,773) / 0
  - `CLOSING CASH`: 31,701 / 16,509 / 6,699 / (0) / 120,904 / 69,000 / 15,255 / 0 / 0 / 48,287 / 17,773 / 0 / 0
  - `STATUS`: HEALTHY / HEALTHY / TIGHT / **CRITICAL** / HEALTHY / HEALTHY / HEALTHY / TIGHT / TIGHT / HEALTHY / HEALTHY / TIGHT / TIGHT
- **Key numbers:** Cash trough at Wk 4 (~$0, status CRITICAL). Wk 5 jump from $241,450 inflow. Recurring Payroll = $49,964/wk, Other Expenses = $63,803/wk (likely formula-linked averages).
- **Notes:** Customer AR Collections row is explicitly sourced "from Sheet 4" (AR Schedule). Numbering convention is confusing — workbook calls this Tab 2 in the tab order, but the README WORKBOOK STRUCTURE labels it Sheet 5. Treat as the canonical 13-week output.

---

## Tab 5. 3a. Monthly Summary 2025
- **Purpose:** Monthly 2025 actual OpEx split between LT-direct and PureX-paid, plus PureX cash remitted to LT. Anchor for ratios used elsewhere (90.2% / 9.8% split).
- **Columns/headers:** `Month | LT Direct OpEx | PureX OpEx | TOTAL OpEx | LT % | PureX % | PureX Remitted to LT`
- **Row labels (months):** `Jan` / `Feb` / `Mar` / `Apr` / `May` / `Jun` / `Jul` / `Aug` / `Sep` / `Oct` / `Nov` / `Dec` / `TOTAL 2025` / `AVG / Month`
- **Key numbers (2025 totals):** LT Direct **$552,168**, PureX **$5,083,615**, TOTAL OpEx **$5,635,783**, PureX Remitted to LT **$1,615,002**. Avg/Month: LT $46,014, PureX $423,635, TOTAL **$469,649**, Remitted **$134,584**. Annual split: **LT 9.8% / PureX 90.2%**.
- **Notes:** Source-of-truth section header reads: `Source: Auto-linked from Sheets 3e (PureX) and 3f (Moysh). All numbers reconcile to source detail.` Feeds the routing ratio used in Tab 14 (3. Assumptions) and Tab 7 (LOC Sizing).

---

## Tab 6. 3b. Settlement History
- **Purpose:** Historical log of every PureX→LT intercompany settlement (Oct 2025 – Apr 2026), with derived monthly run-rate and the implied cash gap.
- **Columns/headers:** `Date | Amount | Days Since Prior | Cumulative | Notes`
- **Row labels / line items (14 settlements):**
  - 2025-10-20 $125,000 (Cum $125K) · 2025-10-31 $50,000 (Cum $175K) · 2025-11-25 $50,000 (Cum $225K) · 2025-12-08 $75,000 (Cum $300K) · 2026-01-05 $30,000 (Cum $330K) · 2026-01-21 $40,000 (Cum $370K) · 2026-02-03 $25,000 (Cum $395K) · 2026-02-23 $50,000 (Cum $445K) · 2026-03-02 $25,000 (Cum $470K) · 2026-03-05 $5,000 (Cum $475K) · 2026-03-11 $20,000 (Cum $495K) · 2026-03-26 $100,000 (Cum $595K) · 2026-03-31 $100,000 (Cum $695K) · 2026-04-22 $15,000 (Cum **$710,000**)
- **Derived metrics block:** `Avg monthly settlement (last 7 months)` **$101,429** · `Required monthly settlement to cover total OpEx` **$469,649** · `Cash gap per month at current run-rate` **$368,220** · `Cash gap over 13 weeks` **$1,104,660** · `Implied annualized cash drag` **$4,418,640`.
- **Settlement statistics block:** Number of settlements 14, Total received $710,000, Avg $50,714, Median $45,000, Smallest $5,000, Largest $125,000, Avg days between 14.15, Max gap 28 days.
- **Notes:** Critical assumption-input feeder. The "Cash gap per month" of $368K is the headline number motivating the LOC sizing on Tab 7. Anchor date implicit: data through 2026-04-22.

---

## Tab 7. 3c. AR Aging
- **Purpose:** Aging-bucket view of open receivables with explicit collection-probability assignment and predicted collection week.
- **Bucket summary table.** Columns: `Bucket | (blank) | (blank) | Total $`. Rows: `0-14` $0 · `15-30` $168,614 · `31-60` $136,583 · `61-90` $249,092 · `90+` $0 · `Total` **$554,289**.
- **Invoice detail table.** Columns: `Invoice # | Description | Issue Date | Amount | Days Out | Bucket | Status | Collect % | Pred Wk # | Notes`.
  - `GEL-INV-06` Gelato Batch INV #06, Jan 2026 (Net 90, due ~May 1) · 2026-02-01 · $249,092 · 86 days · 61-90 · Open · **40.0%** · Pred Wk **1** · "Oldest in-cycle. Apply collection pressure."
  - `GEL-INV-07` Gelato Batch INV #07, Feb 2026 (Net 90, due ~May 31) · 2026-03-01 · $136,583 · 58 · 31-60 · Open · **30.0%** · Pred Wk **5** · "Mid-cycle invoice; expect mid-forecast collection."
  - `GEL-INV-08` Gelato Batch INV #08, Mar 2026 (Net 90, due ~Jun 30) · 2026-04-01 · $168,614 · 27 · 15-30 · Open · **20.0%** · Pred Wk **10** · "Newest invoice; longest tail."
  - `TOTAL AR` $554,289.
- **Notes:** Only Gelato invoices appear; no other customer AR open. Pred Wk # column drives the AR Schedule on Tab 15 (Sheet 5). Collect % is editable.

---

## Tab 8. 3d. Subscriptions
- **Purpose:** Full register of recurring subscriptions/memberships with monthly amount, billing day, week-of-month, pattern flag, and the resulting 13-week cash projection.
- **Columns/headers (43 cols):** `Vendor / Service | Monthly $ | Bill Day | Week of Month | Pattern | Notes | Wk 1 05/04 | Wk 2 05/11 | ... | Wk 13 07/27`. Pattern values seen: `FIXED`, `PERIODIC`, `VARIABLE`.
- **Row labels / line items (45 active subscriptions verbatim, in $-descending order):**
  `DATACREW SOFTWARE` $3,500 (D17 W3 PERIODIC, annual data tools) · `CCA SOLUTIONS` $1,500 (D8 W2 FIXED, compliance) · `HEADSET INC` $1,295 (D13 W2 PERIODIC, bi-monthly analytics) · `GUSTO` $820 (D1 W1 FIXED, payroll fee only) · `HOLY SMOKZ` $625 (D1 W1 FIXED, Sparkplug reimbursement) · `LINDY` $494 (D15 W3 FIXED, AI tool) · `FRONT GROWTH` $395 (D16 W3 FIXED, marketing) · `HUBSPOT` $300 (D21 W3 FIXED, CRM) · `REPLIT` $300 (D28 W4 FIXED, code platform) · `OPENAI/CHATGPT` $230 (D5 W1 VARIABLE, multiple seats) · `LIMITLESS` $228 (D19 W3 PERIODIC) · `NOTION` $226 (D21 W3 FIXED) · `SLACK` $197 (D1 W1 FIXED, team plan) · `CLICKUP` $150 (D10 W2 VARIABLE) · `3030 LABS` $145 (D25 W4 FIXED, lab membership) · `APPLE.COM` $143 (D7 W1 VARIABLE, iCloud + apps) · `B2B PRIME / AMAZON BUSINESS` $137 (D5 W1 PERIODIC) · `QUICKBOOKS` $107 (D1 W1 FIXED, book-keeping) · `PADDLE` $99 (D14 W2 FIXED) · `WEEDMAPS (GHOST MGMT)` $99 (D3 W1 FIXED, cannabis directory) · `INTRO (XAVIER H)` $99 (D22 W4 FIXED, coaching) · `NOTTA` $98 (D28 W4 FIXED, transcription) · `WEBSTAURANT MEMBERSHIP` $89 (D14 W2 FIXED, "MEMBERSHIP ONLY - NOT food purchases") · `HOMEBASE` $70 (D15 W3 FIXED, time tracking) · `AAA MEMBERSHIP` $65 (D29 W4 PERIODIC) · `AMBIENT` $50 (D27 W4 FIXED, AI scheduling) · `PROACTOR AI` $50 (D17 W3 FIXED) · `CARRY.COM` $49 (D2 W1 FIXED) · `TIMEERO` $40 (D12 W2 FIXED, time tracking) · `PERPLEXITY` $40 (D25 W4 FIXED) · `ADOBE` $39 (D20 W3 FIXED, Creative Cloud) · `EXPERIAN` $35 (D9 W2 FIXED, credit monitoring) · `PLAUD` $30 (D4 W1 FIXED, AI hardware) · `CLIPTO` $25 (D4 W1 FIXED) · `PADDLE - N8N CLOUD` $24 (D18 W3 FIXED, automation) · `LOOM` $24 (D22 W4 FIXED, video) · `GOOGLE WORKSPACE` $23 (D30 W4 FIXED) · `CLAY SOFTWARE` $20 (D15 W3 FIXED, sales) · `LENNY'S NEWSLETTER` $20 (D4 W1 FIXED, Substack) · `SHOPIFY` $17 (D25 W4 FIXED, e-commerce) · `SMALLPDF` $15 (D15 W3 FIXED) · `AUDIBLE` $15 (D29 W4 FIXED) · `CANVA` $15 (D24 W4 FIXED, "basic plan only") · `SIMPLEMDM` $13 (D18 W3 FIXED, device management) · `DOORDASH (DASHPASS)` $10 (D7 W1 FIXED, "DashPass subscription only - NOT food orders") · `GETTOBY.COM` $6 (D22 W4 FIXED, browser extension)
- **Key numbers:** Sum of monthly $ ≈ **$11,855/mo** (not explicitly totaled in export). Highest single item $3,500 (Datacrew annual). Subscriptions tagged "MEMBERSHIP ONLY" or "subscription only" carry explicit anti-double-count notes (Webstaurant, DoorDash).
- **Notes:** Source banner: `Source: 2025 transactions from Memberships & Apps tabs, cross-verified with Jan/Feb 2026 actuals`. This is the row-by-row driver behind the `Software & Subscriptions` line on Tab 4 (13-Week Cash Flow). Bill Day + Week of Month produce the per-week placement.

---

## Tab 9. 3e. Expenses By Source - PureX
- **Purpose:** Monthly 2025 + early 2026 actual register of every category of expense paid by PureX, with annual total, monthly avg, and 3-month trailing avg.
- **Columns/headers:** `Group | Category | Jan 2025 | Feb 2025 | Mar 2025 | Apr 2025 | May 2025 | Jun 2025 | Jul 2025 | Aug 2025 | Sep 2025 | Oct 2025 | Nov 2025 | Dec 2025 | Jan 2026 | Feb 2026 | TOTAL | Avg/Mo | 3 months avg`
- **Row labels / line items (verbatim Group | Category):**
  - Payroll | `PureX Production Payroll` (TOTAL $1,566,287; Avg $111,878)
  - Payroll | `COGS Labor (Direct Production)` ($735,310; $52,522)
  - Payroll | `Other Payroll & Team` ($50,460; $3,604)
  - Payroll | `Payroll Fees, Taxes & Benefits` ($22,003; $1,572)
  - Non-Payroll | `Inventory & Raw Materials` ($1,743,797; $124,557)
  - Non-Payroll | `COGS - Compliance Testing` ($276,091; $19,721)
  - Non-Payroll | `COGS - Packaging & Labels` ($347,509; $24,822)
  - Non-Payroll | `COGS - Shipping` ($141,029; $10,073)
  - Non-Payroll | `COGS - Other` ($4,375; $313)
  - Non-Payroll | `Rent / Building Lease` ($280,000; **flat $20,000/mo**)
  - Non-Payroll | `Utilities` ($35,650; $2,546)
  - Non-Payroll | `HVAC & Maintenance` ($18,743; $1,339)
  - Non-Payroll | `Software & Subscriptions` ($20,198; $1,443)
  - Non-Payroll | `Marketing & Advertising` ($38,971; $2,784)
  - Non-Payroll | `Legal & Accounting` ($25,940; $1,853)
  - Non-Payroll | `Travel & Hotels` ($473; $34)
  - Non-Payroll | `Meals & Entertainment` ($2,126; $152)
  - Non-Payroll | `Office Supplies & Storage` ($376; $27)
  - Non-Payroll | `Operating Supplies & Tools` ($57,659; $4,119)
  - Non-Payroll | `R&D - Other` ($3,430; $245)
  - Non-Payroll | `Bank & Merchant Fees` ($7,026; $502)
  - Non-Payroll | `Capital Items (Furniture/Equipment)` ($611; $44)
  - Non-Payroll | `Vendor Payments via A/P (uncategorized)` ($451,882; **$32,277**)
  - Non-Payroll | `Other Operating Expenses` ($6,500; $464)
  - Non-Payroll | `Other (Penalties/Donations/Refunds)` ($5,000; $357)
  - Non-Payroll | `Other / Uncategorized` ($10,531; $752)
- **Banner:** `PUREX-PAID EXPENSES BY MONTH — All expenses paid by PureX, organized by category`.
- **Key numbers:** Largest line by far is `Inventory & Raw Materials` ($1.74M/yr). Production payroll $1.57M. Rent locked at $20K/mo. Notable Jan 2026 spike in `Operating Supplies & Tools` ($20,810) and Feb 2026 spike in `Vendor Payments via A/P` ($109,943).
- **Notes:** This is the canonical detail behind Tab 5 (3a Monthly Summary) PureX column. 14 months of data (Jan 2025 – Feb 2026). 3-month avg column is the trailing forecast input.

---

## Tab 10. 3f. Expenses By Source - Moysh
- **Purpose:** Same structure as 3e, but for the Moysh (Other) entity's directly-paid expenses.
- **Columns/headers:** Same as 3e: `Group | Category | Jan 2025 ... Feb 2026 | TOTAL | Avg/Mo | 3 months avg`.
- **Row labels / line items (verbatim Group | Category):**
  - Payroll | `COGS Labor (Direct Production)` ($455; $33)
  - Payroll | `Executive Salaries` ($127,226; **$9,088** — climbing trend, $17,666 Dec 2025)
  - Payroll | `Contractors (Upwork/Fiverr)` ($102,502; $7,322; trending DOWN — only $1K/mo late 2025/2026)
  - Payroll | `Other Payroll & Team` ($52,737; $3,767)
  - Payroll | `Payroll Fees, Taxes & Benefits` ($947; $68)
  - Non-Payroll | `Inventory & Raw Materials` ($43,867; $3,133)
  - Non-Payroll | `COGS - Compliance Testing` ($390; $28)
  - Non-Payroll | `COGS - Packaging & Labels` ($1,451; $104)
  - Non-Payroll | `COGS - Other` ($2,120; $151)
  - Non-Payroll | `Rent / Building Lease` ($183; $13 — essentially zero, PureX pays rent)
  - Non-Payroll | `Utilities` ($12,812; $915)
  - Non-Payroll | `HVAC & Maintenance` ($184; $13)
  - Non-Payroll | `Software & Subscriptions` ($59,976; **$4,284** — primary driver of Tab 8)
  - Non-Payroll | `Marketing & Advertising` ($27,520; $1,966)
  - Non-Payroll | `Legal & Accounting` ($10,016; $715)
  - Non-Payroll | `Business Insurance` ($2,298; $164)
  - Non-Payroll | `Vehicle & Transportation` ($51,356; $3,668)
  - Non-Payroll | `Travel & Hotels` ($42,140; $3,010 — Oct 2025 $15,252, Jan 2026 $9,288)
  - Non-Payroll | `Meals & Entertainment` ($22,202; $1,586 — spiking Jan/Feb 2026 $5K+)
  - Non-Payroll | `Office Supplies & Storage` ($7,401; $529)
  - Non-Payroll | `Operating Supplies & Tools` ($15,835; $1,131)
  - Non-Payroll | `R&D - Other` ($5,885; $420)
  - Non-Payroll | `Taxes & Licenses` ($47,771; $3,412 — single $34,725 spike in Jul 2025)
  - Non-Payroll | `Shipping & Postage` ($6,177; $441)
  - Non-Payroll | `Capital Items (Furniture/Equipment)` ($3,707; $265 — single Aug 2025 hit)
  - Non-Payroll | `Other Operating Expenses` ($13; $1)
  - Non-Payroll | `Other / Uncategorized` ($5,944; $425)
- **Banner:** `MOYSH (OTHER)-PAID EXPENSES BY MONTH — All expenses paid by Moysh (Other), organized by category`.
- **Key numbers:** Total Moysh-direct OpEx ≈ $552K/yr (reconciles to Tab 5's $552,168). Top three: Executive Salaries $127K, Contractors $102K, Software $60K. Notable: Rent is paid by PureX (only $183 to Moysh), Travel is materially higher per-month on Moysh side than PureX.
- **Notes:** 14 months of data. This is the canonical detail behind Tab 5 (3a) LT-Direct column. The 3-month-avg column is what feeds forward estimates.

---

## Tab 11. 3g. Payroll Detail
- **Purpose:** Monthly payroll schedule split between PureX and Moysh (Other) — a roll-up summary view across 14 months.
- **Banner:** `PAYROLL - MONTHLY DETAIL — Each category split by who paid: PureX or Moysh (Other)`.
- **Columns/headers:** Headers in export collapsed to `NO_HEADER` placeholders (likely a merged-cell artifact). The data line that does render shows a 14-month row with payroll totals:
  - **Row 1 (totals/dollars):** $570,842 | $595,457 | $636,338 | $766,632 | $406,182 | $560,511 | $983,423 | $557,982 | $482,201 | $495,349 | $569,271 | $896,488 | $600,354 | $339,692
  - **Row 2 (percentages — likely Moysh share):** 19% / 39% / 14% / 37% / 63% / 29% / 27% / 32% / 16% / 54% / 36% / 24% / 23% / 25%
- **Row labels / line items:** Not explicitly itemized in export — appears to summarize the Payroll-tagged rows from 3e + 3f, with month-over-month totals and a Moysh-percentage ratio row. Granular category rows (`Production Payroll`, `COGS Labor`, `Other Payroll`, `Fees & Taxes`, `Executive Salaries`, `Contractors`) live in 3e/3f and are aggregated here.
- **Key numbers:** Highest payroll month Jul 2025 $983,423; lowest May 2025 $406,182. Avg 14 months ≈ $604K/mo. Wide volatility in Moysh share (14% to 63%).
- **Notes:** Effectively a pivot view of 3e + 3f Payroll group. Use 3e/3f as the canonical source. Export rendering is incomplete (`NO_HEADER` markers) — the actual sheet likely has labeled rows that did not flatten to markdown cleanly.

---

## Tab 12. 3h. Non-Payroll Detail
- **Purpose:** Same structure as 3g but for the non-payroll categories — splits each non-payroll line between PureX and Moysh and rolls up across months.
- **Banner:** `NON-PAYROLL - MONTHLY DETAIL — Each category split by who paid: PureX or Moysh (Other)`.
- **Columns/headers:** `Category | Paid By | Jan 2025 | Feb 2025 | Mar 2025 | Apr 2025 | May 2025 | Jun 2025 | Jul 2025 | Aug 2025 | Sep 2025 | Oct 2025 | Nov 2025 | Dec 2025 | Jan 2026 | Feb 2026 | TOTAL | Avg/Mo | Last 3 Months Avg | Weekly Average`
- **Row labels / line items (only the COGS block is rendered in the export):**
  - `Inventory & Raw Materials` | Combined | TOTAL $1,787,664 | Avg/Mo $127,690 | L3M $88,298 | **Weekly Avg $22,074.46**
  - `COGS - Compliance Testing` | Combined | $276,481 | $19,749 | $10,306 | **$2,576.50/wk**
  - `COGS - Packaging & Labels` | Combined | $348,960 | $24,926 | $33,106 | **$8,276.51/wk**
  - `COGS - Shipping` | Combined | $141,029 | $10,073 | $13,185 | **$3,296.25/wk**
  - `COGS - Other` | Combined | $6,495 | $464 | $0 | $0/wk
  - (Additional non-COGS rows for Rent, Utilities, etc. exist in the underlying sheet but did not render past line 334 in the export — they live in 3e/3f and aggregate from there.)
- **Key numbers:** Inventory & Raw Materials weekly avg $22K is a critical input for Tab 18 (Outflow Budget) and Tab 20 (Production & Batch Plan). All-in COGS weekly avg ≈ $36K.
- **Notes:** This sheet introduces the **Weekly Average** column that downstream weekly tabs consume. The "Combined" Paid By tag means the row sums PureX + Moysh. The "Last 3 Months Avg" column drives forecast pacing.

---

## Tab 13. 4. Capex & Financing
- **Purpose:** Template / register for tracking project capex spend and financing flows (LOC draws/repayments, equipment loans, owner contributions).
- **Columns/headers:** `Project / Item | Type | Total Cost | Deposit | Progress Pmt | Final Pmt | Notes / Lender`
- **Row labels / line items (all `0` placeholders — template):**
  - `Depositor / production line capex` (Capex) — Notes: "Vendor quote, 25-50% deposit typical."
  - `Packaging line upgrade` (Capex) — "Cannabis equipment lender."
  - `Facility build-out` (Capex) — "Track GC progress payments."
  - `Security system upgrade` (Capex) — "Compliance-driven."
  - `Working capital line draw` (Financing inflow) — "Line size from Inputs!B17."
  - `Working capital line repayment` (Financing outflow) — "Per loan agreement."
  - `Equipment loan principal` (Financing outflow) — "Monthly amortization."
  - `Equipment loan interest` (Financing outflow) — "Monthly."
  - `Owner contribution` (Financing inflow)
  - `Owner distribution` (Financing outflow) — "Discretionary; suspend during shortfall."
- **Key numbers:** All zeros — template only.
- **Notes:** Empty scaffolding. References `Inputs!B17` for LOC size (which lives on Tab 14, 3. Assumptions). When operationalized, this will feed extra outflow lines into the 13-Week Cash Flow.

---

## Tab 14. 3. Assumptions
- **Purpose:** The central editable-inputs control panel. All YELLOW cells are live inputs; everything downstream references this tab.
- **Sub-table A – PUREX EXPENSE ROUTING (Gross View).** Banner explains gross-view methodology. Rows:
  - `% of OpEx paid via PureX (clearing)` **90.2%** — note "ACTUAL 2025: PureX paid ~94% of total OpEx (corrected from prior 80% assumption)"
  - `% of OpEx paid directly by Moysh` **9.8%**
- **Sub-table B – LINE OF CREDIT PARAMETERS.** Columns: `Assumption | Value | Notes`. Rows:
  - `LOC facility size (approved, undrawn capacity)` $0 — "Total approved limit; draw only as needed"
  - `Minimum cash floor (auto-draw trigger)` $0 — "Below this cash level, model draws from LOC"
  - `LOC APR (annual)` **12.0%**
  - `LOC monthly interest rate` **1.0%** (calculated from APR)
  - `LOC origination fee (one-time, on facility)` **1.0%** ("Typical 1% upfront; paid Week 1")
  - `Excess cash sweep % (auto-paydown)` **50%** ("When cash exceeds floor*2, sweep this % to LOC paydown")
- **Sub-table C – INFLOW TIMING (which week each receivable lands).** Columns: `Inflow | Week # | Notes`. Rows:
  - `PureX remittance lump sum, week` **1** (confirmed)
  - `Gelato Jan invoice collection week` **4** (Net 90 from January)
  - `Gelato Feb invoice collection week` **8**
  - `Gelato Mar invoice collection week` **12**
  - `LT current AR (Apr onward) start week` **5** (Net 30 starting)
  - `LT current AR collection spread (weeks)` **4**
  - `LT pre-April AR start week` **2**
  - `LT pre-April AR collection spread (weeks)` **6**
  - `Recurring PureX remittance frequency (weeks)` **4** ("Set to 4 = monthly. Based on 2025 actuals.")
  - `Recurring PureX remittance amount (each)` **$0** ("Avg 2025 monthly remittance from PureX (after $260K Wk1 lump) — Since we are taking the sales already")
  - `Non-collection buffer % (applied to all AR)` **10.0%**
- **Sub-table D – CREDIT CARD APR LOOKUP.** Columns: `Card | APR | Notes`. Rows: MC Consumer 23.0%, Amex Blue Business 19.0%, Delta Business 22.0%, Amex Everyday 21.0%, FNBO 24.0%, Chase 4158 22.0%, Chase 0715 22.0%.
- **Key numbers:** LOC APR 12%, monthly 1%, origination 1%. 90.2% PureX routing ratio.
- **Notes:** This is THE assumptions tab. Banner reads `ASSUMPTIONS & INPUTS — All YELLOW cells are editable. Update with actual figures from QB.` Note the README workbook structure calls this "Sheet 3" but the tab list calls it #14 — naming overlap with Tab 24 ("14. Assumptions") suggests v2 vs v4 assumptions duplication.

---

## Tab 15. 5. AR Schedule
- **Purpose:** Week-by-week mapping of every receivable's expected cash arrival across the 13-week horizon. Drives the `Customer AR Collections` row on Tab 4.
- **Columns/headers:** `Source | Gross Amount | Wk 1 05/04 | Wk 2 05/11 | Wk 3 05/18 | Wk 4 05/25 | Wk 5 06/01 | Wk 6 06/08 | Wk 7 06/15 | Wk 8 06/22 | Wk 9 06/29 | Wk 10 07/06 | Wk 11 07/13 | Wk 12 07/20 | Wk 13 07/27`
- **Row labels / line items:**
  - `Gelato Jan invoice` — Gross **$249,091.65** — all 13 weeks show $0 in this export (NOTE: visible weekly row is blank; expected Wk 4 landing per Tab 14 timing)
  - `Gelato Feb invoice` — Gross **$136,583.13** — lands Wk 5 ($136,583.13), all other weeks $0
  - `Gelato Mar invoice` — Gross **$168,614.00** — lands Wk 10 ($168,614.00), all other weeks $0
  - `LT current AR (Apr onward)` — Gross $0 — distributed: Wk 2 $104,866.80 · Wk 3 $104,866.80 · Wk 4 $104,866.80 · Wk 5 $104,866.80 · Wk 6 $64,529.77 · Wk 7 $64,529.77 · Wk 8 $64,529.77 · Wk 9 $64,529.77 · Wk 10 $83,126.32 · Wk 11 $88,627.18 · Wk 12 $88,627.18 · Wk 13 $88,627.18
  - `LT pre-April AR` — Gross $0 — all weeks $0
  - `PureX remittance (lump sum, this week)` — Gross **$260,000.00** — lands Wk 1 ($260,000), all other weeks $0
- **Key numbers:** Wk 1 inflow $260K (PureX lump). Wk 5 inflow $241K (Feb invoice + LT current AR). Wk 10 inflow $251K (Mar invoice + LT current AR). Gelato Jan invoice schedule is visibly blank in export despite Tab 14 saying it lands Wk 4 (data may not have been migrated to this row, or formula didn't render).
- **Notes:** This is the single most important "live" feeder into Tab 4. All editable yellow inputs from Tab 14 (Inflow Timing) re-shape this grid. The LT current AR row's tapering pattern ($104K → $64K → $88K) reflects Tab 14's 4-week spread + non-collection buffer logic.

---

## Tab 16. 6. CC Payoff Strategy
- **Purpose:** Side-by-side comparison of paying credit-card minimums forever vs paying off all 7 cards Week 1 and consolidating to a 12% LOC.
- **Columns/headers (main table):** `Card | Balance | APR | Monthly Interest | Min Payment | Months to Payoff (min only) | Notes`
- **Row labels / line items (status quo):**
  - `MC Consumer` $23,763 / 23.0% / Mo Int $455 / Min $706 / **55 months** to payoff (min only) / Business
  - `Amex Blue Business` $31,932 / 19.0% / $505 / $7,993 / **5 mo** / Business, high min
  - `Delta Business` $3,265 / 22.0% / $60 / $0 / **Never (min<int)** / Business
  - `Amex Everyday` $15,464 / 21.0% / $270 / $415 / **61 mo** / Business
  - `FNBO` $17,825 / 24.0% / $356 / $2,225 / **9 mo** / Business
  - `Chase 4158` $24,810 / 22.0% / $455 / $776 / **49 mo** / Business
  - `Chase 0715` $3,269 / 22.0% / $60 / $102 / **49 mo** / Business
  - `TOTAL (Status Quo)` $120,328 / **21.6% weighted APR** / Mo Int **$2,162** / Min $12,217
- **After-LOC-consolidation row:** `Consolidated to LOC` $120,328 / 12.0% / Mo Int **$1,203** / Min $0 / "Never" → **MONTHLY INTEREST SAVED $959 · ANNUAL INTEREST SAVED $11,502**.
- **Strategy block ("STRATEGY EXPLAINED"):**
  - Step 1 (Week 1): Pay off ALL business credit cards using cash on hand + $260K PureX inflow.
  - Step 2: All CC minimum payments disappear from cash flow.
  - Step 3: Use LOC ONLY as backup (interest only on drawn balance).
  - Step 4: Direct future AR collections toward LOC paydown if any draws occur.
- **Key numbers:** Weighted APR 21.6% → 12.0% = **$11,502/yr savings**. Total CC payoff $120,328 (matches Tab 3 subtotal exactly).
- **Notes:** APR sourced from Tab 14 sub-table D. Balance sourced from Tab 3 (Current Position). This is the rationale tab that justifies the Wk-1 $120,328 outflow on Tab 4.

---

## Tab 17. 7. LOC Sizing & Lenders
- **Purpose:** Justify the recommended LOC facility size, then walk through 3 lender categories with APR/funding-time/pros/cons.
- **Sizing table.** Columns: `Component | Amount | Rationale`. Rows:
  - `LOC facility size (approved, undrawn)` $0 — "Total approved capacity" (editable, currently blank)
  - `Expected Week 1 use: pay off all CCs` **$120,328** — "Eliminate 21% APR debt; save $11.5K/year"
  - `Operating buffer (4 weeks direct OpEx)` **$46,014** — "1 month of LT-direct OpEx (auto-linked to Sheet 3a)"
  - `Contingency (15%)` **$24,951** — "Standard buffer"
  - `EXPECTED PEAK DRAWN BALANCE` **$191,293** — "Likely peak; actual draw depends on AR timing"
- **Narrative panel "WHY A REVOLVING LOC, NOT A TERM LOAN":** 4 points — (1) interest only on drawn balance; (2) line stays available for future gaps; (3) origination fee only ($4,500 = 1% of $450K); (4) excess cash auto-sweeps to paydown. Rejects $450K term loan ($54K/yr unnecessary interest).
- **Lender comparison — Option A: Traditional Bank LOC.** Lenders: Chase Business, BofA Business, PNC, Huntington (MI), Comerica. APR 8–11%. $100K–$500K+. Time to fund 30–60 days. Pros: lowest cost, revolving, relationship. Cons: strictest underwriting, 2 yrs tax returns, P&L, BS, debt schedule, personal guarantee. Best fit: 2+ yrs tax returns, owner credit 680+, time to wait.
- **Lender comparison — Option B (SBA-implied).** Lenders: Live Oak Bank, Huntington National, Comerica (SBA preferred MI). APR 10.5–13.5% (Prime + 2.75–4.75%). Up to $5M, typically $50K–$350K. Time 45–90 days. Pros: govt-backed, lenient, longer terms, debt consolidation. Cons: slower, SBA paperwork, 2–3.75% guarantee fee. Best fit: bank LOC denied; use sba.gov/lendermatch.
- **Lender comparison — Option C: Online / Fintech.** Lenders: Bluevine LOC, OnDeck, Fundbox, AmEx Business Line. APR 15–24%+. $10K–$250K. Time 1–7 days. Pros: fast funding, minimal docs. Cons: higher APR, shorter terms, daily/weekly auto-debits. Best fit: emergency bridge, refinance into bank LOC ASAP.
- **RECOMMENDED ACTION SEQUENCE:** (1) TODAY: receive $260K PureX, pay off ALL CCs. (2) WEEK 1: apply for bank LOC ($450K), submit this model. (3) WEEK 2: submit SBA Lender Match as backup. (4) WEEKS 4–8: Bank LOC approved, hold UNDRAWN. (5) ONGOING: maintain at $0 to preserve $450K capacity.
- **Key numbers:** $450K target facility size. $191,293 expected peak draw. $4,500 origination fee. $54K/yr term-loan alternative cost (rejected).
- **Notes:** "Operating buffer $46,014" links to Tab 5 (3a) LT avg/month. Sizing math: $120,328 + $46,014 + $24,951 = $191,293 expected peak; round up to $450K for headroom.

---

## Tab 18. 8. Cash Health Roadmap
- **Purpose:** 90-day operational improvement plan, organized in time-phased buckets plus thematic improvement workstreams.
- **Time-phased table.** Columns: `Phase | Description`.
  - `WEEK 1 (Stabilize)` — "Receive $260K PureX. Pay off ALL credit cards. Pause non-essential expenses."
  - `WEEKS 2 to 4 (Bridge)` — "LT pre-April AR collects ($88K/week). Gelato Jan invoice collects in Week 4. Bank LOC docs submitted."
  - `WEEKS 5 to 8 (Consolidate)` — "Bank LOC approved. LT current AR collects ($72K/week). Gelato Feb collects in Week 8."
  - `WEEKS 9 to 13 (Grow)` — "Cash steady. Gelato Mar collects in Week 12. PureX intercompany balance reduces. LOC undrawn."
  - `WEEKS 14+ (Strengthen)` — "Implement deposit-required policy. Renegotiate Gelato terms. Build 60-day cash reserve."
- **AR OPTIMIZATION workstream rows:** `Renegotiate Gelato payment terms` (Net 60 with 1% volume discount OR Net 30 with 2% early-pay; even Net 75 frees ~$200K) · `Same-day invoicing` (accelerates 10–15 days vs month-end) · `Weekly AR aging review` (Friday meetings, owner calls top 5 overdue) · `Deposits on new contracts` (30–50% deposit before work begins) · `1.5% early-pay discount on LT receivables` (cheaper than 12% LOC).
- **VENDOR PAYMENT OPTIMIZATION workstream rows:** `Negotiate Net 45 to Net 60 with top 5 vendors` (frees $25K–$40K) · `Take early-pay discounts ONLY when cash-positive` (2/10 Net 30 = ~36% annualized) · `Stagger payment cycles` (away from payroll weeks) · `Two-signature rule for new expenses over $1,000` (discretionary expense control).
- **INTERCOMPANY (PUREX) STRUCTURAL FIXES rows:** `Formalize the intercompany agreement in writing` (critical for lender presentations) · `Move to weekly settlement cadence` (Friday weekly, vs twice-monthly ad-hoc) · `Set a maximum intercompany balance ceiling` (cap at $200K outstanding).
- **Key numbers:** $88K/week pre-April AR bridge; $72K/week LT current AR; $200K intercompany cap; $200K WC freed via Gelato Net 75; $25K–$40K WC freed via vendor Net 45–60.
- **Notes:** Narrative / playbook tab. No formulas. Editorial output, not data.

---

## Tab 19. 9. Variance Analysis
- **Purpose:** Per workbook structure README, this is intended to compare actuals vs forecast.
- **Columns/headers:** **No rendered content in this export.** Tab exists in the README index but the cell grid did not export.
- **Row labels / line items:** Not present in export.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Likely template scaffolding only at the time of export. Cross-reference Tab 29 (19. Variance Tracker) which appears to be the actual operational variance tab described in the README.

---

## Tab 20. 10. Inventory Roll
- **Purpose:** 13-week roll-forward of inventory at cost across three stages (Raw Materials, WIP/Testing Hold, Finished Goods) plus three derived metrics.
- **Columns/headers:** `Line Item | W1 04-May | W2 11-May | W3 18-May | W4 25-May | W5 01-Jun | W6 08-Jun | W7 15-Jun | W8 22-Jun | W9 29-Jun | W10 06-Jul | W11 13-Jul | W12 20-Jul | W13 27-Jul`
- **Row labels / line items (all cells `-` placeholders — template):**
  - **RAW MATERIALS ($):** `Beginning Raw` · `(+) Purchases` · `(-) Used in production` · `Ending Raw`
  - **WORK IN PROGRESS, TESTING HOLD ($):** `Beginning WIP` · `(+) Production additions` · `(-) Released to Finished Goods` · `(-) Failed batches scrapped` · `Ending WIP`
  - **FINISHED GOODS ($):** `Beginning FG` · `(+) Released from WIP` · `(-) Units sold (at cost)` · `(-) Scrap / shrinkage` · `Ending FG`
  - **INVENTORY METRICS:** `Total Inventory Value ($)` (all `-`) · `Days of Cover (FG vs avg daily demand)` (all `0.0`) · `Cash-in-Inventory Ratio (vs trailing 4w receipts)` (all `0.00`)
- **Key numbers:** All zeros. Template structure is complete but unpopulated.
- **Notes:** **EMPTY TEMPLATE.** Captures the 3-stage cannabis inventory flow with explicit testing-hold lag and a scrap/shrinkage line. Once populated, "Days of Cover" and "Cash-in-Inventory Ratio" become the KPIs that wire into Tab 30 (Production & Batch Plan) and Tab 31 (Decision Alerts).

---

## Tab 21. 11. Historical Sales
- **Purpose:** Per README, historical sales reference (not described further in the export).
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Likely contains monthly/quarterly sales by product line, used to seed Tab 22/23 (Seasonality) and Tab 25 (Monthly Forecast). Not part of the operational dashboard scope per your instructions.

---

## Tab 22. 12. Seasonality (Gelato)
- **Purpose:** Per README, Gelato-specific seasonality curve.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Likely monthly index factors (1.00 = avg). Feeds Monthly Forecast.

---

## Tab 23. 13. Seasonality (Others)
- **Purpose:** Per README, seasonality curve for non-Gelato product lines.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Same structure as Tab 22, for other SKUs.

---

## Tab 24. 14. Assumptions
- **Purpose:** Per README, second-tier assumptions (likely v4 forward-looking inputs distinct from Tab 14 / "3. Assumptions" which is the v2 13-week assumptions).
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Naming collision with Tab 14 ("3. Assumptions") suggests this is the longer-horizon assumptions sheet (monthly model parameters) vs the weekly model on Tab 14.

---

## Tab 25. 15. Monthly Forecast
- **Purpose:** Per README, monthly P&L / cash forecast (likely 12+ month view, derived from Tabs 21–24).
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Intended monthly-grain output of the long-range model.

---

## Tab 26. 16. Weekly Invoices
- **Purpose:** Per README, week-by-week schedule of invoices to be issued (the forward complement to AR Schedule).
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Will pair with Tab 27 (Weekly Collections) to drive the receivables forecast in the new model.

---

## Tab 27. 17. Weekly Collections
- **Purpose:** Per README, the new-model equivalent of Tab 15 (AR Schedule) — week-by-week collection forecast tied to Tab 26.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Future operational AR tab.

---

## Tab 28. 18. Outflow Budget  *(README: "Forward-looking 13-week budget for every cash outflow")*
- **Purpose:** Per README, forward-looking 13-week budget covering **every** cash-outflow category: payroll, inventory & raw materials, packaging, lab testing, compliance, taxes, capex, software, rent/utilities, banking fees, professional fees, marketing. **"Decided in the Monday planning call. Feeds the variance tracker."**
- **Columns/headers:** **No rendered content in this export.** Per the design intent, columns should be `Category | Wk 1 ... Wk 13 | Total | Notes` mirroring Tab 4's 13-week grid.
- **Expected row labels (per README description):** `Payroll`, `Inventory & Raw Materials`, `Packaging`, `Lab Testing`, `Compliance`, `Taxes`, `Capex`, `Software`, `Rent / Utilities`, `Banking Fees`, `Professional Fees`, `Marketing`.
- **Key numbers:** None visible in export.
- **Notes:** **EMPTY in export.** This is the **planning-side** counterpart to Tab 4's snapshot — Tab 4 shows the current best estimate, Tab 28 holds the explicitly-decided Monday-call budget. Cadence: updated every Monday. Feeds Tab 29 (Variance Tracker).

---

## Tab 29. 19. Variance Tracker  *(README: "Friday close: drop in actuals against the Budget. Computes variance $ and %. Includes a re-route log so a postponed payment is pushed to a future week and flagged for the next Monday call.")*
- **Purpose:** Per README, Friday-close actuals vs the Outflow Budget (Tab 28). Computes $ and % variance per category per week. Includes a **re-route log** so postponed payments push to a future week and get flagged for next Monday.
- **Columns/headers:** **No rendered content in this export.** Expected: `Category | Budget Wk N | Actual Wk N | Variance $ | Variance % | Re-route To Week | Re-route Notes`.
- **Row labels:** Same category list as Tab 28 (Payroll, Inventory, Packaging, etc.).
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Cadence: updated every Friday. The re-route log is the bridge between the previous Friday's actuals and the next Monday's re-planning. Critical for the operational dashboard.

---

## Tab 30. 20. Production & Batch Plan
- **Purpose:** Per README, cannabis batch costing — units planned, raw material cost (cannabis input + ingredients), packaging, lab testing fee, labor allocation. Captures testing-hold lag and ties batch funding to the weekly cash plan.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Will feed the inventory roll (Tab 20) and the funding line in Tab 28.

---

## Tab 31. 21. Decision Alerts
- **Purpose:** Per README, trip-wire dashboard. Specific alerts named: minimum cash breach, payroll funding risk, tax payment risk, critical vendor risk, inventory overbuild, batch funding shortfall, collection delay, cumulative margin of error >5%.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present — but the README enumerates 8 alert types verbatim.
- **Key numbers:** Cumulative margin-of-error threshold **5%** (named explicitly).
- **Notes:** **EMPTY in export.** Pure output/dashboard tab. Each alert is a boolean derived from other tabs (Tab 4 for min-cash, Tab 28/29 for variance, Tab 20 for inventory, Tab 7 for AR delay).

---

## Tab 32. 22. Scenario Modeling
- **Purpose:** Per README, side-by-side scenarios: Base / Downside / Upside / Delayed Collection / Inventory Build / Tax Pressure / Post-280E. Each applies a delta to base inflows/outflows and reports the implied minimum cash.
- **Columns/headers:** **No rendered content in this export.** Expected: `Scenario | Inflow Delta | Outflow Delta | Implied Min Cash | Notes`.
- **Row labels (named in README):** `Base`, `Downside`, `Upside`, `Delayed Collection`, `Inventory Build`, `Tax Pressure`, `Post-280E`.
- **Key numbers:** None visible.
- **Notes:** **EMPTY in export.** Output tab. Post-280E references the federal tax-code reclassification of cannabis — a structural-tax scenario.

---

## Tab 33. 23. Meeting Cadence
- **Purpose:** Per README, named system-of-record for "who updates what and when." Contains agendas: Friday close agenda, Monday plan agenda, Monthly review agenda, Quarterly review agenda — each with checklist of inputs to review and outputs to produce.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present — but the README enumerates 4 cadences.
- **Key numbers:** None.
- **Notes:** **EMPTY in export.** Process/governance tab. Pairs with Tab 28 (Monday) and Tab 29 (Friday).

---

## Tab 34. 24. Implementation Roadmap
- **Purpose:** Per README, phased automation plan: QuickBooks pull, bank feeds, AR aging, AP aging, inventory reports, Metrc / seed-to-sale, ending in a fully automated rolling cash flow model.
- **Columns/headers:** **No rendered content in this export.**
- **Row labels / line items:** Not present — but README lists 6 phases verbatim (QuickBooks pull → bank feeds → AR aging → AP aging → inventory reports → Metrc/seed-to-sale → fully automated).
- **Key numbers:** None.
- **Notes:** **EMPTY in export.** Project-plan tab, not operational.

---

## Cross-tab data flow (verified from this export)

| Source tab | Consumed by |
|---|---|
| Tab 3 (1b. Current Position) | Tab 4 Wk1 Opening Cash; Tab 16 CC payoff list |
| Tab 5 (3a. Monthly Summary) | Tab 17 ($46,014 operating buffer) |
| Tab 7 (3c. AR Aging) | Tab 15 (AR Schedule weekly placement) |
| Tab 8 (3d. Subscriptions) | Tab 4 Software & Subscriptions row |
| Tab 9 (3e. Expenses PureX) | Tab 5 (3a); Tab 11 (3g Payroll Detail); Tab 12 (3h Non-Payroll Detail) |
| Tab 10 (3f. Expenses Moysh) | Tab 5 (3a); Tab 11; Tab 12 |
| Tab 14 (3. Assumptions) | Tab 15 (Inflow Timing); Tab 16 (APR lookup); Tab 17 (LOC params); Tab 13 (Capex `Inputs!B17`) |
| Tab 15 (5. AR Schedule) | Tab 4 `Customer AR Collections (from Sheet 4)` row |
| Tab 16 (6. CC Payoff) | Tab 4 Wk1 `Credit Card Full Payoff` $120,328 |
