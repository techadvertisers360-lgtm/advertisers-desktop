const fs = require("node:fs");
const path = require("node:path");
const buf = fs.readFileSync(path.join(__dirname, "recorded-test.webm"));
console.log("size:", buf.length);
console.log("first 16 bytes (hex):", buf.slice(0, 16).toString("hex"));
console.log("EBML magic (should be 1a45dfa3):", buf.slice(0, 4).toString("hex"));
