// Node parity: a minimal async_hooks shim. The web context has no async
// tracking; AsyncLocalStorage keeps a stack that is valid for the synchronous
// section of run(), which covers libraries (e.g. @langchain tracing) that
// only need to read the store while their code executes.

export class AsyncLocalStorage {
  constructor() {
    this._stack = [];
  }

  run(store, callback, ...args) {
    this._stack.push(store);

    let result;
    try {
      result = callback(...args);
    } finally {
      if (!(result && typeof result.finally === "function")) {
        this._stack.pop();
      }
    }

    if (result && typeof result.finally === "function") {
      return result.finally(() => {
        this._stack.pop();
      });
    }

    return result;
  }

  getStore() {
    return this._stack.length
      ? this._stack[this._stack.length - 1]
      : undefined;
  }

  enterWith(store) {
    if (store === undefined) {
      this._stack.pop();
    } else {
      this._stack.push(store);
    }
  }

  exit() {
    this._stack.pop();
  }

  disable() {
    this._stack.length = 0;
  }
}

export function createHook() {
  return {
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  };
}

export function executionAsyncId() {
  return 0;
}

export function executionAsyncResource() {
  return {};
}

export function triggerAsyncId() {
  return 0;
}
