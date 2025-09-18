'use strict';

// Server & utilities
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
require('dotenv').config();

// PDF tooling
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Configuration
const PORT = process.env.PORT || 3000;
const UPS_OAUTH_URL = process.env.UPS_OAUTH_URL || 'https://wwwcie.ups.com/security/v1/oauth/token'; // CIE = sandbox
const UPS_BASE_URL = process.env.UPS_BASE_URL || 'https://wwwcie.ups.com';
const UPS_CLIENT_ID = process.env.UPS_CLIENT_ID || 'OmVHMj0fI8ydcTwM1zzqRJt7qUKFxThisW2iXhT103xH4tlu';
const UPS_CLIENT_SECRET = process.env.UPS_CLIENT_SECRET || 'NGONMZfxH5s0yMgasUA6dzPLvYtqlGzOjVIy5iHEGPhGDV0VVYRWvPwMv2jeq15C';
const UPS_DOCS_VERSION = process.env.UPS_DOCS_VERSION || 'v1';

// Paths
const ROOT_DIR = __dirname;
const BLANKS_DIR = path.join(ROOT_DIR, 'CUSTOMS_DOCs_BLANK');
const OUTPUT_DIR = path.join(ROOT_DIR, 'generated_docs');
const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');

// Ensure output directory exists
fse.ensureDirSync(OUTPUT_DIR);

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---- Helpers ----

