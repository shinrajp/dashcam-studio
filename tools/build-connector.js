// Regenerates js/connector-src.js from connector/Tesla-Grid-Player-Connector.user.js
const fs = require("fs"), path = require("path"), root = path.join(__dirname, "..");
const s = fs.readFileSync(path.join(root, "connector/Tesla-Grid-Player-Connector.user.js"), "utf8");
fs.writeFileSync(path.join(root, "js/connector-src.js"), `/* Auto-generated from connector/Tesla-Grid-Player-Connector.user.js — do not edit. */\nwindow.TDC = window.TDC || {};\nwindow.TDC.CONNECTOR_FILENAME = "Tesla-Grid-Player-Connector.user.js";\nwindow.TDC.CONNECTOR_SRC = ${JSON.stringify(s)};\n`);
