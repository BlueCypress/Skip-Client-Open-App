---
'@askskip/core': patch
---

Fix the production registry repair skipping the instances that need it, and say why when it declines.

`healProductionRegistryIfUnused()` treated *any* `REGISTRY_URI_OVERRIDE_SKIP` as an operator deliberately pointing production's registry somewhere, and returned without acting. But before per-environment registries existed, pointing a client at stage or a laptop **was** setting that variable — so on exactly the clients whose production `Skip` row is stale, the variable is set and the repair never ran. More Cheese Stage upgraded with its `Skip` record still aimed at `brain-stage.askskip.ai`, and nothing in the logs said so.

The test is now *where the override points*, not whether it is set. A value aimed at this instance's own brain cannot be a statement about production — production is somewhere else by definition — so it is treated as leftover wiring, the record is repaired, and the operator is told to remove the variable. A value aimed anywhere else (a mirror, a proxy) is still taken at face value and left alone.

Every path that declines to act now logs why. Previously all of them returned silently, so the only way to discover nothing had happened was to read the table. That includes the duplicate case: two records matching the production registry are now reported rather than passed over, since the existing duplicate reporting only inspects the registry the instance publishes under.
