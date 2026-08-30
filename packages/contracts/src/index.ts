/**
 * The public shape of the Unified Service Scheduler API.
 *
 * This package exists because the brief has the client stubbed rather than
 * built. A stub that restates the request shape in its own words drifts from
 * the server the moment either side changes, and nothing catches it. Sharing
 * the declaration makes that drift a compile error instead.
 *
 * Nothing here may import a server framework, a database client, or Node
 * built-ins -- the package has to remain consumable from a browser.
 */
export * from './schemas';
export * from './envelope';
export * from './views';
export * from './errors';
