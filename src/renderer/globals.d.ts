// Types for the type checker only (npm run typecheck); nothing here is loaded by the app.
// `ron` is the fixed set of operations exposed by src/main/preload.js.
declare const ron: {
  [operation: string]: (...args: any[]) => any;
};
