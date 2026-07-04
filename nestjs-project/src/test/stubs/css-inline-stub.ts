/**
 * Jest stub for the native `@css-inline/css-inline` package.
 *
 * The real package loads a Rust/napi addon that registers a process-level
 * `CustomGC` handle. That handle keeps Jest alive after the run finishes and
 * surfaces under `--detectOpenHandles`. It is pulled in transitively by
 * `@nestjs-modules/mailer`'s HandlebarsAdapter through a static top-level
 * `require('@css-inline/css-inline')`, so no adapter option can avoid loading it.
 *
 * Tests never assert on inlined CSS, so `moduleNameMapper` (in package.json's
 * jest config and in test/jest-e2e.json) redirects the import here. Handlebars
 * templating still runs for real; only the cosmetic CSS-inlining step becomes a
 * passthrough. Production keeps the real css-inline. This lets `npm test` exit
 * on its own without `--forceExit`.
 */
export function inline(html: string): string {
  return html;
}
