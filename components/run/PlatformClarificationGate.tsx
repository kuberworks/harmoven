'use client'

// components/run/PlatformClarificationGate.tsx
// Amendment 74 — Mobile, hardware, and closed-platform clarification wizard
//
// Three variant modes:
//   "mobile"   — radio choice: PWA | crossplatform | iOS | Android | both native
//   "hardware" — radio choice per hardware family (Arduino / RPi / ESP / STM32)
//   "closed"   — hard block with alternatives (PS5, Switch, etc.)
//
// Styled with Tailwind utility classes (dark-first, amber accents).
// When Tailwind is not yet configured the component falls back to the
// inline styles on the wrapper; class names remain so Tailwind picks them
// up automatically once the CSS pipeline is wired.

import React, { useState, useId } from 'react'
import type {
  MobileChoice,
  HardwareProfile,
} from '@/lib/agents/scaffolding/platform.types'
import { HARDWARE_PROFILES } from '@/lib/agents/scaffolding/platform-detector'

// ─── Shared sub-components ───────────────────────────────────────────────────

interface RadioOptionProps {
  id:        string
  name:      string
  value:     string
  checked:   boolean
  onChange:  (value: string) => void
  label:     React.ReactNode
  sublabel?: React.ReactNode
  warning?:  React.ReactNode
  className?: string
}

