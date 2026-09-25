import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const QUEUE_DIR = path.join(
  process.cwd(),
  ".automation-queue"
);

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export async function POST(request) {
  try {
    const body = await request.json();

    const ids = Array.isArray(body.ids)
      ? [
          ...new Set(
            body.ids
              .map(normalizeId)
              .filter(Boolean)
          ),
        ]
      : [];

    if (!ids.length) {
      return Response.json(
        {
          error: "No WIP items selected.",
        },
        {
          status: 400,
        }
      );
    }

    await fs.mkdir(QUEUE_DIR, {
      recursive: true,
    });

    const jobs = [];

    for (const packageId of ids) {
      const jobId = crypto.randomUUID();

      const job = {
        id: jobId,

        packageId,

        signatureField: "RETAG",
        canvasSignature: "IST",

        status: "queued",

        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(
          QUEUE_DIR,
          `${jobId}.json`
        ),
        JSON.stringify(job, null, 2)
      );

      jobs.push({
        jobId,
        packageId,
      });
    }

    return Response.json({
      queued: true,
      count: jobs.length,
      jobs,
    });
  } catch (error) {
    console.error(
      "Could not queue automation:",
      error
    );

    return Response.json(
      {
        error:
          error?.message ||
          "Could not queue automation.",
      },
      {
        status: 500,
      }
    );
  }
}