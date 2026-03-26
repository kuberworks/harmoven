// tests/agents/scaffolding/platform-detector.test.ts
// Unit tests for platform-detector.ts — zero network, zero filesystem (all mocked).

import { jest } from '@jest/globals'

// ─── Mock: fs ────────────────────────────────────────────────────────────────

jest.mock('fs', () => ({
  existsSync:  jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}))
import fs from 'fs'
const mockExistsSync  = fs.existsSync  as jest.MockedFunction<typeof fs.existsSync>
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>
const mockReaddirSync = fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>

// ─── Imports after mocks ─────────────────────────────────────────────────────

import {
  detectOutputType,
  detectMobileTarget,
  detectHardwareSignals,
  checkPlatformAccessibility,
  getPlatformAccessibility,
  selectSmokeStrategy,
  getDefaultHardwareProfile,
  buildHardwareConstraints,
  ORCHESTRATOR_PLATFORM,
  MOBILE_SIGNALS,
  HARDWARE_SIGNALS,
  HARDWARE_PROFILES,
} from '@/lib/agents/scaffolding/platform-detector'
import type { Platform } from '@/lib/agents/scaffolding/platform.types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LINUX_X64: Platform = { os: 'linux', arch: 'x86_64' }

function mockPkg(deps: Record<string, string> = {}, extra: object = {}): void {
  mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
  mockReadFileSync.mockReturnValue(JSON.stringify({ dependencies: deps, ...extra }))
  mockReaddirSync.mockReturnValue([])
}

function mockNoPkg(files: string[] = []): void {
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p)
    return files.some(f => s.endsWith(f))
  })
  mockReaddirSync.mockReturnValue([])
}

// ─── ORCHESTRATOR_PLATFORM ───────────────────────────────────────────────────

describe('ORCHESTRATOR_PLATFORM', () => {
  it('has valid os and arch fields', () => {
    expect(['linux', 'macos', 'windows', 'embedded']).toContain(ORCHESTRATOR_PLATFORM.os)
    expect(['x86_64', 'arm64', 'arm32', 'riscv64', 'wasm', 'universal']).toContain(ORCHESTRATOR_PLATFORM.arch)
  })
})

// ─── detectOutputType ────────────────────────────────────────────────────────

describe('detectOutputType', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    mockReaddirSync.mockReturnValue([])
  })

  it('returns web_app for Next.js project', () => {
    mockPkg({ next: '14.0.0', react: '18.0.0' })
    expect(detectOutputType('/project')).toBe('web_app')
  })

  it('returns web_app for Nuxt.js project', () => {
    mockPkg({ nuxt: '3.0.0' })
    expect(detectOutputType('/project')).toBe('web_app')
  })

  it('returns web_app for @sveltejs/kit project', () => {
    mockPkg({ '@sveltejs/kit': '2.0.0' })
    expect(detectOutputType('/project')).toBe('web_app')
  })

  it('returns web_app for vite + react project', () => {
    mockPkg({ vite: '5.0.0', react: '18.0.0' })
    expect(detectOutputType('/project')).toBe('web_app')
  })

  it('returns desktop_app for Electron project', () => {
    mockPkg({ electron: '30.0.0', react: '18.0.0' })
    expect(detectOutputType('/project')).toBe('desktop_app')
  })

  it('returns cli_tool for commander-based project', () => {
    mockPkg({ commander: '12.0.0' })
    expect(detectOutputType('/project')).toBe('cli_tool')
  })

  it('returns cli_tool for yargs-based project', () => {
    mockPkg({ yargs: '17.0.0' })
    expect(detectOutputType('/project')).toBe('cli_tool')
  })

  it('returns api_only for express project with no frontend', () => {
    mockPkg({ express: '4.18.0' })
    expect(detectOutputType('/project')).toBe('api_only')
  })

  it('returns web_app when express + react both present (fullstack)', () => {
    mockPkg({ express: '4.18.0', react: '18.0.0', next: '14.0.0' })
    expect(detectOutputType('/project')).toBe('web_app')
  })

  it('returns library when main field set, no server', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({ main: 'dist/index.js', dependencies: {} }))
    mockReaddirSync.mockReturnValue([])
    expect(detectOutputType('/project')).toBe('library')
  })

  it('returns embedded for .ino file', () => {
    mockExistsSync.mockReturnValue(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockReaddirSync.mockReturnValue(['sketch.ino'] as any)
    expect(detectOutputType('/project')).toBe('embedded')
  })

  it('returns embedded for platformio.ini', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('platformio.ini'))
    mockReaddirSync.mockReturnValue([])
    expect(detectOutputType('/project')).toBe('embedded')
  })

  it('returns native_binary for Cargo.toml with no JS', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('Cargo.toml'))
    mockReaddirSync.mockReturnValue([])
    expect(detectOutputType('/project')).toBe('native_binary')
  })

  it('returns data_pipeline for pyproject.toml', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pyproject.toml'))
    mockReaddirSync.mockReturnValue([])
    expect(detectOutputType('/project')).toBe('data_pipeline')
  })

  it('falls back to web_app for empty package.json', () => {
    mockPkg({})
    expect(detectOutputType('/project')).toBe('web_app')
  })
})

