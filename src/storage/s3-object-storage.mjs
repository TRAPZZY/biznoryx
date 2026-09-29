import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const MAX_OBJECT_SIZE =
  25 * 1024 * 1024;

export class S3ObjectStorage {
  constructor({
    endpoint,
    region = "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle = true,
    client,
  } = {}) {
    this.bucket =
      requiredText(
        bucket,
        "Object storage bucket is required.",
      );

    if (client) {
      this.client = client;
      return;
    }

    const resolvedEndpoint =
      requiredText(
        endpoint,
        "Object storage endpoint is required.",
      );

    const resolvedAccessKey =
      requiredText(
        accessKeyId,
        "Object storage access key is required.",
      );

    const resolvedSecretKey =
      requiredText(
        secretAccessKey,
        "Object storage secret key is required.",
      );

    this.client =
      new S3Client({
        endpoint:
          resolvedEndpoint,

        region:
          requiredText(
            region,
            "Object storage region is required.",
          ),

        forcePathStyle:
          Boolean(
            forcePathStyle,
          ),

        credentials: {
          accessKeyId:
            resolvedAccessKey,

          secretAccessKey:
            resolvedSecretKey,
        },
      });
  }

  static fromEnv(
    env = process.env,
  ) {
    return new S3ObjectStorage({
      endpoint:
        env
          .BIZNORYX_OBJECT_STORAGE_ENDPOINT,

      region:
        env
          .BIZNORYX_OBJECT_STORAGE_REGION ??
        "us-east-1",

      bucket:
        env
          .BIZNORYX_OBJECT_STORAGE_BUCKET,

      accessKeyId:
        env
          .BIZNORYX_OBJECT_STORAGE_ACCESS_KEY_ID,

      secretAccessKey:
        env
          .BIZNORYX_OBJECT_STORAGE_SECRET_ACCESS_KEY,

      forcePathStyle:
        parseBoolean(
          env
            .BIZNORYX_OBJECT_STORAGE_FORCE_PATH_STYLE,
          true,
        ),
    });
  }

  async healthCheck() {
    await this.client.send(
      new HeadBucketCommand({
        Bucket:
          this.bucket,
      }),
    );

    return true;
  }

  async putObject({
    key,
    body,
    contentType,
    metadata = {},
  }) {
    const normalizedKey =
      validateStorageKey(
        key,
      );

    const buffer =
      normalizeBody(body);

    if (
      buffer.byteLength >
      MAX_OBJECT_SIZE
    ) {
      throw new ObjectStorageError(
        "The uploaded object exceeds the maximum supported size.",
        "OBJECT_TOO_LARGE",
      );
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket:
          this.bucket,

        Key:
          normalizedKey,

        Body:
          buffer,

        ContentType:
          requiredText(
            contentType,
            "Object content type is required.",
          ),

        ContentLength:
          buffer.byteLength,

        Metadata:
          normalizeMetadata(
            metadata,
          ),
      }),
    );

    return {
      bucket:
        this.bucket,

      key:
        normalizedKey,

      byteSize:
        buffer.byteLength,

      contentType,
    };
  }

  async headObject({
    key,
  }) {
    const normalizedKey =
      validateStorageKey(
        key,
      );

    try {
      const result =
        await this.client.send(
          new HeadObjectCommand({
            Bucket:
              this.bucket,

            Key:
              normalizedKey,
          }),
        );

      return {
        exists: true,

        bucket:
          this.bucket,

        key:
          normalizedKey,

        byteSize:
          Number(
            result.ContentLength ??
            0,
          ),

        contentType:
          result.ContentType ??
          null,

        metadata:
          result.Metadata ??
          {},
      };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          exists: false,

          bucket:
            this.bucket,

          key:
            normalizedKey,
        };
      }

      throw wrapStorageError(
        error,
        "Unable to inspect stored object.",
      );
    }
  }

  async getObject({
    key,
  }) {
    const normalizedKey =
      validateStorageKey(
        key,
      );

    try {
      const result =
        await this.client.send(
          new GetObjectCommand({
            Bucket:
              this.bucket,

            Key:
              normalizedKey,
          }),
        );

      if (!result.Body) {
        throw new ObjectStorageError(
          "Stored object has no body.",
          "OBJECT_BODY_MISSING",
        );
      }

      const bytes =
        await result.Body
          .transformToByteArray();

      return {
        bucket:
          this.bucket,

        key:
          normalizedKey,

        contentType:
          result.ContentType ??
          null,

        metadata:
          result.Metadata ??
          {},

        body:
          Buffer.from(
            bytes,
          ),
      };
    } catch (error) {
      if (
        error instanceof
        ObjectStorageError
      ) {
        throw error;
      }

      if (isNotFound(error)) {
        throw new ObjectStorageError(
          "Stored object was not found.",
          "OBJECT_NOT_FOUND",
        );
      }

      throw wrapStorageError(
        error,
        "Unable to read stored object.",
      );
    }
  }

  async deleteObject({
    key,
  }) {
    const normalizedKey =
      validateStorageKey(
        key,
      );

    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket:
            this.bucket,

          Key:
            normalizedKey,
        }),
      );

      return {
        deleted: true,

        bucket:
          this.bucket,

        key:
          normalizedKey,
      };
    } catch (error) {
      throw wrapStorageError(
        error,
        "Unable to delete stored object.",
      );
    }
  }
}

