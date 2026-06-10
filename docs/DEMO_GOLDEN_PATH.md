# Otto/Duvo — Demo Golden Path

End-to-end happy-path demo script. One fictional company carried through all four
surfaces: Director voice interview → High-Level Overview dashboard → Operator
live-screenshare interview → published Process Node Map.

Everything below is written to match the real product vocabulary: director slots
(`function.name`, `process.inventory`, `scope.boundaries`, `ownership.roles`,
`systems-of-record`, friction/SPOF), the complexity-score factor model, the
automation pattern enum (`workflow_automation`, `system_integration`,
`approval_routing`, `exception_monitoring`, `data_validation`, `agent_assistant`,
`intake_form`, `report_generation`, `knowledge_base`), `impact_band`/`effort_band`,
and the operator node kinds (`task | decision | wait | handoff | exception | terminal`).

---

## 0. The Demo Persona (set this up once, keep it consistent)

- **Company:** Westvale Provisions — mid-size specialty food & beverage distributor (~120 people). Wholesale to restaurants and regional grocers.
- **Why this company:** Odoo is genuinely common in wholesale/distribution, so the ERP reads as authentic. Order ops naturally span **Gmail** (orders arrive by email), **Odoo** (ERP: customers, inventory, sales orders), and **Google Sheets** (the daily order tracker + the "real" price list).
- **Director (Surface 1):** *Dana Whitfield, VP of Operations.*
- **Operator (Surface 3):** *Marcus, Order Desk Coordinator* — the person who actually keys orders all day.

This is the classic "the real process lives in Marcus's head, not the SOP" story — perfect for showing Director breadth → Operator depth.

---

## 1. Director Voice Interview (Surface 1)

Goal of this segment: show the agent moving cleanly through phases
`orient → inventory → expand → enrich → closeout`, filling slots and visibly
building the inventory. ~9 exchanges: go **deep** on the focus process (Order
Intake) and then **sweep** the other five at director depth so the dashboard
reads above 80% coverage. Keep Dana's answers crisp; the agent asks exactly one
question per turn (matches `director.turn.plan`).

> Tip: the on-screen coverage meter should tick up as slots fill. Coverage here =
> % of inventoried processes that have owner + systems + cadence + at least one
> friction captured, plus the focus process fully expanded. Going one-deep on all
> six at director depth is what pushes the meter past 80% — a single deep-mapped
> process would only read ~35–40%. By the end you want `function.name`,
> `process.inventory` (6 processes), the focus process fully expanded
> (`scope.boundaries`, `ownership.roles`, systems, cadence/volume, friction,
> SPOF), and the breadth slots filled for the other five.

### Exchange 1 — orient (`discover_function`)
- **Otto:** "Thanks for making the time, Dana. To start broad — what part of the business do you oversee?"
- **Dana:** "I'm VP of Operations. I own everything from when a customer order comes in through getting it picked, shipped, and invoiced — plus purchasing and our vendor payments."
- *(slot filled: `function.name = Operations — order-to-cash + procurement`)*

### Exchange 2 — inventory (`discover_processes`)
- **Otto:** "Got it. What are the main recurring processes your team owns day to day?"
- **Dana:** "Six big ones. Order intake — taking customer orders into the system. Purchasing and replenishment. Vendor invoice processing, our AP. Inventory cycle counts. New customer onboarding and credit setup. And returns and credit memos."
- *(slot filled: `process.inventory = [6 processes]` — the dashboard grid is now seeded)*

### Exchange 3 — expand (`define_process_boundary` + which to map first)
- **Otto:** "That gives me the map. Which of those should we go deep on first?"
- **Dana:** "Order intake, easily. It's the highest volume and it's where mistakes cost us — wrong quantities, missed backorders, pricing that doesn't match."
- **Otto:** "Makes sense. For order intake, where does the process start, and where is it considered done?"
- **Dana:** "Starts when an order email lands in our shared inbox. It's done once the order's in Odoo, confirmed back to the customer, and released to the warehouse to pick."
- *(slots: `scope.boundaries = start: order email in shared Gmail inbox; end: SO confirmed + released to fulfillment`)*

