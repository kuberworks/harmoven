// lib/agents/scaffolding/platform-detector.ts
// Amendment 74 — Platform detection + strategy selection

import fs from 'fs'
import path from 'path'
import {
  OutputType,
  Platform,
  SmokeStrategy,
  MobileTarget,
  PlatformAccessibility,
  PlatformRegistryEntry,
  HardwareProfile,
  HardwarePlannerConstraints,
} from './platform.types'

// ─── Orchestrator platform (detected once at boot) ───────────────────────────

function mapOS(nodePlatform: string): Platform['os'] {
  if (nodePlatform === 'linux')  return 'linux'
  if (nodePlatform === 'darwin') return 'macos'
  if (nodePlatform === 'win32')  return 'windows'
  return 'linux'
}

function mapArch(nodeArch: string): Platform['arch'] {
  if (nodeArch === 'x64')   return 'x86_64'
  if (nodeArch === 'arm64') return 'arm64'
  if (nodeArch === 'arm')   return 'arm32'
  return 'x86_64'
}

export const ORCHESTRATOR_PLATFORM: Platform = {
  os:   mapOS(process.platform),
  arch: mapArch(process.arch),
}

// ─── Signal lists (§26.8, §26.15) ───────────────────────────────────────────

export const MOBILE_SIGNALS: string[] = [
  'iphone', 'ipad', 'ios', 'android', 'app store', 'play store',
  'mobile app', 'smartphone', 'react native', 'flutter', 'expo',
]

export const HARDWARE_SIGNALS: string[] = [
  'arduino', 'raspberry pi', 'rpi', 'esp32', 'esp8266',
  'stm32', 'microcontroller', 'embedded', 'firmware',
  'gpio', 'i2c', 'spi', 'sensor', 'pico', 'teensy',
]

// ─── OutputType detection from project filesystem (§26.2) ────────────────────

interface PkgJson {
  main?:         string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPkgJson(projectPath: string): PkgJson | null {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PkgJson
  } catch {
    return null
  }
}

function allDeps(pkg: PkgJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]
}

function hasDep(deps: string[], ...names: string[]): boolean {
  return names.some(n => deps.includes(n))
}

function fileExists(projectPath: string, name: string): boolean {
  return fs.existsSync(path.join(projectPath, name))
}

/**
 * Detect the primary OutputType from project files.
 * Returns 'web_app' as the default if no strong signal is found.
 */
export function detectOutputType(projectPath: string): OutputType {
  const pkg = readPkgJson(projectPath)
  const deps = pkg ? allDeps(pkg) : []

  // Embedded — check filesystem signals first (no JS involved)
  const hasIno      = fs.readdirSync(projectPath).some(f => f.endsWith('.ino'))
  const hasPlatformIni = fileExists(projectPath, 'platformio.ini')
  if (hasIno || hasPlatformIni) return 'embedded'

  // Native binary — no JS, build system files present
  const hasCMake   = fileExists(projectPath, 'CMakeLists.txt')
  const hasCargo   = fileExists(projectPath, 'Cargo.toml')
  const hasMakefile = fileExists(projectPath, 'Makefile')
  if ((hasCMake || hasCargo || hasMakefile) && deps.length === 0) return 'native_binary'

  // Data pipeline — Python project
  const hasPyProject = fileExists(projectPath, 'pyproject.toml')
  const hasRequirements = fileExists(projectPath, 'requirements.txt')
  if (hasPyProject || hasRequirements) return 'data_pipeline'

  // No package.json → fallback to native_binary if build files, else unknown
  if (!pkg) {
    if (hasCMake || hasCargo || hasMakefile) return 'native_binary'
    return 'web_app'
  }

  // Desktop app
  if (hasDep(deps, 'electron')) return 'desktop_app'

  // Web frameworks
  const WEB_FRAMEWORKS = ['next', 'nuxt', '@sveltejs/kit']
  const hasWebFramework = hasDep(deps, ...WEB_FRAMEWORKS)
  const hasViteWithUI    = hasDep(deps, 'vite') && hasDep(deps, 'react', 'vue', '@vue/core', 'svelte')
  if (hasWebFramework || hasViteWithUI) return 'web_app'

  // CLI tool
  if (hasDep(deps, 'commander', 'yargs', 'minimist')) return 'cli_tool'

  // API only (server framework, no web frontend)
  const hasApiServer = hasDep(deps, 'express', 'fastify', 'hono', 'koa', 'nestjs', '@nestjs/core')
  const hasFrontend  = hasDep(deps, 'react', 'vue', 'svelte', 'angular')
  if (hasApiServer && !hasFrontend) return 'api_only'

  // Library — has main field, no server or app entry
  if (pkg.main && !hasApiServer) return 'library'

  return 'web_app'
}

