import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#6D4AFF',
          dark: '#5631E6',
          light: '#EEEBFF',
        },
        accent: '#B794FF',
        success: '#16B364',
        warning: '#F79009',
        danger: '#F04438',
        bg: '#F4F5FA',
        surface: '#FFFFFF',
        text: {
          primary: '#0E1422',
          secondary: '#6A7385',
        },
        border: '#ECEDF3',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        display: [
          'Plus Jakarta Sans',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      backgroundImage: {
        'primary-gradient': 'linear-gradient(135deg, #7C5CFF 0%, #5631E6 100%)',
        'app-radial':
          'radial-gradient(1200px 600px at 85% -10%, rgba(124,92,255,0.10), transparent 60%), radial-gradient(900px 500px at -10% 10%, rgba(183,148,255,0.10), transparent 55%)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 6px 18px -8px rgba(16,24,40,0.10)',
        'card-hover': '0 12px 34px -10px rgba(16,24,40,0.18)',
        glow: '0 8px 22px -8px rgba(109,74,255,0.55)',
        nav: '0 -10px 30px -12px rgba(16,24,40,0.16)',
        soft: '0 2px 10px -2px rgba(16,24,40,0.08)',
      },
      keyframes: {
        'slide-in': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { transform: 'scale(0.96) translateY(4px)', opacity: '0' },
          '100%': { transform: 'scale(1) translateY(0)', opacity: '1' },
        },
        rise: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pop: {
          '0%': { transform: 'scale(0.95) translateY(8px)', opacity: '0' },
          '100%': { transform: 'scale(1) translateY(0)', opacity: '1' },
        },
        'sheet-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'toast-in': {
          '0%': { transform: 'translateY(-120%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'slide-in': 'slide-in 0.25s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'scale-in': 'scale-in 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        rise: 'rise 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        pop: 'pop 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
        'sheet-up': 'sheet-up 0.32s cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s linear infinite',
        'toast-in': 'toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
