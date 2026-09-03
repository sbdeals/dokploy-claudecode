// Stand-in for the `server-only` package under vitest (see vitest.config.ts).
// The real module throws outside a React Server environment; tests import
// server modules directly, so the alias points here instead.
export {};