// ─── Mobile signal detection (§26.8) ─────────────────────────────────────────

/**
 * Detect if the task input contains mobile signals.
 * Returns MobileTarget based on which signals are present, or null if none.
 */
export function detectMobileTarget(taskInput: string): MobileTarget | null {
  const lower = taskInput.toLowerCase()
  const hasMobileSignal = MOBILE_SIGNALS.some(s => lower.includes(s))
  if (!hasMobileSignal) return null

  const mentionsIos     = ['iphone', 'ipad', 'ios', 'app store', 'swift'].some(s => lower.includes(s))
  const mentionsAndroid = ['android', 'play store', 'kotlin'].some(s => lower.includes(s))

  if (mentionsIos && mentionsAndroid) return 'both'
  if (mentionsIos)     return 'ios_only'
  if (mentionsAndroid) return 'android_only'
  return 'unspecified'  // generic "mobile app" → defaults to both in wizard
}

// ─── Hardware signal detection (§26.15) ──────────────────────────────────────

/**
 * Returns true if the task input contains hardware/embedded signals.
 */
export function detectHardwareSignals(taskInput: string): boolean {
  const lower = taskInput.toLowerCase()
  return HARDWARE_SIGNALS.some(s => lower.includes(s))
}

// ─── Platform accessibility registry (§26.12) ────────────────────────────────

const PLATFORM_REGISTRY: PlatformRegistryEntry[] = [
  // ── OPEN ─────────────────────────────────────────────────────────────
  { id: 'web',        display_name: 'Web / PWA',        accessibility: 'open' },
  { id: 'windows',    display_name: 'Windows',           accessibility: 'open' },
  { id: 'steam',      display_name: 'Steam',             accessibility: 'open' },
  { id: 'linux',      display_name: 'Linux',             accessibility: 'open' },
  { id: 'android',    display_name: 'Android',           accessibility: 'open' },
  { id: 'itch-io',    display_name: 'itch.io',           accessibility: 'open' },
  { id: 'meta-quest', display_name: 'Meta Quest',        accessibility: 'open' },
  { id: 'steam-deck', display_name: 'Steam Deck',        accessibility: 'open' },
  { id: 'smart-tv',   display_name: 'Smart TV',          accessibility: 'open' },
  { id: 'arduino',    display_name: 'Arduino / embedded', accessibility: 'open' },

  // ── RESTRICTED ───────────────────────────────────────────────────────
  {
    id: 'ios',
    display_name: 'iOS / App Store',
    accessibility: 'restricted',
    requirements: ['Apple Developer account ($99/yr)', 'Mac with Xcode', 'Apple review (1–7 days)'],
  },
  {
    id: 'xbox-pc',
    display_name: 'Xbox PC',
    accessibility: 'restricted',
    requirements: ['Partner Center account (free)', 'GDK (public)'],
  },
  {
    id: 'xbox-console',
    display_name: 'Xbox Console',
    accessibility: 'restricted',
    requirements: ['ID@Xbox approval required'],
  },
  {
    id: 'apple-watch',
    display_name: 'Apple Watch',
    accessibility: 'restricted',
    requirements: ['Apple Developer account ($99/yr)', 'Mac with Xcode'],
  },
  {
    id: 'apple-tv',
    display_name: 'Apple TV',
    accessibility: 'restricted',
    requirements: ['Apple Developer account ($99/yr)', 'Mac with Xcode'],
  },

  // ── CLOSED ────────────────────────────────────────────────────────────
  {
    id: 'ps5',
    display_name: 'PS5',
    accessibility: 'closed',
    alternatives: ['web', 'steam', 'windows'],
  },
  {
    id: 'ps4',
    display_name: 'PS4',
    accessibility: 'closed',
    alternatives: ['web', 'steam', 'windows'],
  },
  {
    id: 'nintendo-switch',
    display_name: 'Nintendo Switch',
    accessibility: 'closed',
    alternatives: ['windows', 'web', 'itch-io'],
  },
]

/**
 * Look up a platform in the accessibility registry.
 * Returns null if not found (treated as open by default).
 */
export function checkPlatformAccessibility(platformId: string): PlatformRegistryEntry | null {
  return PLATFORM_REGISTRY.find(p => p.id === platformId) ?? null
}

export function getPlatformAccessibility(platformId: string): PlatformAccessibility {
  return PLATFORM_REGISTRY.find(p => p.id === platformId)?.accessibility ?? 'open'
}

// ─── Strategy selection matrix (§26.3) ───────────────────────────────────────