### Exchange 4 — enrich (owner, systems, cadence/volume, friction)
- **Otto:** "Who's accountable for that process, and who else touches it?"
- **Dana:** "Marcus runs the order desk — he keys basically all of it. Warehouse picks from it, and Finance gets pulled in when a customer's over their credit limit."
- **Otto:** "Which systems does order intake run on?"
- **Dana:** "Orders come in over Gmail. Everything gets entered in Odoo. And Marcus keeps a Google Sheet as the daily tracker — honestly the Sheet is also where the *real* current price list lives, not Odoo."
- *(slots: `ownership.roles = Order Desk (Marcus) accountable; Warehouse, Finance participate`; `systems = Gmail, Odoo, Google Sheets`; friction captured: pricing source-of-truth conflict)*

### Exchange 5 — enrich (cadence, volume, SPOF, friction)
- **Otto:** "Roughly how many orders run through this, and how often?"
- **Dana:** "40 to 60 orders a day, every business day. Spikes Mondays."
- **Otto:** "And where does it hurt most today?"
- **Dana:** "Two things. It all runs through Marcus — if he's out, intake basically stops. And the stock and credit checks are manual, so we catch backorders and over-limit accounts late, sometimes after we've already promised the customer."
- **Otto:** "Clear picture — single-owner risk plus late stock and credit checks. I've got order intake mapped end to end. Before we wrap, let me get a quick read on the other five so the overview is complete — fast version, a couple details each."
- *(slots: `cadence = daily, 40–60/day`; **SPOF** flagged: order desk single-owner; friction: manual stock + credit checks → late exceptions. Focus process now fully expanded.)*

> The next four exchanges are a deliberate **breadth sweep**. Dana answers each in
> one breath; Otto captures owner + systems + cadence + friction per process. This
> is what fills the coverage meter to 80%+. Keep the pace brisk on camera.

### Exchange 6 — breadth sweep: Purchasing & AP
- **Otto:** "Purchasing and replenishment — who owns it, on what systems, and how often?"
- **Dana:** "Our purchasing lead, Priya. She works off Odoo plus a reorder Google Sheet, places POs weekly and ad hoc when something runs low. The pain is it's reactive — we usually reorder *after* we've already stocked out."
- **Otto:** "And vendor invoice processing — your AP?"
- **Dana:** "That's all one AP clerk, Tom. Invoices hit a Gmail inbox, he matches them against POs and receipts in Odoo by hand — about 200 a month. It's slow and it's entirely on him."
- *(slots filled for **Purchasing** and **AP**: owner, systems, cadence, friction; **SPOF** flagged on AP)*

### Exchange 7 — breadth sweep: Cycle Counts & Onboarding
- **Otto:** "Inventory cycle counts — owner, system, cadence?"
- **Dana:** "Warehouse lead runs them in Odoo, monthly. Honestly that one's pretty clean — least of my worries."
- **Otto:** "And new customer onboarding and credit setup?"
- **Dana:** "Finance and Sales split it — about 15 a month, in Odoo with some back-and-forth over Gmail. The friction is credit setup is slow, which is exactly why orders later get stuck at the credit check."
- *(slots filled for **Cycle Counts** and **Onboarding**: owner, systems, cadence, friction; note the onboarding↔intake dependency)*

### Exchange 8 — breadth sweep: Returns & Credit Memos
- **Otto:** "Last one — returns and credit memos?"
- **Dana:** "Marcus and Finance, roughly 30 a month, Odoo plus Gmail. It's the most undocumented thing we have — every rep does it a little differently, and we have no real policy written down."
- *(slots filled for **Returns**: owner, systems, cadence, friction. All six now at director depth.)*

### Exchange 9 — closeout (`playback`)
- **Otto:** "That completes the picture. Here's what I have: six processes across Gmail, Odoo, and Google Sheets, with order intake mapped in full. Three of them lean on a single person — order desk, AP, and purchasing — and I'm seeing a recurring theme of manual cross-system work and exceptions caught too late. Anything important under your team we haven't named?"
- **Dana:** "No, that's the whole department. That's more than I expected from one conversation."
- **Otto:** "Great. The overview's ready, and order intake is queued for a deep dive with Marcus."

