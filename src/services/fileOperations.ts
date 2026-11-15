import { isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';

export type ExportBackupResult = 'saved' | 'cancelled';
export type ImportBackupResult =
  | { status: 'selected'; content: string }
  | { status: 'cancelled' };

/**
 * Sanitizes a document number for safe use in Windows/cross-platform filenames
 * and builds a standard PDF filename (e.g. Quotation-QUO-0001.pdf).
 */
export function buildDocumentPdfFilename(
  type: 'quote' | 'invoice',
  documentNumber: string
): string {
  const prefix = type === 'invoice' ? 'Invoice' : 'Quotation';
  const cleaned = (documentNumber || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');

  return cleaned ? `${prefix}-${cleaned}.pdf` : `${prefix}.pdf`;
}

/**
 * Exports a binary PDF using the native Windows Save dialog in Tauri
 * or a browser Blob download when running in a standard web browser.
 */
export async function exportPdfFile(
  defaultFileName: string,
  pdfBytes: Uint8Array
): Promise<ExportBackupResult> {
  if (isTauri()) {
    const targetPath = await save({
      title: 'Save PDF Document',
      defaultPath: defaultFileName,
      filters: [
        {
          name: 'PDF Document',
          extensions: ['pdf'],
        },
      ],
    });

    if (!targetPath) {
      return 'cancelled';
    }

    await writeFile(targetPath, pdfBytes);
    return 'saved';
  }

  const copy = new Uint8Array(pdfBytes.byteLength);
  copy.set(pdfBytes);
  const blob = new Blob([copy.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = defaultFileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'saved';
}

/**
 * Exports a JSON backup string using the native Windows Save dialog in Tauri
 * or a browser Blob download when running in a standard web browser.
 */
export async function exportJsonBackupFile(
  defaultFileName: string,
  jsonContent: string
): Promise<ExportBackupResult> {
  if (isTauri()) {
    const targetPath = await save({
      title: 'Export Bizora Backup',
      defaultPath: defaultFileName,
      filters: [
        {
          name: 'Bizora Backup (JSON)',
          extensions: ['json'],
        },
      ],
    });

    if (!targetPath) {
      return 'cancelled';
    }

    await writeTextFile(targetPath, jsonContent);
    return 'saved';
  }

  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = defaultFileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return 'saved';
}

/**
 * Opens a native file dialog in Tauri to read a JSON backup file.
 * Returns null in web browser environments so the caller can trigger an <input type="file">.
 */
export async function pickAndReadJsonBackupInTauri(): Promise<ImportBackupResult | null> {
  if (!isTauri()) {
    return null;
  }

  const selectedPath = await open({
    title: 'Restore Bizora Backup',
    multiple: false,
    directory: false,
    filters: [
      {
        name: 'Bizora Backup (JSON)',
        extensions: ['json'],
      },
    ],
  });

  if (!selectedPath || Array.isArray(selectedPath)) {
    return { status: 'cancelled' };
  }

  const content = await readTextFile(selectedPath);
  return { status: 'selected', content };
}