// ─── detectMobileTarget ───────────────────────────────────────────────────────

describe('detectMobileTarget', () => {
  it('returns null for non-mobile task', () => {
    expect(detectMobileTarget('build a REST API for inventory management')).toBeNull()
  })

  it('detects ios_only for iPhone mention', () => {
    expect(detectMobileTarget('I want an iPhone app for cyclists')).toBe('ios_only')
  })

  it('detects ios_only for "ios" mention', () => {
    expect(detectMobileTarget('the app should run on iOS')).toBe('ios_only')
  })

  it('detects android_only for Android mention', () => {
    expect(detectMobileTarget('I need an Android app for my shop')).toBe('android_only')
  })

  it('detects android_only for "play store" mention', () => {
    expect(detectMobileTarget('publish to the play store')).toBe('android_only')
  })

  it('detects both for iPhone and Android mention', () => {
    expect(detectMobileTarget('app for both iPhone and Android users')).toBe('both')
  })

  it('detects both for ios + android signals', () => {
    expect(detectMobileTarget('iOS and android app')).toBe('both')
  })

  it('returns unspecified for generic mobile signal', () => {
    expect(detectMobileTarget('build a mobile app for users')).toBe('unspecified')
  })

  it('detects react native as a mobile signal (unspecified)', () => {
    expect(detectMobileTarget('use react native for my project')).toBe('unspecified')
  })

  it('detects expo as a mobile signal (unspecified)', () => {
    expect(detectMobileTarget('expo app for the team')).toBe('unspecified')
  })

  it('is case-insensitive', () => {
    expect(detectMobileTarget('IPHONE app')).toBe('ios_only')
  })
})

// ─── detectHardwareSignals ────────────────────────────────────────────────────