**What the audience just saw:** nine turns, fast spoken responses, and a live
inventory + coverage build that lands above 80%. Now cut to the dashboard.

---

## 2. High-Level Overview Dashboard (Surface 2)

Header KPI strip (the four headline tiles):

| KPI | Value | Note for narration |
|---|---|---|
| **Processes captured** | **6** | straight from `process.inventory` |
| **Coverage** | **84%** | all 6 captured at director depth (owner+systems+cadence+friction); intake fully expanded |
| **Avg complexity** | **64 / 100** | weighted across the 6 |
| **SPOF count** | **3** | order desk, AP clerk, purchasing lead |

> Why 84% and not 100%: the five non-focus processes have director-level breadth
> but aren't yet expanded to L4 (no operator deep-dive), and Returns is explicitly
> undocumented. That gap is honest *and* it sets up the operator segment — "let's
> close the remaining coverage by going deep on intake." Don't claim 100%; a
> perfect meter reads fake.

### Process card grid (6 cards)

Each card: name · accountable owner · systems · frequency · complexity · risk flag.

1. **Order Intake & Confirmation** — Order Desk (Marcus) · Gmail, Odoo, Google Sheets · 40–60/day · **Complexity 72** · 🔴 SPOF + late exceptions  *(← the one we deep-dive)*
2. **Purchasing & Replenishment** — Purchasing Lead · Odoo, Google Sheets · weekly + ad hoc · Complexity 68 · 🟠 reactive stockouts
3. **Vendor Invoice Processing (AP)** — AP Clerk · Gmail, Odoo · ~200/mo · Complexity 61 · 🔴 SPOF, manual 3-way match
4. **Inventory Cycle Counts** — Warehouse Lead · Odoo · monthly · Complexity 44 · 🟢 stable
5. **New Customer Onboarding & Credit** — Finance + Sales · Odoo, Gmail · ~15/mo · Complexity 58 · 🟠 slow credit setup
6. **Returns & Credit Memos** — Order Desk + Finance · Odoo, Gmail · ~30/mo · Complexity 67 · 🟠 ad hoc, undocumented

### Complexity breakdown for the focus card (Order Intake = 72/100)

Show the factor decomposition (matches `complexity-score.schema.json` —
`total` + named `factors`):

| Factor | Score | Why |
|---|---|---|
| System fragmentation | 22 | spans Gmail + Odoo + Google Sheets, manual re-keying between all three |
| Decision density | 16 | stock check, credit check, pricing reconciliation |
| Exception rate | 14 | backorders, over-limit accounts, price mismatches |
| Single-owner dependency (SPOF) | 12 | one coordinator runs all of it |
| Source-of-truth conflict | 8 | price list lives in the Sheet, not Odoo |

**Narration beat:** "From one conversation, Otto captured all six processes at
84% coverage, scored each one, and found all three single points of failure —
without Dana ever opening a document."

---

## 3. Director-Level Automation Plan — the **Automation tab** (Surface 2)

This is the live `AutomationTab` (`components/overview/AutomationTab.tsx`), built
from the `synthesis.director_automation` plan. The model only ever emits
*operational ranges* (volume, minutes saved, error rate, exception rate); the app
turns those into **dollars deterministically** via `computeROI` using the
workspace ROI prices. So the demo absolutely should show dollar ROI — that math
is Otto's, not the LLM guessing currency.

> **Workspace ROI prices (defaults, editable in Settings → ROI prices):**
> loaded labor `$65/hr`, cost per error `$90`, delay cost `$35`. Mentioning that
> these are configurable per workspace is a nice credibility beat — "plug in your
> own rates and the whole plan re-prices."
>
> ROI formula (per process, from `lib/roi.ts`):
> `time = volume × min_saved × $65 / 60` · `error = volume × error_rate × $90` ·
> `delay = volume × exception_rate × $35` · `gross = time+error+delay` ·
> `net = gross × confidence ÷ effort_penalty` (effort penalty: low 1.1 / med 1.35 / high 1.7).
> All figures below are computed with this formula, so they're internally consistent on screen.

