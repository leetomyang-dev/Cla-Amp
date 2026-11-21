// One check, and only one: a name that is used but never defined. Such a name
// fails only when its line runs, and inside a try/catch it fails silently, so
// it is caught here instead. The Checks run on GitHub uses this file:
//
//   npx eslint@10.15.0 -c tools/undefined-names.eslint.mjs .
//
// The lint tool is not one of Cla-Amp's packages: nobody who only runs
// Cla-Amp downloads it. The names below are the ones each side is given by
// what runs it; a new one is added here when the code starts using it.

const given = names => Object.fromEntries(names.split(/\s+/).filter(Boolean).map(name => [name, 'readonly']))

const SHARED = `console setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone performance
  URL URLSearchParams fetch AbortSignal AbortController TextDecoder TextEncoder Blob Response Request Headers
  DecompressionStream CompressionStream atob btoa crypto Intl WebAssembly`

// The main process, the tools and the tests: Node.
const NODE = `${SHARED} process Buffer setImmediate clearImmediate`

// The window: a sandboxed web page.
const PAGE = `${SHARED} window document navigator location history localStorage sessionStorage
  requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia
  alert confirm prompt
  Node Element HTMLElement HTMLInputElement HTMLTextAreaElement HTMLSelectElement HTMLButtonElement HTMLImageElement
  HTMLCanvasElement HTMLVideoElement HTMLAudioElement HTMLDialogElement HTMLAnchorElement SVGElement DocumentFragment
  Event CustomEvent KeyboardEvent MouseEvent PointerEvent DragEvent ClipboardEvent InputEvent
  MutationObserver ResizeObserver IntersectionObserver
  Image Audio FileReader File DataTransfer DOMParser Range CSS CSSStyleSheet FontFace
  Path2D OffscreenCanvas ImageData createImageBitmap
  AudioContext speechSynthesis SpeechSynthesisUtterance Notification
  DOMRect DOMPoint DOMMatrix NodeFilter XMLSerializer getSelection Option HTMLLinkElement`

export default [
  { ignores: ['node_modules/**', 'skins/**', 'docs/**', '.policy-cache/**'] },
  {
    files: ['*.mjs', 'tools/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: given(NODE) },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['preload.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: given(`${NODE} require module`) },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: given(PAGE) },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
]
