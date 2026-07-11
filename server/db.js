const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = process.env.DB_NAME || "restropulse_landing";

let clientPromise = null;

async function connect() {
  if (!clientPromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
    clientPromise = client.connect().catch(err => {
      clientPromise = null; // allow retry on next request
      throw err;
    });
  }
  const client = await clientPromise;
  return client.db(dbName);
}

module.exports = { connect };
