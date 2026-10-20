const { chromium } = require("playwright");
const { login, findPackage } = require("./msptApi");

const MSPT_URL = "https://istmspt.com/packagetrack";

function isAlreadySignedOut(pkg) {
  return Boolean(
    pkg.signatureDate ||
    pkg.signatureName ||
    pkg.signatureTypeId ||
    pkg.signature
  );
}

const { drawIST } = require("./signatureInk");

async function waitUntilEnabled(locator, timeout = 15000) {
  await locator.waitFor({
    state: "visible",
    timeout,
  });

  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await locator.isEnabled()) {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 250)
    );
  }

  throw new Error(
    "Control did not become enabled."
  );
}

async function processISTPackage(job, { onBeforeSave, onStage } = {}) {
  console.log("");
  console.log("==========================");
  console.log("MSPT REAL SIGNATURE TEST");
  console.log("==========================");
  console.log("Package:", job.packageId);
  console.log("Signature Name:", job.signatureField);
  console.log("Canvas:", job.canvasSignature);

  // --------------------------------------------------
  // LOGIN + PACKAGE PRECHECK
  // --------------------------------------------------

  if (onStage) await onStage("Signing into MSPT");
  const session = await login();

  const pkg = await findPackage(
    session.token,
    job.packageId
  );

  console.log("Package found");
  console.log("Internal ID:", pkg.incomingPackageId);
  console.log("Record GUID:", pkg.id);
  console.log("Pieces:", pkg.numOfPieces);

  if (isAlreadySignedOut(pkg)) {
    console.log("Package already signed out.");

    return {
      status: "skipped",
      reason: "already_signed_out",
      packageId: job.packageId,
      recordId: pkg.id,
    };
  }

  const trackingNumbers = Array.isArray(
    pkg.trackingNumbers
  )
    ? pkg.trackingNumbers
        .map((item) => item.trackingNumber)
        .filter(Boolean)
    : [];

  if (!trackingNumbers.length) {
    throw new Error(
      `Package ${job.packageId} has no tracking number.`
    );
  }

  // For this package we expect one.
  const targetTrackingNumber =
    trackingNumbers[0];

  console.log(
    "Target tracking number:",
    targetTrackingNumber
  );

  // --------------------------------------------------
  // CHROME
  // --------------------------------------------------

  if (onStage) await onStage("Opening Search Package");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1000,
    },
  });

  const page = await context.newPage();

  page.on("pageerror", (error) => {
    console.log(
      "[BROWSER ERROR]",
      error.message
    );
  });

  page.on("requestfailed", (request) => {
    const url = request.url();

    if (
      url.includes("sigwebtablet.com") ||
      url.includes("127.0.0.1:27443") ||
      url.includes("127.0.0.1:28443")
    ) {
      return;
    }

    console.log(
      "[REQUEST FAILED]",
      url,
      request.failure()?.errorText
    );
  });

  try {
    // ------------------------------------------------
    // AUTHENTICATE BROWSER
    // ------------------------------------------------

    console.log(
      "Injecting MSPT browser session..."
    );

    await page.addInitScript(
      ({ token, siteId }) => {
        localStorage.setItem(
          "jwtKey",
          token
        );

        localStorage.setItem(
          "siteId",
          String(siteId)
        );
      },
      {
        token: session.token,
        siteId: session.siteId,
      }
    );

    console.log(
      "Opening Package Track..."
    );

    await page.goto(MSPT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await page.waitForTimeout(15000);

    // ------------------------------------------------
    // SEARCH PACKAGE TAB
    // ------------------------------------------------

    const searchPackageTab =
      page.getByRole("tab", {
        name: "Search Package",
        exact: true,
      });

    await searchPackageTab.waitFor({
      state: "visible",
      timeout: 60000,
    });

    console.log("MSPT loaded.");
    console.log(
      "Opening Search Package..."
    );

    await searchPackageTab.click();

    await page.waitForTimeout(750);

    // ------------------------------------------------
    // INTERNAL ID
    // ------------------------------------------------

    const internalIdContainer = page
      .locator(
        ".k-floating-label-container"
      )
      .filter({
        has: page.locator("label", {
          hasText: "Internal ID",
        }),
      })
      .first();

    const internalIdInput =
      internalIdContainer.locator("input");

    await internalIdInput.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log(
      `Entering Internal ID ${job.packageId}...`
    );

    await internalIdInput.fill(
      String(job.packageId)
    );

    // ------------------------------------------------
    // ACTUAL SEARCH BUTTON
    // ------------------------------------------------

    const searchButton =
      page.getByRole("button", {
        name: "Search",
        exact: true,
      });

    await searchButton.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log("Clicking Search...");

    await searchButton.click();

    // ------------------------------------------------
    // WAIT FOR EXACT RESULT
    // ------------------------------------------------

    console.log(
      "Waiting for package result..."
    );

    const packageCell = page
      .locator(
        'td[role="gridcell"][data-col-index="0"]'
      )
      .filter({
        hasText: new RegExp(
          `^\\s*${job.packageId}\\s*$`
        ),
      })
      .first();

    await packageCell.waitFor({
      state: "visible",
      timeout: 30000,
    });

    const packageRow =
      packageCell.locator("..");

    console.log(
      `Package ${job.packageId} found.`
    );

    // ------------------------------------------------
    // SELECT RESULT
    // ------------------------------------------------

    console.log(
      "Selecting package result..."
    );

    await packageRow.click();

    await page.waitForTimeout(750);

    // Verify Telerik actually selected it.
    const ariaSelected =
      await packageRow.getAttribute(
        "aria-selected"
      );

    console.log(
      "Row selected:",
      ariaSelected
    );

    // ------------------------------------------------
    // WAIT FOR LOWER PACKAGE FORM
    // ------------------------------------------------

    const selectedInternalId = page.locator(
      'input[role="spinbutton"][aria-valuenow="' +
        job.packageId +
        '"]'
    );

    await selectedInternalId.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log(
      "Package detail form loaded."
    );

    // ------------------------------------------------
    // TRACKING NUMBER DROPDOWN
    // ------------------------------------------------

    //
    // We specifically want the dropdown in the
    // selected package detail form, NOT the Tracking
    // Number text field in the search filters.
    //

    const trackingDropdownContainer = page
      .locator(
        ".k-floating-label-container"
      )
      .filter({
        has: page.locator("label", {
          hasText: "Tracking Number",
        }),
      })
      .filter({
        has: page.locator(
          '[role="combobox"]'
        ),
      })
      .first();

    const trackingDropdown =
      trackingDropdownContainer.locator(
        '[role="combobox"]'
      );

    await trackingDropdown.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log(
      "Opening Tracking Number dropdown..."
    );

    await trackingDropdown.click();

    // ------------------------------------------------
    // WAIT FOR CORRECT TRACKING NUMBER
    // ------------------------------------------------

    console.log(
      "Waiting for tracking number:",
      targetTrackingNumber
    );

    const trackingOption = page
      .locator(
        ".k-animation-container:visible"
      )
      .getByText(
        targetTrackingNumber,
        {
          exact: true,
        }
      )
      .first();

    await trackingOption.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log(
      "Selecting tracking number..."
    );

    await trackingOption.click();

    await page.waitForTimeout(750);

    // ------------------------------------------------
    // VERIFY TRACKING SELECTION
    // ------------------------------------------------

    const selectedTrackingText = (
      await trackingDropdownContainer
        .locator(
          ".k-input-value-text"
        )
        .innerText()
    ).trim();

    console.log(
      "Selected tracking number:",
      selectedTrackingText
    );

    if (
      selectedTrackingText !==
      targetTrackingNumber
    ) {
      throw new Error(
        `Wrong tracking number selected. Expected ${targetTrackingNumber}, got ${selectedTrackingText}`
      );
    }

    // ------------------------------------------------
    // SIGNATURE NAME SHOULD NOW BE AVAILABLE
    // ------------------------------------------------

    const signatureNameContainer = page
      .locator(
        ".k-floating-label-container"
      )
      .filter({
        has: page.locator("label", {
          hasText: "Signature Name",
        }),
      })
      .first();

    const signatureNameInput =
      signatureNameContainer.locator(
        "input"
      );

    await waitUntilEnabled(
      signatureNameInput,
      15000
    );

    console.log(
      "Signature Name field available."
    );

    // ------------------------------------------------
    // RETAG
    // ------------------------------------------------

    await signatureNameInput.fill(
      job.signatureField
    );

    const enteredName =
      await signatureNameInput.inputValue();

    if (
      enteredName !==
      job.signatureField
    ) {
      throw new Error(
        `Signature Name mismatch. Expected ${job.signatureField}, got ${enteredName}`
      );
    }

    console.log(
      "Signature Name:",
      enteredName
    );

    // ------------------------------------------------
    // DIGITAL SIGNATURE TYPE
    // ------------------------------------------------

    const signatureTypeContainer = page
      .locator(
        ".k-floating-label-container"
      )
      .filter({
        has: page.locator("label", {
          hasText: "Signature Type",
        }),
      })
      .first();

    const signatureTypeValue =
      signatureTypeContainer.locator(
        ".k-input-value-text"
      );

    let signatureType = (
      await signatureTypeValue.innerText()
    ).trim();

    console.log(
      "Signature Type:",
      signatureType
    );

    if (signatureType !== "Digital") {
      const signatureTypeDropdown =
        signatureTypeContainer.locator(
          '[role="combobox"]'
        );

      await signatureTypeDropdown.click();

      const digitalOption = page
        .locator(
          ".k-animation-container:visible"
        )
        .getByText(
          "Digital",
          {
            exact: true,
          }
        )
        .first();

      await digitalOption.waitFor({
        state: "visible",
        timeout: 10000,
      });

      await digitalOption.click();

      await page.waitForTimeout(500);

      signatureType = (
        await signatureTypeValue.innerText()
      ).trim();

      if (
        signatureType !== "Digital"
      ) {
        throw new Error(
          `Could not select Digital. Current type: ${signatureType}`
        );
      }
    }

    // ------------------------------------------------
    // START
    // ------------------------------------------------

    const startButton =
      page.getByRole("button", {
        name: "Start",
        exact: true,
      });

    await waitUntilEnabled(
      startButton,
      15000
    );

    console.log(
      "Starting signature..."
    );

    await startButton.click();

    await page.waitForFunction(
      () => {
        const element =
          document.querySelector(
            ".signatureBox"
          );

        return (
          element &&
          !element.classList.contains(
            "k-disabled"
          )
        );
      },
      null,
      {
        timeout: 15000,
      }
    );

    // ------------------------------------------------
    // DRAW IST
    // ------------------------------------------------

    console.log("Drawing IST...");

    if (onStage) await onStage("Drawing and checking IST signature");
    await drawIST(page);

    await page.waitForTimeout(500);

    // ------------------------------------------------
    // SIGNATURE COMPLETED
    // ------------------------------------------------
    // Search Package does not use a Done button.
    // Once the Digital signature is drawn, MSPT keeps
    // the signature directly on the form.

    console.log(
      "Signature drawn successfully."
    );

    await page.waitForTimeout(750);

    const signatureCanvas =
      page.locator(".signatureBox canvas");

    await signatureCanvas.waitFor({
      state: "visible",
      timeout: 15000,
    });

    // Clear Signature becomes enabled after MSPT has
    // accepted a drawn signature.
    const clearSignatureButton =
      page.getByRole("button", {
        name: "Clear Signature",
        exact: true,
      });

    await waitUntilEnabled(
      clearSignatureButton,
      15000
    );

    console.log(
      "MSPT accepted drawn signature."
    );

    // ------------------------------------------------
    // PRE-SAVE SCREENSHOT
    // ------------------------------------------------

    const debugScreenshots = process.env.MSPT_DEBUG_SCREENSHOTS === "1";
    const beforeSavePath = debugScreenshots ? `.automation-queue/${job.id}-before-save.png` : null;
    if (beforeSavePath) {
      await page.screenshot({ path: beforeSavePath, fullPage: true });
      console.log("Debug screenshot:", beforeSavePath);
    }

    // ------------------------------------------------
    // FINAL VALIDATION
    // ------------------------------------------------

    if (onStage) await onStage("Checking fields before Save");
    const finalName =
      await signatureNameInput.inputValue();

    const finalTracking = (
      await trackingDropdownContainer
        .locator(
          ".k-input-value-text"
        )
        .innerText()
    ).trim();

    const finalType = (
      await signatureTypeValue.innerText()
    ).trim();

    if (
      finalName !==
      job.signatureField
    ) {
      throw new Error(
        "Signature Name changed before Save."
      );
    }

    if (
      finalTracking !==
      targetTrackingNumber
    ) {
      throw new Error(
        "Tracking Number changed before Save."
      );
    }

    if (finalType !== "Digital") {
      throw new Error(
        "Signature Type changed before Save."
      );
    }

    console.log("");
    console.log(
      "FINAL CHECK PASSED"
    );
    console.log(
      "Package:",
      job.packageId
    );
    console.log(
      "Tracking:",
      finalTracking
    );
    console.log(
      "Signature Name:",
      finalName
    );
    console.log(
      "Signature Type:",
      finalType
    );
    console.log(
      "Canvas: IST"
    );

    // ------------------------------------------------
    // SAVE ONCE
    // ------------------------------------------------

    const saveButton =
      page.getByRole("button", {
        name: "Save",
        exact: true,
      });

    await waitUntilEnabled(
      saveButton,
      15000
    );

    console.log("");
    console.log(
      "CLICKING SAVE..."
    );

    // A durable checkpoint is written BEFORE attempting Save. If Playwright
    // fails or the process dies after this point, the outcome needs review.
    if (typeof onBeforeSave === "function") {
      await onBeforeSave();
    }

    // IMPORTANT: never repeat this click automatically.
    await saveButton.click();

    console.log(
      "Save clicked once."
    );

    // Never retry the Save click.
    await page.waitForTimeout(3000);

    // ------------------------------------------------
    // POST-SAVE SCREENSHOT
    // ------------------------------------------------

    const afterSavePath = debugScreenshots ? `.automation-queue/${job.id}-after-save.png` : null;
    if (afterSavePath) {
      await page.screenshot({ path: afterSavePath, fullPage: true });
      console.log("Debug screenshot:", afterSavePath);
    }

    // ------------------------------------------------
    // API VERIFICATION
    // ------------------------------------------------

    if (onStage) await onStage("Verifying sign-out with MSPT");
    console.log(
      "Verifying through MSPT API..."
    );

    let verifiedPackage = null;

    for (
      let attempt = 1;
      attempt <= 10;
      attempt++
    ) {
      await page.waitForTimeout(1500);

      verifiedPackage =
        await findPackage(
          session.token,
          job.packageId
        );

      console.log(
        `Verification ${attempt}:`,
        {
          signatureName:
            verifiedPackage.signatureName,
          signatureDate:
            verifiedPackage.signatureDate,
          signatureTypeId:
            verifiedPackage.signatureTypeId,
          hasSignature:
            Boolean(
              verifiedPackage.signature
            ),
        }
      );

      if (
        String(
          verifiedPackage.signatureName ||
            ""
        ).trim() ===
          String(
            job.signatureField
          ).trim() &&
        verifiedPackage.signatureDate
      ) {
        break;
      }
    }

    // ------------------------------------------------
    // REQUIRE SERVER CONFIRMATION
    // ------------------------------------------------

    const verified =
      verifiedPackage &&
      String(
        verifiedPackage.signatureName ||
          ""
      ).trim() ===
        String(
          job.signatureField
        ).trim() &&
      Boolean(
        verifiedPackage.signatureDate
      );

    if (!verified) {
      throw new Error(
        `Save was clicked ONCE, but MSPT API did not confirm ${job.signatureField} + signatureDate. Do not automatically retry Save.`
      );
    }

    console.log("");
    console.log(
      "=========================="
    );
    console.log(
      "SAVE VERIFIED"
    );
    console.log(
      "=========================="
    );
    console.log(
      "Package:",
      job.packageId
    );
    console.log(
      "Tracking:",
      targetTrackingNumber
    );
    console.log(
      "Signature Name:",
      verifiedPackage.signatureName
    );
    console.log(
      "Signature Date:",
      verifiedPackage.signatureDate
    );

    return {
      status: "completed",

      packageId:
        job.packageId,

      recordId:
        pkg.id,

      trackingNumber:
        targetTrackingNumber,

      submitted: true,
      verified: true,

      signatureName:
        verifiedPackage.signatureName,

      signatureDate:
        verifiedPackage.signatureDate,

      signatureTypeId:
        verifiedPackage.signatureTypeId,

      beforeSaveScreenshot:
        beforeSavePath,

      afterSaveScreenshot:
        afterSavePath,
    };
  } catch (error) {
    console.log(
      "Automation failed:",
      error.message
    );

    if (process.env.MSPT_DEBUG_SCREENSHOTS === "1") {
      const failurePath = `.automation-queue/${job.id}-FAILED.png`;
      try {
        await page.screenshot({ path: failurePath, fullPage: true });
        console.log("Failure diagnostic screenshot:", failurePath);
      } catch (screenshotError) {
        console.log("Could not capture failure screenshot:", screenshotError.message);
      }
    }

    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = {
  processISTPackage,
  drawIST,
};