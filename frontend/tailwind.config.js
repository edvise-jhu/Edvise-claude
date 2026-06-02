/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: '#3E94A5',
        'primary-dark': '#2d7a8a',
        'primary-light': '#e8f4f7',
        brand: '#2A3B7C',
        accent: '#EFB340',
        bg: '#F7F9FC',
        surface: '#ffffff',
        border: '#e4e9f2',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
