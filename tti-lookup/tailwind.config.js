/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          bg: '#0b0f19',
          surface: '#111827',
          card: '#162032',
          cardHover: '#1c283e',
          border: '#243247',
          borderLight: '#334460',
          muted: '#64748b',
          textMuted: '#94a3b8',
          text: '#f1f5f9',
          textBright: '#ffffff',
        },
        brand: {
          DEFAULT: '#2563eb',
          hover: '#1d4ed8',
          subtle: '#1e3a8a30',
          border: '#3b82f6',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
}
