const DECIMAL_PATTERN = /^\d+(?:\.(\d+))?$/;
const QUANTITY_SCALE = 6;
const FACTOR_SCALE = 18;
const NUMERIC_18_6_MAX_SCALED = 999_999_999_999_999_999n;

const powerOfTen = (exponent) => 10n ** BigInt(exponent);

export const parsePositiveDecimal = (value, { maxFractionDigits, maxIntegerDigits = 12 }) => {
  const text = String(value ?? '').trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return null;
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > maxFractionDigits) return null;
  const significantWhole = whole.replace(/^0+/, '') || '0';
  if (significantWhole.length > maxIntegerDigits) return null;
  const digits = BigInt(`${whole}${fraction}`);
  if (digits <= 0n) return null;
  return { digits, scale: fraction.length, text };
};

export const parsePositiveFactor = (value) => parsePositiveDecimal(value, {
  maxFractionDigits: FACTOR_SCALE,
  maxIntegerDigits: 12
});

const formatScaled6 = (scaled) => {
  const integer = scaled / 1_000_000n;
  const fraction = String(scaled % 1_000_000n).padStart(QUANTITY_SCALE, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : String(integer);
};

export const multiplyQuantityByFactor = (quantity, factor) => {
  const left = parsePositiveDecimal(quantity, { maxFractionDigits: QUANTITY_SCALE, maxIntegerDigits: 12 });
  const right = parsePositiveFactor(factor);
  if (!left || !right) return null;

  const product = left.digits * right.digits;
  const sourceScale = left.scale + right.scale;
  let scaled6;
  if (sourceScale <= QUANTITY_SCALE) {
    scaled6 = product * powerOfTen(QUANTITY_SCALE - sourceScale);
  } else {
    const divisor = powerOfTen(sourceScale - QUANTITY_SCALE);
    scaled6 = product / divisor;
    if ((product % divisor) * 2n >= divisor) scaled6 += 1n;
  }
  if (scaled6 <= 0n || scaled6 > NUMERIC_18_6_MAX_SCALED) return null;
  return formatScaled6(scaled6);
};