### 3a. Top metric strip (3 tiles)

| Tile | Value shown | Note |
|---|---|---|
| **Net annual value range** *(emphasized)* | **$96K – $255K** | sum of per-process `net_score` low→high (base ≈ $167K) |
| **Hours saved** | **~1,450 – 4,050 / yr** | sum of `volume × min_saved / 60` (base ≈ 2,560) |
| **Processes automated** | **6** | `opportunityCount` |

### 3b. Audit Findings

**Problem**
> Operations runs 6 processes across Gmail, Odoo, and Google Sheets with manual
> handoffs and no consolidated operating layer — work is reconciled by hand,
> exceptions absorb senior time, and roughly **2,560 hours a year** are spent on
> tasks that could be automated.

**Systemic patterns** (each renders with a smaller `metricBasis` subline)
- **3 of 6 captured processes are high-complexity**, concentrating operational risk and rework in a handful of workflows.
- **Order Intake is the largest single drain** — cross-system re-keying ties up ~1,460 manual hours/yr (~$215K gross value at risk).
- **Exception handling is unmanaged** — Returns & Credit Memos carries a ~22% exception rate against ~16K annual cases department-wide, with no routing or owner queue.
- **Repeated system-integration and approval-routing opportunities recur** across processes — a department-level operating gap, not isolated one-off fixes.

### 3c. Automation plan — ranked opportunity rows (ranked by **net annual value**)

> Net-score ranking, not gut feel. Order Intake dominates, then AP and Purchasing.

**Rank 1 — Order Intake & Confirmation**  ·  pattern: **System integration + exception monitoring**

- **Implementation plan:** Trigger on a new order email in the Gmail orders inbox. Agent parses the PO, matches the customer in Odoo, runs stock and credit checks up front, reconciles line pricing against the Google Sheet price list, and drafts the Odoo sales order + tracker row + confirmation email. Exceptions (out of stock, over credit limit, price mismatch) route to a human queue; a person approves the final send.
- **Expected result:** Order entry drops from ~8 manual minutes to a ~1-minute review and stock/credit exceptions are caught before the customer is promised. **Modeled range: 833 – 2,250 hrs saved / yr; $118K – $333K gross impact at 70% confidence.**
- **Assumption pills (basis · confidence):**
  - Annual volume **10,000 – 15,000 cases** · *evidence* · 70%
  - Minutes saved **5 – 9 min/case** · *inferred* · 55%
  - Error rate **4 – 8%** · *inferred* · 50%
  - Exception rate **8 – 15%** · *evidence* · 65%

**Ranks 2–6** (each row has the same shape on screen; key figures below)

| # | Process | Pattern | Volume (base) | Min saved | Hrs saved/yr (base) | Gross impact (base) | Net value (base) | Conf |
|---|---|---|---|---|---|---|---|---|
| 2 | Vendor Invoice (AP) | Data validation + approval routing | 2,400/yr | 12 | ~480 | ~$61K | ~$23K | 65% |
| 3 | Purchasing & Replenishment | Report generation | 1,200/yr | 20 | ~400 | ~$44K | ~$20K | 60% |
| 4 | Returns & Credit Memos | Knowledge base + agent assistant | 360/yr | 15 | ~90 | ~$13K | ~$5K | 50% |
| 5 | Customer Onboarding & Credit | Intake form + approval routing | 180/yr | 25 | ~75 | ~$8K | ~$4K | 55% |
| 6 | Inventory Cycle Counts | Workflow automation | 600/yr | 6 | ~60 | ~$8K | ~$4K | 50% |

### 3d. ROI calculation breakdown (the table at the bottom of the tab)

Scoped to the top opportunity (Order Intake), shown as low–high ranges:

