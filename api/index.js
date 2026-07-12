/* Vercel serverless entrypoint.
   The whole Express app (routes + express.static for public/) is exported
   from server/index.js and handled here as a single function. vercel.json
   rewrites every path to this function. */
module.exports = require("../server/index.js");