describe('detectHardwareSignals', () => {
  it('returns false for non-hardware task', () => {
    expect(detectHardwareSignals('build a blog platform')).toBe(false)
  })

  it('detects arduino', () => {
    expect(detectHardwareSignals('blink an LED on arduino')).toBe(true)
  })

  it('detects esp32', () => {
    expect(detectHardwareSignals('connect to WiFi on ESP32')).toBe(true)
  })

  it('detects raspberry pi', () => {
    expect(detectHardwareSignals('control GPIO on Raspberry Pi')).toBe(true)
  })

  it('detects rpi shorthand', () => {
    expect(detectHardwareSignals('rpi temperature monitor')).toBe(true)
  })

  it('detects stm32', () => {
    expect(detectHardwareSignals('stm32 UART driver')).toBe(true)
  })

  it('detects firmware', () => {
    expect(detectHardwareSignals('write firmware for my device')).toBe(true)
  })

  it('detects gpio', () => {
    expect(detectHardwareSignals('read GPIO pins in Python')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(detectHardwareSignals('Arduino UNO project')).toBe(true)
  })
})

// ─── checkPlatformAccessibility / getPlatformAccessibility ───────────────────

describe('platform accessibility registry', () => {
  it('web is open', () => {
    expect(getPlatformAccessibility('web')).toBe('open')
  })

  it('ios is restricted', () => {
    expect(getPlatformAccessibility('ios')).toBe('restricted')
  })

  it('ps5 is closed', () => {
    expect(getPlatformAccessibility('ps5')).toBe('closed')
  })

  it('nintendo-switch is closed', () => {
    expect(getPlatformAccessibility('nintendo-switch')).toBe('closed')
  })

  it('unknown platform defaults to open', () => {
    expect(getPlatformAccessibility('unknown-platform')).toBe('open')
  })

  it('checkPlatformAccessibility returns entry for known platform', () => {
    const entry = checkPlatformAccessibility('ps5')
    expect(entry).not.toBeNull()
    expect(entry?.accessibility).toBe('closed')
    expect(entry?.alternatives).toContain('web')
  })

  it('checkPlatformAccessibility returns null for unknown platform', () => {
    expect(checkPlatformAccessibility('unknown-xyz')).toBeNull()
  })

  it('ios entry has requirements', () => {
    const entry = checkPlatformAccessibility('ios')
    expect(entry?.requirements).toBeDefined()
    expect(entry?.requirements?.length).toBeGreaterThan(0)
  })

  it('android is open (no gate)', () => {
    expect(getPlatformAccessibility('android')).toBe('open')
  })

  it('steam is open', () => {
    expect(getPlatformAccessibility('steam')).toBe('open')
  })
})

// ─── selectSmokeStrategy ─────────────────────────────────────────────────────

describe('selectSmokeStrategy', () => {
  it('web_app + Docker → http_preview', () => {
    expect(selectSmokeStrategy('web_app', LINUX_X64, true)).toBe('http_preview')
  })

  it('web_app + no Docker → electron_process', () => {
    expect(selectSmokeStrategy('web_app', LINUX_X64, false)).toBe('electron_process')
  })

  it('mobile_pwa → http_preview', () => {
    expect(selectSmokeStrategy('mobile_pwa', LINUX_X64, false)).toBe('http_preview')
  })

  it('mobile_crossplatform → expo_go_qr', () => {
    expect(selectSmokeStrategy('mobile_crossplatform', LINUX_X64, false)).toBe('expo_go_qr')
  })

  it('mobile_native_ios → static_analysis', () => {
    expect(selectSmokeStrategy('mobile_native_ios', LINUX_X64, false)).toBe('static_analysis')
  })

  it('mobile_native_android → static_analysis', () => {
    expect(selectSmokeStrategy('mobile_native_android', LINUX_X64, false)).toBe('static_analysis')
  })

  it('api_only + arch match → http_check', () => {
    expect(selectSmokeStrategy('api_only', LINUX_X64, false)).toBe('http_check')
  })

  it('api_only + arch mismatch → static_analysis', () => {
    const armTarget: Platform = { os: 'macos', arch: 'arm64' }
    expect(selectSmokeStrategy('api_only', LINUX_X64, false, armTarget)).toBe('static_analysis')
  })

  it('cli_tool + arch match → subprocess_check', () => {
    expect(selectSmokeStrategy('cli_tool', LINUX_X64, false)).toBe('subprocess_check')
  })

  it('cli_tool + arch mismatch → test_suite', () => {
    const armTarget: Platform = { os: 'macos', arch: 'arm64' }
    expect(selectSmokeStrategy('cli_tool', LINUX_X64, false, armTarget)).toBe('test_suite')
  })

  it('desktop_app → test_suite', () => {
    expect(selectSmokeStrategy('desktop_app', LINUX_X64, true)).toBe('test_suite')
  })

  it('library → test_suite', () => {
    expect(selectSmokeStrategy('library', LINUX_X64, false)).toBe('test_suite')
  })

  it('data_pipeline + arch match → dry_run', () => {
    expect(selectSmokeStrategy('data_pipeline', LINUX_X64, false)).toBe('dry_run')
  })

  it('data_pipeline + arch mismatch → test_suite', () => {
    const armTarget: Platform = { os: 'macos', arch: 'arm64' }
    expect(selectSmokeStrategy('data_pipeline', LINUX_X64, false, armTarget)).toBe('test_suite')
  })

  it('native_binary + arch match → build_check', () => {
    expect(selectSmokeStrategy('native_binary', LINUX_X64, false)).toBe('build_check')
  })

  it('native_binary + arch mismatch → static_analysis', () => {
    const armTarget: Platform = { os: 'macos', arch: 'arm64' }
    expect(selectSmokeStrategy('native_binary', LINUX_X64, false, armTarget)).toBe('static_analysis')
  })

  it('embedded → static_analysis', () => {
    expect(selectSmokeStrategy('embedded', LINUX_X64, false)).toBe('static_analysis')
  })
})

// ─── HARDWARE_PROFILES catalog ───────────────────────────────────────────────

describe('HARDWARE_PROFILES', () => {
  it('has exactly one default per family for core families', () => {
    const families = ['arduino', 'raspberry_pi', 'esp', 'stm32'] as const
    for (const family of families) {
      const defaults = HARDWARE_PROFILES.filter(p => p.family === family && p.is_default)
      expect(defaults).toHaveLength(1)
    }
  })

  it('arduino default is Uno', () => {
    const defaultArduino = HARDWARE_PROFILES.find(p => p.family === 'arduino' && p.is_default)
    expect(defaultArduino?.id).toBe('arduino-uno')
    expect(defaultArduino?.cpu_arch).toBe('avr')
    expect(defaultArduino?.ram_kb).toBe(2)
  })

  it('raspberry_pi default has arm64 arch', () => {
    const defaultRpi = HARDWARE_PROFILES.find(p => p.family === 'raspberry_pi' && p.is_default)
    expect(defaultRpi?.cpu_arch).toBe('arm64')
  })

  it('esp default is ESP32 (not ESP8266)', () => {
    const defaultEsp = HARDWARE_PROFILES.find(p => p.family === 'esp' && p.is_default)
    expect(defaultEsp?.id).toBe('esp32-devkit')
  })

  it('stm32 default is Nucleo-64', () => {
    const defaultStm = HARDWARE_PROFILES.find(p => p.family === 'stm32' && p.is_default)
    expect(defaultStm?.id).toBe('stm32-nucleo-64')
  })
})

// ─── getDefaultHardwareProfile ───────────────────────────────────────────────

describe('getDefaultHardwareProfile', () => {
  it('returns Uno for arduino', () => {
    const p = getDefaultHardwareProfile('arduino')
    expect(p?.id).toBe('arduino-uno')
  })

  it('returns ESP32 for esp', () => {
    const p = getDefaultHardwareProfile('esp')
    expect(p?.id).toBe('esp32-devkit')
  })

  it('returns null for other (no default defined)', () => {
    expect(getDefaultHardwareProfile('other')).toBeNull()
  })
})

// ─── buildHardwareConstraints ────────────────────────────────────────────────

describe('buildHardwareConstraints', () => {
  it('Arduino Uno: 80% RAM = 1KB, 90% flash = 28KB', () => {
    const uno = HARDWARE_PROFILES.find(p => p.id === 'arduino-uno')!
    const constraints = buildHardwareConstraints(uno)
    expect(constraints.max_ram_usage_kb).toBe(1)   // floor(2 * 0.8)
    expect(constraints.max_flash_kb).toBe(28)       // floor(32 * 0.9)
  })

  it('Arduino Uno: forbidden patterns include malloc', () => {
    const uno = HARDWARE_PROFILES.find(p => p.id === 'arduino-uno')!
    const constraints = buildHardwareConstraints(uno)
    expect(constraints.forbidden_patterns.some(p => p.includes('malloc'))).toBe(true)
  })

  it('RPi Pico: forbidden patterns include RPi.GPIO', () => {
    const pico = HARDWARE_PROFILES.find(p => p.id === 'rpi-pico')!
    const constraints = buildHardwareConstraints(pico)
    expect(constraints.forbidden_patterns.some(p => p.includes('RPi.GPIO'))).toBe(true)
  })

  it('ESP32: forbidden patterns include ESP8266WiFi', () => {
    const esp32 = HARDWARE_PROFILES.find(p => p.id === 'esp32-devkit')!
    const constraints = buildHardwareConstraints(esp32)
    expect(constraints.forbidden_patterns.some(p => p.includes('ESP8266WiFi'))).toBe(true)
  })

  it('ESP8266: no ESP8266WiFi forbidden (it is the right lib)', () => {
    const esp8266 = HARDWARE_PROFILES.find(p => p.id === 'esp8266')!
    const constraints = buildHardwareConstraints(esp8266)
    expect(constraints.forbidden_patterns.some(p => p.includes('ESP8266WiFi'))).toBe(false)
  })

  it('allowed_libs matches popular_libs', () => {
    const uno = HARDWARE_PROFILES.find(p => p.id === 'arduino-uno')!
    const constraints = buildHardwareConstraints(uno)
    expect(constraints.allowed_libs).toEqual(uno.popular_libs)
  })

  it('toolchain and framework forwarded from profile', () => {
    const rpi4 = HARDWARE_PROFILES.find(p => p.id === 'rpi-4')!
    const constraints = buildHardwareConstraints(rpi4)
    expect(constraints.toolchain).toBe(rpi4.toolchain)
    expect(constraints.framework).toBe(rpi4.framework)
  })
})

// ─── Signal array completeness ────────────────────────────────────────────────

describe('signal arrays', () => {
  it('MOBILE_SIGNALS includes core mobile keywords', () => {
    expect(MOBILE_SIGNALS).toContain('iphone')
    expect(MOBILE_SIGNALS).toContain('android')
    expect(MOBILE_SIGNALS).toContain('expo')
  })

  it('HARDWARE_SIGNALS includes core hardware keywords', () => {
    expect(HARDWARE_SIGNALS).toContain('arduino')
    expect(HARDWARE_SIGNALS).toContain('esp32')
    expect(HARDWARE_SIGNALS).toContain('gpio')
  })
})
