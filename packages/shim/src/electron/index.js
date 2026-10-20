import { ipcRenderer } from "./ipc-renderer.js";
import { webFrame } from "./web-frame.js";
import { remoteShim } from "./remote/index.js";
import { nativeImageShim } from "./remote/native-image.js";
import { clipboardShim } from "./remote/clipboard.js";

export const electronShim = {
  ipcRenderer,
  webFrame,
  remote: remoteShim,
  nativeImage: nativeImageShim,
  clipboard: clipboardShim,

  // Browsers cannot open arbitrary local paths or system dialogs; external
  // links are the one piece plugins genuinely need (release notes, auth
  // pages, issue reporters), so route those to a new tab. Schemes are
  // restricted the same way Obsidian restricts openLinkText externally.
  shell: {
    openExternal(url) {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch {
        return Promise.reject(new Error(`openExternal: invalid URL: ${url}`));
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return Promise.reject(new Error(`openExternal: refused ${parsed.protocol} URL`));
      }
      window.open(parsed.href, "_blank", "noopener");
      return Promise.resolve();
    },
    openPath() {
      return Promise.reject(new Error("openPath is not available in the browser"));
    },
    showItemInFolder() {},
    beep() {},
  },

  safeStorage: {
    isEncryptionAvailable() {
      return false;
    },
    encryptString(plainText) {
      return Buffer.from(plainText);
    },
    decryptString(encrypted) {
      return encrypted.toString();
    },
  },

  webUtils: {
    getPathForFile(file) {
      return "";
    },
  },

  deprecate: {
    function(fn, name) {
      return fn;
    },
    event(emitter, name) {},
    removeFunction(fn, name) {
      return fn;
    },
    log(message) {
      console.log("[electron:deprecate]", message);
    },
    warn(oldName, newName) {},
    promisify(fn) {
      return fn;
    },
    renameFunction(fn, newName) {
      return fn;
    },
  },
};
