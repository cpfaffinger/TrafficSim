# ADR-0021: Navigation devices with driver compliance

- Status: Accepted
- Date: 2026-11-15

## Context

Every vehicle is simulated individually with its own route, but until now only familiar drivers
(commuters, #55) adapted their route to congestion: they re-planned on experienced travel times and
always switched. Real traffic today is shaped by navigation apps that re-plan on live traffic and
suggest detours, which drivers follow or ignore. Users also want to see why a vehicle drives where it
does: where it came from, which detours it took and which suggestions it ignored (#129).

## Decision

**A share of drivers has a navigation device** (`navigation.share`, default 0.5). The navi re-plans
every `reRouting.interval` seconds from the vehicle's current link on the experienced (live) travel
times already maintained for commuters. It proposes the new route only if it is faster by at least
`reRouting.threshold` (relative) and `navigation.minGain` seconds (absolute), so it does not flicker
between equivalent routes.

**Each driver has a compliance**, drawn per vehicle from `compliance ± complianceSpread`. A proposal
is followed with that probability, otherwise ignored (the driver keeps the route, e.g. in a hurry or
distrusting the device). Navi decisions use a random stream of their own per vehicle (seed, vehicle
id), so enabling navigation changes no other random sequence and runs stay deterministic per seed.

**Commuters stay as they are**: they know the network, re-plan on the same travel times and always
switch. A vehicle that misses a mandatory lane change is still re-routed from where it is.

**Every vehicle keeps a trip record**: the links driven, its route at insertion and a log of route
events (`accepted` / `ignored` proposals with the estimated saving, `commuter` re-plans,
`missedTurn`). The vehicle inspector shows it and draws the trip: links driven, links ahead and the
abandoned rest of the original route. Debug snapshots of vehicles, links, lanes and junctions can be
downloaded as JSON for bug reports.

## Consequences

- Congested links are avoided by part of the traffic, as in reality; detours load parallel roads.
- Re-planning costs one shortest-path search per navi vehicle and interval (cached per origin,
  destination and vehicle fit until the travel times change).
- The trip record grows with the links driven (a few hundred bytes per vehicle).
- `navigation.share = 0` restores the previous behaviour.
