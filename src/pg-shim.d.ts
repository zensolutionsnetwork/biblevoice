// Minimal module declaration for `pg` (no bundled types; we run on tsx at runtime).
// Lets `tsc --noEmit` pass as a pre-deploy gate without adding @types/pg.
declare module "pg";
