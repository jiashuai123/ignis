import { processShim } from "../process.js";
import { installBuffer } from "./buffer.js";
import { installFetchShim } from "./fetch.js";
import { installWindowClose, installWindowOpen } from "./window.js";
import {
  installVibrateShim,
  installQueryLocalFontsShim,
  installRandomUUIDShim,
  installClipboardShim,
  installMediaDevicesShim,
  installSubtleShim,
} from "./web-apis.js";

function installProcess() {
  window.process = processShim;
}

// Electron always has SharedArrayBuffer; browsers only expose it on
// cross-origin-isolated pages. Some plugin bundles reference it at module
// top level (e.g. new Int32Array(new SharedArrayBuffer(4))), which throws a
// ReferenceError and kills the plugin on load. A inert stub keeps module
// evaluation alive; it cannot back real cross-worker sharing or Atomics.
function installSharedArrayBufferStub() {
  if (typeof window.SharedArrayBuffer !== "undefined") {
    return;
  }

  window.SharedArrayBuffer = class SharedArrayBuffer {
    constructor(byteLength) {
      this.byteLength = byteLength;
    }

    slice(start, end) {
      return new window.SharedArrayBuffer(this.byteLength);
    }
  };
}

function installGlobalAlias() {
  window.global = window;
}

function installContextMenuFix() {
  // hacky fix to prevent browser from showing context menu while allowing obsidian context menu
  window.addEventListener(
    "contextmenu",
    (e) => {
      const isTouch =
        e.pointerType === "touch" || e.sourceCapabilities?.firesTouchEvents;

      // allow for touch events. Fixes copy/paste on mobile devices.
      if (isTouch) {
        return;
      }

      e.preventDefault();
      Object.defineProperty(e, "defaultPrevented", { get: () => false });
    },
    true,
  );
}

export function installGlobals() {
  installGlobalAlias();
  installProcess();
  installBuffer();
  installSharedArrayBufferStub();
  installFetchShim();
  installWindowClose();
  installWindowOpen();
  installVibrateShim();
  installQueryLocalFontsShim();
  installRandomUUIDShim();
  installClipboardShim();
  installMediaDevicesShim();
  installSubtleShim();
  installContextMenuFix();
}
