/** Where the theme choice is remembered (components/theme.tsx). */
export const THEME_KEY = "nos-brainer:theme"

/** Inline in <head>: applies the remembered theme before the page paints, so a dark page never flashes white. */
export const THEME_SCRIPT = `try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}`
