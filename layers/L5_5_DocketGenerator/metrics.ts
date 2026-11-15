/**
 * Advance widths from Tinos Regular and Bold (units per em 2048).
 * Tinos uses Times New Roman metrics, so a line that fits these widths
 * fits Times New Roman and the LibreOffice Tinos substitute.
 * Index 0 is U+0020. Code points outside U+0020–U+007E take a full em.
 */
const UNITS_PER_EM = 2048

const TINOS_REGULAR = [
  512, 682, 836, 1024, 1024, 1706, 1593, 369, 682, 682, 1024, 1155, 512, 682, 512, 569, 1024, 1024, 1024, 1024, 1024,
  1024, 1024, 1024, 1024, 1024, 569, 569, 1155, 1155, 1155, 909, 1886, 1479, 1366, 1366, 1479, 1251, 1139, 1479, 1479,
  682, 797, 1479, 1251, 1821, 1479, 1479, 1139, 1479, 1366, 1139, 1251, 1479, 1479, 1933, 1479, 1479, 1251, 682, 569, 682,
  961, 1024, 682, 909, 1024, 909, 1024, 909, 682, 1024, 1024, 569, 569, 1024, 569, 1593, 1024, 1024, 1024, 1024, 682, 797,
  569, 1024, 1024, 1479, 1024, 1024, 909, 983, 410, 983, 1108,
]

const TINOS_BOLD = [
  512, 682, 1137, 1024, 1024, 2048, 1706, 569, 682, 682, 1024, 1167, 512, 682, 512, 569, 1024, 1024, 1024, 1024, 1024,
  1024, 1024, 1024, 1024, 1024, 682, 682, 1167, 1167, 1167, 1024, 1905, 1479, 1366, 1479, 1479, 1366, 1251, 1593, 1593,
  797, 1024, 1593, 1366, 1933, 1479, 1593, 1251, 1593, 1479, 1139, 1366, 1479, 1479, 2048, 1479, 1479, 1366, 682, 569, 682,
  1190, 1024, 682, 1024, 1139, 909, 1139, 909, 682, 1024, 1139, 569, 682, 1139, 569, 1706, 1139, 1024, 1139, 1139, 909,
  797, 682, 1139, 1024, 1479, 1024, 1024, 909, 807, 451, 807, 1065,
]

export function tnrWidth(text: string, sizePt: number, bold = false): number {
  const table = bold ? TINOS_BOLD : TINOS_REGULAR
  let units = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    units += code >= 32 && code <= 126 ? (table[code - 32] ?? UNITS_PER_EM) : UNITS_PER_EM
  }
  return (units / UNITS_PER_EM) * sizePt
}
