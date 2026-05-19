/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Brand olivově-zlatá z ivetasmolkova.cz (CTA: rgba(178, 159, 75, 0.92))
        brand: {
          50:  '#faf8ec',
          100: '#f4f0d3',
          200: '#e9dfa8',
          300: '#d9c97a',
          400: '#c8b358',
          500: '#b29f4b',  // primary — odpovídá #B29F4B z webu
          600: '#998840',
          700: '#7c6d36',
          800: '#665a31',
          900: '#574d2c'
        },
        // Doplňková tmavomodrá z hero fotky interiéru
        ink: {
          50:  '#f4f6f9',
          100: '#e6ebf2',
          500: '#3a4860',
          700: '#1f2b3e',
          900: '#0f172a'
        }
      },
      fontFamily: {
        sans: ['Montserrat', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Montserrat Alternates"', 'Montserrat', 'system-ui', 'sans-serif']
      }
    },
  },
  plugins: [],
}