/**
 * Select smoke strategy based on output type, orchestrator platform, and
 * whether Docker is available.
 *
 * @param targetPlatform - the platform the project is built to run on.
 *   Defaults to orchestratorPlatform (same machine — always a "match").
 *   Pass a different platform to indicate cross-compilation / mismatch.
 */
export function selectSmokeStrategy(
  outputType: OutputType,
  orchestratorPlatform: Platform,
  hasDocker: boolean,
  targetPlatform: Platform = orchestratorPlatform,
): SmokeStrategy {
  const archMatches: boolean =
    targetPlatform.os === orchestratorPlatform.os &&
    targetPlatform.arch === orchestratorPlatform.arch

  switch (outputType) {
    case 'web_app':
      return hasDocker ? 'http_preview' : 'electron_process'

    case 'mobile_pwa':
      return 'http_preview'

    case 'mobile_crossplatform':
      // expo_go_qr only if expo is in PATH — caller must check; we return expo_go_qr as target
      return 'expo_go_qr'

    case 'mobile_native_ios':
    case 'mobile_native_android':
      // build_check only if compiler is available; otherwise static_analysis
      // Caller is responsible for verifying tool availability
      return 'static_analysis'

    case 'api_only':
      return archMatches ? 'http_check' : 'static_analysis'

    case 'cli_tool':
      return archMatches ? 'subprocess_check' : 'test_suite'

    case 'desktop_app':
      return 'test_suite'

    case 'library':
      return 'test_suite'

    case 'data_pipeline':
      return archMatches ? 'dry_run' : 'test_suite'

    case 'native_binary':
      return archMatches ? 'build_check' : 'static_analysis'

    case 'embedded':
      return 'static_analysis'
  }
}

// ─── Hardware profile catalog (§26.16 + §26.17) ──────────────────────────────

