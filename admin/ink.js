/**
 * A readable text colour for a given background.
 *
 * Categories are data: the organisers can add Press in any colour they like,
 * and a badge printed in a pale one needs dark text while a navy one needs
 * light. Deciding that by eye per category would mean revisiting it every time
 * somebody adds one, so it is computed.
 *
 * Rec. 709 luma, which weights green the way an eye does. The threshold is
 * where the two candidate inks are about equally legible against the
 * background, and gold -- the colour that made this necessary -- sits clearly
 * on the dark-text side of it.
 */
export function inkOn(hex) {
  const value = String(hex ?? "").replace("#", "");
  if (value.length !== 6) return "#FFFFFF";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return "#FFFFFF";
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#1C2B4A" : "#FFFFFF";
}