| Value driver | Amount | Methodology |
|---|---|---|
| Manual effort removed (Order Intake) | **$54K – $146K** | 10,000–15,000 cases × 5–9 min saved/case × $65/hr ÷ 60 |
| Error reduction (Order Intake) | **$36K – $108K** | volume × 4–8% error rate × $90 cost per error |
| Exception delay reduction (Order Intake) | **$28K – $79K** | volume × 8–15% exception rate × $35 delay cost |
| **Net realized value (Operations)** | **$96K – $255K** | time + error + delay across all 6, adjusted by confidence and effort band |

**Narration beat:** "This isn't a vibe. Otto sized every process — volume,
minutes saved, error and exception rates — and turned it into a dollar range
using *your* labor and error costs, ranked by net annual value. Order Intake is
the clear first build. Let's prove Otto can capture the real workflow before
anyone writes a line of automation."

→ Click into **Order Intake** to launch the operator deep-dive.

---

## 4. Operator Live-Screenshare Interview (Surface 3)

**Process:** Sales Order Intake & Confirmation.
**Systems on screen:** Gmail → Odoo → Google Sheets (have all three tabs open and a sample order email ready).
**Phases (real):** `orient → happy_path → hard_case → exception_sweep → playback → closeout`.

The agent is *sparing* — it lets Marcus narrate and only interrupts when a gap
blocks mapping a step/system/decision/exception (matches `operator.turn.plan`
priority order). Below: **[ON SCREEN]** = what you do, **[YOU SAY]** = Marcus
narration, **[OTTO ASKS]** = the agent's question.

### Phase: orient
- **[OTTO ASKS]:** "Whenever you're ready, walk me through a normal order from the moment it lands. I'll mostly listen and jump in if I need a detail."
- **[YOU SAY]:** "Okay, so a new order just came in to our shared inbox."

### Phase: happy_path

**Step 1 — Receive order (Gmail)**
- **[ON SCREEN]:** Open the order email in Gmail. It's a PO from "Harbor Street Bistro" listing 4 line items.
- **[YOU SAY]:** "This is how every order starts — a customer emails their PO to the orders inbox. I read it to see who it's from and what they want."

**Step 2 — Look up customer (Odoo)**
- **[ON SCREEN]:** Switch to Odoo → Contacts → search "Harbor Street Bistro" → open record.
- **[YOU SAY]:** "First thing, I pull up the customer in Odoo to make sure they're set up and check their terms."
- **[OTTO ASKS]:** "What are you checking on that customer record before you go further?"
- **[YOU SAY]:** "Mainly that they exist, their pricing tier, and their credit limit. If they're not in Odoo yet, that's a whole separate onboarding — I'd stop and send it to Finance."
  - *(Otto records: decision "Existing customer on file?", handoff to onboarding/Finance on the No branch.)*

**Step 3 — Check stock (Odoo Inventory)**
- **[ON SCREEN]:** Odoo → Inventory → check on-hand for each line item. Three are in stock; one ("Case – Sparkling Water 24ct") shows 0 available.
- **[YOU SAY]:** "Then I check stock for each line. Here — three are fine, but the sparkling water is out."
- **[OTTO ASKS]:** "When an item's out like that, what do you do — does the whole order wait, or does it split?"  *(this is a live decision/exception probe)*
- **[YOU SAY]:** "I email the customer to ask if they want to split the shipment or wait for the full order. I can't just decide for them."
  - *(Otto records: decision "All items in stock?", exception "Email customer for split-ship vs. backorder", wait on customer reply.)*

### Phase: hard_case

**Step 4 — Credit check (Odoo)**
- **[ON SCREEN]:** Back on the customer record, point at credit limit vs. open balance. This order would push them over.
- **[YOU SAY]:** "This is the part that bites us. Their order would put them over their credit limit. When that happens I can't release it — I have to send it to Finance for approval and wait."
- **[OTTO ASKS]:** "While that's with Finance, does the order sit, or do you keep working it?"
- **[YOU SAY]:** "It sits. I can't confirm to the customer until Finance clears it. Sometimes that's an hour, sometimes a day."
  - *(Otto records: decision "Over credit limit?" → wait "Finance credit approval", handoff to Finance.)*

