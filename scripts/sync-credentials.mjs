import { syncCredentials } from "../src/credentials-sync.js";

async function main() {
  try {
    const result = await syncCredentials(process.env);
    console.log(
      JSON.stringify({ message: "credentials synced", updated: result.updated })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "credential sync failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    process.exit(1);
  }
}

await main();
