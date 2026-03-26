// lib/agents/scaffolding/platform.types.ts
// Amendment 74 — Platform Detection & Multi-target types

// ─── Output types ────────────────────────────────────────────────────────────

export type OutputType =
  | 'web_app'
  | 'api_only'
  | 'cli_tool'
  | 'desktop_app'
  | 'library'
  | 'data_pipeline'
  | 'native_binary'
  | 'embedded'
  | 'mobile_pwa'
  | 'mobile_crossplatform'
  | 'mobile_native_ios'
  | 'mobile_native_android'

// ─── Platform (OS + architecture) ───────────────────────────────────────────

export type Platform = {
  os:   'linux' | 'macos' | 'windows' | 'embedded'
  arch: 'x86_64' | 'arm64' | 'arm32' | 'riscv64' | 'wasm' | 'universal'
}

// ─── Smoke strategies ────────────────────────────────────────────────────────

export type SmokeStrategy =
  | 'http_preview'     // web_app — full cascade (Am.73)
  | 'http_check'       // api_only — routes only, no preview
  | 'subprocess_check' // cli_tool — --help / --version
  | 'test_suite'       // library, desktop_app, fallback
  | 'dry_run'          // data_pipeline
  | 'build_check'      // native_binary — compile only
  | 'static_analysis'  // embedded, cross-arch mismatch
  | 'electron_process' // web_app in Electron mode without Docker
  | 'expo_go_qr'       // Expo Go QR scan — real device preview

// ─── Mobile types ────────────────────────────────────────────────────────────

export type MobileTarget = 'ios_only' | 'android_only' | 'both' | 'unspecified'

export type MobileChoice =
  | 'pwa'                // output_types: ['mobile_pwa']
  | 'crossplatform_both' // output_types: ['mobile_crossplatform']
  | 'native_ios'         // output_types: ['mobile_native_ios']
  | 'native_android'     // output_types: ['mobile_native_android']
  | 'native_both'        // output_types: ['mobile_native_ios', 'mobile_native_android']

// ─── Platform accessibility ──────────────────────────────────────────────────

export type PlatformAccessibility = 'open' | 'restricted' | 'closed'

export interface PlatformRegistryEntry {
  id:              string
  display_name:    string
  accessibility:   PlatformAccessibility
  alternatives?:   string[]   // for closed platforms
  requirements?:   string[]   // for restricted platforms (human-readable)
}

// ─── Hardware profile ────────────────────────────────────────────────────────

export type HardwareFamily = 'arduino' | 'raspberry_pi' | 'esp' | 'stm32' | 'other'

export interface HardwareProfile {
  id:           string
  display_name: string
  family:       HardwareFamily
  cpu_arch:     string   // 'avr' | 'arm64' | 'arm32' | 'xtensa' | 'riscv32'
  ram_kb:       number
  flash_kb:     number
  os:           string | null  // null = bare metal
  toolchain:    string
  framework:    string
  popular_libs: string[]
  is_default:   boolean
  notes:        string
}

export interface HardwarePlannerConstraints {
  target_hardware:    HardwareProfile
  max_ram_usage_kb:   number   // 80% of ram_kb
  max_flash_kb:       number   // 90% of flash_kb
  toolchain:          string
  framework:          string
  allowed_libs:       string[]
  forbidden_patterns: string[]
}

// ─── Scaffolding planner handoff extension ───────────────────────────────────

export interface ScaffoldingPlannerHandoff {
  output_types:      OutputType[]
  target_platforms:  Platform[]
  smoke_strategies:  SmokeStrategy[]  // computed, one per output_type
}
