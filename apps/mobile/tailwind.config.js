/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        "omx-teal": "#007b8b",
        "omx-teal-light": "#e0f2f1",
        "omx-teal-hover": "#006475",
        "omx-primary-blue": "#1A73E8",
      },
    },
  },
  plugins: [],
};