### Phase: exception_sweep (the money shot — the undocumented workaround)

**Step 5 — Create the sales order (Odoo)**
- **[ON SCREEN]:** Odoo → Sales → New → add the in-stock lines, set the customer.
- **[YOU SAY]:** "Once it's cleared, I build the sales order in Odoo."

**Step 6 — Price reconciliation (Google Sheets) — the workaround**
- **[ON SCREEN]:** Switch to Google Sheets "2024 Price List" tab. Show that the price for one line differs from what Odoo auto-filled. Manually override the price in Odoo to match the Sheet.
- **[YOU SAY]:** "Here's the thing nobody writes down — Odoo's prices are stale. The real current price list is this Google Sheet. So for every line I cross-check the Sheet and override Odoo by hand if it doesn't match."
- **[OTTO ASKS]:** "Quick check — so the Sheet is the real source of truth for pricing, and Odoo is overridden manually every time? Is that the normal workflow, or only when something looks off?"  *(this is the SOP-vs-screen contradiction probe — exactly the high-value live question)*
- **[YOU SAY]:** "Every single order. We keep meaning to fix Odoo but never do."
  - *(Otto records: exception/workaround "Reconcile price against Google Sheet, override Odoo", source-of-truth conflict flagged, loops back to order build.)*

**Step 7 — Log in tracker (Google Sheets)**
- **[ON SCREEN]:** Switch to the "Daily Order Tracker" Sheet, add a row: date, customer, order #, status.
- **[YOU SAY]:** "Then I log it in our daily tracker Sheet so the team can see status at a glance — Odoo's views are too clunky for that."

### Phase: playback

**Step 8 — Confirm & release (Gmail + Odoo)**
- **[ON SCREEN]:** Odoo → Confirm the sales order. Switch to Gmail → reply to the customer confirming the order and noting the split shipment.
- **[YOU SAY]:** "Last thing — I confirm the SO in Odoo, which tells the warehouse to pick, and I email the customer their confirmation."
- **[OTTO ASKS]:** "Let me play this back: order email in Gmail → look up and credit-check the customer in Odoo → check stock, split if needed → build the SO, reconcile pricing against the Google Sheet → log the tracker → confirm in Odoo and email the customer. Did I miss anything?"
- **[YOU SAY]:** "That's exactly it."

### Phase: closeout
- **[OTTO ASKS]:** "Before we wrap — is there anything operators routinely do that the official process leaves out?"
- **[YOU SAY]:** "Just the price-list thing. That's the one that would bite a new person on day one."

**What the audience just saw:** the agent captured the *real* process — including
the credit-hold wait, the stock-split exception, and the undocumented Google
Sheet price override — by listening and asking ~5 targeted questions, not 30.

---

## 5. Published Process Node Map (Surface 3 output)

The synthesis output: business workflow nodes (never capture artifacts), every
node typed and grounded. Tabs: **Current Process** (the map below) · Steps (L4) ·
Impact · Insights · Risk & Vulnerabilities · **Transformation Proposal**.

### Node list (kinds match the semantic model: task/decision/wait/handoff/exception/terminal)

| ID | Kind | Title | System | Role |
|---|---|---|---|---|
| n1 | **task** | Receive customer order email | Gmail | Order Desk |
| n2 | **task** | Look up customer & terms in Odoo | Odoo | Order Desk |
| n3 | **decision** | Existing customer on file? | Odoo | Order Desk |
| n3x | **handoff** | Route to onboarding & credit setup | Odoo/Gmail | → Finance |
| n4 | **task** | Check stock for each line item | Odoo | Order Desk |
| n5 | **decision** | All items in stock? | Odoo | Order Desk |
| n5x | **exception** | Email customer: split shipment or backorder | Gmail | Order Desk |
| n5w | **wait** | Wait for customer split/backorder decision | Gmail | (customer) |
| n6 | **decision** | Order over credit limit? | Odoo | Order Desk |
| n6w | **wait** | Wait for Finance credit approval | Odoo | (Finance) |
| n6h | **handoff** | Route over-limit order to Finance | Odoo | → Finance |
| n7 | **task** | Build sales order in Odoo | Odoo | Order Desk |
| n8 | **exception** | Reconcile price vs. Google Sheet & override Odoo | Google Sheets → Odoo | Order Desk |
| n9 | **task** | Log order in Daily Order Tracker | Google Sheets | Order Desk |
| n10 | **task** | Confirm SO in Odoo & email customer | Odoo + Gmail | Order Desk |
| n10h | **handoff** | Release to warehouse for picking | Odoo | → Warehouse |
| end | **terminal** | Order confirmed & released to fulfillment | — | — |

