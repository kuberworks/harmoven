import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Harmoven design tokens → CSS vars (DESIGN_SYSTEM.md §1.3)
        surface: {
          base:     'var(--surface-base)',
          raised:   'var(--surface-raised)',
          overlay:  'var(--surface-overlay)',
          hover:    'var(--surface-hover)',
          selected: 'var(--surface-selected)',
          border:   'var(--surface-border)',
        },
        accent: {
          amber:         'var(--accent-amber-9)',
          'amber-press': 'var(--accent-amber-10)',
          'amber-subtle':'var(--accent-amber-3)',
          'amber-hover': 'var(--accent-amber-4)',
        },
        sand: {
          11: 'var(--sand-11)',
          12: 'var(--sand-12)',
        },
        status: {
          running:   'var(--color-status-running)',
          completed: 'var(--color-status-completed)',
          failed:    'var(--color-status-failed)',
          paused:    'var(--color-status-paused)',
          suspended: 'var(--color-status-suspended)',
          pending:   'var(--color-status-pending)',
        },
        severity: {
          blocking:  'var(--color-severity-blocking)',
          important: 'var(--color-severity-important)',
          watch:     'var(--color-severity-watch)',
        },
        // shadcn/ui semantic aliases
        background: 'var(--background)',
        foreground:  'var(--foreground)',
        card:  { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent2: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        border:  'var(--border)',
        input:   'var(--input)',
        ring:    'var(--ring)',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        card:  'var(--radius-card)',
        input: 'var(--radius-input)',
        badge: 'var(--radius-badge)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'pulse-gate': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
      },
      animation: {
        'pulse-gate': 'pulse-gate 2s ease-in-out infinite',
        'fade-in':    'fade-in 0.15s ease-out',
        'slide-in':   'slide-in-right 0.15s ease-out',
      },
    },
  },
  plugins: [],
}

export default config
