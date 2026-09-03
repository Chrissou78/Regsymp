export function escape(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function layout({ title, user, body, flash }) {
  const notice = flash
    ? `<div class="a-flash a-flash--${escape(flash.kind)}">${flash.html ?? escape(flash.message)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} — RegSymp Admin</title>
<link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body>
<header class="a-head">
  <a class="a-brand" href="/admin">RegSymp Admin</a>
  <div class="a-user">${
    user
      ? `<span>${escape(user.email ?? user.login)}</span><a href="/admin/signout">Sign out</a>`
      : ""
  }</div>
</header>
<main class="a-main">
${notice}
${body}
</main>
</body>
</html>`;
}

/** Render one form control from its schema field definition. */
export function field(def, value) {
  const id = `f-${def.name}`;
  const name = escape(def.name);
  const required = def.required ? " required" : "";
  const help = def.help ? `<span class="a-help">${escape(def.help)}</span>` : "";
  const label = `<label for="${id}">${name}${def.required ? ' <span class="a-req">*</span>' : ""}</label>`;

  let control;
  switch (def.type) {
    case "textarea":
      control = `<textarea id="${id}" name="${name}" rows="5"${required}>${escape(value)}</textarea>`;
      break;
    case "checkbox":
      control = `<input id="${id}" type="checkbox" name="${name}"${value ? " checked" : ""}>`;
      break;
    case "url":
      control = `<input id="${id}" type="url" name="${name}" value="${escape(value)}"${required}>`;
      break;
    case "image":
      control =
        `<input id="${id}" type="file" name="${name}" accept="image/*">` +
        `<input type="hidden" name="${name}__current" value="${escape(value)}">` +
        (value ? `<span class="a-current">Current: ${escape(value)}</span>` : "");
      break;
    default:
      control = `<input id="${id}" type="text" name="${name}" value="${escape(value)}"${required}>`;
  }

  return `<div class="a-field">${label}${control}${help}</div>`;
}

export function errorList(errors = []) {
  if (errors.length === 0) return "";
  const items = errors.map((e) => `<li>${escape(e.message)}</li>`).join("");
  return `<div class="a-errors"><ul>${items}</ul></div>`;
}
