import { pathToFileURL } from "node:url";

const DEFAULT_CREDENTIALS_MODULE =
  "/app/runtime/node_modules/@milldr/crono/dist/credentials.js";

function required(name, value) {
  if (!value || String(value).trim() === "") {
    throw new Error(`Missing required credential: ${name}`);
  }
  return String(value).trim();
}

export async function syncCredentials(raw = process.env) {
  const kernelApiKey = required("CRONO_KERNEL_API_KEY", raw.CRONO_KERNEL_API_KEY);
  const email = required("CRONO_CRONOMETER_EMAIL", raw.CRONO_CRONOMETER_EMAIL);
  const password = required(
    "CRONO_CRONOMETER_PASSWORD",
    raw.CRONO_CRONOMETER_PASSWORD
  );

  const credentialsModulePath =
    raw.CRONO_CREDENTIALS_MODULE || DEFAULT_CREDENTIALS_MODULE;
  const credentialsModuleUrl = pathToFileURL(credentialsModulePath).href;
  const credentialsModule = await import(credentialsModuleUrl);

  if (typeof credentialsModule.setCredential !== "function") {
    throw new Error(
      `Invalid credentials module at ${credentialsModulePath}: setCredential() not found`
    );
  }

  credentialsModule.setCredential("kernel-api-key", kernelApiKey);
  credentialsModule.setCredential("cronometer-username", email);
  credentialsModule.setCredential("cronometer-password", password);

  process.env.KERNEL_API_KEY = kernelApiKey;

  return {
    updated: ["kernel-api-key", "cronometer-username", "cronometer-password"],
  };
}
