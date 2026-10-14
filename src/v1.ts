/**
 * Legacy OpenCode 1.x entrypoint.
 *
 * OpenCode 2 requires a plain object default export; OpenCode 1 expects
 * a callable plugin. Keep them on separate entrypoints.
 */
export { AgyPlugin as default, AgyPlugin, server, setup } from "./index";
