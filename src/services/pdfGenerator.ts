import React from 'react';
import { Font, pdf, type DocumentProps } from '@react-pdf/renderer';
import geistRegularWoff from '@fontsource/geist/files/geist-latin-400-normal.woff?url';
import geistMediumWoff from '@fontsource/geist/files/geist-latin-500-normal.woff?url';
import geistSemiBoldWoff from '@fontsource/geist/files/geist-latin-600-normal.woff?url';
import geistBoldWoff from '@fontsource/geist/files/geist-latin-700-normal.woff?url';
import geistMonoRegularWoff from '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff?url';
import geistMonoMediumWoff from '@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff?url';
import geistMonoSemiBoldWoff from '@fontsource/geist-mono/files/geist-mono-latin-600-normal.woff?url';
import { BizoraPdfDocument, type PreparedPdfLogo } from '../components/documents/BizoraPdfDocument';
import type { Invoice, Quotation } from '../types';

let fontsRegistered = false;

function ensurePdfFontsRegistered(): void {
  if (fontsRegistered) return;
  fontsRegistered = true;

  Font.register({
    family: 'Geist',
    fonts: [
      { src: geistRegularWoff, fontWeight: 400 },
      { src: geistMediumWoff, fontWeight: 500 },
      { src: geistSemiBoldWoff, fontWeight: 600 },
      { src: geistBoldWoff, fontWeight: 700 },
    ],
  });

  Font.register({
    family: 'GeistMono',
    fonts: [
      { src: geistMonoRegularWoff, fontWeight: 400 },
      { src: geistMonoMediumWoff, fontWeight: 500 },
      { src: geistMonoSemiBoldWoff, fontWeight: 600 },
    ],
  });

  Font.registerHyphenationCallback((word) => [word]);
}

function isNativelySupportedPdfImage(src: string): boolean {
  const lower = src.slice(0, 48).toLowerCase();
  if (
    lower.startsWith('data:image/png') ||
    lower.startsWith('data:image/jpeg') ||
    lower.startsWith('data:image/jpg')
  ) {
    return true;
  }
  return /\.(png|jpe?g)(\?.*)?$/i.test(src);
}

async function prepareLogoForPdf(
  logoUrl: string | undefined,
  maxWidthPt: number,
  maxHeightPt: number
): Promise<PreparedPdfLogo | undefined> {
  const trimmed = logoUrl?.trim();
  if (!trimmed) return undefined;

  if (typeof window === 'undefined' || typeof globalThis.document === 'undefined') {
    return isNativelySupportedPdfImage(trimmed) ? { src: trimmed } : undefined;
  }

  return new Promise<PreparedPdfLogo | undefined>((resolve) => {
    const img = new window.Image();
    let settled = false;

    const finish = (value: PreparedPdfLogo | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timeout = window.setTimeout(() => finish(undefined), 3000);

    if (!trimmed.startsWith('data:') && !trimmed.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }

    img.onload = () => {
      window.clearTimeout(timeout);
      const naturalW = img.naturalWidth || 0;
      const naturalH = img.naturalHeight || 0;

      if (naturalW <= 0 || naturalH <= 0) {
        finish(isNativelySupportedPdfImage(trimmed) ? { src: trimmed } : undefined);
        return;
      }

      const fitScale = Math.min(maxWidthPt / naturalW, maxHeightPt / naturalH);
      const targetWidth = Math.max(10, Math.round(naturalW * fitScale * 10) / 10);
      const targetHeight = Math.max(10, Math.round(naturalH * fitScale * 10) / 10);

      if (isNativelySupportedPdfImage(trimmed)) {
        finish({
          src: trimmed,
          width: targetWidth,
          height: targetHeight,
        });
        return;
      }

      // Convert SVG, WebP, or other browser-supported formats into transparent high-DPI PNG
      try {
        const targetPixelScale = 4;
        const maxRasterDim = 1000;
        const rawCanvasW = Math.max(1, Math.round(naturalW * targetPixelScale));
        const rawCanvasH = Math.max(1, Math.round(naturalH * targetPixelScale));
        const clampScale = Math.min(1, maxRasterDim / Math.max(rawCanvasW, rawCanvasH));
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(rawCanvasW * clampScale));
        canvas.height = Math.max(1, Math.round(rawCanvasH * clampScale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(undefined);
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pngDataUrl = canvas.toDataURL('image/png');
        finish({
          src: pngDataUrl,
          width: targetWidth,
          height: targetHeight,
        });
      } catch {
        finish(undefined);
      }
    };

    img.onerror = () => {
      window.clearTimeout(timeout);
      finish(undefined);
    };

    img.src = trimmed;
  });
}

export interface GenerateDocumentPdfOptions {
  type: 'quote' | 'invoice';
  document: Quotation | Invoice;
  quoteRefLabel?: string;
}

export async function generateDocumentPdfBytes({
  type,
  document,
  quoteRefLabel,
}: GenerateDocumentPdfOptions): Promise<Uint8Array> {
  ensurePdfFontsRegistered();

  const maxLogoWidthPt = 84;
  const maxLogoHeightPt = 39;

  const preparedLogo = await prepareLogoForPdf(
    document.businessSnapshot.logoUrl,
    maxLogoWidthPt,
    maxLogoHeightPt
  );

  const element = React.createElement(BizoraPdfDocument, {
    type,
    document,
    quoteRefLabel,
    preparedLogo,
  }) as unknown as React.ReactElement<DocumentProps>;

  const pdfInstance = pdf(element);
  const blob = await pdfInstance.toBlob();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
