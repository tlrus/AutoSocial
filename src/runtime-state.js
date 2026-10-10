const fs = require("node:fs");
const path = require("node:path");
const { config } = require("./config");
const statePath = path.join(config.projectRoot, ".scheduler-state", "runtime.json");
let state = {};
let shuttingDown = false;
try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}

function save(key, enabled) {
  if (shuttingDown) return;
  state[key] = enabled;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${statePath}.tmp`, statePath);
}

function trackController(controller, key) {
  controller.resumeRequested = state[key] === true;
  for (const [method, enabled] of [["start", true], ["stop", false]]) {
    const original = controller[method].bind(controller);
    controller[method] = (...args) => {
      const complete = (result) => {
        if (result?.ok) { save(key, enabled); controller.resumeRequested = enabled; }
        return result;
      };
      const result = original(...args);
      return result?.then ? result.then(complete) : complete(result);
    };
  }
  return controller;
}

function beginShutdown() { shuttingDown = true; }
module.exports = { trackController, beginShutdown };
