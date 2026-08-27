/**
 * Minimal multipart/form-data parser.
 *
 * Written rather than depended on because the admin handles exactly one
 * shape of form — a handful of text fields and at most one image — and
 * adding a parsing dependency to a zero-dependency server is a poor trade.
 */
export function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let start = buffer.indexOf(delimiter);
  if (start === -1) return { fields, files };

  while (start !== -1) {
    const partStart = start + delimiter.length;

    // "--" immediately after the delimiter marks the final boundary.
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;

    const headerEnd = buffer.indexOf("\r\n\r\n", partStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(partStart, headerEnd).toString("utf8");

    const next = buffer.indexOf(delimiter, headerEnd);
    // Content is followed by CRLF before the next delimiter.
    const contentEnd = next === -1 ? buffer.length : next - 2;
    const data = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, contentEnd));

    const nameMatch = headers.match(/name="([^"]*)"/);
    const filenameMatch = headers.match(/filename="([^"]*)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      if (filenameMatch) {
        // An untouched file input still submits a part, with an empty
        // filename and no content. That is not an upload.
        if (filenameMatch[1] && data.length > 0) {
          files.push({
            name: nameMatch[1],
            filename: filenameMatch[1],
            type: typeMatch ? typeMatch[1].trim() : "",
            data
          });
        }
      } else {
        fields[nameMatch[1]] = data.toString("utf8");
      }
    }

    start = next;
  }

  return { fields, files };
}

/**
 * Identify an image from its magic bytes.
 *
 * The declared Content-Type is attacker-controlled and therefore useless
 * for validation; the file's own header is not.
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(PNG)) return "png";

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";

  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString("latin1") === "RIFF" &&
    buffer.slice(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }

  const head = buffer.slice(0, 200).toString("utf8").trim();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";

  return null;
}

/** Parse the boundary out of a Content-Type header. */
export function boundaryFrom(contentType) {
  const match = String(contentType ?? "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  return (match[1] ?? match[2]).trim();
}
