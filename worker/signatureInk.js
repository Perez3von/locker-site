"use strict";

// Draw a legible I-S-T with intentional pauses between strokes. The T occupies
// its own right-hand area of the canvas so we can verify that those pixels
// actually changed before Save. This is UI-level evidence, not a guarantee
// that the MSPT server will persist the signature.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function drawIST(page) {
  const canvas = page.locator(".signatureBox .k-signature-canvas canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 15000 });
  const box = await canvas.boundingBox();
  if (!box || box.width < 100 || box.height < 75) {
    throw new Error("Signature canvas is missing or too small to draw safely. No Save attempted.");
  }

  // Snapshot JUST the T region before drawing it. A nonzero difference after
  // drawing detects cases where mouse events were ignored by Telerik.
  async function inkSnapshot() {
    return canvas.evaluate(element => {
      const context = element.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Cannot inspect signature canvas pixels.");
      const { width, height } = element;
      const x = Math.floor(width * 0.53);
      const y = Math.floor(height * 0.24);
      const w = Math.max(1, Math.floor(width * 0.30));
      const h = Math.max(1, Math.floor(height * 0.54));
      return Array.from(context.getImageData(x, y, w, h).data);
    });
  }

  async function stroke(points) {
    const [sx, sy] = points[0];
    await page.mouse.move(box.x + box.width * sx, box.y + box.height * sy);
    await sleep(85);
    await page.mouse.down();
    await sleep(65);
    try {
      for (const [px, py] of points.slice(1)) {
        await page.mouse.move(box.x + box.width * px, box.y + box.height * py, { steps: 10 });
        await sleep(65);
      }
    } finally {
      await sleep(110);
      await page.mouse.up();
    }
    await sleep(160); // give Telerik time to commit the stroke
  }

  await stroke([[0.18, 0.27], [0.18, 0.73]]); // I
  await stroke([
    [0.45, 0.31], [0.39, 0.27], [0.32, 0.30], [0.28, 0.36],
    [0.32, 0.43], [0.39, 0.48], [0.45, 0.55], [0.45, 0.63],
    [0.39, 0.70], [0.32, 0.72], [0.28, 0.68],
  ]);

  const beforeT = await inkSnapshot();
  // T: two independent deliberate strokes with ample margins.
  await stroke([[0.56, 0.28], [0.80, 0.28]]);
  await stroke([[0.68, 0.28], [0.68, 0.74]]);
  const afterT = await inkSnapshot();

  if (beforeT.length !== afterT.length) {
    throw new Error("Signature canvas changed dimensions while drawing. No Save attempted.");
  }
  let changedPixels = 0;
  for (let p = 0; p < beforeT.length; p += 4) {
    if (Math.abs(beforeT[p] - afterT[p]) +
        Math.abs(beforeT[p + 1] - afterT[p + 1]) +
        Math.abs(beforeT[p + 2] - afterT[p + 2]) +
        Math.abs(beforeT[p + 3] - afterT[p + 3]) > 45) {
      changedPixels++;
    }
  }
  if (changedPixels < 15) {
    throw new Error("The T stroke was not visibly drawn on the signature canvas. No Save attempted.");
  }
  console.log(`Signature canvas: T stroke confirmed (${changedPixels} changed pixels).`);
}

module.exports = { drawIST };
