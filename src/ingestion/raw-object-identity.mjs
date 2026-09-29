import {
  createHash,
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