export class ObjectStorageError
  extends Error {
  constructor(
    message,
    code =
      "OBJECT_STORAGE_ERROR",
    options,
  ) {
    super(
      message,
      options,
    );

    this.name =
      "ObjectStorageError";

    this.code =
      code;
  }
}

function validateStorageKey(
  key,
) {
  const value =
    requiredText(
      key,
      "Object storage key is required.",
    );

  if (
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (segment) =>
          segment === ".." ||
          segment === ".",
      )
  ) {
    throw new ObjectStorageError(
      "Object storage key is invalid.",
      "INVALID_OBJECT_KEY",
    );
  }

  return value;
}

function normalizeBody(body) {
  if (
    Buffer.isBuffer(body)
  ) {
    return body;
  }

  if (
    typeof body ===
    "string"
  ) {
    return Buffer.from(
      body,
      "utf8",
    );
  }

  if (
    body instanceof
    Uint8Array
  ) {
    return Buffer.from(
      body,
    );
  }

  throw new ObjectStorageError(
    "Object body must be a Buffer, string, or Uint8Array.",
    "INVALID_OBJECT_BODY",
  );
}

function normalizeMetadata(
  metadata,
) {
  if (
    !metadata ||
    typeof metadata !==
      "object" ||
    Array.isArray(metadata)
  ) {
    throw new ObjectStorageError(
      "Object metadata must be an object.",
      "INVALID_OBJECT_METADATA",
    );
  }

  const normalized = {};

  for (
    const [
      key,
      value,
    ] of Object.entries(
      metadata,
    )
  ) {
    const metadataKey =
      String(key)
        .trim()
        .toLowerCase();

    if (
      !metadataKey ||
      !/^[a-z0-9-]+$/.test(
        metadataKey,
      )
    ) {
      throw new ObjectStorageError(
        "Object metadata contains an invalid key.",
        "INVALID_OBJECT_METADATA",
      );
    }

    normalized[
      metadataKey
    ] =
      String(
        value ?? "",
      ).slice(
        0,
        1024,
      );
  }

  return normalized;
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
    throw new ObjectStorageError(
      message,
      "OBJECT_STORAGE_CONFIGURATION_INVALID",
    );
  }

  return text;
}

function parseBoolean(
  value,
  fallback,
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const normalized =
    String(value)
      .trim()
      .toLowerCase();

  if (
    [
      "1",
      "true",
      "yes",
      "on",
    ].includes(
      normalized,
    )
  ) {
    return true;
  }

  if (
    [
      "0",
      "false",
      "no",
      "off",
    ].includes(
      normalized,
    )
  ) {
    return false;
  }

  throw new ObjectStorageError(
    "Object storage force-path-style value must be true or false.",
    "OBJECT_STORAGE_CONFIGURATION_INVALID",
  );
}

function isNotFound(
  error,
) {
  return (
    error?.$metadata
      ?.httpStatusCode === 404 ||
    error?.name ===
      "NotFound" ||
    error?.name ===
      "NoSuchKey"
  );
}

function wrapStorageError(
  error,
  message,
) {
  return new ObjectStorageError(
    message,
    "OBJECT_STORAGE_ERROR",
    {
      cause: error,
    },
  );
}