async function getUpsAccessToken() {
  if (!UPS_CLIENT_ID || !UPS_CLIENT_SECRET) {
    return null; // no creds provided; run in mock mode
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  const authHeader = Buffer.from(`${UPS_CLIENT_ID}:${UPS_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(UPS_OAUTH_URL, params, {
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  return res.data.access_token;
}

async function createUpsShipmentReal(shipmentData) {
  console.log(shipmentData,'shipmetdata')
  const accessToken = await getUpsAccessToken();
  console.log(accessToken,'accessToken');
  if (!accessToken) return null;

  // NOTE: This is a placeholder for a real UPS shipment creation request body.
  // Consult UPS Shipping API (Shipments) spec to build the full payload.
  const shipTo = shipmentData.address || {};
  const shipFrom = shipmentData.shipFrom;
  const accountNumber = process.env.UPS_ACCOUNT_NUMBER || '0AB297';
  const accountCountry = (process.env.UPS_ACCOUNT_COUNTRY || shipFrom.countryCode || 'US').toUpperCase();
  const isImperial = ['US', 'PR'].includes(accountCountry);
  const weightUnit = isImperial ? 'LBS' : 'KGS';
  const dimUnit = isImperial ? 'IN' : 'CM';

  const itemsSummary = (shipmentData.items || [])
    .map((it) => `${it.description || 'Item'} x${it.quantity || 1}`)
    .join('; ');

  const payload = {
    ShipmentRequest: {
      Request: {
        SubVersion: '1801',
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: shipmentData.customerContext || '' },
      },
      Shipment: {
        Shipper: {
          Name: shipmentData.shipperName || 'Your Company',
          ShipperNumber: accountNumber,
          Address: {
            AddressLine: [shipFrom.addressLine1, shipFrom.addressLine2].filter(Boolean),
            City: shipFrom.city || '',
            StateProvinceCode: shipFrom.state || '',
            PostalCode: shipFrom.postalCode || '',
            CountryCode: accountCountry,
          },
          AttentionName: shipFrom.attentionName || shipFrom.name || shipmentData.shipperName || 'Shipping Dept',
          Phone: { Number: (shipFrom.phone || shipmentData.shipperPhone || '0000000000').replace(/[^0-9]/g, '').slice(0,15) },
        },
        ShipFrom: {
          Name: shipFrom.name || shipmentData.shipperName || 'Your Company',
          Address: {
            AddressLine: [shipFrom.addressLine1, shipFrom.addressLine2].filter(Boolean),
            City: shipFrom.city || '',
            StateProvinceCode: shipFrom.state || '',
            PostalCode: shipFrom.postalCode || '',
            CountryCode: accountCountry,
          },
          AttentionName: shipFrom.attentionName || shipFrom.name || 'Warehouse',
          Phone: { Number: (shipFrom.phone || shipmentData.shipperPhone || '0000000000') },
        },
        ShipTo: {
          Name: shipTo.name || '',
          Address: {
            AddressLine: [shipTo.addressLine1, shipTo.addressLine2].filter(Boolean),
            City: shipTo.city || '',
            StateProvinceCode: 'AZ',
            PostalCode:  '85043',
            CountryCode: shipTo.countryCode || 'US',
          },
          AttentionName: shipTo.attentionName || shipTo.name || 'Receiver',
          Phone: { Number: (`+${shipTo.phone}` || shipmentData.shipToPhone || '0000000000') },
        },
        Description: shipmentData.description || itemsSummary || 'Merchandise',
        Service: {
          Code: '65', // 03 = Ground (example)
          Description: shipmentData.serviceDescription || 'Ground',
        },
        PaymentInformation: {
          ShipmentCharge: {
            Type: '01', // 01 = Transportation
            BillShipper: { AccountNumber: accountNumber },
          },
        },
        Package: (shipmentData.items || []).map((it) => {
          // Harmonize units
          const weight = isImperial
            ? (it.weightLbs != null ? Number(it.weightLbs) : (it.weightKg != null ? Number(it.weightKg) * 2.20462262 : 1))
            : (it.weightKg != null ? Number(it.weightKg) : (it.weightLbs != null ? Number(it.weightLbs) * 0.45359237 : 1));
          const lengthVal = it.length != null ? Number(it.length) : (isImperial ? 4 : 10);
          const widthVal  = it.width  != null ? Number(it.width)  : (isImperial ? 4 : 10);
          const heightVal = it.height != null ? Number(it.height) : (isImperial ? 4 : 10);

          return {
            Description: it.description || ' ',
            Packaging: { Code: it.packagingCode || '02', Description: it.packagingDescription || 'Customer Supplied Package' },
            Dimensions: {
              UnitOfMeasurement: { Code: dimUnit, Description: isImperial ? 'Inches' : 'Centimeters' },
              Length: String(lengthVal),
              Width: String(widthVal),
              Height: String(heightVal),
            },
            PackageWeight: {
              UnitOfMeasurement: { Code: weightUnit, Description: isImperial ? 'Pounds' : 'Kilograms' },
              Weight: String(weight),
            },
          };
        }),
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF', Description: 'GIF' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  };

  try {
    const res = await axios.post(`${UPS_BASE_URL}/api/shipments/v1/ship`, payload, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log(res.data,'response');
    const shipmentNumber = res?.data?.ShipmentResponse?.ShipmentResults?.ShipmentIdentificationNumber;
    return { shipmentNumber, raw: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    throw new Error(`UPS create shipment error ${status || ''}: ${JSON.stringify(data)}`);
  }
}

async function createUpsShipmentMock(shipmentData) {
  const fakeNumber = `1Z${Math.random().toString().slice(2, 12).toUpperCase()}`;
  return { shipmentNumber: fakeNumber, raw: { mock: true, shipmentData } };
}

// Upload a user-created form as base64 per UPS Paperless Documents API
async function upsUploadUserCreatedForm(filePath, options = {}) {
  const accessToken = await getUpsAccessToken();
  if (!accessToken) return null;

  const fileBuffer = fs.readFileSync(filePath);
  const base64 = fileBuffer.toString('base64');
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const fileName = options.fileName || path.basename(filePath);
  const fileFormat = options.fileFormat || (ext || 'pdf');
  const documentType = options.documentType || '013'; // User Created Form
  const customerContext = options.customerContext || '';
  const shipperNumber = options.shipperNumber || process.env.UPS_ACCOUNT_NUMBER || '0AB297';

  const payload = {
    UploadRequest: {
      Request: { TransactionReference: { CustomerContext: customerContext } },
      UserCreatedForm: [
        {
          UserCreatedFormFileName: fileName,
          UserCreatedFormFileFormat: fileFormat,
          UserCreatedFormDocumentType: documentType,
          UserCreatedFormFile: base64,
        }
      ],
      ShipperNumber: shipperNumber,
    },
  };

  try {
    const res = await axios.post(
      `${UPS_BASE_URL}/api/paperlessdocuments/${UPS_DOCS_VERSION}/upload`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}`, ShipperNumber: shipperNumber } }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    throw new Error(`UPS upload error ${status || ''}: ${JSON.stringify(data)}`);
  }
}

