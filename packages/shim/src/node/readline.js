import { EventEmitter } from "./events.js";

// Node parity: a minimal readline shim. Enough for module top-level code that
// constructs an interface; interactive line editing is not available in the
// browser. question() answers immediately with an empty string.

export function createInterface() {
  const rl = new EventEmitter();

  rl.question = (query, callback) => {
    if (typeof callback === "function") {
      callback("");
    }

    return rl;
  };

  rl.close = () => {};
  rl.pause = () => {};
  rl.resume = () => {};
  rl.prompt = () => {};
  rl.write = () => {};

  return rl;
}
