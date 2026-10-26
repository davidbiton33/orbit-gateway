import { GatewayError } from './security.mjs';

// The Gemini website is not an API.  Its upload input can appear only AFTER the
// user clicks "Upload files".  Prefer a real Playwright filechooser event; never
// inject JavaScript into the page or forge a drag/drop event.
export const UPLOAD_MENU_BUTTON_SELECTORS = [
  'button[aria-label="Upload & tools"]',
  'button[aria-label="Open upload file menu"]',
  'button[aria-label="Add files"]',
  'button[aria-label="Upload files"]',
  'button[aria-label*="upload & tools" i]',
  'button[aria-label*="upload file" i]',
  'button[aria-label*="add files" i]',
  'button[aria-label*="צירוף" i]',
  'button[aria-label*="העלאת" i]',
  'button[aria-label*="הוספת קבצים" i]',
  'button[aria-label*="קובץ" i]',
  'button:has(mat-icon[data-mat-icon-name="add_2"])',
  'button:has(mat-icon[fonticon="add"])',
];

export const UPLOAD_ACTION_SELECTORS = [
  // Published Gemini DOM anchors. May change; keep role/text fallbacks too.
  'images-files-uploader[data-test-id="uploader-images-files-button-advanced"]',
  '[data-test-id="uploader-images-files-button-advanced"]',
  '[data-test-id="local-images-files-uploader-icon"]',
  'images-files-uploader',
];

const MENU_LABEL = /upload files|upload from computer|upload from device|files from (?:this )?device|העלאת קבצים|העלאת קובץ|העלאה מהמחשב|העלאת קבצים מהמכשיר|העלאה מהמכשיר|上传文件/i;
const MENU_BUTTON_LABEL = /upload\s*(?:&|and)\s*tools|open upload file menu|add files|attach files|צירוף קבצים|הוספת קבצים|העלאה וכלים|הוספה וכלים|添加文件/i;

const PREVIEW_SELECTORS = [
  'rich-textarea img[src^="blob:"]',
  'rich-textarea img[src^="data:image/"]',
  'rich-textarea file-preview-item',
  'rich-textarea uploader-file-item',
  'file-preview-item',
  'uploader-file-item',
  '[data-test-id*="attachment-preview" i]',
  '[data-test-id*="uploaded-file" i]',
  '[data-test-id*="file-preview" i]',
  '[class*="attachment-preview"] img',
  '[class*="upload-preview"] img',
  '[class*="file-preview"] img',
  'rich-textarea mat-chip-row',
  'rich-textarea [class*="attachment"]',
  'rich-textarea [class*="file-chip"]',
];

function candidates(page, stage) {
  if (stage === 'menu') return [
    ...UPLOAD_MENU_BUTTON_SELECTORS.map(css => page.locator(css)),
    page.getByRole('button', {name:MENU_BUTTON_LABEL}),
  ];
  return [
    ...UPLOAD_ACTION_SELECTORS.map(css=>page.locator(css)),
    page.getByRole('menuitem', {name:MENU_LABEL}),
    page.getByRole('button', {name:MENU_LABEL}),
    page.getByText(MENU_LABEL,{exact:true}),
  ];
}

async function firstVisible(locators) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      if (await first.isVisible()) return first;
    } catch { /* Site can replace nodes mid-render. */ }
  }
  return null;
}

async function findImageInput(page) {
  const inputs = page.locator('input[type="file"]');
  const count = Math.min(await inputs.count(), 20);
  // If more than one file input exists, do not blindly use the first one: it
  // might belong to Drive import, a code folder uploader, or a different UI.
  for (let i=0;i<count;i++) {
    const input = inputs.nth(i);
    try {
      const accept = (await input.getAttribute('accept') || '').toLowerCase();
      const outer = await input.evaluate(el=>el.parentElement?.tagName?.toLowerCase() || '');
      if (accept.includes('image/') || outer === 'images-files-uploader') return input;
    } catch { /* node removed */ }
  }
  if (count === 1) return inputs.first();
  return null;
}

async function setExistingInput(page,payload) {
  const input = await findImageInput(page);
  if (!input) return false;
  try { await input.setInputFiles(payload,{timeout:3500}); return true; }
  catch { return false; }
}

async function triggerWithChooser(page,locator,payload) {
  // Important: subscribe BEFORE clicking. Gemini creates a hidden input at the
  // very moment the upload action triggers the native chooser.
  const chooserPromise = page.waitForEvent('filechooser',{timeout:2400}).catch(()=>null);
  await locator.click({timeout:3500});
  const chooser = await chooserPromise;
  if (chooser) {await chooser.setFiles(payload);return true;}
  return setExistingInput(page,payload);
}

export async function attachImage(page,content,mimeType) {
  const filename = mimeType==='image/png'?'reference.png':mimeType==='image/webp'?'reference.webp':'reference.jpg';
  const payload = {name:filename,mimeType,buffer:content};

  // Some Gemini versions render a permanent hidden input even before the menu.
  if (await setExistingInput(page,payload)) return filename;

  // Some versions have a direct "Upload files" trigger.  Try it before opening
  // the general menu; never click "Add from Drive" or "Import code".
  const direct = await firstVisible(candidates(page,'action'));
  if (direct) {
    try {if (await triggerWithChooser(page,direct,payload)) return filename;} catch {}
  }

  const menu = await firstVisible(candidates(page,'menu'));
  if (!menu) {
    throw new GatewayError(502,'upload_ui_unavailable',
      'Gemini upload button was not found (tried Upload & tools / Add files). No image was sent.');
  }
  try {
    if (await triggerWithChooser(page,menu,payload)) return filename;
  } catch { /* A menu button may simply open a menu without a chooser. */ }

  const action = await firstVisible(candidates(page,'action'));
  if (!action) {
    throw new GatewayError(502,'upload_ui_unavailable',
      'Gemini upload menu opened, but Upload files is missing. No image was sent.');
  }
  try {
    if (await triggerWithChooser(page,action,payload)) return filename;
  } catch { /* report actionable error instead of misleading success */ }

  throw new GatewayError(502,'upload_ui_unavailable',
    'Gemini Upload files was found, but neither the file chooser nor an image file input was available. No image was sent.');
}

export async function confirmAttachment(page,filename,{timeoutMs=25000}={}) {
  const deadline = Date.now()+timeoutMs;
  while (Date.now()<deadline) {
    const preview = await firstVisible(PREVIEW_SELECTORS.map(css=>page.locator(css)));
    if (preview) return true;
    // Some current Gemini designs replace the thumbnail with a filename chip.
    const filenameChip = page.getByText(filename,{exact:false});
    try {if (await filenameChip.first().isVisible()) return true;} catch {}
    await page.waitForTimeout(350);
  }
  throw new GatewayError(502,'attachment_not_confirmed',
    'Gemini did not show an uploaded reference image. The request was NOT submitted. Check that your account allows image uploads.');
}
