import {
  createHash,
  randomUUID,
} from "node:crypto";

export function createRawObjectIdentity({
  organizationId,
  originalFilename,
  content,
}) {
  const checksumSha256 =
    createHash("sha256")
      .update(
        normalizeContent(content),
      )
      .digest("hex");

  const storageKey = [
    "organizations",
    requiredText(
      organizationId,
      "Organization is required.",
    ),
    "uploads",
    checksumSha256,
    safeFilename(
      originalFilename,
    ),
  ].join("/");

  return {
    checksumSha256,
    storageKey,
  };
}

export function createUniqueRawObjectIdentity(input) {
  const original = createRawObjectIdentity(input);
  const slash = original.storageKey.lastIndexOf("/");

  return {
    ...original,
    storageKey:
      original.storageKey.slice(0, slash) +
      "/v2/" + randomUUID() + "/" +
      original.storageKey.slice(slash + 1),
  };
}

export function isUniqueRawObjectStorageKey(base, candidate) {
  if (typeof candidate !== "string") return false;

  const slash = base.storageKey.lastIndexOf("/");
  const prefix = base.storageKey.slice(0, slash) + "/v2/";
  const suffix = "/" + base.storageKey.slice(slash + 1);

  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) {
    return false;
  }

  const token = candidate.slice(prefix.length, -suffix.length);

  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token);
}

export function safeFilename(
  filename,
) {
  const cleaned =
    String(
      filename ?? "",
    )
      .trim()
      .replace(
        /[^a-zA-Z0-9._-]+/g,
        "-",
      )
      .replace(
        /^[-.]+/,
        "",
      )
      .slice(
        0,
        180,
      );

  return cleaned || "upload";
}

function normalizeContent(
  content,
) {
  if (
    Buffer.isBuffer(content)
  ) {
    return content;
  }

  if (
    content instanceof
    Uint8Array
  ) {
    return Buffer.from(
      content,
    );
  }

  if (
    typeof content ===
    "string"
  ) {
    return Buffer.from(
      content,
      "utf8",
    );
  }

  throw new TypeError(
    "Raw object content must be a string, Buffer, or Uint8Array.",
  );
}

function requiredText(
  value,
  message,
) {
  const text =
    String(
      value ?? "",
    ).trim();

  if (!text) {
    throw new TypeError(
      message,
    );
  }

  return text;
}