// Push an uploaded document to be associated with a shipment
async function upsPushDocumentToShipment(params) {
  const accessToken = await getUpsAccessToken();
  if (!accessToken) return null;

  const {
    documentId,
    shipmentIdentifier,
    trackingNumber,
    shipmentDateTime, // format: YYYY-MM-DD-HH.MM.SS
    customerContext = '',
  } = params;

  const payload = {
    PushToImageRepositoryRequest: {
      Request: { TransactionReference: { CustomerContext: customerContext } },
      FormsHistoryDocumentID: { DocumentID: documentId },
      ShipmentIdentifier: shipmentIdentifier,
      ShipmentDateAndTime: shipmentDateTime,
      ShipmentType: '1',
      TrackingNumber: trackingNumber,
    },
  };

  const shipperNumber = process.env.UPS_ACCOUNT_NUMBER || '0AB297';

  try {
    const res = await axios.post(
      `${UPS_BASE_URL}/api/paperlessdocuments/${UPS_DOCS_VERSION}/image`,
      payload,
      { headers: { Authorization: `Bearer ${accessToken}`, ShipperNumber: shipperNumber } }
    );
    console.log(res.data,'res.data');
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    throw new Error(`UPS push image error ${status || ''}: ${JSON.stringify(data)}`);
  }
}

async function uploadDocumentToUpsMock(shipmentNumber, filePath, documentType) {
  return { mock: true, shipmentNumber, filePath, documentType };
}

async function writeTextOnPdf(inputPath, outputPath, lines) {
  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageCount = pdfDoc.getPageCount();

  for (const line of lines) {
    const pageIndex = typeof line.page === 'number' ? line.page : 0;
    const clampedIndex = Math.min(Math.max(0, pageIndex), pageCount - 1);
    const page = pdfDoc.getPage(clampedIndex);
    const { height } = page.getSize();

    const text = line.text ?? '';
    const x = typeof line.x === 'number' ? line.x : 40;
    const y = typeof line.y === 'number' ? line.y : (height - 40);
    const size = typeof line.size === 'number' ? line.size : 8;

    if (typeof line.maxWidth === 'number' && line.maxWidth > 0) {
      const maxWidth = line.maxWidth;
      const lineHeight = typeof line.lineHeight === 'number' ? line.lineHeight : 10;
      const words = String(text).split(/\s+/);

      let curr = '';
      const wrapped = [];
      for (const w of words) {
        const candidate = curr ? curr + ' ' + w : w;
        const width = font.widthOfTextAtSize(candidate, size);
        if (width <= maxWidth) {
          curr = candidate;
        } else {
          if (curr) wrapped.push(curr);
          curr = w;
        }
      }
      if (curr) wrapped.push(curr);

      wrapped.forEach((ln, idx) => {
        const yOffset = y - idx * lineHeight;
        page.drawText(ln, { x, y: yOffset, size, font, color: rgb(0, 0, 0) });
      });
    } else {
      page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0) });
    }
  }

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, outBytes);
  return outputPath;
}


async function mergePdfAppend(basePdfPath, appendPdfPath, outPath) {
  const baseBytes = fs.readFileSync(basePdfPath);
  const appendBytes = fs.readFileSync(appendPdfPath);

  const baseDoc = await PDFDocument.load(baseBytes);
  const appendDoc = await PDFDocument.load(appendBytes);

  const pages = await baseDoc.copyPages(appendDoc, appendDoc.getPageIndices());
  pages.forEach((p) => baseDoc.addPage(p));

  const outBytes = await baseDoc.save();
  fs.writeFileSync(outPath, outBytes);
  return outPath;
}

