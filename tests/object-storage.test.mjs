import assert from "node:assert/strict";
import test from "node:test";

import {
  ObjectStorageError,
  S3ObjectStorage,
} from "../src/storage/s3-object-storage.mjs";

class FakeS3Client {
  constructor() {
    this.commands = [];
    this.objects =
      new Map();
  }

  async send(command) {
    this.commands.push(
      command,
    );

    const name =
      command.constructor.name;

    const input =
      command.input;

    if (
      name ===
      "HeadBucketCommand"
    ) {
      return {};
    }

    if (
      name ===
      "PutObjectCommand"
    ) {
      this.objects.set(
        input.Key,
        {
          body:
            Buffer.from(
              input.Body,
            ),

          contentType:
            input.ContentType,

          metadata:
            input.Metadata ??
            {},
        },
      );

      return {
        ETag:
          '"test-etag"',
      };
    }

    if (
      name ===
      "HeadObjectCommand"
    ) {
      const object =
        this.objects.get(
          input.Key,
        );

      if (!object) {
        const error =
          new Error(
            "Not found",
          );

        error.name =
          "NotFound";

        error.$metadata = {
          httpStatusCode: 404,
        };

        throw error;
      }

      return {
        ContentLength:
          object.body
            .byteLength,

        ContentType:
          object.contentType,

        Metadata:
          object.metadata,
      };
    }

    if (
      name ===
      "GetObjectCommand"
    ) {
      const object =
        this.objects.get(
          input.Key,
        );

      if (!object) {
        const error =
          new Error(
            "Not found",
          );

        error.name =
          "NoSuchKey";

        error.$metadata = {
          httpStatusCode: 404,
        };

        throw error;
      }

      return {
        ContentType:
          object.contentType,

        Metadata:
          object.metadata,

        Body: {
          async transformToByteArray() {
            return object.body;
          },
        },
      };
    }

    if (
      name ===
      "DeleteObjectCommand"
    ) {
      this.objects.delete(
        input.Key,
      );

      return {};
    }

    throw new Error(
      `Unexpected command: ${name}`,
    );
  }
}

test(
  "S3 storage writes, reads, inspects and deletes tenant objects",
  async () => {
    const client =
      new FakeS3Client();

    const storage =
      new S3ObjectStorage({
        bucket:
          "biznoryx-test",

        client,
      });

    assert.equal(
      await storage.healthCheck(),
      true,
    );

    const stored =
      await storage.putObject({
        key:
          "organizations/org-1/uploads/file-1/sales.csv",

        body:
          "product,revenue\nA,10\n",

        contentType:
          "text/csv",

        metadata: {
          organizationId:
            "org-1",
        },
      });

    assert.equal(
      stored.bucket,
      "biznoryx-test",
    );

    assert.equal(
      stored.key,
      "organizations/org-1/uploads/file-1/sales.csv",
    );

    const head =
      await storage.headObject({
        key: stored.key,
      });

    assert.equal(
      head.exists,
      true,
    );

    assert.equal(
      head.contentType,
      "text/csv",
    );

    const object =
      await storage.getObject({
        key: stored.key,
      });

    assert.equal(
      object.body.toString(
        "utf8",
      ),
      "product,revenue\nA,10\n",
    );

    const deleted =
      await storage.deleteObject({
        key: stored.key,
      });

    assert.equal(
      deleted.deleted,
      true,
    );

    const missing =
      await storage.headObject({
        key: stored.key,
      });

    assert.equal(
      missing.exists,
      false,
    );
  },
);

test(
  "S3 storage rejects unsafe keys",
  async () => {
    const storage =
      new S3ObjectStorage({
        bucket:
          "biznoryx-test",

        client:
          new FakeS3Client(),
      });

    await assert.rejects(
      storage.putObject({
        key:
          "../secret.csv",

        body:
          "test",

        contentType:
          "text/csv",
      }),

      (error) =>
        error instanceof
          ObjectStorageError &&
        error.code ===
          "INVALID_OBJECT_KEY",
    );
  },
);

test(
  "S3 storage rejects unsupported object bodies",
  async () => {
    const storage =
      new S3ObjectStorage({
        bucket:
          "biznoryx-test",

        client:
          new FakeS3Client(),
      });

    await assert.rejects(
      storage.putObject({
        key:
          "organizations/org/upload.csv",

        body: {
          unsafe:
            true,
        },

        contentType:
          "text/csv",
      }),

      (error) =>
        error instanceof
          ObjectStorageError &&
        error.code ===
          "INVALID_OBJECT_BODY",
    );
  },
);