### Topology (edges)

```
n1 ─▶ n2 ─▶ n3 ┐
               ├─ No ─▶ n3x (handoff: Finance/onboarding) ─▶ [back to n2 once set up]
               └─ Yes ─▶ n4 ─▶ n5 ┐
                                   ├─ No ──▶ n5x (exception) ─▶ n5w (wait) ─┐
                                   │                                         ▼
                                   └─ Yes ───────────────────────────────▶ n6 ┐
                                                                               ├─ Yes(over limit) ─▶ n6h (handoff) ─▶ n6w (wait) ─┐
                                                                               │                                                    ▼
                                                                               └─ No ──────────────────────────────────────────▶ n7
                                                                                                                                    │
                                          n7 ─▶ n8 (exception/workaround: Sheet price override) ──loops back to──▶ n7 if mismatch  │
                                                                                                                                    ▼
                                                                                          n7 ─▶ n9 ─▶ n10 ─▶ n10h (handoff: Warehouse) ─▶ end
```

### Why this map sells the product
- **All three systems are visible and tagged** on the nodes (Gmail, Odoo, Google Sheets) — the cross-system re-keying problem is now *visual*.
- **Two decisions, two waits, two exceptions, three handoffs** — it's a real business process, not a linear checklist.
- **The undocumented Google Sheet price override (n8)** is captured as an exception/workaround with a source-of-truth conflict — the kind of tacit knowledge the whole pitch is about ("lives in Marcus's head, not the SOP").
- It lines up 1:1 with the **Transformation Proposal** tab: the n5/n6 decisions become the `exception_monitoring` pre-checks; the n1→n2→n7→n9 re-keying chain becomes the `system_integration` agent.

### Transformation Proposal tab (the side-by-side payoff)
> **Order Intake Agent.** Trigger: order email arrives in the Gmail orders inbox.
> The agent parses the PO, matches the customer in Odoo, runs the stock and credit
> checks *up front*, reconciles pricing against the Google Sheet, and drafts the
> Odoo sales order + tracker row + confirmation email for Marcus to approve.
> Exceptions (out of stock, over credit limit, price mismatch) are surfaced
> **before** the customer is promised, with a human approving the final send.
> **Expected result:** order entry drops from ~8 manual minutes to a ~1-minute
> review; stock/credit exceptions caught pre-commitment instead of post-promise;
> intake no longer depends on one person.

---

## 6. Run-of-show cheat sheet

1. **Director voice (≈2.5min):** 9 exchanges — 5 deep on Order Intake, then a brisk 4-exchange breadth sweep across the other five; watch the inventory + coverage build to 84%.
2. **Dashboard (≈45s):** 4 KPIs (lead with **84% coverage**), 6 cards, click complexity breakdown on Order Intake.
3. **Automation plan (≈45s):** lead with the **$96K–$255K net value** strip, scroll the ranked rows + assumption pills, land on the ROI breakdown table; tee up Order Intake (rank 1) as first build.
4. **Operator screenshare (≈3–4min):** Gmail → Odoo → Google Sheets walk-through, hit the credit-hold wait, the stock split, and the Sheet price override.
5. **Node map (≈45s):** show the typed map, point at the 3 systems + the workaround node, flip to Transformation Proposal.

**The single sentence to land:** "From one short conversation and one screen-share,
Otto did the discovery half of a forward-deployed engineer's job — mapped the real
process, found where it breaks, and proposed exactly what to build."
