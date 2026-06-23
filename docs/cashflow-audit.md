# Subscription audit vs. QuickBooks

- Realm: `9130357914032116`
- Lookback window: 6 months (since 2025-11-11)
- QBO totals: 121 vendors, 1315 purchases, 370 bills

## Summary
- **Strong vendor match:** 11
- **Fuzzy / probable match:** 2
- **No vendor record, but found in line-item descriptions:** 27
- **Not found at all in last 6 months:** 6

## Detail

| Expected | $/mo | Match | Score | QBO last seen | QBO txns | QBO avg amt | Notes |
|---|---:|---|---:|---|---:|---:|---|
| DATACREW SOFTWARE | $3,500.00 | _(line-item match: DATACREW SOFTWARE…)_ | line | 2026-01-19 | 2 | $3,500.00 | Annual sub - data tools |
| CCA SOLUTIONS | $1,500.00 | IFC Solutions | 0.67 | — | 0 | — | Compliance services |
| HEADSET INC | $1,295.00 | HeadSet | 0.88 | 2025-12-16 | 1 | $1,590.00 | Bi-monthly data analytics · ⚠ avg +$295.00 vs expected |
| GUSTO | $820.00 | Gusto | 1.00 | 2026-03-27 | 48 | $1,677.67 | Payroll fee only · ⚠ avg +$857.67 vs expected |
| HOLY SMOKZ | $625.00 | _(line-item match: Holy Smokz Reimbursement Sparkplug…)_ | line | 2026-02-02 | 3 | $625.00 | Sparkplug reimbursement |
| LINDY | $494.00 | _(line-item match: LINDY…)_ | line | 2025-12-14 | 5 | $255.98 |  |
| FRONT GROWTH | $395.00 | _(line-item match: 8230509ELEHMZ45SX FRONT GROWTH-2 SAN FRA…)_ | line | 2026-03-09 | 3 | $395.00 |  |
| HUBSPOT | $300.00 | _(line-item match: Hubspot Inc.…)_ | line | 2026-03-21 | 5 | $505.81 |  |
| REPLIT | $300.00 | _(line-item match: REPLIT, INC.…)_ | line | 2025-12-13 | 5 | $88.42 |  |
| OPENAI | $230.00 | _(line-item match: OPENAI…)_ | line | 2026-03-23 | 5 | $15.26 | aka ChatGPT, multiple seats |
| LIMITLESS | $228.00 | — | — | — | 0 | — | ❌ no QBO record |
| NOTION | $226.00 | _(line-item match: NOTION LABS, INC.…)_ | line | 2026-05-05 | 5 | $355.78 |  |
| SLACK | $197.00 | _(line-item match: 8230509FBEHNM3G13 SLACK T07LA19KVFB SAN …)_ | line | 2026-04-01 | 4 | $193.25 |  |
| CLICKUP | $150.00 | _(line-item match: CLICKUP…)_ | line | 2026-03-17 | 5 | $79.48 |  |
| 3030 LABS | $145.00 | _(line-item match: 3030 LABS, INC.…)_ | line | 2025-12-25 | 3 | $145.00 |  |
| APPLE | $143.00 | Apple | 1.00 | 2026-05-05 | 40 | $52.17 | iCloud + apps · ⚠ avg $-90.83 vs expected |
| AMAZON BUSINESS | $137.00 | Amazon | 0.88 | 2026-03-31 | 159 | $99.08 | B2B Prime · ⚠ avg $-37.92 vs expected |
| QUICKBOOKS | $107.00 | QuickBooks Payments | 0.92 | 2026-03-24 | 6 | $67.31 | ⚠ avg $-39.69 vs expected |
| PADDLE | $99.00 | _(line-item match: PADDLE.NET* TIMEDOCTOR…)_ | line | 2026-05-03 | 5 | $133.60 |  |
| WEEDMAPS | $99.00 | — | — | — | 0 | — | Ghost Mgmt · ❌ no QBO record |
| INTRO | $99.00 | — | — | — | 0 | — | Xavier H coaching · ❌ no QBO record |
| NOTTA | $98.00 | _(line-item match: NOTTA…)_ | line | 2026-05-04 | 1 | $97.99 |  |
| WEBSTAURANT | $89.00 | Webstaurant | 1.00 | 2026-04-28 | 51 | $592.99 | Membership only · ⚠ avg +$503.99 vs expected |
| HOMEBASE | $70.00 | — | — | — | 0 | — | ❌ no QBO record |
| AAA | $65.00 | _(line-item match: AAA ACG NE0069 EFT RCC   800-222-1134 MI…)_ | line | 2025-12-29 | 1 | $65.00 |  |
| AMBIENT | $50.00 | _(line-item match: Ambient Temp Inc Inv 1782 Check 3272…)_ | line | 2026-02-25 | 4 | $287.50 |  |
| PROACTOR | $50.00 | _(line-item match: PROACTOR AI…)_ | line | 2025-11-17 | 1 | $49.99 |  |
| CARRY | $49.00 | _(line-item match: WWW.CARRY.COM…)_ | line | 2026-02-10 | 4 | $49.00 |  |
| TIMEERO | $40.00 | _(line-item match: TIMEERO GILBERT AZ XXXX1025…)_ | line | 2026-04-15 | 5 | $62.94 |  |
| PERPLEXITY | $40.00 | Perplexity (Chatgpt competitor) | 0.92 | 2026-04-25 | 11 | $44.13 |  |
| ADOBE | $39.00 | Adobe | 1.00 | 2026-05-03 | 12 | $19.68 | ⚠ avg $-19.32 vs expected |
| EXPERIAN | $35.00 | Experian | 1.00 | 2026-03-09 | 4 | $34.99 |  |
| PLAUD | $30.00 | _(line-item match: PLAUD LLC SAN FRANCISCO CA XXXX1015…)_ | line | 2026-04-04 | 5 | $29.99 |  |
| CLIPTO | $25.00 | — | — | — | 0 | — | ❌ no QBO record |
| N8N CLOUD | $24.00 | _(line-item match: PADDLE.NET* N8N CLOUD1…)_ | line | 2026-05-02 | 5 | $24.00 | via Paddle |
| LOOM | $24.00 | — | — | — | 0 | — | ❌ no QBO record |
| GOOGLE WORKSPACE | $23.00 | _(line-item match: 1527021FB013V4ZJM GOOGLE WORKSPACE_LITTL…)_ | line | 2026-04-01 | 5 | $486.91 |  |
| CLAY | $20.00 | _(line-item match: CLAY SOFTWARE…)_ | line | 2025-12-15 | 4 | $20.00 | sales software |
| LENNY'S NEWSLETTER | $20.00 | S&S Flavors Inc | 0.63 | — | 0 | — |  |
| SHOPIFY | $17.00 | _(line-item match: SHOPIFY* XXXXX1544…)_ | line | 2026-03-02 | 5 | $91.59 |  |
| SMALLPDF | $15.00 | _(line-item match: SMALLPDF…)_ | line | 2026-05-03 | 5 | $15.00 |  |
| AUDIBLE | $15.00 | Audible | 1.00 | 2026-02-28 | 4 | $14.95 |  |
| CANVA | $15.00 | _(line-item match: PAYPAL *CANVA…)_ | line | 2026-04-15 | 4 | $15.00 |  |
| SIMPLEMDM | $13.00 | _(line-item match: SIMPLEMDM…)_ | line | 2026-03-18 | 5 | $8.59 |  |
| DOORDASH | $10.00 | DoorDash | 1.00 | 2026-03-30 | 177 | $79.63 | DashPass only · ⚠ avg +$69.63 vs expected |
| GETTOBY | $6.00 | _(line-item match: WWW.GETTOBY.COM…)_ | line | 2026-04-22 | 5 | $6.00 |  |

