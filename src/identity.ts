import fs from "node:fs";
import path from "node:path";

export interface SystemIdentity {
  name: string;
  version: string;
  tagline: string;
  protocol?: string;
  branding: {
    owner: string;
    organization: string;
    address?: string;
    location?: string;
  };
  contact?: {
    phone?: string;
    email?: string;
    website?: string;
  };
  license: string;
}

const DEFAULT_IDENTITY: SystemIdentity = {
  name: "lama",
  version: "0.1.0",
  tagline: "Stock llama.cpp, sovereign locally.",
  protocol: "SSI-Core/1",
  branding: {
    owner: "Sahon Srabon",
    organization: "Developer Zone",
    location: "Dhaka, Bangladesh",
  },
  contact: { website: "https://zombiecoder.my.id/" },
  license: "Proprietary - Local Freedom Protocol",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateIdentity(value: unknown): SystemIdentity {
  if (!isRecord(value)) throw new Error("identity.json must contain an object");
  const raw = isRecord(value.system_identity) ? value.system_identity : value;
  const branding = isRecord(raw.branding) ? raw.branding : {};
  const contact = isRecord(raw.contact) ? raw.contact : {};
  const text = (input: unknown, field: string): string => {
    if (typeof input !== "string" || !input.trim()) throw new Error(`identity.${field} is required`);
    return input.trim();
  };
  const identity: SystemIdentity = {
    name: text(raw.name, "name"),
    version: text(raw.version, "version"),
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    branding: {
      owner: text(branding.owner, "branding.owner"),
      organization: text(branding.organization, "branding.organization"),
      ...(typeof branding.location === "string" ? { location: branding.location } : {}),
      ...(typeof branding.address === "string" ? { address: branding.address } : {}),
    },
    license: text(raw.license, "license"),
  };
  if (typeof raw.protocol === "string") identity.protocol = raw.protocol;
  const phone = typeof contact.phone === "string" ? contact.phone : undefined;
  const email = typeof contact.email === "string" ? contact.email : undefined;
  const website = typeof contact.website === "string" ? contact.website : undefined;
  if (phone || email || website) {
    identity.contact = {
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      ...(website ? { website } : {}),
    };
  }
  return identity;
}

export function identityPath(root: string): string {
  return path.join(root, "identity.json");
}

export function loadIdentity(root: string): SystemIdentity {
  const file = identityPath(root);
  if (!fs.existsSync(file)) return DEFAULT_IDENTITY;
  return validateIdentity(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}

export function ensureIdentityFile(root: string): { path: string; created: boolean } {
  const file = identityPath(root);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ system_identity: DEFAULT_IDENTITY }, null, 2)}\n`, { mode: 0o444 });
    return { path: file, created: true };
  }
  try {
    fs.chmodSync(file, 0o444);
  } catch {
    // read-only enforcement is best effort on filesystems without POSIX modes
  }
  return { path: file, created: false };
}

export function identityHeaders(identity: SystemIdentity): Record<string, string> {
  return {
    "x-powered-by": `${identity.name}-by-${identity.branding.owner.replace(/\s+/g, "")}`,
    "x-system-identity": identity.name,
    "x-system-version": identity.version,
    "x-system-owner": identity.branding.owner,
  };
}