function RadioOption({
  id, name, value, checked, onChange, label, sublabel, warning, className = '',
}: RadioOptionProps) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors
        ${checked
          ? 'border-amber-500 bg-amber-500/10 text-white'
          : 'border-zinc-700 bg-zinc-800/60 text-zinc-300 hover:border-zinc-500'}
        ${className}`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1 accent-amber-500"
      />
      <span className="flex flex-col gap-1">
        <span className="font-medium text-white">{label}</span>
        {sublabel && (
          <span className="text-sm text-zinc-400">{sublabel}</span>
        )}
        {warning && (
          <span className="text-sm text-amber-400">{warning}</span>
        )}
      </span>
    </label>
  )
}

function ContinueButton({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`mt-6 self-end rounded-lg px-6 py-2.5 text-sm font-semibold transition-colors
        ${disabled
          ? 'cursor-not-allowed bg-zinc-700 text-zinc-500'
          : 'bg-amber-500 text-zinc-900 hover:bg-amber-400'}`}
    >
      Continue →
    </button>
  )
}

// ─── Props & gate interfaces ──────────────────────────────────────────────────

export interface MobileGateProps {
  variant:     'mobile'
  /** Pre-detected mobile target (influences title copy) */
  mobileTarget?: 'ios_only' | 'android_only' | 'both' | 'unspecified'
  onConfirm:   (choice: MobileChoice) => void
}

export interface HardwareGateProps {
  variant:     'hardware'
  /** Which hardware family was detected (defaults to 'arduino') */
  family?:     HardwareProfile['family']
  onConfirm:   (profile: HardwareProfile) => void
}

export interface ClosedPlatformGateProps {
  variant:      'closed'
  platformName: string
  /** Human-readable reason why it's closed */
  reason:       string
  /** Alternative platforms to offer as radio options */
  alternatives: Array<{ id: string; label: string; description?: string }>
  onConfirm:    (alternativeId: string) => void
}

export type PlatformClarificationGateProps =
  | MobileGateProps
  | HardwareGateProps
  | ClosedPlatformGateProps

// ─── Mobile clarification wizard (UX §5.3) ───────────────────────────────────

const MOBILE_TITLE: Record<string, string> = {
  ios_only:    'You want an iPhone app.',
  android_only: 'You want an Android app.',
  both:        'You want an app for iPhone and Android.',
  unspecified: 'You want a mobile app.',
}

function MobileClarificationGate({ mobileTarget = 'both', onConfirm }: Omit<MobileGateProps, 'variant'>) {
  const [choice, setChoice] = useState<MobileChoice>('pwa')
  const groupId = useId()
  const title = MOBILE_TITLE[mobileTarget] ?? MOBILE_TITLE['both']

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-2">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-zinc-400">What matters most to you?</p>
      </div>

      <RadioOption
        id={`${groupId}-pwa`}
        name={groupId}
        value="pwa"
        checked={choice === 'pwa'}
        onChange={v => setChoice(v as MobileChoice)}
        label="Works on both — no app stores needed"
        sublabel="Installable web app (PWA) · Free · No Apple account"
      />

      <RadioOption
        id={`${groupId}-crossplatform`}
        name={groupId}
        value="crossplatform_both"
        checked={choice === 'crossplatform_both'}
        onChange={v => setChoice(v as MobileChoice)}
        label="Real apps on both App Store and Google Play"
        sublabel={
          <>
            React Native — one codebase, two stores
            <br />
            <span className="text-zinc-400">✓ Android: no Mac needed — Google Play $25 one-time</span>
            <br />
            <span className="text-zinc-500 text-xs">ℹ You can publish Android first while waiting for a Mac</span>
          </>
        }
        warning="⚠ iPhone: Apple account ($99/year) + Mac + Xcode"
      />

      {(mobileTarget === 'ios_only' || mobileTarget === 'both' || mobileTarget === 'unspecified') && (
        <RadioOption
          id={`${groupId}-ios`}
          name={groupId}
          value="native_ios"
          checked={choice === 'native_ios'}
          onChange={v => setChoice(v as MobileChoice)}
          label="iPhone only (Swift)"
          sublabel="Apple Developer account ($99/yr) + Mac required"
        />
      )}

      {(mobileTarget === 'android_only' || mobileTarget === 'both' || mobileTarget === 'unspecified') && (
        <RadioOption
          id={`${groupId}-android`}
          name={groupId}
          value="native_android"
          checked={choice === 'native_android'}
          onChange={v => setChoice(v as MobileChoice)}
          label="Android only (Kotlin)"
          sublabel="Google Play Developer account ($25 one-time) · No Mac needed"
        />
      )}

      {(mobileTarget === 'both' || mobileTarget === 'unspecified') && (
        <RadioOption
          id={`${groupId}-native-both`}
          name={groupId}
          value="native_both"
          checked={choice === 'native_both'}
          onChange={v => setChoice(v as MobileChoice)}
          label="Native apps for both (Swift + Kotlin)"
          sublabel="Two separate codebases · Maximum performance · Most complex"
          warning="⚠ Apple account ($99/yr) + Mac required for iOS"
        />
      )}

      <ContinueButton onClick={() => onConfirm(choice)} />
    </div>
  )
}

// ─── Hardware clarification wizard (UX §5.4) ─────────────────────────────────

function HardwareClarificationGate({
  family = 'arduino',
  onConfirm,
}: Omit<HardwareGateProps, 'variant'>) {
  const profiles = HARDWARE_PROFILES.filter(p => p.family === family)
  const defaultProfile = profiles.find(p => p.is_default) ?? profiles[0]
  const [selectedId, setSelectedId] = useState<string>(defaultProfile?.id ?? '')
  const groupId = useId()

  const familyLabel: Record<string, string> = {
    arduino:       'Arduino',
    raspberry_pi:  'Raspberry Pi',
    esp:           'ESP',
    stm32:         'STM32',
    other:         'Hardware',
  }

  const selected = profiles.find(p => p.id === selectedId)

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-2">
        <h2 className="text-lg font-semibold text-white">What hardware are you building for?</h2>
        <p className="mt-1 text-sm text-zinc-400">{familyLabel[family] ?? family} boards</p>
      </div>

      <div className="flex flex-col gap-2">
        {profiles.map(profile => (
          <RadioOption
            key={profile.id}
            id={`${groupId}-${profile.id}`}
            name={groupId}
            value={profile.id}
            checked={selectedId === profile.id}
            onChange={setSelectedId}
            label={
              <>
                {profile.display_name}
                {profile.is_default && (
                  <span className="ml-2 text-xs font-normal text-zinc-500">[default]</span>
                )}
              </>
            }
            sublabel={profile.notes}
          />
        ))}
      </div>

      <ContinueButton
        onClick={() => { if (selected) onConfirm(selected) }}
        disabled={!selected}
      />
    </div>
  )
}

// ─── Closed platform block (UX §5.5) ─────────────────────────────────────────

function ClosedPlatformBlock({
  platformName,
  reason,
  alternatives,
  onConfirm,
}: Omit<ClosedPlatformGateProps, 'variant'>) {
  const [choice, setChoice] = useState<string>(alternatives[0]?.id ?? '')
  const groupId = useId()

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-2 rounded-lg border border-red-800 bg-red-900/20 p-4">
        <h2 className="text-lg font-semibold text-white">
          {platformName} development isn&apos;t available
        </h2>
        <p className="mt-2 text-sm text-zinc-300">{reason}</p>
        <p className="mt-1 text-xs text-zinc-500">
          This is not a Harmoven limitation — the platform controls access.
        </p>
      </div>

      <p className="text-sm font-medium text-zinc-300">
        What Harmoven can build instead:
      </p>

      <div className="flex flex-col gap-2">
        {alternatives.map(alt => (
          <RadioOption
            key={alt.id}
            id={`${groupId}-${alt.id}`}
            name={groupId}
            value={alt.id}
            checked={choice === alt.id}
            onChange={setChoice}
            label={alt.label}
            sublabel={alt.description}
          />
        ))}
      </div>

      <ContinueButton
        onClick={() => onConfirm(choice)}
        disabled={!choice}
      />
    </div>
  )
}

// ─── Root component ───────────────────────────────────────────────────────────

/**
 * PlatformClarificationGate
 *
 * Renders one of three wizard variants based on the `variant` prop:
 * - "mobile"   → mobile platform choice wizard
 * - "hardware" → hardware board selection wizard
 * - "closed"   → hard block for closed platforms (PS5, Switch, etc.)
 */
export function PlatformClarificationGate(props: PlatformClarificationGateProps) {
  return (
    <div className="w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-lg">
      {props.variant === 'mobile' && (
        <MobileClarificationGate
          mobileTarget={props.mobileTarget}
          onConfirm={props.onConfirm}
        />
      )}
      {props.variant === 'hardware' && (
        <HardwareClarificationGate
          family={props.family}
          onConfirm={props.onConfirm}
        />
      )}
      {props.variant === 'closed' && (
        <ClosedPlatformBlock
          platformName={props.platformName}
          reason={props.reason}
          alternatives={props.alternatives}
          onConfirm={props.onConfirm}
        />
      )}
    </div>
  )
}

export default PlatformClarificationGate
