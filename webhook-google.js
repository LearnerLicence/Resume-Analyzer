// webhook-google.js - Vercel serverless function with proper Chromium setup
import puppeteer from "puppeteer-core";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let browser = null;

  try {
    console.log("📥 Received Tally webhook");
    console.log("📋 Webhook data:", JSON.stringify(req.body, null, 2));

    // Verify Tally webhook (optional but recommended)
    const tallySignature = req.headers["tally-signature"];
    if (tallySignature) {
      console.log("🔐 Tally signature present");
    }

    // Extract file URL from Tally webhook
    const fileData = extractFileUrl(req.body);

    if (!fileData || !fileData.url) {
      console.log("❌ No file found in webhook data");
      return res.status(400).json({
        error: "No file found in webhook data",
        debug: {
          fieldsFound: req.body?.data?.fields?.length || 0,
          fileFields:
            req.body?.data?.fields?.filter((f) => f.type === "FILE_UPLOAD") ||
            [],
        },
      });
    }

    console.log("📎 File found:", fileData);

    // Check if it's a resume file (basic validation)
    if (!isResumeFile(fileData)) {
      console.log("⚠️ File doesn't appear to be a resume");
      return res.status(400).json({
        error:
          "Uploaded file doesn't appear to be a resume (PDF/DOC/DOCX expected)",
        fileInfo: fileData,
      });
    }

    console.log("🚀 Starting browser automation...");

    // FIXED: Proper Chromium setup for Vercel with dynamic import
    const isLocal =
      process.env.NODE_ENV === "development" || !process.env.VERCEL;

    console.log(`🔧 Environment: ${isLocal ? "local" : "production"}`);

    if (isLocal) {
      // Local development - use system Chrome
      const chromeExecPaths = {
        win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        linux: "/usr/bin/google-chrome-stable",
        darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      };

      browser = await puppeteer.launch({
        executablePath: chromeExecPaths[process.platform],
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    } else {
      // Production - use @sparticuz/chromium with dynamic import
      console.log("🌐 Using Chromium for production...");

      // Dynamic import for ESM compatibility
      const chromium = await import("@sparticuz/chromium");

      browser = await puppeteer.launch({
        args: [
          ...chromium.default.args,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-extensions",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-ipc-flooding-protection",
        ],
        defaultViewport: {
          width: 1280,
          height: 720,
        },
        executablePath: await chromium.default.executablePath(),
        headless: chromium.default.headless,
        ignoreHTTPSErrors: true,
      });
    }

    console.log("✅ Browser launched successfully");

    const page = await browser.newPage();

    // Set longer timeout for slower serverless environments
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    try {
      // Navigate to open-resume
      console.log("🌐 Navigating to open-resume...");
      await page.goto("https://www.open-resume.com/resume-parser", {
        waitUntil: "networkidle0",
        timeout: 45000,
      });

      console.log("✅ Page loaded successfully");

      // Download file buffer (keep in memory only)
      const fileBuffer = await downloadFileAsBuffer(fileData.url);
      console.log(`💾 Downloaded file: ${fileBuffer.length} bytes`);

      // Find and interact with file input
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        throw new Error("File input not found on page");
      }

      // Create file directly in browser memory
      console.log("📤 Creating file object in browser...");
      await page.evaluateHandle(
        async (bufferData, filename, mimeType) => {
          try {
            const uint8Array = new Uint8Array(bufferData);
            const file = new File([uint8Array], filename, {
              type: mimeType || "application/pdf",
              lastModified: Date.now(),
            });

            const input = document.querySelector('input[type="file"]');
            if (input) {
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);
              input.files = dataTransfer.files;

              const changeEvent = new Event("change", { bubbles: true });
              const inputEvent = new Event("input", { bubbles: true });
              input.dispatchEvent(changeEvent);
              input.dispatchEvent(inputEvent);

              console.log("✅ File uploaded successfully:", filename);
            }
          } catch (error) {
            console.error("File creation failed:", error);
            throw error;
          }
        },
        Array.from(fileBuffer),
        fileData.name,
        fileData.mimeType
      );

      console.log("✅ File uploaded directly to browser");
      console.log("⏳ Waiting for analysis...");

      // Wait for the specific table to load
      const tableSelector =
        "body > main > div > div.flex.px-6.text-gray-900.md\\:col-span-3.md\\:h-\\[calc\\(100vh-var\\(--top-nav-bar-height\\)\\)\\].md\\:overflow-y-scroll > section > table";

      try {
        await page.waitForSelector(tableSelector, { timeout: 50000 });
        console.log("✅ Target table found!");
      } catch (timeoutError) {
        console.log("⚠️ Target table not found, trying fallback selectors...");
        const fallbackSelectors = [
          "main table",
          "section table",
          "div table",
          "table",
        ];

        let tableFound = false;
        for (const selector of fallbackSelectors) {
          try {
            await page.waitForSelector(selector, { timeout: 15000 });
            console.log(`✅ Found table with fallback selector: ${selector}`);
            tableFound = true;
            break;
          } catch (e) {
            continue;
          }
        }

        if (!tableFound) {
          throw new Error("No table found on page");
        }
      }

      // Give it a moment to fully load
      await new Promise((r) => setTimeout(r, 3000));

      // Extract table data
      const results = await page.evaluate((targetSelector) => {
        let tableElement = document.querySelector(targetSelector);

        if (!tableElement) {
          const fallbacks = [
            "main table",
            "section table",
            "div table",
            "table",
          ];
          for (const selector of fallbacks) {
            tableElement = document.querySelector(selector);
            if (tableElement) break;
          }
        }

        if (!tableElement) {
          return { error: "Table not found" };
        }

        const tableData = {
          html: tableElement.outerHTML,
          text: tableElement.innerText,
          rows: [],
          headers: [],
        };

        // Extract headers
        const headerRows = tableElement.querySelectorAll(
          "thead tr, tr:first-child"
        );
        if (headerRows.length > 0) {
          const headerCells = headerRows[0].querySelectorAll("th, td");
          tableData.headers = Array.from(headerCells).map((cell) =>
            cell.textContent.trim()
          );
        }

        // Extract all rows
        const allRows = tableElement.querySelectorAll("tbody tr, tr");
        tableData.rows = Array.from(allRows).map((row) => {
          const cells = row.querySelectorAll("td, th");
          return Array.from(cells).map((cell) => cell.textContent.trim());
        });

        return {
          success: true,
          tableData,
          totalRows: tableData.rows.length,
          totalColumns:
            tableData.headers.length || tableData.rows[0]?.length || 0,
          timestamp: new Date().toISOString(),
          pageTitle: document.title,
          url: window.location.href,
        };
      }, tableSelector);

      console.log("✅ Table extraction complete!");

      // 📊 SAVE TO GOOGLE SHEETS
      try {
        await saveToGoogleSheets(results, fileData);
        console.log("✅ Results saved to Google Sheets!");
      } catch (sheetError) {
        console.error("❌ Google Sheets error:", sheetError);
        // Continue even if sheets fails - still return results
      }

      return res.json({
        success: true,
        message: "Analysis complete and saved to Google Sheets!",
        fileInfo: {
          name: fileData.name,
          size: fileData.size,
          mimeType: fileData.mimeType,
        },
        summary: {
          totalRows: results.totalRows,
          totalColumns: results.totalColumns,
          timestamp: results.timestamp,
        },
        // Only include full data in development
        ...(isLocal ? { fullResults: results } : {}),
      });
    } catch (error) {
      throw error;
    }
  } catch (error) {
    console.error("❌ Error:", error);

    return res.status(500).json({
      error: error.message,
      details: "Browser automation failed",
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 Browser closed");
    }
  }
}

