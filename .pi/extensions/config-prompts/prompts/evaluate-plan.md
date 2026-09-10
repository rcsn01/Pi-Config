---
description: Evaluate plan.md against the code for correctness and over-engineering
---
Evaluate plan.md for correctness and architectural over-engineering.

First establish ground truth from the code yourself. Enumerate every site, symbol, hazard, and test the plan touches using grep/read/count; do not trust the plan’s inventories or numbers.

Check both directions:

Plan → code: Verify every claim, annotation, count, and risk statement against the source, including boundary cases. Repeated claims must be checked everywhere they appear.
Code → plan: Ensure every relevant hazard, edge case, and behavior-preserving subtlety is represented. A missing warning at one affected site is as much a defect as a false claim.

Try to falsify claims rather than confirm them. For each invariant, risk, or “X behaves like Y” statement, enumerate the case taxonomy and look for counterexamples or empty sets. “Verified” means boundary cases were checked. Resolve all hedges now: “verify at migration time” is unacceptable in a finalized plan—verify it and record the result.

Treat the plan as an execution checklist. Assume the implementer follows it literally without rereading the source. Anything that would lead them wrong is a defect, even if a later safeguard might catch it.

Editing rules:

Do not shorten detail merely because the plan is long. Preserve implementation detail, rationale, and decisions.
Edit only unnecessary abstractions, duplicated behavior, solutions to hypothetical problems with no current consumer, or changes whose cost outweighs their benefit.
Fix defects decisively; do not hedge.
Keep all counts, totals, tables, and cross-references consistent after edits.
If the plan is sound, leave it unchanged and explain what you verified.

Report what you verified, what you changed and why, and what you deliberately left unchanged.
