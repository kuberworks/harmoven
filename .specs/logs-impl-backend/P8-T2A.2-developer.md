# P8-T2A.2 — Platform Detection + Clarification Gates
**Agent**: developer  
**Date**: 2026-03-27  
**Score**: 5 / 5  

---

## What was implemented

### Files created
| File | Purpose |
|---|---|
| `lib/agents/scaffolding/platform.types.ts` | All platform types: `OutputType` (12 variants), `Platform`, `SmokeStrategy` (9), `MobileTarget`, `MobileChoice`, `PlatformAccessibility`, `HardwareProfile`, `HardwarePlannerConstraints`, `ScaffoldingPlannerHandoff` |
| `lib/agents/scaffolding/platform-detector.ts` | Detection logic: `ORCHESTRATOR_PLATFORM`, `detectOutputType()`, `detectMobileTarget()`, `detectHardwareSignals()`, platform registry, `selectSmokeStrategy()`, `HARDWARE_PROFILES` catalog, `buildHardwareConstraints()` |
| `components/run/PlatformClarificationGate.tsx` | React wizard — 3 variants: mobile choice, hardware board, closed-platform block |
| `tests/agents/scaffolding/platform-detector.test.ts` | 80 unit tests — all filesystem I/O mocked |

---

## Decisions

### `selectSmokeStrategy()` — targetPlatform as optional 4th arg
The spec's §26.3 matrix talks about "arch match?" but the function originally only received the orchestrator platform — making the comparison always `true`. Fixed by adding an optional `targetPlatform: Platform = orchestratorPlatform` parameter. When the caller passes a different platform (cross-compile scenario), the arch-mismatch branches fire correctly.

### Mobile detection — `unspecified` defaults to `both` (§26.8)
When the task mentions generic mobile signals ("mobile app", "react native", "expo") without naming iOS or Android specifically, `detectMobileTarget()` returns `'unspecified'`. The wizard then shows all options with `crossplatform_both` as the default — this matches the spec's "most users want both" rationale.

### PlatformClarificationGate — Tailwind class strings, no runtime dependency
No Tailwind or shadcn/ui is installed yet. The component uses Tailwind utility class strings in JSX `className` props. Styles are inert until the Tailwind pipeline is configured (separate task). No `clsx` or `cn()` helper needed at this stage — template literals suffice.

### Hardware profiles — ESP8266 forbidden pattern scoping
`buildHardwareConstraints()` adds `'ESP8266WiFi (use WiFi.h for ESP32)'` to `forbidden_patterns` only for ESP family boards that are NOT `esp8266`. For the ESP8266 itself, `ESP8266WiFi.h` is the correct library.

### `detectOutputType()` — embedded first, then native_binary
Embedded signals (`.ino` file, `platformio.ini`) are checked before the `package.json` is read, because embedded projects often have no JS at all. `native_binary` (Cargo.toml, CMakeLists.txt, Makefile) is checked after but only if `deps.length === 0` to avoid false-positives on JS monorepos that include a Makefile.