async function mergePdfInsertAfter(basePdfPath, insertPdfPath, insertAfterPageIndex, outPath) {
  const baseBytes = fs.readFileSync(basePdfPath);
  const insertBytes = fs.readFileSync(insertPdfPath);

  const baseDoc = await PDFDocument.load(baseBytes);
  const insertDoc = await PDFDocument.load(insertBytes);

  const insertPages = await baseDoc.copyPages(insertDoc, insertDoc.getPageIndices());
  const baseCount = baseDoc.getPageCount();
  const startIndex = Math.min(Math.max(insertAfterPageIndex + 1, 0), baseCount);

  insertPages.forEach((page, idx) => {
    baseDoc.insertPage(startIndex + idx, page);
  });

  const outBytes = await baseDoc.save();
  fs.writeFileSync(outPath, outBytes);
  return outPath;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function fillPdfForm(pdfPath, lines) {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  lines.forEach((line) => {
    const pageIndex = line.page || 0;
    if (pageIndex < pages.length) {
      const page = pages[pageIndex];
      const { width, height } = page.getSize();
      page.drawText(line.text, {
        x: line.x,
        y: height - line.y,
        size: 10,
        font: font,
        color: rgb(0, 0, 0),
      });
    }
  });

  const pdfBytesModified = await pdfDoc.save();
  fs.writeFileSync(pdfPath, pdfBytesModified);
}

async function renderInvoiceItemsPdf(items, options) {
  const {
    shipmentNumber = 'UNKNOWN',
    pageSize = 'Letter',
    rowsPerPage = 28,
    outputDir = OUTPUT_DIR,
  } = options || {};

  const templatePath = path.join(TEMPLATES_DIR, 'invoice_dynamic.ejs');
  const pages = chunkArray(Array.isArray(items) ? items : [], rowsPerPage);

  const html = await ejs.renderFile(templatePath, { pages }, { async: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: pageSize,
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
    });
    const outPath = path.join(outputDir, `INVOICE_ITEMS_${shipmentNumber}.pdf`);
    fs.writeFileSync(outPath, pdfBuffer);
    return outPath;
  } finally {
    await browser.close();
  }
}



function buildCustomsLinesFromShipment(shipmentData, templateType) {
  const address = shipmentData?.address || {};
  const items = Array.isArray(shipmentData?.items) ? shipmentData.items : [];
  const order = shipmentData?.order || {};
  const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const itemSummary = items.map((i) => `${i.description || 'Item'} x${i.quantity || 1}`).join('; ');

  // Calculate totals
  const invoiceSubtotal = order.invoice_subtotal || order.subtotal || 0;
  const discountRebate = order.discount_rebate || order.discount || 0;
  const freight = order.freight || 0;
  const insurance = order.insurance || 0;
  const others = order.others || 0;
  const weight = order.weight;
  const totalInvoiceAmount = order.total_invoice_amount || order.total || (invoiceSubtotal - discountRebate + freight + insurance + others);
  const invoiceNumber = "INV-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

  if (templateType === 'INVOICES') {
    // Hybrid mode: only static fields here; items will be rendered via HTML → PDF
    return [
      // Address fields
      { text: `${address.name || ''}`, x: 84, y: 512 },
      { text: `${address.addressLine1 || ''}`, x: 23, y: 500 },
      { text: `${address.city || ''}`, x: 23, y: 488 },
      { text: `${address.countryCode || ''}`, x: 23, y: 476 },
      { text: `${currentDate}`, x:333, y: 655 },
      { text: `${invoiceNumber}`, x:358, y: 645 },


      // Invoice totals
      { text: `${invoiceSubtotal}`, x: 448, y: 690, page: 1 },
      { text: `${discountRebate}`, x: 448, y: 676, page: 1 },
      { text: `${invoiceSubtotal}`, x: 448, y: 662, page: 1 },
      { text: `${freight}`, x: 448, y: 649, page: 1 },
      { text: `${insurance}`, x: 448, y: 635, page: 1 },
      { text: `${others}`, x: 448, y: 622, page: 1 },
      { text: `${totalInvoiceAmount}`, x: 448, y: 608, page: 1 },
      { text: `${shipmentData.shipmentNumber || ''}`, x: 359, y: 712 },
      { text: `${weight || ''}`, x: 448, y: 577, page:1},
      { text: `${items.length || ''}`, x: 448, y: 589, page:1},

    ];
  }

  if (templateType === 'TSCA') {
    // Write products directly into the blank TSCA template
    const lines = [
      { text: `${shipmentData.shipmentNumber || ''}`, x: 240, y: 127 },
      { text: `${currentDate}`, x: 327, y: 720 },
    ];
    
    // Add up to 4 products to the TSCA form
    // These coordinates are approximate - you may need to adjust based on the actual TSCA template
    const productYPositions = [539, 554, 569, 584]; // Y positions for 4 product lines
    
    items.slice(0, 4).forEach((item, index) => {
      const description = item.description || item.name || '';
      const words = description.split(' ').slice(0, 4).join(' ');
      lines.push({
        text: words,
        x: 50, // X position for product description
        y: productYPositions[index]
      });
    });
    
    return lines;
  }

  if (templateType === '232_FORM') {
    return [
      { text: `${currentDate}`, x:77, y: 690 },
    ];
  }

  // Default fallback
  return [
    { text: `${address.name || ''}`, x: 84, y: 512 },
    { text: `${itemSummary}`, x: 30, y: 432 },
  ];
}

