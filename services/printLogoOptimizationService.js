import sharp from 'sharp';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_000_000;
const MAX_INPUT_DIMENSION = 8_192;
const SUPPORTED_FORMATS = new Set(['png', 'jpeg']);

export const mmToPixels203Dpi = (millimeters) =>
  Math.round((Number(millimeters) / 25.4) * 203);

const failure = (reason) => ({ ok: false, reason });

const decodeSupportedDataUrl = (value) => {
  const match = String(value || '').match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) return failure('UNSUPPORTED_DATA_URL');

  const estimatedBytes = Math.floor((match[2].length * 3) / 4);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_INPUT_BYTES) return failure('INPUT_SIZE_INVALID');

  const buffer = Buffer.from(match[2], 'base64');
  const normalizedInput = match[2].replace(/=+$/, '');
  if (
    buffer.length === 0
    || buffer.length > MAX_INPUT_BYTES
    || buffer.toString('base64').replace(/=+$/, '') !== normalizedInput
  ) {
    return failure('INVALID_BASE64');
  }

  return { ok: true, buffer };
};

export const optimizePrintLogoDataUrl = async (dataUrl, { targetWidthPx, targetHeightPx } = {}) => {
  const width = Math.floor(Number(targetWidthPx));
  const height = Math.floor(Number(targetHeightPx));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return failure('TARGET_SIZE_INVALID');
  }

  const decoded = decodeSupportedDataUrl(dataUrl);
  if (!decoded.ok) return decoded;

  try {
    const inputOptions = {
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true
    };
    const metadata = await sharp(decoded.buffer, inputOptions).metadata();
    if (
      !SUPPORTED_FORMATS.has(metadata.format)
      || !Number.isInteger(metadata.width)
      || !Number.isInteger(metadata.height)
      || metadata.width < 1
      || metadata.height < 1
      || metadata.width > MAX_INPUT_DIMENSION
      || metadata.height > MAX_INPUT_DIMENSION
      || metadata.width * metadata.height > MAX_INPUT_PIXELS
    ) {
      return failure('IMAGE_DIMENSIONS_INVALID');
    }

    const { data: buffer, info } = await sharp(decoded.buffer, inputOptions)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width,
        height,
        fit: 'inside',
        withoutEnlargement: true
      })
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true
      })
      .toBuffer({ resolveWithObject: true });

    return {
      ok: true,
      buffer,
      inputWidthPx: metadata.width,
      inputHeightPx: metadata.height,
      outputWidthPx: info.width,
      outputHeightPx: info.height
    };
  } catch {
    return failure('IMAGE_PROCESSING_FAILED');
  }
};