## Borderline matches (review)

- **CCA SOLUTIONS** → best: `IFC Solutions` (score 0.67)
    - alt: `Infineed Solutions Pvt. Ltd` (score 0.63)
- **LENNY'S NEWSLETTER** → best: `S&S Flavors Inc` (score 0.63)
    - alt: `Tim Horton's` (score 0.60)
    - alt: `Trader Joe's` (score 0.60)

## Recurring QBO vendor activity not on the expected list (top 25)

Only vendors with **2+ transactions** in the lookback window. Likely candidates for missed subscriptions or other recurring spend.

| Vendor | Txns | Total | Avg | Last seen |
|---|---:|---:|---:|---|
| Upwork | 18 | $51,337.23 | $2,852.07 | 2026-03-30 |
| Albanese Confectionary | 5 | $47,104.04 | $9,420.81 | 2026-04-01 |
| Infineed Solutions Pvt. Ltd | 13 | $33,241.00 | $2,557.00 | 2026-02-28 |
| Lucid Design | 6 | $27,630.75 | $4,605.13 | 2026-01-10 |
| State of Michigan | 7 | $25,814.50 | $3,687.79 | 2026-03-29 |
| Amoretti | 18 | $17,901.71 | $994
| Metro Airport Parking | 6 | $1,301.47 | $216.91 | 2026-03-28 |
| Starbucks | 21 | $943.03 | $44.91 | 2026-04-12 |
| Exxon | 11 | $723.30 | $65.75 | 2026-04-12 |
| MSI Insurance | 2 | $571.34 | $285.67 | 2026-03-01 |
| U-Haul | 5 | $520.00 | $104.00 | 2026-04-16 |
| Wix | 19 | $494.91 | $26.05 | 2026-05-05 |