export const HARDWARE_PROFILES: HardwareProfile[] = [
  // ── Arduino family ─────────────────────────────────────────────────────
  {
    id:           'arduino-uno',
    display_name: 'Arduino Uno',
    family:       'arduino',
    cpu_arch:     'avr',
    ram_kb:       2,
    flash_kb:     32,
    os:           null,
    toolchain:    'avr-gcc',
    framework:    'Arduino',
    popular_libs: ['Wire', 'SPI', 'Servo', 'LiquidCrystal', 'FastLED'],
    is_default:   true,
    notes:        'ATmega328P — most common, most tutorials, good for most projects',
  },
  {
    id:           'arduino-nano',
    display_name: 'Arduino Nano',
    family:       'arduino',
    cpu_arch:     'avr',
    ram_kb:       2,
    flash_kb:     32,
    os:           null,
    toolchain:    'avr-gcc',
    framework:    'Arduino',
    popular_libs: ['Wire', 'SPI', 'Servo'],
    is_default:   false,
    notes:        'ATmega328P — smaller form factor, same capabilities as Uno',
  },
  {
    id:           'arduino-mega',
    display_name: 'Arduino Mega',
    family:       'arduino',
    cpu_arch:     'avr',
    ram_kb:       8,
    flash_kb:     256,
    os:           null,
    toolchain:    'avr-gcc',
    framework:    'Arduino',
    popular_libs: ['Wire', 'SPI', 'Servo', 'LiquidCrystal'],
    is_default:   false,
    notes:        'ATmega2560 — more pins and memory, good for larger projects',
  },
  {
    id:           'arduino-nano-every',
    display_name: 'Arduino Nano Every',
    family:       'arduino',
    cpu_arch:     'avr',
    ram_kb:       6,
    flash_kb:     48,
    os:           null,
    toolchain:    'avr-gcc',
    framework:    'Arduino',
    popular_libs: ['Wire', 'SPI'],
    is_default:   false,
    notes:        'ATmega4809 — modern Nano with more memory',
  },
  {
    id:           'arduino-leonardo',
    display_name: 'Arduino Leonardo',
    family:       'arduino',
    cpu_arch:     'avr',
    ram_kb:       2,
    flash_kb:     32,
    os:           null,
    toolchain:    'avr-gcc',
    framework:    'Arduino',
    popular_libs: ['Wire', 'SPI', 'Keyboard', 'Mouse'],
    is_default:   false,
    notes:        'ATmega32U4 — acts as keyboard/mouse over USB (HID)',
  },

  // ── Raspberry Pi family ────────────────────────────────────────────────
  {
    id:           'rpi-4',
    display_name: 'Raspberry Pi 4',
    family:       'raspberry_pi',
    cpu_arch:     'arm64',
    ram_kb:       1024 * 1024, // 1–8 GB variants; use 1 GB as minimum
    flash_kb:     0,            // SD card, no fixed flash
    os:           'Raspberry Pi OS (64-bit)',
    toolchain:    'gcc-aarch64',
    framework:    'Linux',
    popular_libs: ['RPi.GPIO', 'gpiozero', 'smbus2', 'spidev', 'picamera2'],
    is_default:   true,
    notes:        'Linux arm64 — most common, good for general-purpose projects',
  },
  {
    id:           'rpi-5',
    display_name: 'Raspberry Pi 5',
    family:       'raspberry_pi',
    cpu_arch:     'arm64',
    ram_kb:       4 * 1024 * 1024, // 4–8 GB
    flash_kb:     0,
    os:           'Raspberry Pi OS (64-bit)',
    toolchain:    'gcc-aarch64',
    framework:    'Linux',
    popular_libs: ['RPi.GPIO', 'gpiozero', 'smbus2', 'spidev'],
    is_default:   false,
    notes:        'Linux arm64 — faster, PCIe slot, good for demanding projects',
  },
  {
    id:           'rpi-pico',
    display_name: 'Raspberry Pi Pico',
    family:       'raspberry_pi',
    cpu_arch:     'arm32',
    ram_kb:       264,
    flash_kb:     2048,
    os:           null,
    toolchain:    'arm-none-eabi-gcc',
    framework:    'MicroPython / C SDK',
    popular_libs: ['machine', 'utime', 'ustruct'],
    is_default:   false,
    notes:        'RP2040 — bare metal, different from Pi 4, drag-and-drop .uf2 flashing',
  },

  // ── ESP family ─────────────────────────────────────────────────────────
  {
    id:           'esp32-devkit',
    display_name: 'ESP32 DevKit v1',
    family:       'esp',
    cpu_arch:     'xtensa',
    ram_kb:       520,
    flash_kb:     4096,
    os:           null,
    toolchain:    'xtensa-esp32-elf-gcc',
    framework:    'Arduino / ESP-IDF',
    popular_libs: ['WiFi', 'Wire', 'SPI', 'BluetoothSerial', 'HTTPClient'],
    is_default:   true,
    notes:        'Dual-core Xtensa LX6, 520KB RAM, WiFi + Bluetooth — most popular ESP board',
  },
  {
    id:           'esp8266',
    display_name: 'ESP8266 (NodeMCU)',
    family:       'esp',
    cpu_arch:     'xtensa',
    ram_kb:       80,
    flash_kb:     4096,
    os:           null,
    toolchain:    'xtensa-lx106-elf-gcc',
    framework:    'Arduino',
    popular_libs: ['ESP8266WiFi', 'Wire', 'SPI'],
    is_default:   false,
    notes:        'Older generation — use ESP32 for new projects (more RAM, BT, dual-core)',
  },

  // ── STM32 family ───────────────────────────────────────────────────────
  {
    id:           'stm32-nucleo-64',
    display_name: 'STM32 Nucleo-64 (F446RE)',
    family:       'stm32',
    cpu_arch:     'arm32',
    ram_kb:       128,
    flash_kb:     512,
    os:           null,
    toolchain:    'arm-none-eabi-gcc',
    framework:    'STM32Cube HAL / Arduino',
    popular_libs: ['STM32duino', 'Wire', 'SPI'],
    is_default:   true,
    notes:        'Cortex-M4 @ 180MHz — popular in education and professional prototyping',
  },
]

/**
 * Get the default hardware profile for a given family.
 */
export function getDefaultHardwareProfile(
  family: HardwareProfile['family'],
): HardwareProfile | null {
  return HARDWARE_PROFILES.find(p => p.family === family && p.is_default) ?? null
}

/**
 * Build HardwarePlannerConstraints from a HardwareProfile.
 */
export function buildHardwareConstraints(
  profile: HardwareProfile,
): HardwarePlannerConstraints {
  const forbiddenPatterns: string[] = []

  if (profile.cpu_arch === 'avr' && profile.ram_kb <= 2) {
    forbiddenPatterns.push(
      'String concatenation (use char[] instead)',
      'malloc / new (use static buffers)',
    )
  }
  if (profile.id === 'rpi-pico') {
    forbiddenPatterns.push('RPi.GPIO (use machine.Pin instead)')
  }
  if (profile.family === 'esp' && profile.id !== 'esp8266') {
    forbiddenPatterns.push('ESP8266WiFi (use WiFi.h for ESP32)')
  }

  return {
    target_hardware:  profile,
    max_ram_usage_kb: Math.floor(profile.ram_kb * 0.8),
    max_flash_kb:     Math.floor(profile.flash_kb * 0.9),
    toolchain:        profile.toolchain,
    framework:        profile.framework,
    allowed_libs:     profile.popular_libs,
    forbidden_patterns: forbiddenPatterns,
  }
}