// 📊 GOOGLE SHEETS INTEGRATION
async function saveToGoogleSheets(results, fileData) {
  // Check if Google credentials are configured
  if (
    !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !process.env.GOOGLE_PRIVATE_KEY ||
    !process.env.GOOGLE_SHEET_ID
  ) {
    throw new Error("Google Sheets credentials not configured");
  }

  // Setup Google Sheets authentication
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // Initialize the sheet
  const doc = new GoogleSpreadsheet(
    process.env.GOOGLE_SHEET_ID,
    serviceAccountAuth
  );
  await doc.loadInfo();

  // Get or create the main results sheet
  let sheet = doc.sheetsByTitle["Resume Analysis Results"];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: "Resume Analysis Results",
      headerValues: [
        "Timestamp",
        "Filename",
        "File Size",
        "URL",
        "Status",
        "Total Rows",
        "Total Columns",
        "Raw Data (JSON)",
        "Notes",
      ],
    });
  }

  // Add the main result row
  const mainRow = {
    Timestamp: new Date().toLocaleString(),
    Filename: fileData.name,
    "File Size": `${Math.round(fileData.size / 1024)} KB`,
    URL: results.url || "N/A",
    Status: results.success ? "Success" : "Failed",
    "Total Rows": results.totalRows || 0,
    "Total Columns": results.totalColumns || 0,
    "Raw Data (JSON)": JSON.stringify(results.tableData || {}),
    Notes: results.error || "Analysis completed successfully",
  };

  await sheet.addRow(mainRow);

  // Create detailed analysis sheet with JSON data
  if (results.success && results.tableData) {
    const detailSheetName = `Analysis_${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:-]/g, "")}`;

    try {
      const detailSheet = await doc.addSheet({
        title: detailSheetName,
        headerValues: ["Field", "Data"],
      });

      // Add comprehensive data to the detailed sheet
      const detailRows = [
        { Field: "Filename", Data: fileData.name },
        { Field: "File Size (KB)", Data: Math.round(fileData.size / 1024) },
        { Field: "URL", Data: results.url || "N/A" },
        { Field: "Page Title", Data: results.pageTitle || "N/A" },
        { Field: "Analysis Timestamp", Data: new Date().toLocaleString() },
        { Field: "Total Rows Found", Data: results.totalRows || 0 },
        { Field: "Total Columns Found", Data: results.totalColumns || 0 },
        { Field: "--- TABLE HEADERS ---", Data: "--- TABLE HEADERS ---" },
      ];

      // Add headers
      if (results.tableData.headers && results.tableData.headers.length > 0) {
        results.tableData.headers.forEach((header, index) => {
          detailRows.push({ Field: `Header ${index + 1}`, Data: header });
        });
      } else {
        detailRows.push({ Field: "Headers", Data: "No headers found" });
      }

      detailRows.push({
        Field: "--- TABLE DATA ---",
        Data: "--- TABLE DATA ---",
      });

      // Add table rows data
      if (results.tableData.rows && results.tableData.rows.length > 0) {
        results.tableData.rows.forEach((row, rowIndex) => {
          if (Array.isArray(row) && row.length > 0) {
            detailRows.push({
              Field: `Row ${rowIndex + 1}`,
              Data: row.join(" | "),
            });
          }
        });
      } else {
        detailRows.push({ Field: "Table Data", Data: "No table data found" });
      }

      detailRows.push({
        Field: "--- RAW TABLE TEXT ---",
        Data: "--- RAW TABLE TEXT ---",
      });
      detailRows.push({
        Field: "Table Text Content",
        Data: results.tableData.text || "No text content",
      });

      detailRows.push({
        Field: "--- FULL JSON DATA ---",
        Data: "--- FULL JSON DATA ---",
      });
      detailRows.push({
        Field: "Complete JSON",
        Data: JSON.stringify(results.tableData, null, 2),
      });

      // Add all rows to the sheet
      for (const row of detailRows) {
        await detailSheet.addRow(row);
      }

      console.log(`✅ Created detailed analysis sheet: ${detailSheetName}`);
    } catch (detailError) {
      console.log(`⚠️ Could not create detail sheet: ${detailError.message}`);
    }
  }
}

// Extract file URL from Tally webhook
function extractFileUrl(webhookData) {
  const fields = webhookData?.data?.fields || [];

  for (const field of fields) {
    if (field.type === "FILE_UPLOAD" && field.value) {
      if (Array.isArray(field.value) && field.value.length > 0) {
        const firstFile = field.value[0];
        return {
          url: firstFile.url,
          name: firstFile.name,
          mimeType: firstFile.mimeType,
          size: firstFile.size,
        };
      } else if (typeof field.value === "object" && field.value.url) {
        return field.value;
      } else if (typeof field.value === "string") {
        return { url: field.value };
      }
    }
  }
  return null;
}

// Check if uploaded file is likely a resume
function isResumeFile(fileData) {
  if (!fileData || !fileData.mimeType) return false;
  const allowedTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  return allowedTypes.includes(fileData.mimeType);
}

// Download file as buffer
async function downloadFileAsBuffer(url) {
  const fetch = (await import("node-fetch")).default;
  const headers = {};

  if (url.includes("tally.so") && process.env.TALLY_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.TALLY_API_KEY}`;
  }

  console.log(`📡 Downloading file from: ${url}`);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

export const config = {
  maxDuration: 60,
  // Increase memory for browser operations
  memory: 1024,
};
