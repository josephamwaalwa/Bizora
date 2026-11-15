import { isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

export type ExportBackupResult = 'saved' | 'cancelled';
export type ImportBackupResult =
  | { status: 'selected'; content: string }
  | { status: 'cancelled' };

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