// ---- Routes ----

// Creates a UPS shipment (real if credentials exist, mock otherwise)
app.post('/create-shipment', async (req, res) => {
  try {
    const shipmentData = req.body?.shipmentData || {};
    let result;
    try {
      result = await createUpsShipmentReal(shipmentData);
    } catch (realErr) {
      // fall back to mock if real fails or no creds
      if (UPS_CLIENT_ID && UPS_CLIENT_SECRET) {
        console.error(realErr.message);
      }
     // result = await createUpsShipmentMock(shipmentData);
    }

    res.json({ shipmentNumber: result.shipmentNumber, raw: result.raw });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Create shipment failed' });
  }
});

// Generates customs PDFs from blanks and uploads them to the UPS shipment
app.post('/generate-and-upload-docs/:shipmentNumber', async (req, res) => {
  const shipmentNumber = req.params.shipmentNumber;
  const shipmentData = req.body || {};
  shipmentData.shipmentNumber = shipmentNumber; // Add shipment number to data
  try {
    // Build lines per template type
    const templateLines = {
      'INVOICES_BLANK.pdf': buildCustomsLinesFromShipment(shipmentData, 'INVOICES'),
      'TSCA_BLANK.pdf': buildCustomsLinesFromShipment(shipmentData, 'TSCA'),
      '232_FORM_BLANK.pdf': buildCustomsLinesFromShipment(shipmentData, '232_FORM'),
    };

    const blanks = [
      { file: 'INVOICES_BLANK.pdf', type: 'COMMERCIAL_INVOICE' },
      { file: '232_FORM_BLANK.pdf', type: 'OTHER' },
      { file: 'TSCA_BLANK.pdf', type: 'OTHER' },
    ];

    const uploadResults = [];
    const shipmentDocuments = []; // Array to collect all document IDs for shipment association

    for (const blank of blanks) {
      const inputPath = path.join(BLANKS_DIR, blank.file);
      const baseName = `${path.parse(blank.file).name}_${shipmentNumber}.pdf`;
      const outputPath = path.join(OUTPUT_DIR, baseName);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Missing template: ${inputPath}`);
      }
     if (blank.file !== 'TSCA_BLANK.pdf') {
      await writeTextOnPdf(inputPath, outputPath, templateLines[blank.file] || []);
     }
     

      // Hybrid flow for INVOICE: generate paginated items via HTML and append to invoice template
      if (blank.file === 'INVOICES_BLANK.pdf') {
        const itemsPdfPath = await renderInvoiceItemsPdf(shipmentData.items || [], {
          shipmentNumber,
          rowsPerPage: 28,
          pageSize: 'Letter',
          outputDir: OUTPUT_DIR,
        });
        const mergedPath = path.join(OUTPUT_DIR, `${path.parse(blank.file).name}_${shipmentNumber}_MERGED.pdf`);
        // Insert items pages after page 1 (index 0) so base page 2 remains last
        await mergePdfInsertAfter(outputPath, itemsPdfPath, 0, mergedPath);
        // Replace outputPath with mergedPath for upload
        fse.moveSync(mergedPath, outputPath, { overwrite: true });
      }

      if (blank.file === 'TSCA_BLANK.pdf') {
        // Create multiple TSCA forms with max 4 products each, written directly into blank template
        const items = shipmentData.items || [];
        const maxProductsPerForm = 4;
        
        // Split items into groups of max 4
        const itemGroups = [];
        for (let i = 0; i < items.length; i += maxProductsPerForm) {
          itemGroups.push(items.slice(i, i + maxProductsPerForm));
        }
        
        // Process each TSCA form separately
        for (let i = 0; i < itemGroups.length; i++) {
          const formNumber = itemGroups.length > 1 ? `_${i + 1}` : '';
          const finalOutputPath = path.join(OUTPUT_DIR, `${path.parse(blank.file).name}_${shipmentNumber}${formNumber}.pdf`);
          
          // Copy the base TSCA form for each product group.
          // Use the original blank as the source, and avoid copying when source and destination are the same.
          const sourcePath = inputPath; // always copy from the original blank template
          if (finalOutputPath !== outputPath) {
            fse.copySync(sourcePath, finalOutputPath);
          } else {
            // Single-group case: ensure the base file exists; copy only if not already created earlier
            if (!fs.existsSync(outputPath)) {
              fse.copySync(sourcePath, outputPath);
            }
          }
          
          // Create a modified shipment data with only the products for this form
          const formShipmentData = {
            ...shipmentData,
            items: itemGroups[i]
          };
          
          // Fill the TSCA form with products written directly into the blank template
          const tscaLines = buildCustomsLinesFromShipment(formShipmentData, 'TSCA');
          await fillPdfForm(finalOutputPath, tscaLines);
          
          // Upload each TSCA form separately
          try {
            const uploadRes = await upsUploadUserCreatedForm(finalOutputPath, {
              fileName: path.basename(finalOutputPath),
              fileFormat: 'pdf',
              documentType: '013',
              customerContext: shipmentData.customerContext || '',
            });
            console.log(`TSCA Form ${i + 1} upload result:`, uploadRes);
            const documentId = uploadRes?.UploadResponse?.FormsHistoryDocumentID?.DocumentID;
            
            // Build shipment date/time in required format
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const shipmentDateTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
            
            // Push TSCA form to shipment
            if (documentId) {
              const pushRes = await upsPushDocumentToShipment({
                documentId,
                shipmentIdentifier: shipmentNumber,
                trackingNumber: shipmentData.trackingNumber || shipmentNumber,
                shipmentDateTime,
                customerContext: shipmentData.customerContext || '',
              });
              
              console.log(`TSCA Form ${i + 1} push result:`, pushRes);
              
              // Add to upload results
              uploadResults.push({
                template: `TSCA_BLANK.pdf (Form ${i + 1})`,
                outputPath: finalOutputPath,
                uploadResponse: uploadRes,
                pushResponse: pushRes,
              });
            }
          } catch (uploadErr) {
            console.error(`Failed to upload TSCA form ${i + 1}:`, uploadErr.message);
          }
        }
        
        // Skip the normal processing for TSCA since we handled it above
        continue;
      }

      let result = { template: blank.file, outputPath };
      try {
        const uploadRes = await upsUploadUserCreatedForm(outputPath, {
          fileName: path.basename(outputPath),
          fileFormat: 'pdf',
          documentType: '013',
          customerContext: shipmentData.customerContext || '',
        });
        console.log(uploadRes,'uploadRes');
        const documentId = uploadRes?.UploadResponse?.FormsHistoryDocumentID?.DocumentID;

        // Build shipment date/time in required format
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const shipmentDateTime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;

        const pushRes = await upsPushDocumentToShipment({
          documentId,
          shipmentIdentifier: shipmentNumber,
          trackingNumber: shipmentData.trackingNumber || shipmentNumber,
          shipmentDateTime,
          customerContext: shipmentData.customerContext || '',
        });

        console.log(pushRes,'pushRes');

        result.uploadResponse = uploadRes;
        result.pushResponse = pushRes;
      } catch (err) {
        if (UPS_CLIENT_ID && UPS_CLIENT_SECRET) {
          console.error(err.message);
        }
       // const mock = await uploadDocumentToUpsMock(shipmentNumber, outputPath, blank.type);
        //result.uploadResponse = mock;
      }

      uploadResults.push(result);
    }

    res.json({ shipmentNumber, uploadResults });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Doc generation/upload failed' });
  }
});

app.get('/', (_req, res) => {
  res.send('UPS Service is running');
});

app.listen(PORT, () => {
  console.log(`UPS service listening on http://localhost:${PORT}`);
});


